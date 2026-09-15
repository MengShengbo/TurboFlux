import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationRuntimeRepositoryV2 } from './conversationRuntimeRepositoryV2'
import { ConversationRepositoryV2 } from './conversationRepositoryV2'
import { ConversationEventStoreV2 } from './conversationEventStoreV2'
import { conversationV2IdFactory, isConversationV2Uuid } from './conversationV2Ids'
import type { PersistedConversation } from './types'
import type { AnyConversationEvent } from '../events/conversationEvent'
import { WorkSession } from '../work/workSession'
import type { ToolResult } from '../../shared/agentTypes'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'turboflux-runtime-v2-'))
  roots.push(directory)
  return directory
}

function conversation(): PersistedConversation {
  return {
    id: 'conversation-1', title: 'Portable task', titleSource: 'custom', workspacePath: '/source/project', createdAt: 10, updatedAt: 30,
    mode: 'vibe', model: 'test-model', provider: 'custom', turnCount: 2,
    turns: [
      { id: 'turn-user', role: 'user', content: 'Inspect /source/project/src/app.ts', timestamp: 10 },
      {
        id: 'turn-assistant', role: 'assistant', content: 'Done', timestamp: 20,
        toolCalls: [{ id: 'tool-1', name: 'read_file', arguments: { path: '/source/project/src/app.ts' } }],
        toolResults: [{ toolCallId: 'tool-1', name: 'read_file', output: 'contents', isError: false }],
      },
    ],
  }
}

