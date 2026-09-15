import { FlowEventFactory, type FlowEventType, type FlowPayloadFor } from '../../shared/flowEvents'
import { describe, expect, it, vi } from 'vitest'
import {
  createThreadFlowState,
  MAX_FLOW_NOTIFICATION_ITEMS,
  MAX_FLOW_STREAM_TEXT_CHARS,
  reduceFlowEvent,
} from './flowReducer'
import {
  FLOW_INPUT_RECEIPT_TTL_MS,
  selectCanSteer,
  selectInputReceipt,
  selectNeedsAction,
  selectPrimaryActivity,
  selectRunningBackgroundCount,
} from './flowSelectors'
import { FlowStore } from './flowStore'

function harness() {
  let now = 100
  let id = 0
  const factory = new FlowEventFactory(() => ++now, () => `event-${++id}`)
  const create = <Type extends FlowEventType>(
    type: Type,
    payload: FlowPayloadFor<Type>,
    options: { runId?: string; itemId?: string } = {},
  ) => factory.create({
    sessionId: 'session-1',
    threadId: 'thread-1',
    type,
    payload,
    ...options,
  })
  return { factory, create }
}

describe('flowReducer', () => {
  it('tracks an input through rejected steer restoration', () => {
    const { create } = harness()
    let state = createThreadFlowState('session-1', 'thread-1')
    state = reduceFlowEvent(state, create('run.started', { objective: 'Fix race' }, { runId: 'run-1' }))
    state = reduceFlowEvent(state, create('input.submitted', {
      intent: 'steer',
      text: 'Also add a regression test',
      attachmentIds: [],
    }, { runId: 'run-1', itemId: 'input-1' }))
    state = reduceFlowEvent(state, create('input.durable', {}, { runId: 'run-1', itemId: 'input-1' }))
    state = reduceFlowEvent(state, create('input.rejected', { reason: 'turn already completed' }, { runId: 'run-1', itemId: 'input-1' }))
    state = reduceFlowEvent(state, create('input.restored', { reason: 'rejected steer' }, { runId: 'run-1', itemId: 'input-1' }))

    expect(state.inputs['input-1']).toMatchObject({ status: 'restored', reason: 'rejected steer' })
    expect(state.draft.text).toBe('Also add a regression test')
    expect(selectCanSteer(state)).toBe(true)
    expect(selectInputReceipt(state, state.lastEventAt + FLOW_INPUT_RECEIPT_TTL_MS + 1)).toMatchObject({
      kind: 'restored',
      intent: 'steer',
    })
  })

  it('projects pending, steering, committed, and expired input receipts', () => {
    const { create } = harness()
    let state = createThreadFlowState('session-1', 'thread-1')
    state = reduceFlowEvent(state, create('run.started', {}, { runId: 'run-1' }))
    state = reduceFlowEvent(state, create('input.submitted', {
      intent: 'steer',
      text: 'Add the test too',
      attachmentIds: [],
    }, { runId: 'run-1', itemId: 'input-1' }))
    state = reduceFlowEvent(state, create('input.durable', {}, { runId: 'run-1', itemId: 'input-1' }))
    expect(selectInputReceipt(state, state.lastEventAt)).toMatchObject({ kind: 'pending', intent: 'steer' })

    state = reduceFlowEvent(state, create('input.accepted', {}, { runId: 'run-1', itemId: 'input-1' }))
    expect(selectInputReceipt(state, state.lastEventAt)).toMatchObject({ kind: 'steering' })

    state = reduceFlowEvent(state, create('input.committed', {}, { runId: 'run-1', itemId: 'input-1' }))
    expect(selectInputReceipt(state, state.lastEventAt)).toMatchObject({ kind: 'committed' })
    expect(selectInputReceipt(state, state.lastEventAt + FLOW_INPUT_RECEIPT_TTL_MS + 1)).toBeNull()
  })

  it('counts only running background work', () => {
    const { create } = harness()
    let state = createThreadFlowState('session-1', 'thread-1')
    state = reduceFlowEvent(state, create('runtime.started', { kind: 'subagent', label: 'review' }, { itemId: 'agent-1' }))
    state = reduceFlowEvent(state, create('runtime.started', { kind: 'terminal', label: 'tests' }, { itemId: 'terminal-1' }))
    expect(selectRunningBackgroundCount(state)).toBe(2)

    state = reduceFlowEvent(state, create('runtime.completed', { kind: 'subagent', outcome: 'completed' }, { itemId: 'agent-1' }))
    expect(selectRunningBackgroundCount(state)).toBe(1)
  })

  it('bounds retained stream text and drops committed input payload copies', () => {
    const { create } = harness()
    let state = createThreadFlowState('session-1', 'thread-1')
    state = reduceFlowEvent(state, create('input.submitted', {
      intent: 'turn',
      text: 'x'.repeat(100_000),
      attachmentIds: ['image-1'],
      attachments: [{ id: 'image-1', type: 'image', path: 'large.png' }],
    }, { itemId: 'input-1' }))
    state = reduceFlowEvent(state, create('input.committed', {}, { itemId: 'input-1' }))
    state = reduceFlowEvent(state, create('stream.started', { channel: 'thinking' }, { itemId: 'thinking-1' }))
    state = reduceFlowEvent(state, create('stream.delta', {
      channel: 'thinking',
      text: 'y'.repeat(MAX_FLOW_STREAM_TEXT_CHARS + 500),
    }, { itemId: 'thinking-1' }))

    expect(state.inputs['input-1']).toMatchObject({ text: '', attachmentIds: [], attachments: [] })
    expect(state.streams.thinking.tail).toHaveLength(MAX_FLOW_STREAM_TEXT_CHARS)
  })

  it('bounds retained Flow notifications', () => {
    const { create } = harness()
    let state = createThreadFlowState('session-1', 'thread-1')
    for (let index = 0; index < MAX_FLOW_NOTIFICATION_ITEMS + 10; index += 1) {
      state = reduceFlowEvent(state, create('notification.raised', {
        priority: 20,
        category: 'info',
      }, { itemId: `notification-${index}` }))
    }

    expect(Object.keys(state.notifications)).toHaveLength(MAX_FLOW_NOTIFICATION_ITEMS)
    expect(state.notifications['notification-0']).toBeUndefined()
  })

  it('keeps persistent Flow notifications while trimming transient ones', () => {
    const { create } = harness()
    let state = createThreadFlowState('session-1', 'thread-1')
    state = reduceFlowEvent(state, create('notification.raised', {
      priority: 100,
      category: 'action-required',
    }, { itemId: 'approval-1' }))
    for (let index = 0; index < MAX_FLOW_NOTIFICATION_ITEMS + 10; index += 1) {
      state = reduceFlowEvent(state, create('notification.raised', {
        priority: 20,
        category: 'info',
      }, { itemId: `transient-${index}` }))
    }

    expect(state.notifications['approval-1']).toBeDefined()
    expect(Object.keys(state.notifications)).toHaveLength(MAX_FLOW_NOTIFICATION_ITEMS)
  })

  it('preserves detailed Agent run phase transitions', () => {
    const { create } = harness()
    let state = createThreadFlowState('session-1', 'thread-1')
    state = reduceFlowEvent(state, create('run.started', { objective: 'Run tests' }, { runId: 'run-1' }))
    state = reduceFlowEvent(state, create('run.state_changed', {
      state: {
        phase: 'awaiting_approval',
        activeTool: 'run_command',
        detail: 'Approval required',
        updatedAt: 120,
      },
    }, { runId: 'run-1' }))

    expect(state.run).toMatchObject({
      phase: 'active',
      objective: 'Run tests',
      agentState: {
        phase: 'awaiting_approval',
        activeTool: 'run_command',
        detail: 'Approval required',
      },
    })
  })

  it('keeps the active task visible across run phase updates', () => {
    const { create } = harness()
    let state = createThreadFlowState('session-1', 'thread-1')
    state = reduceFlowEvent(state, create('run.started', { objective: 'Build feature' }, { runId: 'run-1' }))
    state = reduceFlowEvent(state, create('task.active_changed', {
      task: {
        taskId: 'task-1',
        title: 'Build feature',
        priority: 'major',
        progress: 25,
        toolCalls: [],
        startedAt: 110,
      },
    }, { runId: 'run-1' }))
    state = reduceFlowEvent(state, create('run.state_changed', {
      state: { phase: 'thinking', detail: 'Planning the next step', updatedAt: 120 },
    }, { runId: 'run-1' }))

    expect(state.activeTask).toMatchObject({ taskId: 'task-1', progress: 25 })
  })

  it('keeps approval requests in FIFO order and settles exactly once', () => {
    const { create } = harness()
    let state = createThreadFlowState('session-1', 'thread-1')
    state = reduceFlowEvent(state, create('approval.requested', { kind: 'permission', toolName: 'files__read' }, { itemId: 'approval-1' }))
    state = reduceFlowEvent(state, create('approval.requested', { kind: 'permission', toolName: 'search__read' }, { itemId: 'approval-2' }))
    state = reduceFlowEvent(state, create('approval.presented', {}, { itemId: 'approval-1' }))

    expect(state.approvalQueue).toEqual(['approval-1', 'approval-2'])
    expect(selectNeedsAction(state)).toBe(true)
    expect(selectPrimaryActivity(state)).toMatchObject({ kind: 'action-required', detail: 'files__read' })

    state = reduceFlowEvent(state, create('approval.resolved', { decision: 'allow-once' }, { itemId: 'approval-1' }))
    expect(state.activeApprovalId).toBe('approval-2')
    expect(state.approvals['approval-1'].status).toBe('resolved')

    state = reduceFlowEvent(state, create('approval.resolved', { decision: 'deny' }, { itemId: 'approval-1' }))
    expect(state.approvals['approval-1'].decision).toBe('allow-once')
    expect(state.violations.at(-1)?.code).toBe('terminal_reversal')
  })

  it('ignores duplicate sequence numbers and records sequence gaps', () => {
    const { create } = harness()
    let state = createThreadFlowState('session-1', 'thread-1')
    const started = create('run.started', {}, { runId: 'run-1' })
    state = reduceFlowEvent(state, started)
    expect(reduceFlowEvent(state, started)).toBe(state)

    const completed = create('run.completed', { outcome: 'succeeded' }, { runId: 'run-1' })
    const withGap = { ...completed, seq: completed.seq + 1 }
    state = reduceFlowEvent(state, withGap)
    expect(state.violations).toContainEqual(expect.objectContaining({ code: 'sequence_gap' }))
  })
})

describe('FlowStore', () => {
  it('publishes stable snapshots and isolates thread state', () => {
    const store = new FlowStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.activateThread('session-1', 'thread-1')
    const factory = new FlowEventFactory(() => 1, () => 'event-1')
    store.dispatch(factory.create({
      sessionId: 'session-1',
      threadId: 'thread-1',
      runId: 'run-1',
      type: 'run.started',
      payload: { objective: 'Test store' },
    }))

    expect(store.getSnapshot().activeThreadId).toBe('thread-1')
    expect(store.getThread('thread-1')?.run).toMatchObject({ id: 'run-1', phase: 'active' })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('drops least-recent inactive threads after the store limit', () => {
    const store = new FlowStore({ maxThreads: 2 })
    store.activateThread('session-1', 'thread-1')
    store.activateThread('session-2', 'thread-2')
    store.activateThread('session-3', 'thread-3')

    expect(store.getThread('thread-1')).toBeUndefined()
    expect(store.getThread('thread-2')).toBeDefined()
    expect(store.getThread('thread-3')).toBeDefined()
  })
})
