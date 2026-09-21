import { describe, expect, it } from 'vitest'
import type { PersistedConversation } from './types'
import { planConversationV2Migration } from './conversationV2Migration'
import { projectConversationEvents } from './conversationProjections'
import { conversationV2IdFactory } from './conversationV2Ids'
import { ConversationEventStoreV2 } from './conversationEventStoreV2'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function legacy(): PersistedConversation {
  return {
    id: 'conversation-1',
    title: 'Legacy task',
    titleSource: 'custom',
    workspacePath: '/old-machine/project',
    createdAt: 10,
    updatedAt: 30,
    mode: 'vibe',
    model: 'gpt-test',
    provider: 'openai',
    turnCount: 2,
    turns: [
      { id: 'turn-1', role: 'user', content: 'Edit it', timestamp: 10 },
      {
        id: 'turn-2', role: 'assistant', content: 'Done', timestamp: 20,
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: '/old-machine/project/src/index.ts' } }],
        toolResults: [{ toolCallId: 'call-1', name: 'read_file', output: 'ok', isError: false }],
      },
    ],
  }
}

describe('planConversationV2Migration', () => {
  it('is deterministic and virtualizes known tool paths', () => {
    const first = planConversationV2Migration('profile-1', legacy())
    const second = planConversationV2Migration('profile-1', legacy())
    expect(first).toEqual(second)
    expect(first.counts).toMatchObject({ turns: 2, messageItems: 2, toolCalls: 1, toolResults: 1, runs: 0, approvals: 0, canonicalEvents: 0 })
    const toolEvent = first.events.find(event => event.type === 'item.created' && event.payload.item.kind === 'tool_call')
    expect(toolEvent?.type === 'item.created' && toolEvent.payload.item.kind === 'tool_call'
      ? toolEvent.payload.item.payload.pathRefs
      : []).toEqual([{ scheme: 'workspace', workspaceId: first.workspaceId, relativePath: 'src/index.ts' }])
  })

  it('can append the same migration plan twice without duplicating history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'turboflux-v2-migration-'))
    try {
      const store = new ConversationEventStoreV2(directory)
      const plan = planConversationV2Migration('profile-1', legacy())
      const first = store.append(plan.events)
      const second = store.append(plan.events)
      expect(first.appended).toBeGreaterThan(0)
      expect(second.appended).toBe(0)
      expect(second.duplicateEventIds).toHaveLength(plan.events.length)
      const projection = projectConversationEvents(store.readAll('conversation-1'))
      expect(projection.turns).toHaveLength(2)
      expect(projection.items).toHaveLength(4)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('normalizes unsafe legacy coordinates before writing the V2 journal', () => {
    const directory = mkdtempSync(join(tmpdir(), 'turboflux-v2-unsafe-'))
    try {
      const value = legacy()
      value.turns[0]!.id = 'turn:user:1'
      value.turns[1]!.id = 'turn:assistant:1'
      value.turns[1]!.metadata = { workRunId: 'run:single:1' }
      value.turns[1]!.toolCalls = [{ id: 'tool:read:1', name: 'read_file', arguments: { path: '/old-machine/project/src/index.ts' } }]
      value.turns[1]!.toolResults = [{ toolCallId: 'tool:read:1', name: 'read_file', output: 'ok', isError: false }]
      value.canonicalEvents = [{
        schemaVersion: 1,
        eventId: 'legacy:event:1',
        conversationId: value.id,
        threadId: value.id,
        runId: 'run:single:1',
        turnId: 'turn:assistant:1',
        seq: 1,
        at: 20,
        source: 'workbench',
        provenance: 'live',
        type: 'run.started',
        payload: { objective: 'Continue' },
      }]

      const store = new ConversationEventStoreV2(directory)
      store.append(planConversationV2Migration('profile-1', value).events)
      const events = store.readAll(value.id)
      expect(events.flatMap(event => [event.eventId, event.runId, event.turnId, event.itemId].filter((id): id is string => Boolean(id)))
        .every(id => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id))).toBe(true)
      const projection = projectConversationEvents(events)
      expect(projection.runs).toEqual([expect.objectContaining({ id: expect.not.stringContaining(':') })])
      expect(projection.turns).toHaveLength(2)
      expect(projection.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'tool_call', payload: expect.objectContaining({ toolCallId: expect.not.stringContaining(':') }) }),
        expect.objectContaining({ kind: 'tool_result', payload: expect.objectContaining({ toolCallId: expect.not.stringContaining(':') }) }),
      ]))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('migrates canonical runs, approvals, compaction, work activities, artifacts and recovery semantically', () => {
    const value = legacy()
    value.turns[1]!.metadata = { workRunId: 'run-1', thinking: { content: 'Checked the implementation.' } }
    value.turns[1]!.toolCalls = [{ id: 'browser-1', name: 'browser__navigate', arguments: { url: 'https://example.com' } }]
    value.turns[1]!.toolResults = [{
      toolCallId: 'browser-1', name: 'browser__navigate', output: 'ready', isError: false,
      changeSummary: { path: '/old-machine/project/report.md', operation: 'write' },
      attachments: [{ id: 'artifact-1', type: 'file', path: '/old-machine/project/report.md', mime: 'text/markdown', filename: 'report.md', size: 42 }],
    }]
    value.contextSegments = [{ startMessageId: 'turn-1', endMessageId: 'turn-2', summary: 'Portable summary', isModelGenerated: true, originalCharCount: 100, isValid: true }]
    value.contextCompactionState = { id: 'compact-1', phase: 'completed', source: 'compact', startedAt: 21, updatedAt: 22, elapsedMs: 1, startMessageId: 'turn-1', endMessageId: 'turn-2', recoverable: false }
    value.interactionState = { queuedInputs: [{ id: 'input-1', prompt: 'Continue' }], draft: { text: 'Draft' }, pendingSteering: [], pendingApprovals: [{ requestId: 'approval-pending', requestKind: 'permission', question: 'Allow?' }] }
    value.workExecution = {
      schemaVersion: 1,
      currentRunId: 'run-1',
      runs: [{
        id: 'run-1', conversationId: value.id, objective: 'Finish migration', presentation: 'work', status: 'completed', phase: 'done', rootStepIds: ['step-1'],
        steps: { 'step-1': { id: 'step-1', runId: 'run-1', title: 'Verify', description: '', status: 'completed', parentId: null, childIds: [], dependencyIds: [], order: 0, progress: 1, progressMode: 'explicit', activityIds: ['activity-1'], createdAt: 10, updatedAt: 30, startedAt: 10, completedAt: 30 } },
        activities: { 'activity-1': { id: 'activity-1', runId: 'run-1', kind: 'computer', title: 'Inspect Preview', status: 'completed', attempt: 1, startedAt: 12, updatedAt: 13, completedAt: 13, result: 'Verified' } },
        startedAt: 10, updatedAt: 30, completedAt: 30, outcome: 'Done',
      }],
    }
    value.canonicalEvents = [
      { schemaVersion: 1, eventId: 'legacy-run-start', conversationId: value.id, threadId: value.id, runId: 'run-1', seq: 1, at: 10, source: 'workbench', provenance: 'live', type: 'run.started', payload: { objective: 'Finish migration' } },
      { schemaVersion: 1, eventId: 'legacy-approval', conversationId: value.id, threadId: value.id, runId: 'run-1', seq: 2, at: 15, source: 'agent', provenance: 'live', type: 'approval.requested', payload: { requestId: 'approval-1', kind: 'permission', question: 'Write report?' } },
      { schemaVersion: 1, eventId: 'legacy-approval-done', conversationId: value.id, threadId: value.id, runId: 'run-1', seq: 3, at: 16, source: 'agent', provenance: 'live', type: 'approval.resolved', payload: { requestId: 'approval-1', decision: 'allow-once' } },
      { schemaVersion: 1, eventId: 'legacy-run-done', conversationId: value.id, threadId: value.id, runId: 'run-1', seq: 4, at: 30, source: 'workbench', provenance: 'live', type: 'run.completed', payload: { outcome: 'completed' } },
    ]
    value.recovery = { interrupted: true, truncatedJournal: false, unresolvedToolCalls: 0 }

    const plan = planConversationV2Migration('profile-1', value)
    const projection = projectConversationEvents(plan.events.map((event, index) => ({ ...event, schemaVersion: 2, seq: index + 1, eventId: event.eventId!, at: event.at! })) as never)
    expect(plan.counts).toMatchObject({ runs: 1, approvals: 2, contextCompactions: 1, plans: 1, artifacts: 1, recoveries: 1, canonicalEvents: 4 })
    expect(plan.warnings).toEqual([])
    const ids = conversationV2IdFactory(value.id)
    expect(projection.runs).toEqual([expect.objectContaining({ id: ids.normalize('run', 'run-1'), status: 'completed', outcome: 'Done' })])
    expect(projection.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'reasoning' }),
      expect.objectContaining({ kind: 'browser_activity' }),
      expect.objectContaining({ kind: 'computer_activity' }),
      expect.objectContaining({ kind: 'file_change' }),
      expect.objectContaining({ kind: 'plan' }),
      expect.objectContaining({ kind: 'approval', status: 'completed' }),
      expect.objectContaining({ kind: 'approval', status: 'cancelled' }),
      expect.objectContaining({ kind: 'context_compaction', payload: expect.objectContaining({ summary: 'Portable summary' }) }),
      expect.objectContaining({ kind: 'recovery' }),
    ]))
    expect(projection.artifacts).toEqual([expect.objectContaining({ artifactId: ids.normalize('artifact', 'artifact-1'), status: 'available' })])
    expect(plan.events.some(event => event.legacyEventId === 'legacy-run-start')).toBe(true)
  })
})