describe('ConversationRuntimeRepositoryV2', () => {
  it.each(['history', 'live'] as const)('preserves task mode and multiple stop records through %s persistence', source => {
    const directory = root()
    const runtime = new ConversationRuntimeRepositoryV2(directory, 'profile-1', 'workspace-12345678', '/source/project', () => 300_000)
    const value = conversation()
    value.workExecution = {
      schemaVersion: 1, currentRunId: null, runs: [{
        id: 'run-1', conversationId: value.id, objective: 'Inspect', responseMode: 'task', presentation: 'work',
        status: 'completed', phase: 'completed', rootStepIds: [], steps: {}, activities: {}, startedAt: 1_000, updatedAt: 248_000, completedAt: 248_000,
        executionSegments: [
          { startedAt: 1_000, endedAt: 8_000, outcome: 'paused' },
          { startedAt: 100_000, endedAt: 105_000, outcome: 'paused' },
          { startedAt: 200_000, endedAt: 248_000, outcome: 'completed' },
        ],
      }],
    }
    if (source === 'history') runtime.persist(value)
    else {
      const base = { schemaVersion: 1 as const, conversationId: value.id, threadId: value.id, source: 'workbench' as const, provenance: 'live' as const, runId: 'run-1' }
      runtime.appendCanonical({ ...base, seq: 1, eventId: 'start', at: 1_000, type: 'run.started', payload: { objective: 'Inspect' } }, value)
      runtime.appendCanonical({ ...base, seq: 2, eventId: 'timing', at: 248_000, type: 'runtime.event', payload: { kind: 'work:execution', payload: { snapshot: value.workExecution } } }, value)
    }
    const reopened = new ConversationRuntimeRepositoryV2(directory, 'profile-1', 'workspace-12345678', '/source/project', () => 900_000)
    const restored = reopened.load(value.id)?.workExecution?.runs.find(run => run.responseMode === 'task')
    expect(restored).toMatchObject({ presentation: 'work', responseMode: 'task', status: 'completed', executionSegments: value.workExecution.runs[0].executionSegments })
  })

  it.each(['history', 'live'] as const)('preserves retrieval evidence through %s persistence and canonical replay', source => {
    const directory = root()
    const runtime = new ConversationRuntimeRepositoryV2(directory, 'profile-1', 'workspace-12345678', '/source/project', () => 100)
    const value = conversation()
    const toolResult = value.turns[1]!.toolResults![0]!
    toolResult.retrieval = {
      operation: 'read_file', scope: 'src/app.ts', totalIsExact: false, truncated: true, nextOffset: 15,
      resources: [{ path: 'src/app.ts', kind: 'file', state: 'read', line: 10, endLine: 14, preview: 'export function run() {}', textTruncated: true }],
    }
    if (source === 'history') runtime.persist(value)
    else {
      let seq = 0
      const events = [
        { type: 'run.started', payload: { objective: 'Inspect source' } },
        { type: 'turn.started', payload: { turn: value.turns[1] } },
        { type: 'tool.proposed', payload: { toolCall: value.turns[1]!.toolCalls![0] } },
        { type: 'tool.completed', payload: { toolResult } },
      ]
      for (const event of events) runtime.appendCanonical({
        schemaVersion: 1, eventId: `e-${++seq}`, conversationId: value.id, threadId: value.id, seq, at: 100 + seq,
        source: 'workbench', provenance: 'live', runId: 'run-1', turnId: 'turn-assistant', ...event,
      } as AnyConversationEvent, value)
    }
    const reopened = new ConversationRuntimeRepositoryV2(directory, 'profile-1', 'workspace-12345678', '/source/project', () => 200)
    const loaded = reopened.load(value.id)
    const restored = loaded?.turns.flatMap(turn => turn.toolResults || []).find(result => result.name === 'read_file')
    expect(restored?.retrieval).toEqual(toolResult.retrieval)
    const completed = loaded?.canonicalEvents?.find(event => event.type === 'tool.completed')
    expect(completed?.type === 'tool.completed' && completed.payload.toolResult.retrieval).toEqual(toolResult.retrieval)
  })

  it.each(['history', 'live'] as const)('restores command records, sources, and full diffs after %s persistence', source => {
    const directory = root()
    const runtime = new ConversationRuntimeRepositoryV2(directory, 'profile-1', 'workspace-12345678', '/source/project', () => 100)
    const value = conversation()
    const results: ToolResult[] = [
      { toolCallId: 'command', name: 'run_command', output: 'Process exited with code 2', isError: true, errorKind: 'execution',
        data: { kind: 'command', command: 'npm test', cwd: '/source/project', stdout: '1 failed', stderr: 'Assertion failed', exitCode: 2, status: 'failed' } },
      { toolCallId: 'edit', name: 'edit_file', output: 'File updated', isError: false,
        changeSummary: { path: 'src/app.ts', operation: 'edit', before: 'return false', after: 'return true', diffStatus: 'complete' } },
      { toolCallId: 'search', name: 'web_search', output: 'One source', isError: false,
        data: { kind: 'web_search', response: { query: 'reference', queries: ['reference'], provider: 'fixture', retrievedAt: '2026-09-15T00:00:00Z', partial: false, providers: [], warnings: [],
          results: [{ title: 'Reference', url: 'https://example.com/reference', snippet: 'Saved source excerpt' }] } } },
    ]
    const turn = value.turns[1]!
    turn.toolCalls = results.map(result => ({ id: result.toolCallId, name: result.name, arguments: {} }))
    turn.toolResults = results
    if (source === 'history') runtime.persist(value)
    else {
      let seq = 0
      const append = (event: { type: string; payload: unknown }) => runtime.appendCanonical({
        schemaVersion: 1, eventId: `record-${++seq}`, conversationId: value.id, threadId: value.id, seq, at: 100 + seq,
        source: 'workbench', provenance: 'live', runId: 'run-1', turnId: turn.id, ...event,
      } as AnyConversationEvent, value)
      append({ type: 'run.started', payload: { objective: 'Inspect source' } })
      append({ type: 'turn.started', payload: { turn } })
      for (const [index, result] of results.entries()) {
        append({ type: 'tool.proposed', payload: { toolCall: turn.toolCalls[index] } })
        append({ type: 'tool.completed', payload: { toolResult: result } })
      }
    }
    const loaded = new ConversationRuntimeRepositoryV2(directory, 'profile-1', 'workspace-12345678', '/source/project', () => 200).load(value.id)
    for (const expected of results) {
      const restored = loaded?.turns.flatMap(turn => turn.toolResults || []).find(result => result.name === expected.name)
      const event = loaded?.canonicalEvents?.find(event => event.type === 'tool.completed' && event.payload.toolResult.name === expected.name)
      for (const actual of [restored, event?.type === 'tool.completed' ? event.payload.toolResult : undefined]) {
        expect(actual?.data).toEqual(expected.data)
        expect(actual?.changeSummary).toEqual(expected.changeSummary)
        expect(actual?.errorKind).toEqual(expected.errorKind)
      }
    }
  })

  it('persists typed live Run, Approval, Context and Subagent facts', () => {
    const directory = root()
    const runtime = new ConversationRuntimeRepositoryV2(directory, 'profile-1', 'workspace-12345678', '/source/project', () => 100)
    const value = conversation()
    value.contextSegments = [{
      startMessageId: 'message-turn-user',
      endMessageId: 'message-turn-assistant',
      summary: 'The portable task was inspected and verified.',
      isModelGenerated: true,
      originalCharCount: 120,
      isValid: true,
    }]
    let seq = 0
    const event = <Type extends AnyConversationEvent['type']>(type: Type, payload: Extract<AnyConversationEvent, { type: Type }>['payload'], coordinates: Partial<AnyConversationEvent> = {}) => ({
      schemaVersion: 1 as const,
      eventId: `canonical-${++seq}`,
      conversationId: value.id,
      threadId: value.id,
      seq,
      at: 100 + seq,
      source: 'workbench' as const,
      provenance: 'live' as const,
      type,
      payload,
      ...coordinates,
    }) as AnyConversationEvent

    runtime.appendCanonical(event('run.started', { objective: 'Ship it' }, { runId: 'run-1' }), value)
    runtime.appendCanonical(event('turn.started', { turn: value.turns[0]! }, { runId: 'run-1', turnId: 'turn-user' }), value)
    runtime.appendCanonical(event('approval.requested', { requestId: 'approval-1', kind: 'permission', question: 'Allow write?' }, { runId: 'run-1', itemId: 'approval-1' }), value)
    runtime.appendCanonical(event('approval.resolved', { requestId: 'approval-1', decision: 'allow-once' }, { runId: 'run-1', itemId: 'approval-1' }), value)
    runtime.appendCanonical(event('context.compaction', { state: { id: 'compact-1', phase: 'started', source: 'compact', startedAt: 105, updatedAt: 105, elapsedMs: 0, startMessageId: 'message-turn-user', endMessageId: 'message-turn-assistant', recoverable: true } }, { runId: 'run-1' }), value)
    runtime.appendCanonical(event('context.compaction', { state: { id: 'compact-1', phase: 'completed', source: 'compact', startedAt: 105, updatedAt: 106, elapsedMs: 1, recoverable: false } }, { runId: 'run-1' }), value)
    runtime.appendCanonical(event('tool.proposed', { toolCall: { id: 'browser-1', name: 'browser__navigate', arguments: { url: 'https://example.com' } } }, { runId: 'run-1', turnId: 'turn-assistant' }), value)
    runtime.appendCanonical(event('tool.completed', { toolResult: { toolCallId: 'browser-1', name: 'browser__navigate', output: 'Example Domain', isError: false } }, { runId: 'run-1', turnId: 'turn-assistant' }), value)
    runtime.appendCanonical(event('tool.proposed', { toolCall: { id: 'computer-1', name: 'computer__open_app', arguments: { application: 'Preview' } } }, { runId: 'run-1', turnId: 'turn-assistant' }), value)
    runtime.appendCanonical(event('tool.completed', { toolResult: { toolCallId: 'computer-1', name: 'computer__open_app', output: 'Opened', isError: false } }, { runId: 'run-1', turnId: 'turn-assistant' }), value)
    runtime.appendCanonical(event('tool.proposed', { toolCall: { id: 'write-1', name: 'write_file', arguments: { path: '/source/project/report.md' } } }, { runId: 'run-1', turnId: 'turn-assistant' }), value)
    runtime.appendCanonical(event('tool.completed', { toolResult: {
      toolCallId: 'write-1', name: 'write_file', output: 'saved', isError: false,
      changeSummary: { path: '/source/project/report.md', operation: 'write' },
      attachments: [{ id: 'artifact-1', type: 'file', path: '/source/project/report.md', mime: 'text/markdown', filename: 'report.md', size: 42 }],
    } }, { runId: 'run-1', turnId: 'turn-assistant' }), value)
    runtime.appendCanonical(event('runtime.event', { kind: 'work:execution', payload: {
      type: 'work:execution',
      snapshot: {
        schemaVersion: 1,
        currentRunId: 'run-1',
        runs: [{
          id: 'run-1', conversationId: value.id, objective: 'Ship it', presentation: 'work', status: 'running', phase: 'execute', rootStepIds: ['step-1'],
          steps: { 'step-1': { id: 'step-1', title: 'Verify output', status: 'running' } },
          activities: { 'activity-1': { id: 'activity-1', runId: 'run-1', kind: 'browser', title: 'Inspect result', status: 'completed', startedAt: 110, updatedAt: 111, result: 'Verified' } },
          startedAt: 100, updatedAt: 111,
        }],
      },
    } }, { runId: 'run-1' }), value)
    runtime.appendCanonical(event('runtime.event', { kind: 'subagent:start', payload: { agentId: 'agent-1', objective: 'Inspect tests' } }, { runId: 'run-1' }), value)
    runtime.appendCanonical(event('runtime.event', { kind: 'subagent:end', payload: { agentId: 'agent-1', ok: true } }, { runId: 'run-1' }), value)
    runtime.appendCanonical(event('run.completed', { outcome: 'completed' }, { runId: 'run-1' }), value)

    const projection = new ConversationRepositoryV2(directory).projection(value.id)
    const ids = conversationV2IdFactory(value.id)
    const runId = ids.normalize('run', 'run-1')
    const artifactId = ids.normalize('artifact', 'artifact-1')
    const artifactItemId = ids.scoped('artifact', 'artifact-1')
    expect(projection.runs).toEqual([expect.objectContaining({ id: runId, objective: 'Ship it', status: 'completed' })])
    expect(projection.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'user_message', runId }),
      expect.objectContaining({ kind: 'approval', status: 'completed', payload: expect.objectContaining({ decision: 'allow-once' }) }),
      expect.objectContaining({ kind: 'context_compaction', status: 'completed', payload: expect.objectContaining({ summary: 'The portable task was inspected and verified.' }) }),
      expect.objectContaining({ kind: 'browser_activity', status: 'completed', payload: expect.objectContaining({ action: 'navigate', url: 'https://example.com' }) }),
      expect.objectContaining({ kind: 'computer_activity', status: 'completed', payload: expect.objectContaining({ action: 'open_app', application: 'Preview' }) }),
      expect.objectContaining({ kind: 'file_change', status: 'completed', payload: expect.objectContaining({ change: 'created' }) }),
      expect.objectContaining({ kind: 'artifact', status: 'completed', payload: expect.objectContaining({ artifactId, name: 'report.md' }) }),
      expect.objectContaining({ kind: 'plan', status: 'running', payload: { steps: [{ id: ids.normalize('step', 'step-1'), title: 'Verify output', status: 'running' }] } }),
      expect.objectContaining({ kind: 'subagent', status: 'completed' }),
    ]))
    expect(projection.artifacts).toEqual([{ artifactId, itemIds: [artifactItemId], status: 'available', updatedAt: expect.any(Number) }])
    expect(projection.timeline.length).toBeGreaterThan(projection.items.length)
    expect(projection.conversation?.status).toBe('idle')
  })

  it('persists live history idempotently and rebuilds runtime turns', () => {
    const repository = new ConversationRuntimeRepositoryV2(root(), 'profile-1', 'workspace-12345678', '/source/project', () => 100)
    repository.persist(conversation())
    repository.persist(conversation())

    expect(repository.list()).toEqual([expect.objectContaining({ id: 'conversation-1', title: 'Portable task', turnCount: 2 })])
    const loaded = repository.load('conversation-1')
    expect(loaded).toMatchObject({
      workspacePath: '/source/project',
      turns: [
        { id: 'turn-user', role: 'user', content: 'Inspect /source/project/src/app.ts' },
        { id: 'turn-assistant', role: 'assistant', content: 'Done', toolCalls: [{ id: 'tool-1' }], toolResults: [{ toolCallId: 'tool-1' }] },
      ],
    })
    expect(loaded?.canonicalEvents?.map(event => event.type)).toEqual(expect.arrayContaining([
      'turn.started',
      'stream.committed',
      'tool.proposed',
      'tool.completed',
      'turn.completed',
    ]))
    const restored = new WorkSession('conversation-1')
    restored.replaceFromEvents(loaded?.canonicalEvents ?? [], loaded?.turns ?? [])
    expect(restored.getSnapshot().projection.order.map(key => restored.getSnapshot().projection.nodes[key]?.kind))
      .toEqual(expect.arrayContaining(['input', 'answer', 'tool']))
  })

  it('restores execution history and the real failed-run error without writing recovery duplicates', () => {
    const directory = root()
    const runtime = new ConversationRuntimeRepositoryV2(directory, 'profile-1', 'workspace-12345678', '/source/project', () => 100)
    const value = conversation()
    let seq = 0
    const event = <Type extends AnyConversationEvent['type']>(type: Type, payload: Extract<AnyConversationEvent, { type: Type }>['payload'], coordinates: Partial<AnyConversationEvent> = {}) => ({
      schemaVersion: 1 as const,
      eventId: `restart-${++seq}`,
      conversationId: value.id,
      threadId: value.id,
      seq,
      at: 100 + seq,
      source: 'workbench' as const,
      provenance: 'live' as const,
      type,
      payload,
      ...coordinates,
    }) as AnyConversationEvent
    const error = '当前模型暂不可用，请切换模型后重试。\n上游返回：Model "gpt-6-astra" is not supported by this account'
    runtime.appendCanonical(event('run.started', { objective: 'Continue task' }, { runId: 'run-1' }), value)
    runtime.appendCanonical(event('turn.started', { turn: { ...value.turns[0]!, metadata: { workRunId: 'run-1' } } }, { runId: 'run-1', turnId: 'turn-user' }), value)
    runtime.appendCanonical(event('stream.committed', { channel: 'thinking', text: 'Checking the workspace' }, { runId: 'run-1', turnId: 'turn-assistant', itemId: 'thinking-1' }), value)
    runtime.appendCanonical(event('tool.proposed', { toolCall: value.turns[1]!.toolCalls![0]! }, { runId: 'run-1', turnId: 'turn-assistant' }), value)
    runtime.appendCanonical(event('tool.completed', { toolResult: value.turns[1]!.toolResults![0]! }, { runId: 'run-1', turnId: 'turn-assistant' }), value)
    runtime.appendCanonical(event('run.completed', { outcome: 'failed', error }, { runId: 'run-1' }), value)

    const beforeLoad = new ConversationEventStoreV2(join(directory, 'events')).readAll(value.id)
    const loaded = runtime.load(value.id)
    const loadedAgain = new ConversationRuntimeRepositoryV2(directory, 'profile-1', 'workspace-12345678', '/source/project', () => 100).load(value.id)
    const afterLoad = new ConversationEventStoreV2(join(directory, 'events')).readAll(value.id)

    expect(loaded?.workExecution).toMatchObject({
      currentRunId: null,
      runs: [{ status: 'failed', error }],
    })
    expect(Object.values(loaded?.workExecution?.runs[0]?.activities ?? {})).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'read_file', status: 'completed', result: 'contents' }),
    ]))
    expect(loaded?.canonicalEvents?.map(item => item.type)).toEqual(expect.arrayContaining([
      'run.started', 'turn.started', 'stream.committed', 'tool.proposed', 'tool.completed', 'run.completed',
    ]))
    expect(loadedAgain?.canonicalEvents).toEqual(loaded?.canonicalEvents)
    expect(afterLoad).toHaveLength(beforeLoad.length)
  })

  it('appends later turns and tool facts without duplicating prior events', () => {
    const directory = root()
    const runtime = new ConversationRuntimeRepositoryV2(directory, 'profile-1', 'workspace-12345678', '/source/project', () => 100)
    const initial = conversation()
    initial.turns = [initial.turns[0]!]
    initial.turnCount = 1
    initial.updatedAt = 10

    runtime.persist(initial)
    const eventStore = new ConversationEventStoreV2(join(directory, 'events'))
    const initialEvents = eventStore.readAll(initial.id)

    const continued = conversation()
    runtime.persist(continued)
    const appendedEvents = eventStore.readAll(continued.id)
    expect(appendedEvents.length).toBeGreaterThan(initialEvents.length)
    expect(appendedEvents.map(event => event.seq)).toEqual(Array.from({ length: appendedEvents.length }, (_, index) => index + 1))

    const rebuilt = new ConversationRuntimeRepositoryV2(directory, 'profile-1', 'workspace-12345678', '/source/project', () => 100)
    expect(rebuilt.load(continued.id)).toMatchObject({
      turns: [
        { id: 'turn-user', role: 'user', content: 'Inspect /source/project/src/app.ts' },
        { id: 'turn-assistant', role: 'assistant', content: 'Done', toolCalls: [{ id: 'tool-1' }], toolResults: [{ toolCallId: 'tool-1', output: 'contents' }] },
      ],
    })
    expect(new ConversationRepositoryV2(directory).search('Done')).toEqual([
      expect.objectContaining({ conversationId: continued.id, kind: 'message' }),
    ])

    runtime.persist(continued)
    expect(eventStore.readAll(continued.id)).toHaveLength(appendedEvents.length)
  })

  it('rewrites retained turns and synchronizes conversation configuration', () => {
    const directory = root()
    const runtime = new ConversationRuntimeRepositoryV2(directory, 'profile-1', 'workspace-12345678', '/source/project', () => 100)
    const value = conversation()
    runtime.persist(value)

    const rewritten: PersistedConversation = {
      ...value,
      updatedAt: 40,
      mode: 'plan',
      provider: 'openai',
      model: 'updated-model',
      turnCount: 1,
      turns: [{ ...value.turns[0]!, content: 'Inspect the revised workspace' }],
    }
    runtime.rewrite(rewritten)

    expect(runtime.load(value.id)).toMatchObject({
      mode: 'plan',
      provider: 'openai',
      model: 'updated-model',
      turns: [{ content: 'Inspect the revised workspace' }],
    })
    const projection = new ConversationRepositoryV2(directory).projection(value.id)
    expect(projection.turns).toHaveLength(1)
    expect(projection.items.filter(item => item.kind === 'assistant_message')).toEqual([])
  })

  it('projects legacy duplicate message events as one logical turn item', () => {
    const directory = root()
    const runtime = new ConversationRuntimeRepositoryV2(directory, 'profile-1', 'workspace-12345678', '/source/project', () => 100)
    const value = conversation()
    runtime.persist(value)
    const repository = new ConversationRepositoryV2(directory)
    const userItem = repository.projection(value.id).items.find(item => item.kind === 'user_message')!
    repository.append([{
      eventId: 'duplicate-user-message-event',
      profileId: 'profile-1',
      conversationId: value.id,
      workspaceId: 'workspace-12345678',
      turnId: userItem.turnId,
      itemId: 'duplicate-user-message-item',
      source: 'runtime',
      provenance: 'live',
      type: 'item.created',
      at: 40,
      payload: { item: { ...userItem, id: 'duplicate-user-message-item', updatedAt: 40 } },
    }])

    expect(repository.projection(value.id).items.filter(item => item.kind === 'user_message')).toHaveLength(1)
  })

  it('normalizes canonical runtime coordinates into stable V2 identifiers', () => {
    const directory = root()
    const runtime = new ConversationRuntimeRepositoryV2(directory, 'profile-1', 'workspace-12345678', '/source/project', () => 100)
    const value = conversation()
    value.id = 'a47ac10b-58cc-4372-a567-0e02b2c3d479'
    let seq = 0
    const canonical = <Type extends AnyConversationEvent['type']>(type: Type, payload: Extract<AnyConversationEvent, { type: Type }>['payload'], coordinates: Partial<AnyConversationEvent> = {}) => ({
      schemaVersion: 1 as const,
      eventId: `canonical:unsafe:${++seq}`,
      conversationId: value.id,
      threadId: value.id,
      seq,
      at: 200 + seq,
      source: 'workbench' as const,
      provenance: 'live' as const,
      type,
      payload,
      ...coordinates,
    }) as AnyConversationEvent

    const unsafeRunId = 'conversation-1:run:1'
    runtime.appendCanonical(canonical('run.started', { objective: 'Continue imported work' }, { runId: unsafeRunId }), value)
    runtime.appendCanonical(canonical('turn.started', {
      turn: { id: 'turn:user:1', role: 'user', content: 'Continue', timestamp: 201 },
    }, { runId: unsafeRunId, turnId: 'turn:user:1' }), value)
    runtime.appendCanonical(canonical('runtime.event', {
      kind: 'task:system',
      payload: { tree: [{ id: 'task:1', title: 'Read workspace', status: 'in_progress', children: [] }] },
    }, { runId: unsafeRunId, itemId: 'run:1:step:1' }), value)
    runtime.appendCanonical(canonical('tool.proposed', {
      toolCall: { id: 'tool:read:1', name: 'read_file', arguments: { path: 'NEXT.md' } },
    }, { runId: unsafeRunId, turnId: 'turn:assistant:1', itemId: 'tool:read:1' }), value)

    const events = new ConversationEventStoreV2(join(directory, 'events')).readAll(value.id)
    const ids = events.flatMap(event => [event.eventId, event.runId, event.turnId, event.itemId]
      .filter((id): id is string => Boolean(id)))
    expect(ids.every(isConversationV2Uuid)).toBe(true)
    const projection = new ConversationRepositoryV2(directory).projection(value.id)
    expect([
      ...projection.runs.map(run => run.id),
      ...projection.turns.map(turn => turn.id),
      ...projection.items.map(item => item.id),
    ].every(isConversationV2Uuid)).toBe(true)
    expect(projection.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'plan', runId: expect.not.stringContaining(':') }),
      expect.objectContaining({ kind: 'tool_call', payload: expect.objectContaining({ toolCallId: expect.not.stringContaining(':') }) }),
    ]))
    const plan = projection.items.find(item => item.kind === 'plan')
    const tool = projection.items.find(item => item.kind === 'tool_call')
    expect(plan?.kind === 'plan' && plan.payload.steps.every(step => isConversationV2Uuid(step.id))).toBe(true)
    expect(tool?.kind === 'tool_call' && isConversationV2Uuid(tool.payload.toolCallId)).toBe(true)
  })

  it('renames and archives through append-only events', () => {
    const repository = new ConversationRuntimeRepositoryV2(root(), 'profile-1', 'workspace-12345678', '/source/project', () => 100)
    repository.persist(conversation())
    expect(repository.rename('conversation-1', 'Renamed', 'custom', 40)).toBe(true)
    expect(repository.load('conversation-1')?.title).toBe('Renamed')
    expect(repository.archive('conversation-1', 50)).toBe(true)
    expect(repository.load('conversation-1')).toBeNull()
    expect(repository.list()).toEqual([])
  })
})
