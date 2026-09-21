import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cpus, platform, arch, totalmem, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { projectConversationEvents } from '@turboflux/conversations/conversations/conversationProjections'
import { ConversationRepositoryV2 } from '@turboflux/conversations/conversations/conversationRepositoryV2'
import { persistedConversationFromProjectionV2 } from '@turboflux/conversations/conversations/conversationRuntimeRepositoryV2'
import { stableConversationV2Id } from '@turboflux/conversations/conversations/conversationV2Ids'
import type { AnyConversationEventV2, ConversationRecordV2, ConversationTranscriptProjectionV2 } from '@turboflux/conversations/conversations/conversationV2Types'
import { captureGithubActionsProvenance } from './github-actions-provenance.mjs'
import { sanitizeSourceEvidenceReport, writeSourceEvidenceReportAtomically } from './source-evidence-report.mjs'

const EVENT_COUNT = 100_000
const CONVERSATION_COUNT = 10_000
const PROFILE_SCALE_EVENTS_PER_CONVERSATION = 100
const REPLAY_BUDGET_MS = 5_000
const CATALOG_BUDGET_MS = 150
const FIRST_PAGE_ITEM_COUNT = 10_000
const FIRST_PAGE_BUDGET_MS = 500
const RESTORE_TURN_COUNT = 8_000
const RESTORE_BUDGET_MS = 2_000
const qualification = process.argv.includes('--stable') ? 'stable' : 'development'

function record(id: string, at: number): ConversationRecordV2 {
  return {
    schemaVersion: 2,
    id,
    profileId: 'profile-benchmark',
    workspaceId: 'workspace-benchmark',
    title: `Conversation ${id}`,
    titleSource: 'generated',
    mode: 'vibe',
    provider: 'benchmark',
    model: 'benchmark',
    status: 'idle',
    createdAt: at,
    updatedAt: at,
    lastEventSeq: 0,
    turnCount: 0,
    runCount: 0,
    tags: [],
  }
}

function replayFixture(): AnyConversationEventV2[] {
  const conversationId = 'conversation-benchmark'
  const events: AnyConversationEventV2[] = [{
    schemaVersion: 2,
    eventId: 'event-created',
    profileId: 'profile-benchmark',
    conversationId,
    workspaceId: 'workspace-benchmark',
    seq: 1,
    at: 1,
    source: 'migration',
    provenance: 'migrated',
    type: 'conversation.created',
    payload: { record: record(conversationId, 1) },
  }]
  for (let index = 1; index < EVENT_COUNT; index += 1) {
    const itemId = `notification-${index}`
    events.push({
      schemaVersion: 2,
      eventId: `event-${index}`,
      profileId: 'profile-benchmark',
      conversationId,
      workspaceId: 'workspace-benchmark',
      itemId,
      seq: index + 1,
      at: index + 1,
      source: 'runtime',
      provenance: 'live',
      type: 'item.created',
      payload: {
        item: {
          schemaVersion: 1,
          id: itemId,
          conversationId,
          kind: 'notification',
          status: 'completed',
          createdAt: index + 1,
          updatedAt: index + 1,
          payload: { level: 'info', message: `Event ${index}` },
        },
      },
    })
  }
  return events
}

function catalogFixture(): ConversationRecordV2[] {
  return Array.from({ length: CONVERSATION_COUNT }, (_, index) => record(`conversation-${String(index).padStart(5, '0')}`, index))
}

