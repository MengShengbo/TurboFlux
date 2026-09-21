import { describe, expect, it } from 'vitest'
import { createConversationProjector, projectConversationEvents } from './conversationProjections'
import type { AnyAppendConversationEventV2Input, AnyConversationEventV2 } from './conversationV2Types'

const common = { conversationId: 'c', profileId: 'p', workspaceId: 'w', source: 'runtime' as const, provenance: 'live' as const }
const item = (id: string, text: string) => ({ schemaVersion: 1 as const, id, conversationId: 'c', turnId: 't', kind: 'assistant_message' as const, status: 'running' as const, createdAt: 3, updatedAt: 3, payload: { text } })
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const inputs: AnyAppendConversationEventV2Input[] = [
  { ...common, type: 'conversation.created', payload: { record: { schemaVersion: 2, id: 'c', profileId: 'p', workspaceId: 'w', title: 'First', titleSource: 'custom', mode: 'vibe', provider: 'fixture', model: 'fixture', status: 'needs_workspace', createdAt: 1, updatedAt: 1, lastEventSeq: 0, turnCount: 0, runCount: 0, tags: [] } } },
  { ...common, type: 'run.started', runId: 'r', payload: { run: { id: 'r', conversationId: 'c', workspaceId: 'w', objective: 'Work', status: 'running', startedAt: 2, updatedAt: 2 } } },
  { ...common, type: 'turn.started', turnId: 't', runId: 'r', payload: { turn: { id: 't', conversationId: 'c', runId: 'r', role: 'assistant', status: 'started', createdAt: 3 } } },
  { ...common, type: 'item.created', itemId: 'first', payload: { item: item('first', 'first text') } },
  { ...common, type: 'item.created', itemId: 'alias', payload: { item: item('alias', 'replacement text') } },
  { ...common, type: 'item.updated', itemId: 'alias', payload: { updatedAt: 6, payload: { text: 'Updated through alias' } } },
  { ...common, type: 'run.completed', runId: 'r', payload: { status: 'completed', completedAt: 7 } },
  { ...common, type: 'workspace.verification_changed', payload: { workspaceId: 'w', state: 'bound', at: 8 } },
  { ...common, type: 'input.queued', payload: { inputId: 'input', text: 'queued' } },
  { ...common, type: 'approval.requested', payload: { requestId: 'approval', requestKind: 'permission', question: 'Allow?' } },
  { ...common, type: 'approval.resolved', payload: { requestId: 'approval', decision: 'allow' } },
  { ...common, type: 'context.compaction_started', payload: { compactionId: 'compaction', sourceItemIds: ['first'] } },
  { ...common, type: 'context.compaction_committed', payload: { compactionId: 'compaction', itemId: 'summary', summary: 'summary' } },
  { ...common, type: 'artifact.registered', payload: { artifactId: 'artifact', itemId: 'artifact-item' } },
  { ...common, type: 'artifact.missing', payload: { artifactId: 'artifact', reason: 'missing' } },
  { ...common, type: 'input.removed', payload: { inputId: 'input', reason: 'cancelled' } },
  { ...common, type: 'conversation.rewritten', payload: { retainedTurnIds: ['t'], rewrittenAt: 17 } },
  { ...common, type: 'item.updated', itemId: 'alias', payload: { updatedAt: 18, payload: { text: 'Alias cleared by rewrite' } } },
  { ...common, type: 'item.completed', itemId: 'first', payload: { completedAt: 19, status: 'completed' } },
  { ...common, type: 'conversation.archived', payload: { archivedAt: 20 } },
  { ...common, type: 'conversation.restored', payload: {} },
]
const events = inputs.map((input, index) => ({ ...input, schemaVersion: 2, eventId: `e-${index}`, seq: index + 1, at: index === 1 ? 1000 : index + 1 })) as AnyConversationEventV2[]

describe('incremental conversation projection', () => {
  it.each(Array.from({ length: events.length + 1 }, (_, index) => index))('matches full replay after restoring a checkpoint at %s', split => {
    const first = createConversationProjector()
    first.apply(events.slice(0, split))
    const resumed = createConversationProjector(json(first.snapshot()))
    expect(json(resumed.apply(events.slice(split)))).toEqual(json(projectConversationEvents(events)))
  })

  it('preserves hidden state across repeated single-event checkpoints without changing input events', () => {
    const original = json(events)
    let projector = createConversationProjector()
    for (let i = 0; i < events.length; i += 1) {
      projector.apply([events[i]!])
      expect(json(projector.projection)).toEqual(json(projectConversationEvents(events.slice(0, i + 1))))
      projector = createConversationProjector(json(projector.snapshot()))
    }
    expect(json(events)).toEqual(original)
  })
})
