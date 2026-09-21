import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationRepositoryV2 } from './conversationRepositoryV2'
import type { AnyAppendConversationEventV2Input, ConversationRecordV2 } from './conversationV2Types'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'turboflux-conversation-repository-v2-'))
  roots.push(directory)
  return directory
}

function created(id: string, title: string, at: number, workspaceId = 'workspace-1', profileId = 'profile-1'): AnyAppendConversationEventV2Input {
  const record: ConversationRecordV2 = {
    schemaVersion: 2, id, profileId, workspaceId, title, titleSource: 'custom', mode: 'vibe', provider: 'openai', model: 'test', status: 'idle',
    createdAt: at, updatedAt: at, lastEventSeq: 0, turnCount: 0, runCount: 0, tags: [],
  }
  return { eventId: `event-${id}`, profileId, conversationId: id, workspaceId, source: 'user', provenance: 'live', type: 'conversation.created', at, payload: { record } }
}

describe('ConversationRepositoryV2', () => {
  it('maintains a paged catalog without reading event journals for normal list calls', () => {
    const repository = new ConversationRepositoryV2(root(), () => 100)
    repository.append([created('conversation-1', 'First', 10)])
    repository.append([created('conversation-2', 'Second', 20)])
    const first = repository.list({ limit: 1 })
    expect(first).toMatchObject({ total: 2, conversations: [{ id: 'conversation-2' }] })
    expect(first.nextCursor).toBeTruthy()
    expect(repository.list({ limit: 1, cursor: first.nextCursor! }).conversations[0]?.id).toBe('conversation-1')
  })

  it('keeps catalog pagination stable when newer conversations arrive between pages', () => {
    const repository = new ConversationRepositoryV2(root(), () => 100)
    repository.append([created('conversation-1', 'First', 10)])
    repository.append([created('conversation-2', 'Second', 20)])
    repository.append([created('conversation-3', 'Third', 30)])

    const first = repository.list({ limit: 2 })
    expect(first.conversations.map(conversation => conversation.id)).toEqual(['conversation-3', 'conversation-2'])
    repository.append([created('conversation-4', 'Newest', 40)])

    const second = repository.list({ limit: 2, cursor: first.nextCursor! })
    expect(second.conversations.map(conversation => conversation.id)).toEqual(['conversation-1'])
    expect(second.nextCursor).toBeNull()
  })

  it('does not reuse an opaque catalog cursor with different filters or sorting', () => {
    const repository = new ConversationRepositoryV2(root(), () => 100)
    repository.append([created('conversation-1', 'Alpha first', 10, 'workspace-1')])
    repository.append([created('conversation-2', 'Beta second', 20, 'workspace-2')])
    repository.append([created('conversation-3', 'Alpha third', 30, 'workspace-1')])

    const cursor = repository.list({ limit: 1, query: 'Alpha', sort: 'updated_desc' }).nextCursor!
    expect(repository.list({ limit: 1, cursor, workspaceId: 'workspace-2', sort: 'created_asc' }).conversations).toEqual([
      expect.objectContaining({ id: 'conversation-2' }),
    ])
  })

  it('rebuilds a corrupt snapshot from the event log', () => {
    const directory = root()
    const repository = new ConversationRepositoryV2(directory, () => 100)
    repository.append([created('conversation-1', 'First', 10)])
    const snapshotPath = join(directory, 'snapshots', 'conversation-1.json')
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { projection: { conversation: { title: string } } }
    snapshot.projection.conversation.title = 'Tampered'
    writeFileSync(snapshotPath, JSON.stringify(snapshot))
    expect(repository.projection('conversation-1').conversation?.title).toBe('First')
  })

  it('rebuilds a checksum-valid snapshot missing current projection fields', () => {
    const directory = root()
    const repository = new ConversationRepositoryV2(directory, () => 100)
    repository.append([created('conversation-1', 'First', 10)])
    const snapshotPath = join(directory, 'snapshots', 'conversation-1.json')
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { checksum: string; projection: Record<string, unknown> }
    delete snapshot.projection.timeline
    delete snapshot.projection.artifacts
    delete snapshot.projection.workspace
    snapshot.checksum = createHash('sha256').update(JSON.stringify(snapshot.projection)).digest('hex')
    writeFileSync(snapshotPath, JSON.stringify(snapshot))

    expect(repository.projection('conversation-1')).toMatchObject({
      timeline: expect.any(Array),
      artifacts: expect.any(Array),
      workspace: null,
    })
  })

  it('searches typed messages and tools while preserving result identity', () => {
    const repository = new ConversationRepositoryV2(root(), () => 100)
    repository.append([created('conversation-1', 'Task', 10), {
      eventId: 'event-message', profileId: 'profile-1', conversationId: 'conversation-1', workspaceId: 'workspace-1', itemId: 'item-1', source: 'agent', provenance: 'live', type: 'item.created', at: 20,
      payload: { item: { schemaVersion: 1, id: 'item-1', conversationId: 'conversation-1', kind: 'assistant_message', status: 'completed', createdAt: 20, updatedAt: 20, payload: { text: 'The portable result is ready' } } },
    }])
    expect(repository.search('portable')).toEqual([expect.objectContaining({ conversationId: 'conversation-1', itemId: 'item-1', kind: 'message' })])
  })

  it('filters private search results by workspace, date and typed result kind', () => {
    const directory = root()
    const repository = new ConversationRepositoryV2(directory, () => 100)
    repository.append([created('conversation-1', 'Portable task', 10, 'workspace-1'), {
      eventId: 'event-message-1', profileId: 'profile-1', conversationId: 'conversation-1', workspaceId: 'workspace-1', itemId: 'item-1', source: 'agent', provenance: 'live', type: 'item.created', at: 20,
      payload: { item: { schemaVersion: 1, id: 'item-1', conversationId: 'conversation-1', kind: 'assistant_message', status: 'completed', createdAt: 20, updatedAt: 20, payload: { text: 'Portable result from Alpha' } } },
    }])
    repository.append([created('conversation-2', 'Portable task', 30, 'workspace-2'), {
      eventId: 'event-command-2', profileId: 'profile-1', conversationId: 'conversation-2', workspaceId: 'workspace-2', itemId: 'item-2', source: 'agent', provenance: 'live', type: 'item.created', at: 40,
      payload: { item: { schemaVersion: 1, id: 'item-2', conversationId: 'conversation-2', kind: 'command_execution', status: 'completed', createdAt: 40, updatedAt: 40, payload: { command: 'portable build', requiresReview: true } } },
    }])

    expect(repository.search({ query: 'portable', workspaceId: 'workspace-2', from: 35, to: 45, kinds: ['command'] })).toEqual([
      expect.objectContaining({ conversationId: 'conversation-2', itemId: 'item-2', kind: 'command', workspaceId: 'workspace-2', occurredAt: 40 }),
    ])
    expect(repository.search({ query: 'portable', workspaceId: 'workspace-1', from: 25 })).toEqual([])
    expect(() => repository.search({ query: 'portable', from: 50, to: 40 })).toThrow(/start time/iu)

    writeFileSync(join(directory, 'search-index.json'), JSON.stringify({ schemaVersion: 1, entries: [], updatedAt: 1 }))
    expect(repository.search({ query: 'portable', workspaceId: 'workspace-2', kinds: ['command'] })).toHaveLength(1)
  })

  it('rebuilds a private search index without leaking results across profile roots', () => {
    const firstRoot = root()
    const secondRoot = root()
    const first = new ConversationRepositoryV2(firstRoot, () => 100)
    const second = new ConversationRepositoryV2(secondRoot, () => 100)
    first.append([created('conversation-a', 'Alpha', 10, 'workspace-1', 'profile-a'), {
      eventId: 'event-private-a', profileId: 'profile-a', conversationId: 'conversation-a', workspaceId: 'workspace-1', itemId: 'item-a', source: 'user', provenance: 'live', type: 'item.created', at: 20,
      payload: { item: { schemaVersion: 1, id: 'item-a', conversationId: 'conversation-a', kind: 'user_message', status: 'completed', createdAt: 20, updatedAt: 20, payload: { text: 'PRIVATE_ALPHA_TOKEN', attachmentIds: [] } } },
    }])
    second.append([created('conversation-b', 'Beta', 10, 'workspace-1', 'profile-b'), {
      eventId: 'event-private-b', profileId: 'profile-b', conversationId: 'conversation-b', workspaceId: 'workspace-1', itemId: 'item-b', source: 'user', provenance: 'live', type: 'item.created', at: 20,
      payload: { item: { schemaVersion: 1, id: 'item-b', conversationId: 'conversation-b', kind: 'user_message', status: 'completed', createdAt: 20, updatedAt: 20, payload: { text: 'PRIVATE_BETA_TOKEN', attachmentIds: [] } } },
    }])
    rmSync(join(firstRoot, 'search-index.json'), { force: true })
    expect(first.search('private_alpha')).toEqual([expect.objectContaining({ conversationId: 'conversation-a', itemId: 'item-a' })])
    expect(first.search('private_beta')).toEqual([])
    expect(second.search('private_alpha')).toEqual([])

    first.append([{ eventId: 'event-redact-a', profileId: 'profile-a', conversationId: 'conversation-a', workspaceId: 'workspace-1', itemId: 'item-a', source: 'user', provenance: 'live', type: 'item.redacted', at: 30, payload: { reason: 'Removed by user', redactedAt: 30 } }])
    expect(first.search('private_alpha')).toEqual([])
  })

  it('lists a 10k catalog with one catalog read and no journal reads', () => {
    const directory = root()
    const records = Array.from({ length: 10_000 }, (_, index) => ({
      schemaVersion: 2 as const,
      id: `conversation-${String(index).padStart(5, '0')}`,
      profileId: 'profile-1',
      workspaceId: 'workspace-1',
      title: `Conversation ${index}`,
      titleSource: 'custom' as const,
      mode: 'vibe' as const,
      provider: 'openai',
      model: 'test',
      status: 'idle' as const,
      createdAt: index,
      updatedAt: index,
      lastEventSeq: 1,
      turnCount: 1,
      runCount: 0,
      tags: [],
    }))
    writeFileSync(join(directory, 'catalog.json'), JSON.stringify({ schemaVersion: 1, records, updatedAt: 10_000 }))
    const reads: string[] = []
    const repository = new ConversationRepositoryV2(directory, () => 100, { onRead: (kind) => reads.push(kind) })
    const page = repository.list({ limit: 50 })
    expect(page.total).toBe(10_000)
    expect(page.conversations).toHaveLength(50)
    expect(page.conversations[0]?.id).toBe('conversation-09999')
    expect(reads).toEqual(['catalog'])
  })

  it('repairs corrupt tails and interrupts active work without replaying it', () => {
    const directory = root()
    let timestamp = 100
    const repository = new ConversationRepositoryV2(directory, () => ++timestamp)
    repository.append([
      created('conversation-1', 'Interrupted task', 10),
      {
        eventId: 'event-run', profileId: 'profile-1', conversationId: 'conversation-1', workspaceId: 'workspace-1', runId: 'run-1', source: 'agent', provenance: 'live', type: 'run.started', at: 20,
        payload: { run: { id: 'run-1', conversationId: 'conversation-1', workspaceId: 'workspace-1', objective: 'Write file', status: 'running', startedAt: 20, updatedAt: 20 } },
      },
      {
        eventId: 'event-tool', profileId: 'profile-1', conversationId: 'conversation-1', workspaceId: 'workspace-1', runId: 'run-1', itemId: 'tool-1', source: 'agent', provenance: 'live', type: 'item.created', at: 30,
        payload: { item: { schemaVersion: 1, id: 'tool-1', conversationId: 'conversation-1', runId: 'run-1', kind: 'tool_call', status: 'running', createdAt: 30, updatedAt: 30, payload: { toolCallId: 'tool-call-1', toolName: 'write_file', arguments: { path: 'a.ts' }, requiresReview: true } } },
      },
    ])
    const journalPath = join(repository.eventsRoot, 'conversation-1.jsonl')
    writeFileSync(journalPath, `${readFileSync(journalPath, 'utf8')}{"schemaVersion":2`, 'utf8')

    const receipt = repository.recoverInterruptedConversations()
    expect(receipt).toEqual({ repairedJournals: ['conversation-1'], interruptedRuns: 1, interruptedItems: 1, recoveredConversations: ['conversation-1'] })
    const projection = repository.projection('conversation-1')
    expect(projection.runs[0]).toMatchObject({ status: 'interrupted', recoveredFromPersistence: true })
    expect(projection.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'tool-1', status: 'interrupted' }),
      expect.objectContaining({ kind: 'recovery', status: 'completed' }),
    ]))
    expect(repository.recoverInterruptedConversations().recoveredConversations).toEqual([])
  })

  it('rebuilds artifact and workspace state from events after all projections are removed', () => {
    const directory = root()
    const repository = new ConversationRepositoryV2(directory, () => 100)
    repository.append([
      created('conversation-1', 'Portable workspace', 10),
      {
        eventId: 'event-artifact-item', profileId: 'profile-1', conversationId: 'conversation-1', workspaceId: 'workspace-1', itemId: 'artifact-item-1', source: 'agent', provenance: 'live', type: 'item.created', at: 20,
        payload: { item: { schemaVersion: 1, id: 'artifact-item-1', conversationId: 'conversation-1', kind: 'artifact', status: 'completed', createdAt: 20, updatedAt: 20, payload: { artifactId: 'artifact-1', name: 'report.md' } } },
      },
      { eventId: 'event-artifact', profileId: 'profile-1', conversationId: 'conversation-1', workspaceId: 'workspace-1', itemId: 'artifact-item-1', source: 'agent', provenance: 'live', type: 'artifact.registered', at: 21, payload: { artifactId: 'artifact-1', itemId: 'artifact-item-1' } },
      { eventId: 'event-workspace', profileId: 'profile-1', conversationId: 'conversation-1', workspaceId: 'workspace-1', source: 'runtime', provenance: 'live', type: 'workspace.binding_changed', at: 22, payload: { workspaceId: 'workspace-1', state: 'missing', at: 22 } },
    ])

    rmSync(repository.snapshotsRoot, { recursive: true, force: true })
    writeFileSync(join(directory, 'catalog.json'), '{broken')
    const rebuilt = new ConversationRepositoryV2(directory, () => 200).projection('conversation-1')
    expect(rebuilt.artifacts).toEqual([{ artifactId: 'artifact-1', itemIds: ['artifact-item-1'], status: 'available', updatedAt: 21 }])
    expect(rebuilt.workspace).toEqual({ workspaceId: 'workspace-1', bindingState: 'missing', verificationState: 'missing', updatedAt: 22 })
    expect(rebuilt.conversation).toMatchObject({ status: 'needs_workspace', lastEventSeq: 4 })
    expect(rebuilt.timeline.map(entry => entry.eventId)).toEqual(['event-conversation-1', 'event-artifact-item', 'event-artifact', 'event-workspace'])
    rmSync(join(directory, 'snapshots'), { recursive: true, force: true })
    rmSync(join(directory, 'catalog.json'), { force: true })
    rmSync(join(directory, 'search-index.json'), { force: true })
    expect(new ConversationRepositoryV2(directory, () => 300).rebuildAllProjections()).toMatchObject({ conversations: 1, events: 4 })
  })
})
