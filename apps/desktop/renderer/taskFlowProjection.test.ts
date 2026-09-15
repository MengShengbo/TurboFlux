import { describe, expect, it } from 'vitest'
import type {
  AnyConversationEvent,
  ConversationEventPayloadMap,
  ConversationEventType,
} from '@turboflux/agent-core/workbench'
import {
  applyTaskFlowWorkSnapshot,
  applyTaskFlowEvent,
  createTaskFlowProjection,
  latestTaskFlowNodeId,
  orderTaskFlowNodeIds,
  projectWorkProjection,
  syncTaskFlowLiveText,
  taskFlowNodeIdForTool,
  taskFlowNodeIdForTurn,
} from './taskFlowProjection'

function event<Type extends ConversationEventType>(
  seq: number,
  type: Type,
  payload: ConversationEventPayloadMap[Type],
  identity: { runId?: string; turnId?: string; stepId?: string; itemId?: string } = {},
): AnyConversationEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${seq}`,
    conversationId: 'conversation-1',
    threadId: 'conversation-1',
    seq,
    at: 100 + seq,
    source: 'runtime',
    provenance: 'live',
    type,
    payload,
    ...identity,
  } as AnyConversationEvent
}

describe('task flow projection', () => {
  it('pauses streamed and executing tools, preserves cancellation, and accepts late results after resume', () => {
    const identity = { runId: 'run-1', stepId: 'step-1' }
    let state = [
      event(1, 'run.started', {}, identity),
      event(2, 'tool.proposed', { toolCall: { id: 'executing', name: 'read_file', arguments: {} } }, { ...identity, itemId: 'executing' }),
      event(3, 'tool.delta', { toolCallId: 'partial', toolName: 'read_file', partialJson: '{"path":' }, { ...identity, itemId: 'partial' }),
      event(4, 'run.state_changed', { state: { phase: 'paused', updatedAt: 104 } }, identity),
    ].reduce(applyTaskFlowEvent, createTaskFlowProjection('conversation-1'))
    expect(state.nodes['tool:executing']).toMatchObject({ status: 'paused', settled: false })
    expect(state.nodes['tool:partial']).toMatchObject({ status: 'paused', settled: false })
    state = applyTaskFlowEvent(state, event(5, 'step.completed', { index: 1, outcome: 'interrupted' }, identity))
    state = applyTaskFlowEvent(state, event(6, 'run.state_changed', { state: { phase: 'tool_running', updatedAt: 106 } }, identity))
    expect(state.nodes['tool:partial']).toMatchObject({ status: 'interrupted', settled: true })
    expect(state.nodes['tool:executing']).toMatchObject({ status: 'running', settled: false })
    state = applyTaskFlowEvent(state, event(7, 'tool.completed', {
      toolResult: { toolCallId: 'executing', name: 'read_file', output: 'ok', isError: false },
    }, { ...identity, itemId: 'executing' }))
    expect(state.nodes['tool:executing']).toMatchObject({ status: 'completed', settled: true })
  })

  it('adapts the canonical work projection without re-deriving identity or order', () => {
    const work = {
      schemaVersion: 1 as const,
      window: {
        schemaVersion: 1 as const,
        sessionId: 'conversation-1',
        threadId: 'conversation-1',
        baseSeq: 1,
        lastSeq: 7,
        eventCount: 7,
        hasMore: false,
      },
      projection: {
        schemaVersion: 1 as const,
        sessionId: 'conversation-1',
        threadId: 'conversation-1',
        revision: 7,
        lastSeq: 7,
        activeRunId: 'run-1',
        nodes: {
          'run:run-1:response:1:reasoning': {
            key: 'run:run-1:response:1:reasoning', anchorSeq: 2, lastSeq: 3, ordinal: 1,
            kind: 'reasoning' as const, status: 'completed' as const, runId: 'run-1',
            responseId: 'run:run-1:response:1', turnId: 'assistant-1', content: '先分析',
            startedAt: 102, updatedAt: 103, completedAt: 103, settled: true,
          },
          'tool:read-1': {
            key: 'tool:read-1', anchorSeq: 4, lastSeq: 7, ordinal: 2,
            kind: 'tool' as const, status: 'completed' as const, runId: 'run-1',
            turnId: 'assistant-1', callId: 'read-1', toolName: 'read_file', content: 'read_file', detail: 'ok',
            startedAt: 104, updatedAt: 107, completedAt: 107, settled: true,
          },
        },
        order: ['run:run-1:response:1:reasoning', 'tool:read-1'],
      },
    }

    const state = applyTaskFlowWorkSnapshot(null, work)
    expect(state).toMatchObject({ source: 'work', revision: 7, lastSeq: 7, activeRunId: 'run-1' })
    expect(state.order).toEqual(['run:run-1:response:1:reasoning', 'tool:read-1'])
    expect(state.nodes['run:run-1:response:1:reasoning']).toMatchObject({ kind: 'thinking', turnId: 'assistant-1' })
    expect(state.nodes['tool:read-1']).toMatchObject({ kind: 'tool', callId: 'read-1', detail: 'ok' })
  })

  it('settles open nodes that no longer belong to the active run', () => {
    const state = projectWorkProjection({
      schemaVersion: 1,
      sessionId: 'conversation-1',
      threadId: 'conversation-1',
      revision: 2,
      lastSeq: 2,
      activeRunId: 'run-2',
      nodes: {
        'phase:run-1': {
          key: 'phase:run-1', anchorSeq: 1, lastSeq: 1, ordinal: 1, kind: 'phase', status: 'running',
          runId: 'run-1', content: 'Planning the next step', startedAt: 100, updatedAt: 100, settled: false,
        },
        'phase:run-2': {
          key: 'phase:run-2', anchorSeq: 2, lastSeq: 2, ordinal: 2, kind: 'phase', status: 'running',
          runId: 'run-2', content: 'thinking', startedAt: 110, updatedAt: 110, settled: false,
        },
      },
      order: ['phase:run-1', 'phase:run-2'],
    })
    expect(state.nodes['phase:run-1']).toMatchObject({ status: 'interrupted', settled: true })
    expect(state.nodes['phase:run-2']).toMatchObject({ status: 'running', settled: false })
  })

  it('uses canonical turn and tool ids for restored and live DOM bindings', () => {
    const projection = projectWorkProjection({
      schemaVersion: 1,
      sessionId: 'conversation-1',
      threadId: 'conversation-1',
      revision: 3,
      lastSeq: 3,
      nodes: {
        'input:user-1': {
          key: 'input:user-1', anchorSeq: 1, lastSeq: 1, ordinal: 1, kind: 'input', status: 'completed',
          runId: 'run-1', turnId: 'user-1', content: '检查项目', startedAt: 100, updatedAt: 100, completedAt: 100, settled: true,
        },
        'run:run-1:response:1:answer': {
          key: 'run:run-1:response:1:answer', anchorSeq: 2, lastSeq: 2, ordinal: 2, kind: 'answer', status: 'completed',
          runId: 'run-1', responseId: 'run:run-1:response:1', turnId: 'assistant-1', content: '开始检查', startedAt: 110, updatedAt: 110, completedAt: 110, settled: true,
        },
        'tool:read-1': {
          key: 'tool:read-1', anchorSeq: 3, lastSeq: 3, ordinal: 3, kind: 'tool', status: 'running',
          runId: 'run-1', turnId: 'assistant-1', callId: 'read-1', toolName: 'read_file', content: 'read_file', startedAt: 111, updatedAt: 111, settled: false,
        },
      },
      order: ['input:user-1', 'run:run-1:response:1:answer', 'tool:read-1'],
    })
    const userTurn = { id: 'user-1', role: 'user' as const, content: '检查项目', timestamp: 100 }
    const assistantTurn = { id: 'assistant-1', role: 'assistant' as const, content: '开始检查', timestamp: 110 }

    expect(taskFlowNodeIdForTurn(projection, userTurn, 'input')).toBe('input:user-1')
    expect(taskFlowNodeIdForTurn(projection, assistantTurn, 'answer')).toBe('run:run-1:response:1:answer')
    expect(taskFlowNodeIdForTool(projection, 'read-1')).toBe('tool:read-1')
  })

  it('keeps late tool results at the original node position', () => {
    let state = createTaskFlowProjection('conversation-1')
    state = applyTaskFlowEvent(state, event(1, 'run.started', { objective: 'test' }, { runId: 'run-1' }))
    state = applyTaskFlowEvent(state, event(2, 'stream.started', { channel: 'thinking' }, { runId: 'run-1', itemId: 'thinking-1' }))
    state = applyTaskFlowEvent(state, event(3, 'tool.proposed', { toolCall: { id: 'tool-1', name: 'read_file', arguments: {} } }, { runId: 'run-1', itemId: 'tool-1' }))
    state = applyTaskFlowEvent(state, event(4, 'stream.started', { channel: 'answer' }, { runId: 'run-1', itemId: 'answer-1' }))
    state = applyTaskFlowEvent(state, event(5, 'tool.completed', { toolResult: { toolCallId: 'tool-1', name: 'read_file', output: 'ok', isError: false } }, { runId: 'run-1', itemId: 'tool-1' }))

    expect(state.order).toEqual(['thinking-1', 'tool:tool-1', 'answer-1'])
    expect(state.nodes['tool:tool-1']).toMatchObject({ status: 'completed', ordinal: 3, settled: true })
    expect(orderTaskFlowNodeIds(state, ['answer-1', 'tool:tool-1', 'thinking-1'])).toEqual(['thinking-1', 'tool:tool-1', 'answer-1'])
  })

  it('projects user turns and run phases without renderer-side message insertion', () => {
    let state = createTaskFlowProjection('conversation-1')
    const userTurn = { id: 'user-1', role: 'user' as const, content: '检查项目', timestamp: 101 }
    state = applyTaskFlowEvent(state, event(1, 'run.started', { objective: userTurn.content }, { runId: 'run-1' }))
    state = applyTaskFlowEvent(state, event(2, 'turn.started', { turn: userTurn }, { runId: 'run-1', turnId: userTurn.id }))
    state = applyTaskFlowEvent(state, event(3, 'run.state_changed', {
      state: { phase: 'thinking', updatedAt: 103, detail: '正在分析' },
    }, { runId: 'run-1' }))

    expect(state.order).toEqual(['input:user-1', 'phase:run-1'])
    expect(state.nodes['input:user-1']).toMatchObject({ kind: 'input', content: '检查项目', status: 'completed', settled: true })
    expect(state.nodes['phase:run-1']).toMatchObject({ kind: 'phase', content: '正在分析', status: 'running', settled: false })

    state = applyTaskFlowEvent(state, event(4, 'run.completed', { outcome: 'completed' }, { runId: 'run-1' }))
    expect(state.activeRunId).toBeUndefined()
    expect(state.nodes['phase:run-1']).toMatchObject({ status: 'completed', settled: true })
  })

  it('keeps an in-run user answer between surrounding work nodes', () => {
    let state = createTaskFlowProjection('conversation-1')
    state = applyTaskFlowEvent(state, event(1, 'stream.started', { channel: 'thinking' }, { runId: 'run-1', itemId: 'thinking-1' }))
    state = applyTaskFlowEvent(state, event(2, 'input.state_changed', { inputId: 'input-1', intent: 'steer', state: 'accepted', text: '继续' }, { runId: 'run-1', itemId: 'input-1' }))
    state = applyTaskFlowEvent(state, event(3, 'input.state_changed', { inputId: 'input-1', intent: 'steer', state: 'committed' }, { runId: 'run-1', itemId: 'input-1' }))
    state = applyTaskFlowEvent(state, event(4, 'tool.proposed', { toolCall: { id: 'tool-1', name: 'read_file', arguments: {} } }, { runId: 'run-1', itemId: 'tool-1' }))
    expect(state.order).toEqual(['thinking-1', 'input:input-1', 'tool:tool-1'])
    expect(state.nodes['input:input-1']).toMatchObject({ kind: 'input', status: 'completed' })
  })

  it('ignores duplicates and records sequence gaps', () => {
    let state = createTaskFlowProjection('conversation-1')
    const thinking = event(2, 'stream.started', { channel: 'thinking' }, { runId: 'run-1', itemId: 'thinking-1' })
    state = applyTaskFlowEvent(state, thinking)
    const unchanged = applyTaskFlowEvent(state, thinking)
    expect(unchanged).toBe(state)
    expect(state.sequenceGaps).toEqual([2])
  })

  it('commits canonical stream text exactly once and settles the node', () => {
    let state = createTaskFlowProjection('conversation-1')
    state = applyTaskFlowEvent(state, event(1, 'stream.delta', { channel: 'answer', text: '完成' }, { runId: 'run-1', stepId: 'step-1', itemId: 'step-1:answer' }))
    state = applyTaskFlowEvent(state, event(2, 'stream.committed', { channel: 'answer', text: '完成任务' }, { runId: 'run-1', stepId: 'step-1', itemId: 'step-1:answer' }))

    expect(state.nodes['step:step-1:answer']).toMatchObject({
      content: '完成任务',
      status: 'completed',
      settled: true,
    })
  })

  it('resets cleanly when history rewrite restarts sequence numbers', () => {
    let state = createTaskFlowProjection('conversation-1')
    state = applyTaskFlowEvent(state, event(5, 'stream.started', { channel: 'thinking' }, { itemId: 'old-thinking' }))
    state = applyTaskFlowEvent(state, event(1, 'conversation.activated', {}))
    expect(state.lastSeq).toBe(1)
    expect(state.order).toEqual([])
  })

  it('finds the latest unsettled node for live DOM binding', () => {
    let state = createTaskFlowProjection('conversation-1')
    state = applyTaskFlowEvent(state, event(1, 'stream.started', { channel: 'thinking' }, { itemId: 'thinking-1' }))
    state = applyTaskFlowEvent(state, event(2, 'stream.ended', { channel: 'thinking', interrupted: false }, { itemId: 'thinking-1' }))
    state = applyTaskFlowEvent(state, event(3, 'stream.started', { channel: 'thinking' }, { itemId: 'thinking-2' }))
    expect(latestTaskFlowNodeId(state, 'thinking', { unsettled: true })).toBe('thinking-2')
  })

  it('updates canonical live text without rebuilding the work snapshot', () => {
    const state = projectWorkProjection({
      schemaVersion: 1,
      sessionId: 'conversation-1',
      threadId: 'conversation-1',
      revision: 1,
      lastSeq: 2,
      activeRunId: 'run-1',
      nodes: {
        'run:run-1:response:1:reasoning': {
          key: 'run:run-1:response:1:reasoning', anchorSeq: 2, lastSeq: 2, ordinal: 1,
          kind: 'reasoning', status: 'running', runId: 'run-1', responseId: 'run:run-1:response:1',
          content: '先', startedAt: 100, updatedAt: 100, settled: false,
        },
      },
      order: ['run:run-1:response:1:reasoning'],
    })

    const updated = syncTaskFlowLiveText(state, 'thinking', '先检查完整链路', 120)
    expect(updated).not.toBe(state)
    expect(updated.nodes['run:run-1:response:1:reasoning']).toMatchObject({
      content: '先检查完整链路',
      updatedAt: 120,
    })
    expect(syncTaskFlowLiveText(updated, 'thinking', '先检查完整链路', 130)).toBe(updated)
  })

  it('replays an ordinary send into one settled canonical transcript', () => {
    const userTurn = { id: 'user-1', role: 'user' as const, content: '检查项目', timestamp: 101 }
    const assistantTurn = { id: 'assistant-1', role: 'assistant' as const, content: '检查完成', timestamp: 106 }
    const events = [
      event(1, 'run.started', { objective: userTurn.content }, { runId: 'run-1' }),
      event(2, 'turn.started', { turn: userTurn }, { runId: 'run-1', turnId: userTurn.id }),
      event(3, 'run.state_changed', { state: { phase: 'thinking', updatedAt: 103, detail: '正在分析' } }, { runId: 'run-1' }),
      event(4, 'stream.delta', { channel: 'answer', text: '检查' }, { runId: 'run-1', turnId: assistantTurn.id, stepId: 'step-1' }),
      event(5, 'stream.committed', { channel: 'answer', text: assistantTurn.content }, { runId: 'run-1', turnId: assistantTurn.id, stepId: 'step-1' }),
      event(6, 'turn.completed', { turn: assistantTurn }, { runId: 'run-1', turnId: assistantTurn.id }),
      event(7, 'run.completed', { outcome: 'completed' }, { runId: 'run-1' }),
    ]
    const state = events.reduce(applyTaskFlowEvent, createTaskFlowProjection('conversation-1'))

    expect(state.activeRunId).toBeUndefined()
    expect(state.order).toEqual(['input:user-1', 'phase:run-1', 'step:step-1:answer'])
    expect(state.nodes['step:step-1:answer']).toMatchObject({ content: '检查完成', status: 'completed', settled: true })
    expect(Object.values(state.nodes).every(node => node.settled)).toBe(true)
  })

  it('replays edited resend after activation without retaining abandoned nodes', () => {
    let state = createTaskFlowProjection('conversation-1')
    state = applyTaskFlowEvent(state, event(1, 'run.started', { objective: '旧问题' }, { runId: 'run-old' }))
    state = applyTaskFlowEvent(state, event(2, 'turn.started', {
      turn: { id: 'user-1', role: 'user', content: '旧问题', timestamp: 102 },
    }, { runId: 'run-old', turnId: 'user-1' }))
    state = applyTaskFlowEvent(state, event(3, 'stream.committed', { channel: 'answer', text: '旧答案' }, { runId: 'run-old', stepId: 'step-old' }))
    state = applyTaskFlowEvent(state, event(4, 'run.completed', { outcome: 'completed' }, { runId: 'run-old' }))

    state = applyTaskFlowEvent(state, event(1, 'conversation.activated', {}))
    state = applyTaskFlowEvent(state, event(2, 'run.started', { objective: '新问题' }, { runId: 'run-new' }))
    state = applyTaskFlowEvent(state, event(3, 'turn.started', {
      turn: { id: 'user-1', role: 'user', content: '新问题', timestamp: 103 },
    }, { runId: 'run-new', turnId: 'user-1' }))
    state = applyTaskFlowEvent(state, event(4, 'stream.committed', { channel: 'answer', text: '新答案' }, { runId: 'run-new', stepId: 'step-new' }))
    state = applyTaskFlowEvent(state, event(5, 'run.completed', { outcome: 'completed' }, { runId: 'run-new' }))

    expect(state.order).toEqual(['input:user-1', 'step:step-new:answer'])
    expect(state.nodes['input:user-1']).toMatchObject({ content: '新问题', runId: 'run-new' })
    expect(state.nodes['step:step-old:answer']).toBeUndefined()
  })

  it('settles pause, approval, tool failure, and recoverable failure facts deterministically', () => {
    const events = [
      event(1, 'run.started', { objective: '执行任务' }, { runId: 'run-1' }),
      event(2, 'turn.started', {
        turn: { id: 'user-1', role: 'user', content: '执行任务', timestamp: 102 },
      }, { runId: 'run-1', turnId: 'user-1' }),
      event(3, 'run.state_changed', { state: { phase: 'paused', updatedAt: 103, detail: '已暂停' } }, { runId: 'run-1' }),
      event(4, 'approval.requested', {
        requestId: 'approval-1', kind: 'permission', question: '允许读取？', toolName: 'read_file',
      }, { runId: 'run-1', itemId: 'approval-1' }),
      event(5, 'approval.resolved', { requestId: 'approval-1', decision: 'allow-once' }, { runId: 'run-1', itemId: 'approval-1' }),
      event(6, 'tool.proposed', { toolCall: { id: 'tool-1', name: 'read_file', arguments: {} } }, { runId: 'run-1', itemId: 'tool-1' }),
      event(7, 'tool.completed', {
        toolResult: { toolCallId: 'tool-1', name: 'read_file', output: 'failed', isError: true },
      }, { runId: 'run-1', itemId: 'tool-1' }),
      event(8, 'run.state_changed', {
        state: { phase: 'recoverable_error', updatedAt: 108, detail: '可以重试', recoverable: true },
      }, { runId: 'run-1' }),
      event(9, 'run.completed', { outcome: 'failed', error: 'failed' }, { runId: 'run-1' }),
    ]
    const state = events.reduce(applyTaskFlowEvent, createTaskFlowProjection('conversation-1'))

    expect(state.activeRunId).toBeUndefined()
    expect(state.nodes['approval:approval-1']).toMatchObject({ status: 'completed', settled: true })
    expect(state.nodes['tool:tool-1']).toMatchObject({ status: 'failed', settled: true })
    expect(state.nodes['phase:run-1']).toMatchObject({ content: '可以重试', status: 'failed', settled: true })
  })
})
