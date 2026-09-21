import { describe, expect, it } from 'vitest'
import { WorkSession } from './workSession'
import { applyConversationViewEvent, createTaskFlowProjection, projectWorkProjection, type ConversationViewState } from '@turboflux/presentation'

const initial = (): ConversationViewState => ({
  flow: createTaskFlowProjection('conversation'),
  execution: { schemaVersion: 1, currentRunId: null, runs: [] },
  runState: { phase: 'idle', updatedAt: 0 }, status: 'ready',
})
const run = { id: 'run' }

describe('conversation view replay', () => {
  it('stamps replacement histories and all following events with the new generation', () => {
    const session = new WorkSession('conversation')
    session.startRun({ runId: 'old' })
    session.finishRun({ outcome: 'completed' })
    const old = session.getSnapshot()
    const replacement = session.replaceFromTurns([])
    const events = session.startRun({ runId: 'new' })
    expect(replacement.projection.generation).toBe((old.projection.generation ?? 0) + 1)
    expect(events[0].generation).toBe(replacement.projection.generation)
    expect(events[0].seq).toBe(1)
  })

  it('replays a full live lifecycle into the same content and completion as its kernel snapshot', () => {
    const session = new WorkSession('conversation')
    session.startRun({ runId: run.id, at: 1_000 })
    session.appendAgent({ type: 'turn:start', turn: { id: run.id, role: 'user', content: 'Inspect', timestamp: 1_000 } }, 1_000)
    session.appendAgent({ type: 'stream:start' }, 2_000)
    session.appendAgent({ type: 'stream:delta', text: 'Done' }, 3_000)
    session.appendAgent({ type: 'stream:end' }, 4_000)
    session.appendAgent({ type: 'turn:complete', turn: { id: 'answer', role: 'assistant', content: 'Done', timestamp: 4_000 } }, 4_000)
    session.finishRun({ outcome: 'completed', at: 5_000 })
    const live = session.log.getEvents().reduce(applyConversationViewEvent, initial())
    const restored = projectWorkProjection(session.getSnapshot().projection)
    expect(live.flow.order).toEqual(restored.order)
    expect(live.flow.order.map(id => ({ id, content: live.flow.nodes[id].content, status: live.flow.nodes[id].status, settled: live.flow.nodes[id].settled, turnId: live.flow.nodes[id].turnId })))
      .toEqual(restored.order.map(id => ({ id, content: restored.nodes[id].content, status: restored.nodes[id].status, settled: restored.nodes[id].settled, turnId: restored.nodes[id].turnId })))
    expect(live.status).toBe('ready')
  })
})
