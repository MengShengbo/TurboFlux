import { describe, expect, it } from 'vitest'
import type { AgentRunState } from '@turboflux/contracts/agentTypes'
import type { WorkRun } from '@turboflux/contracts/workExecutionTypes'
import type { AnyConversationEvent } from '@turboflux/contracts/conversationEvent'
import { createTaskFlowProjection } from './taskFlowProjection'
import { applyConversationViewEvent, applyConversationViewSnapshot, type ConversationViewState } from './conversationViewProjection'

const run: WorkRun = {
  id: 'run', conversationId: 'conversation', objective: 'Inspect', presentation: 'work', responseMode: 'task',
  status: 'running', phase: 'thinking', rootStepIds: [], steps: {}, activities: {}, startedAt: 1_000, updatedAt: 201_000,
  executionSegments: [{ startedAt: 1_000, endedAt: 8_000, outcome: 'paused' }, { startedAt: 200_000 }],
}
const initial = (): ConversationViewState => ({
  flow: createTaskFlowProjection('conversation'),
  execution: { schemaVersion: 1, currentRunId: null, runs: [] },
  runState: { phase: 'idle', updatedAt: 0 }, status: 'ready',
})
const event = (seq: number, type: AnyConversationEvent['type'], payload: unknown): AnyConversationEvent => ({
  schemaVersion: 1, eventId: `event-${seq}`, conversationId: 'conversation', threadId: 'conversation',
  runId: 'run', seq, at: 248_000, source: 'agent', provenance: 'live', type, payload,
} as AnyConversationEvent)

describe('canonical conversation view', () => {
  it.each(['completed', 'partial', 'failed', 'cancelled'] as const)('settles %s timing, transcript, and composer in one event', status => {
    let view = applyConversationViewEvent(initial(), event(1, 'run.started', {}))
    view = applyConversationViewEvent(view, event(2, 'execution.updated', { snapshot: { schemaVersion: 1, currentRunId: run.id, runs: [run] } }))
    const completed: WorkRun = { ...run, status, phase: status, updatedAt: 248_000, completedAt: 248_000, executionSegments: [run.executionSegments![0], { startedAt: 200_000, endedAt: 248_000, outcome: status === 'cancelled' ? 'stopped' : status === 'partial' ? 'interrupted' : status }] }
    const state: AgentRunState = { phase: status === 'failed' ? 'recoverable_error' : 'completed', startedAt: 1_000, updatedAt: 248_000 }
    const next = applyConversationViewEvent(view, event(3, 'run.completed', { outcome: status, run: completed, state }))
    expect(next.execution.runs[0]).toEqual(completed)
    expect(next.execution.currentRunId).toBeNull()
    expect(next.flow.activeRunId).toBeUndefined()
    expect(next.runState).toEqual(state)
    expect(next.status).toBe(status === 'failed' ? 'error' : 'ready')
    expect(view.execution.runs[0].status).toBe('running')
  })

  it('ignores duplicate events and stale snapshots without repeating terminal side effects', () => {
    const started = applyConversationViewEvent(initial(), event(1, 'run.started', {}))
    const finished = applyConversationViewEvent(started, event(2, 'run.completed', { outcome: 'completed' }))
    expect(applyConversationViewEvent(finished, event(1, 'run.started', {}))).toBe(finished)
    expect(applyConversationViewEvent(finished, event(2, 'run.completed', { outcome: 'failed' }))).toBe(finished)
    expect(applyConversationViewSnapshot(finished, started)).toBe(finished)
    expect(applyConversationViewSnapshot(finished, { ...finished, status: 'running' }).status).toBe('ready')
  })

  it('holds out-of-order completion until a snapshot fills the missing events', () => {
    const started = applyConversationViewEvent(initial(), event(1, 'run.started', {}))
    const completion = event(3, 'run.completed', { outcome: 'completed' })
    expect(applyConversationViewEvent(started, completion)).toBe(started)
    const snapshot = { ...started, flow: { ...started.flow, lastSeq: 2 } }
    const restored = applyConversationViewSnapshot(started, snapshot)
    expect(applyConversationViewEvent(restored, completion).status).toBe('ready')
    expect(applyConversationViewEvent(restored, { ...completion, conversationId: 'other' })).toBe(restored)
  })

  it('requires an explicit new run before later active state can reopen a completed run', () => {
    let view = applyConversationViewEvent(initial(), event(1, 'run.started', {}))
    const completed = { ...run, status: 'completed', completedAt: 248_000 }
    view = applyConversationViewEvent(view, event(2, 'run.completed', { outcome: 'completed', run: completed }))
    view = applyConversationViewEvent(view, event(3, 'run.state_changed', { state: { phase: 'thinking', updatedAt: 300_000 } }))
    view = applyConversationViewEvent(view, event(4, 'execution.updated', { snapshot: { schemaVersion: 1, currentRunId: run.id, runs: [run] } }))
    expect(view.status).toBe('ready')
    expect(view.execution.runs[0]).toEqual(completed)
    expect(view.flow.activeRunId).toBeUndefined()
    expect(view.flow.lastSeq).toBe(4)
    expect(applyConversationViewEvent(view, event(5, 'run.started', {})).status).toBe('running')
  })

  it('settles older journals from event timing and keeps stopped segments immutable', () => {
    const started = { ...initial(), flow: { ...initial().flow, activeRunId: run.id }, execution: { schemaVersion: 1 as const, currentRunId: run.id, runs: [run] } }
    const finished = applyConversationViewEvent(started, event(1, 'run.completed', { outcome: 'interrupted' }))
    expect(finished.execution.runs[0]).toMatchObject({ status: 'partial', completedAt: 248_000 })
    expect(finished.execution.runs[0].executionSegments).toEqual([run.executionSegments![0], { startedAt: 200_000, endedAt: 248_000, outcome: 'interrupted' }])
  })

  it('accepts the new sequence after history rewrite and rejects delayed facts from the old generation', () => {
    const old = { ...initial(), generation: 1, flow: { ...initial().flow, lastSeq: 90 } }
    const rewritten = { ...initial(), generation: 2, flow: { ...initial().flow, lastSeq: 2 } }
    const accepted = applyConversationViewSnapshot(old, rewritten)
    expect(accepted).toBe(rewritten)
    expect(applyConversationViewSnapshot(accepted, old)).toBe(accepted)
    expect(applyConversationViewEvent(accepted, { ...event(91, 'run.completed', { outcome: 'failed' }), generation: 1 })).toBe(accepted)
    expect(applyConversationViewEvent(accepted, { ...event(3, 'run.started', {}), generation: 2 }).status).toBe('running')
  })

})