function runtimeRestoreFixture(): ConversationTranscriptProjectionV2 {
  const conversationId = 'conversation-restore-benchmark'
  const runId = 'run-restore-benchmark'
  const projection: ConversationTranscriptProjectionV2 = {
    conversation: record(conversationId, 0),
    runs: [{ id: runId, conversationId, workspaceId: null, objective: 'Restore tool history', status: 'completed', startedAt: 0, updatedAt: RESTORE_TURN_COUNT * 5 }],
    turns: [], items: [], timeline: [], artifacts: [], workspace: null, queuedInputIds: [], throughSeq: RESTORE_TURN_COUNT * 5,
  }
  for (let index = 0; index < RESTORE_TURN_COUNT; index += 1) {
    const turnId = `turn-${index}`
    const toolCallId = `tool-${index}`
    const at = index * 5
    projection.turns.push({ id: turnId, conversationId, runId, role: 'assistant', status: 'completed', createdAt: at, completedAt: at + 4 })
    const base = { schemaVersion: 1 as const, conversationId, runId, turnId, status: 'completed' as const, createdAt: at + 1, updatedAt: at + 3 }
    const items = [
      { ...base, id: `message-${index}`, kind: 'assistant_message' as const, payload: { text: 'Recorded response' } },
      { ...base, id: `call-${index}`, kind: 'tool_call' as const, payload: { toolCallId, toolName: 'read_file', arguments: { path: 'README.md' } } },
      { ...base, id: `result-${index}`, kind: 'tool_result' as const, payload: { toolCallId, toolName: 'read_file', output: 'Recorded content', isError: false } },
    ]
    projection.items.push(...items)
    projection.timeline.push(
      { eventId: `${turnId}-start`, seq: at + 1, at, type: 'turn.started', turnId, runId },
      ...items.map((item, offset) => ({ eventId: `${item.id}-created`, seq: at + offset + 2, at: at + offset + 1, type: 'item.created' as const, itemId: item.id, turnId, runId })),
      { eventId: `${turnId}-end`, seq: at + 5, at: at + 4, type: 'turn.completed', turnId, runId },
    )
  }
  return projection
}

function numericUuid(namespace: number, value: number): string {
  return `00000000-0000-5${namespace.toString(16).padStart(3, '0')}-8000-${value.toString(16).padStart(12, '0')}`
}

function stableCatalogFixture(): ConversationRecordV2[] {
  const profileId = numericUuid(1, 1)
  return Array.from({ length: CONVERSATION_COUNT }, (_, index) => ({
    ...record(numericUuid(2, index + 1), index),
    profileId,
    workspaceId: null,
    lastEventSeq: PROFILE_SCALE_EVENTS_PER_CONVERSATION,
  }))
}

function writeStableProfileScaleFixture(eventsRoot: string, records: ConversationRecordV2[]): { eventCount: number; journalBytes: number } {
  let journalBytes = 0
  for (let conversationIndex = 0; conversationIndex < records.length; conversationIndex += 1) {
    const conversation = records[conversationIndex]!
    const events: AnyConversationEventV2[] = [{
      schemaVersion: 2,
      eventId: numericUuid(3, conversationIndex * PROFILE_SCALE_EVENTS_PER_CONVERSATION + 1),
      profileId: conversation.profileId,
      conversationId: conversation.id,
      seq: 1,
      at: 1,
      source: 'migration',
      provenance: 'migrated',
      type: 'conversation.created',
      payload: { record: { ...conversation, lastEventSeq: 0 } },
    }]
    for (let eventIndex = 1; eventIndex < PROFILE_SCALE_EVENTS_PER_CONVERSATION; eventIndex += 1) {
      events.push({
        schemaVersion: 2,
        eventId: numericUuid(3, conversationIndex * PROFILE_SCALE_EVENTS_PER_CONVERSATION + eventIndex + 1),
        profileId: conversation.profileId,
        conversationId: conversation.id,
        seq: eventIndex + 1,
        at: eventIndex + 1,
        source: 'migration',
        provenance: 'migrated',
        type: 'conversation.renamed',
        payload: { title: `Conversation ${conversationIndex}`, titleSource: 'generated' },
      })
    }
    const journal = `${events.map(event => JSON.stringify(event)).join('\n')}\n`
    writeFileSync(join(eventsRoot, `${conversation.id}.jsonl`), journal, { mode: 0o600 })
    journalBytes += Buffer.byteLength(journal)
  }
  return { eventCount: records.length * PROFILE_SCALE_EVENTS_PER_CONVERSATION, journalBytes }
}

