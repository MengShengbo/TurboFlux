import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { ConversationEventStoreV2 } from './conversationEventStoreV2'
import { projectConversationEvents } from './conversationProjections'
import type { AnyAppendConversationEventV2Input, ConversationRecordV2 } from './conversationV2Types'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'turboflux-conversation-v2-'))
  roots.push(value)
  return value
}

function record(): ConversationRecordV2 {
  return {
    schemaVersion: 2,
    id: 'conversation-1',
    profileId: 'profile-1',
    workspaceId: 'workspace-1',
    title: 'Portable work',
    titleSource: 'custom',
    mode: 'vibe',
    provider: 'openai',
    model: 'gpt-test',
    status: 'idle',
    createdAt: 10,
    updatedAt: 10,
    lastEventSeq: 0,
    turnCount: 0,
    runCount: 0,
    tags: [],
  }
}

function createdEvent(eventId = 'event-1'): AnyAppendConversationEventV2Input {
  return {
    eventId,
    profileId: 'profile-1',
    conversationId: 'conversation-1',
    workspaceId: 'workspace-1',
    source: 'user',
    provenance: 'live',
    type: 'conversation.created',
    payload: { record: record() },
  }
}

describe('ConversationEventStoreV2', () => {
  it('recovers open execution timing without counting downtime or mutating persisted events', () => {
    const store = new ConversationEventStoreV2(root(), () => 300_000)
    const common = { profileId: 'profile-1', conversationId: 'conversation-1', workspaceId: 'workspace-1', source: 'runtime' as const, provenance: 'live' as const, runId: 'run-1' }
    store.append([
      createdEvent(),
      { ...common, eventId: 'run-start', type: 'run.started', payload: { run: { id: 'run-1', conversationId: 'conversation-1', workspaceId: 'workspace-1', objective: 'Inspect', status: 'running', startedAt: 1_000, updatedAt: 1_000 } } },
      { ...common, eventId: 'run-timing', type: 'run.state_changed', payload: { status: 'running', updatedAt: 105_000, responseMode: 'task', executionSegments: [
        { startedAt: 1_000, endedAt: 8_000, outcome: 'paused' }, { startedAt: 100_000 },
      ] } },
      { ...common, eventId: 'run-recover', type: 'run.recovered', payload: { recoveredAt: 300_000, reason: 'Restart' } },
    ])
    const events = store.read('conversation-1', 0, 100).events
    const projection = projectConversationEvents(events)
    expect(projection.runs[0].executionSegments).toEqual([
      { startedAt: 1_000, endedAt: 8_000, outcome: 'paused' }, { startedAt: 100_000, endedAt: 105_000, outcome: 'interrupted' },
    ])
    const timingEvent = events.find(event => event.type === 'run.state_changed')
    expect(timingEvent?.type === 'run.state_changed' && timingEvent.payload.executionSegments?.[1]).toEqual({ startedAt: 100_000 })
  })

  it('persists a strict sequence across store instances and paginates history', () => {
    const directory = root()
    const first = new ConversationEventStoreV2(directory, () => 100, () => 'generated-1')
    expect(first.append([createdEvent()])).toMatchObject({ firstSeq: 1, lastSeq: 1, appended: 1 })

    const second = new ConversationEventStoreV2(directory, () => 200, () => 'event-2')
    second.append([{
      profileId: 'profile-1',
      conversationId: 'conversation-1',
      source: 'user',
      provenance: 'live',
      type: 'conversation.renamed',
      payload: { title: 'Renamed', titleSource: 'custom' },
    }])

    expect(second.read('conversation-1', 0, 1)).toMatchObject({ nextSeq: 1 })
    expect(second.read('conversation-1', 1, 5).events.map(event => event.seq)).toEqual([2])
  })

  it('reads a first page without loading the complete journal', () => {
    const directory = root()
    const writer = new ConversationEventStoreV2(directory, () => 100, () => 'generated')
    writer.append([
      createdEvent(),
      ...Array.from({ length: 800 }, (_, index): AnyAppendConversationEventV2Input => ({
        eventId: `event-page-${index}`,
        profileId: 'profile-1',
        conversationId: 'conversation-1',
        source: 'user',
        provenance: 'live',
        type: 'conversation.renamed',
        payload: { title: `Renamed ${index}`, titleSource: 'custom' },
      })),
    ])
    let bytesRead = 0
    const reader = new ConversationEventStoreV2(directory, Date.now, undefined, {
      onPageRead: bytes => { bytesRead += bytes },
    })
    const page = reader.read('conversation-1', 0, 50)
    expect(page.events).toHaveLength(50)
    expect(page.nextSeq).toBe(50)
    expect(bytesRead).toBeLessThan(statSync(join(directory, 'conversation-1.jsonl')).size)
  })

  it('deduplicates event ids without creating sequence gaps', () => {
    const store = new ConversationEventStoreV2(root(), () => 100, () => 'generated')
    store.append([createdEvent()])
    const receipt = store.append([createdEvent(), {
      eventId: 'event-2',
      profileId: 'profile-1',
      conversationId: 'conversation-1',
      source: 'user',
      provenance: 'live',
      type: 'conversation.renamed',
      payload: { title: 'Renamed', titleSource: 'custom' },
    }])
    expect(receipt).toMatchObject({ appended: 1, lastSeq: 2, duplicateEventIds: ['event-1'] })
    expect(store.readAll('conversation-1').map(event => event.seq)).toEqual([1, 2])
  })

  it('rejects profile identity drift within one conversation journal', () => {
    const store = new ConversationEventStoreV2(root(), () => 100, () => 'generated')
    store.append([createdEvent()])

    expect(() => store.append([{
      eventId: 'event-foreign-profile',
      profileId: 'profile-2',
      conversationId: 'conversation-1',
      source: 'user',
      provenance: 'live',
      type: 'conversation.renamed',
      payload: { title: 'Must not cross profiles', titleSource: 'custom' },
    }])).toThrow('profile identity does not match')
    expect(store.readAll('conversation-1').map(event => event.eventId)).toEqual(['event-1'])
  })

  it('rejects mixed profile identities before creating a journal', () => {
    const directory = root()
    const store = new ConversationEventStoreV2(directory, () => 100, () => 'generated')

    expect(() => store.append([createdEvent(), {
      eventId: 'event-foreign-profile',
      profileId: 'profile-2',
      conversationId: 'conversation-1',
      source: 'user',
      provenance: 'live',
      type: 'conversation.renamed',
      payload: { title: 'Must not cross profiles', titleSource: 'custom' },
    }])).toThrow('cannot span profiles')
    expect(existsSync(join(directory, 'conversation-1.jsonl'))).toBe(false)
  })

  it('repairs a corrupt tail while preserving a forensic copy', () => {
    const directory = root()
    const store = new ConversationEventStoreV2(directory, () => 123, () => 'repair-id')
    store.append([createdEvent()])
    const journal = join(directory, 'conversation-1.jsonl')
    writeFileSync(journal, `${readFileSync(journal, 'utf8')}{"schemaVersion":2`, 'utf8')
    expect(() => store.read('conversation-1')).toThrow(/requires recovery/)
    expect(() => store.readAll('conversation-1')).toThrow(/requires recovery/)
    const recovery = store.recover('conversation-1')
    expect(recovery).toMatchObject({ repaired: true, throughSeq: 1 })
    expect(readFileSync(recovery.corruptCopyPath!, 'utf8')).toContain('{"schemaVersion":2')
    expect(store.readAll('conversation-1')).toHaveLength(1)
  })

  it('rejects unknown persisted event and item kinds before writing', () => {
    const directory = root()
    const store = new ConversationEventStoreV2(directory)
    expect(() => store.append([{ ...createdEvent(), type: 'future.event' } as never])).toThrow('Invalid Conversation V2 event')
    expect(() => store.append([{
      eventId: 'event-unknown-item', profileId: 'profile-1', conversationId: 'conversation-1', source: 'migration', provenance: 'migrated', type: 'item.created',
      payload: { item: { schemaVersion: 1, id: 'item-1', conversationId: 'conversation-1', kind: 'future_item', payload: {} } },
    } as never])).toThrow('Invalid Conversation V2 item')
    expect(existsSync(join(directory, 'conversation-1.jsonl'))).toBe(false)
  })

  it.each([
    ['source', { ...createdEvent(), source: 'network' }],
    ['provenance', { ...createdEvent(), provenance: 'guessed' }],
    ['agent mode', { ...createdEvent(), payload: { record: { ...record(), mode: 'automatic' } } }],
    ['renamed payload', { eventId: 'event-invalid-rename', profileId: 'profile-1', conversationId: 'conversation-1', source: 'user', provenance: 'live', type: 'conversation.renamed', payload: { title: 42, titleSource: 'custom' } }],
    ['configuration payload', { eventId: 'event-invalid-configuration', profileId: 'profile-1', conversationId: 'conversation-1', source: 'runtime', provenance: 'live', type: 'conversation.configuration_changed', payload: { mode: 'automatic', provider: 'openai', model: 'gpt-test' } }],
    ['rewrite payload', { eventId: 'event-invalid-rewrite', profileId: 'profile-1', conversationId: 'conversation-1', source: 'runtime', provenance: 'live', type: 'conversation.rewritten', payload: { retainedTurnIds: 'turn-1', rewrittenAt: 20 } }],
    ['completed run status', { eventId: 'event-invalid-run', profileId: 'profile-1', conversationId: 'conversation-1', runId: 'run-1', source: 'agent', provenance: 'live', type: 'run.completed', payload: { status: 'running', completedAt: 20 } }],
    ['message payload', { eventId: 'event-invalid-item', profileId: 'profile-1', conversationId: 'conversation-1', itemId: 'item-1', source: 'user', provenance: 'live', type: 'item.created', payload: { item: { schemaVersion: 1, id: 'item-1', conversationId: 'conversation-1', kind: 'user_message', status: 'completed', createdAt: 20, updatedAt: 20, payload: { text: 'Hello', attachmentIds: 'not-an-array' } } } }],
    ['approval policy', { eventId: 'event-invalid-approval', profileId: 'profile-1', conversationId: 'conversation-1', itemId: 'item-approval', source: 'agent', provenance: 'live', type: 'item.created', payload: { item: { schemaVersion: 1, id: 'item-approval', conversationId: 'conversation-1', kind: 'approval', status: 'pending', createdAt: 20, updatedAt: 20, payload: { requestId: 'request-1', requestKind: 'permission', question: 'Allow?', policy: 'always' } } } }],
    ['workspace state', { eventId: 'event-invalid-workspace', profileId: 'profile-1', conversationId: 'conversation-1', workspaceId: 'workspace-1', source: 'runtime', provenance: 'live', type: 'workspace.binding_changed', payload: { workspaceId: 'workspace-1', state: 'trusted', at: 20 } }],
    ['negative recovery sequence', { eventId: 'event-invalid-recovery', profileId: 'profile-1', conversationId: 'conversation-1', source: 'recovery', provenance: 'restored', type: 'recovery.applied', payload: { reason: 'repair', throughSeq: -1 } }],
    ['non-empty restored payload', { eventId: 'event-invalid-restore', profileId: 'profile-1', conversationId: 'conversation-1', source: 'user', provenance: 'live', type: 'conversation.restored', payload: { unexpected: true } }],
  ])('rejects invalid %s discriminated event data', (_label, event) => {
    expect(() => new ConversationEventStoreV2(root()).append([event as never])).toThrow('Invalid Conversation V2')
  })

  it('recovers a duplicated persisted event identity instead of projecting it twice', () => {
    const directory = root()
    const store = new ConversationEventStoreV2(directory, () => 100, () => 'generated')
    store.append([createdEvent()])
    const journal = join(directory, 'conversation-1.jsonl')
    const first = JSON.parse(readFileSync(journal, 'utf8')) as Record<string, unknown>
    const duplicate = { ...first, seq: 2, at: 200, type: 'conversation.renamed', payload: { title: 'Duplicate', titleSource: 'custom' } }
    writeFileSync(journal, `${JSON.stringify(first)}\n${JSON.stringify(duplicate)}\n`)

    expect(() => store.readAll('conversation-1')).toThrow('requires recovery')
    expect(store.recover('conversation-1')).toMatchObject({ repaired: true, throughSeq: 1 })
    expect(store.readAll('conversation-1').map(event => event.eventId)).toEqual(['event-1'])
  })

  it('rejects entity identities that disagree with their event envelopes', () => {
    const directory = root()
    const store = new ConversationEventStoreV2(directory)
    expect(() => store.append([{
      ...createdEvent('event-record-mismatch'),
      payload: { record: { ...record(), id: 'conversation-other' } },
    }])).toThrow('Conversation V2 record identity does not match its event envelope')
    expect(() => store.append([{
      eventId: 'event-run-mismatch', profileId: 'profile-1', conversationId: 'conversation-1', workspaceId: 'workspace-1', runId: 'run-envelope', source: 'agent', provenance: 'live', type: 'run.started',
      payload: { run: { id: 'run-payload', conversationId: 'conversation-1', workspaceId: 'workspace-1', objective: 'Mismatch', status: 'running', startedAt: 20, updatedAt: 20 } },
    }])).toThrow('Conversation V2 run identity does not match its event envelope')
    expect(() => store.append([{
      eventId: 'event-turn-mismatch', profileId: 'profile-1', conversationId: 'conversation-1', runId: 'run-1', turnId: 'turn-envelope', source: 'user', provenance: 'live', type: 'turn.started',
      payload: { turn: { id: 'turn-payload', conversationId: 'conversation-1', runId: 'run-1', role: 'user', status: 'started', createdAt: 30 } },
    }])).toThrow('Conversation V2 turn identity does not match its event envelope')
    expect(() => store.append([{
      eventId: 'event-item-mismatch', profileId: 'profile-1', conversationId: 'conversation-1', runId: 'run-envelope', turnId: 'turn-1', itemId: 'item-1', source: 'user', provenance: 'live', type: 'item.created',
      payload: { item: { schemaVersion: 1, id: 'item-1', conversationId: 'conversation-1', runId: 'run-payload', turnId: 'turn-1', kind: 'user_message', status: 'completed', createdAt: 30, updatedAt: 30, payload: { text: 'Mismatch', attachmentIds: [] } } },
    }])).toThrow('Conversation V2 item identity does not match its event envelope')
    expect(existsSync(join(directory, 'conversation-1.jsonl'))).toBe(false)
  })

  it('rebuilds transcript and run projections from events only', () => {
    const store = new ConversationEventStoreV2(root(), () => 100, (() => {
      let id = 0
      return () => `generated-${++id}`
    })())
    store.append([
      createdEvent(),
      {
        profileId: 'profile-1', conversationId: 'conversation-1', source: 'agent', provenance: 'live', type: 'run.started', runId: 'run-1',
        payload: { run: { id: 'run-1', conversationId: 'conversation-1', workspaceId: 'workspace-1', objective: 'Ship it', status: 'running', startedAt: 20, updatedAt: 20 } },
      },
      {
        profileId: 'profile-1', conversationId: 'conversation-1', source: 'user', provenance: 'live', type: 'turn.started', runId: 'run-1', turnId: 'turn-1',
        payload: { turn: { id: 'turn-1', conversationId: 'conversation-1', runId: 'run-1', role: 'user', status: 'started', createdAt: 30 } },
      },
      {
        profileId: 'profile-1', conversationId: 'conversation-1', source: 'user', provenance: 'live', type: 'item.created', runId: 'run-1', turnId: 'turn-1', itemId: 'item-1',
        payload: { item: { schemaVersion: 1, id: 'item-1', conversationId: 'conversation-1', runId: 'run-1', turnId: 'turn-1', kind: 'user_message', status: 'completed', createdAt: 30, updatedAt: 30, payload: { text: 'Hello', attachmentIds: [] } } },
      },
      {
        profileId: 'profile-1', conversationId: 'conversation-1', source: 'agent', provenance: 'live', type: 'run.completed', runId: 'run-1',
        payload: { status: 'completed', completedAt: 40, outcome: 'Done' },
      },
    ])
    const projection = projectConversationEvents(store.readAll('conversation-1'))
    expect(projection.conversation).toMatchObject({ lastEventSeq: 5, turnCount: 1, runCount: 1 })
    expect(projection.runs[0]).toMatchObject({ status: 'completed', outcome: 'Done' })
    expect(projection.items[0]).toMatchObject({ kind: 'user_message', payload: { text: 'Hello' } })
  })

  it('serializes concurrent writers across processes without sequence gaps', async () => {
    const directory = root()
    const moduleUrl = pathToFileURL(resolve('packages/agent-core/src/application/conversations/conversationEventStoreV2.ts')).href
    const executable = resolve('node_modules/.bin/tsx')
    const runWriter = (prefix: string) => new Promise<void>((resolveWriter, rejectWriter) => {
      const source = `import { ConversationEventStoreV2 } from ${JSON.stringify(moduleUrl)}; const store = new ConversationEventStoreV2(${JSON.stringify(directory)}); for (let index = 0; index < 20; index += 1) store.append([{ eventId: ${JSON.stringify(prefix)} + '-' + index, profileId: 'profile-1', conversationId: 'conversation-concurrent', source: 'runtime', provenance: 'live', type: 'conversation.renamed', payload: { title: ${JSON.stringify(prefix)} + '-' + index, titleSource: 'custom' } }]);`
      const child = spawn(executable, ['-e', source], { stdio: 'pipe' })
      let error = ''
      child.stderr.on('data', chunk => { error += String(chunk) })
      child.on('error', rejectWriter)
      child.on('exit', code => code === 0 ? resolveWriter() : rejectWriter(new Error(error || `writer exited ${code}`)))
    })
    await Promise.all([runWriter('writer-a'), runWriter('writer-b')])
    const events = new ConversationEventStoreV2(directory).readAll('conversation-concurrent')
    expect(events).toHaveLength(40)
    expect(events.map(event => event.seq)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1))
    expect(new Set(events.map(event => event.eventId)).size).toBe(40)
  }, 20_000)
})