function firstPageFixture(): { conversationId: string; journal: string } {
  const profileId = stableConversationV2Id('benchmark-profile', 'first-page')
  const workspaceId = stableConversationV2Id('benchmark-workspace', 'first-page')
  const conversationId = stableConversationV2Id('benchmark-conversation', 'first-page')
  const created: AnyConversationEventV2 = {
    schemaVersion: 2,
    eventId: stableConversationV2Id('benchmark-event', 'first-page-created'),
    profileId,
    conversationId,
    workspaceId,
    seq: 1,
    at: 1,
    source: 'migration',
    provenance: 'migrated',
    type: 'conversation.created',
    payload: { record: { ...record(conversationId, 1), profileId, workspaceId } },
  }
  const events: AnyConversationEventV2[] = [created]
  for (let index = 0; index < FIRST_PAGE_ITEM_COUNT; index += 1) {
    const itemId = stableConversationV2Id('benchmark-item', 'first-page', index)
    events.push({
      schemaVersion: 2,
      eventId: stableConversationV2Id('benchmark-event', 'first-page', index),
      profileId,
      conversationId,
      workspaceId,
      itemId,
      seq: index + 2,
      at: index + 2,
      source: 'runtime',
      provenance: 'live',
      type: 'item.created',
      payload: {
        item: {
          schemaVersion: 1,
          id: itemId,
          conversationId,
          kind: 'notification',
          status: 'completed',
          createdAt: index + 2,
          updatedAt: index + 2,
          payload: { level: 'info', message: `Paged event ${index}` },
        },
      },
    })
  }
  return { conversationId, journal: `${events.map(event => JSON.stringify(event)).join('\n')}\n` }
}

let temporaryRoot: string | undefined
try {
  temporaryRoot = mkdtempSync(join(tmpdir(), 'turboflux-conversation-v2-benchmark-'))
  const events = replayFixture()
  const memoryBefore = process.memoryUsage().rss
  const replayStartedAt = performance.now()
  const projection = projectConversationEvents(events)
  const replayMs = performance.now() - replayStartedAt
  const replayRssDeltaBytes = Math.max(0, process.memoryUsage().rss - memoryBefore)
  if (projection.throughSeq !== EVENT_COUNT || projection.timeline.length !== EVENT_COUNT || projection.items.length !== EVENT_COUNT - 1) {
    throw new Error('Conversation V2 replay benchmark produced an inconsistent projection')
  }

  const restoreProjection = runtimeRestoreFixture()
  const restoreStartedAt = performance.now()
  const restored = persistedConversationFromProjectionV2(restoreProjection, '/benchmark-workspace')
  const restoreMs = performance.now() - restoreStartedAt
  if (restored?.turns.length !== RESTORE_TURN_COUNT
    || restored.canonicalEvents?.length !== RESTORE_TURN_COUNT * 5 + 2
    || Object.keys(restored.workExecution?.runs[0]?.activities ?? {}).length !== RESTORE_TURN_COUNT) {
    throw new Error('Conversation V2 runtime restoration lost recorded turns or tools')
  }

  const records = qualification === 'stable' ? stableCatalogFixture() : catalogFixture()
  writeFileSync(join(temporaryRoot, 'catalog.json'), JSON.stringify({ schemaVersion: 1, records, updatedAt: Date.now() }))
  const eventsRoot = join(temporaryRoot, 'events')
  mkdirSync(eventsRoot, { recursive: true })
  const profileScale = qualification === 'stable'
    ? writeStableProfileScaleFixture(eventsRoot, records)
    : { eventCount: 0, journalBytes: 0 }
  const reads: string[] = []
  let eventPageBytesRead = 0
  const catalogStartedAt = performance.now()
  const repository = new ConversationRepositoryV2(temporaryRoot, Date.now, {
    onRead: kind => reads.push(kind),
    onEventPageRead: bytes => { eventPageBytesRead += bytes },
  })
  const page = repository.list({ limit: 50 })
  const catalogMs = performance.now() - catalogStartedAt
  if (page.total !== CONVERSATION_COUNT || page.conversations.length !== 50 || reads.join(',') !== 'catalog') {
    throw new Error('Conversation V2 catalog benchmark performed unexpected I/O')
  }

  const firstPageFixtureValue = firstPageFixture()
  const journalPath = join(repository.eventsRoot, `${firstPageFixtureValue.conversationId}.jsonl`)
  writeFileSync(journalPath, firstPageFixtureValue.journal, { mode: 0o600 })
  const journalBytes = statSync(journalPath).size
  const firstPageStartedAt = performance.now()
  const firstPage = repository.read(firstPageFixtureValue.conversationId, 0, 50)
  const firstPageMs = performance.now() - firstPageStartedAt
  if (firstPage.events.length !== 50 || firstPage.nextSeq !== 50 || eventPageBytesRead >= journalBytes) {
    throw new Error('Conversation V2 first-page benchmark loaded an invalid or complete Journal')
  }

  const report = {
    schemaVersion: 2,
    provenance: captureGithubActionsProvenance(),
    qualification,
    generatedAt: new Date().toISOString(),
    command: qualification === 'stable' ? 'npm run perf:conversations-v2:stable' : 'npm run perf:conversations-v2',
    environment: {
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      node: process.version,
    },
    replay: {
      eventCount: EVENT_COUNT,
      itemCount: projection.items.length,
      elapsedMs: Number(replayMs.toFixed(2)),
      rssDeltaBytes: replayRssDeltaBytes,
      budgetMs: REPLAY_BUDGET_MS,
      passed: replayMs < REPLAY_BUDGET_MS,
    },
    runtimeRestore: {
      turnCount: RESTORE_TURN_COUNT,
      itemCount: restoreProjection.items.length,
      eventCount: restored.canonicalEvents.length,
      elapsedMs: Number(restoreMs.toFixed(2)),
      budgetMs: RESTORE_BUDGET_MS,
      passed: restoreMs < RESTORE_BUDGET_MS,
    },
    catalog: {
      conversationCount: CONVERSATION_COUNT,
      profileEventCount: profileScale.eventCount,
      profileJournalBytes: profileScale.journalBytes,
      pageSize: page.conversations.length,
      elapsedMs: Number(catalogMs.toFixed(2)),
      reads,
      budgetMs: CATALOG_BUDGET_MS,
      passed: catalogMs < CATALOG_BUDGET_MS,
    },
    firstPage: {
      itemCount: FIRST_PAGE_ITEM_COUNT,
      eventCount: FIRST_PAGE_ITEM_COUNT + 1,
      pageSize: firstPage.events.length,
      elapsedMs: Number(firstPageMs.toFixed(2)),
      bytesRead: eventPageBytesRead,
      journalBytes,
      budgetMs: FIRST_PAGE_BUDGET_MS,
      passed: firstPageMs < FIRST_PAGE_BUDGET_MS && eventPageBytesRead < journalBytes,
    },
    passed: replayMs < REPLAY_BUDGET_MS
      && restoreMs < RESTORE_BUDGET_MS
      && catalogMs < CATALOG_BUDGET_MS
      && firstPageMs < FIRST_PAGE_BUDGET_MS
      && eventPageBytesRead < journalBytes,
  }
  const sanitizedReport = qualification === 'stable'
    ? await writeSourceEvidenceReportAtomically(
      join(process.cwd(), 'apps', 'desktop', 'generated', 'profile-benchmarks', `conversation-v2-stable-${process.platform}-${process.arch}.json`),
      report,
    )
    : sanitizeSourceEvidenceReport(report)
  process.stdout.write(`${JSON.stringify(sanitizedReport, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
} catch {
  process.stderr.write('Conversation V2 benchmark failed\n')
  process.exitCode = 1
} finally {
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true })
}
