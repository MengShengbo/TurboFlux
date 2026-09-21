import { describe, expect, it } from 'vitest'
import type { AgentTurn, ToolCall, ToolResult } from '@turboflux/contracts/agentTypes'
import { ConversationEventLog, DEFAULT_CONVERSATION_EVENT_WINDOW_LIMIT } from '@turboflux/conversations/events/index'
import { WorkSession } from './workSession'
import { applyTaskFlowEvent, projectWorkProjection } from '@turboflux/presentation/taskFlowProjection'

const userTurn: AgentTurn = {
  id: 'user-1',
  role: 'user',
  content: '检查项目',
  timestamp: 100,
  metadata: { workRunId: 'run-1' },
}

const calls: ToolCall[] = [
  { id: 'tool-1', name: 'read_file', arguments: { path: 'a.ts' } },
  { id: 'tool-2', name: 'grep', arguments: { query: 'TODO' } },
]

const assistantTurn: AgentTurn = {
  id: 'assistant-1',
  role: 'assistant',
  content: '先检查代码。',
  timestamp: 110,
  toolCalls: calls,
  metadata: {
    workRunId: 'run-1',
    thinking: { content: '分析目录和关键文件', source: 'provider', status: 'complete' },
  },
}

const results: ToolResult[] = [
  { toolCallId: 'tool-1', name: 'read_file', output: 'ok', isError: false },
  { toolCallId: 'tool-2', name: 'grep', output: 'found', isError: false },
]

const resultTurn: AgentTurn = {
  id: 'result-1',
  role: 'tool_result',
  content: 'ok',
  timestamp: 120,
  toolResults: results,
  metadata: { workRunId: 'run-1' },
}

function visible(snapshot: ReturnType<WorkSession['getSnapshot']>) {
  return snapshot.projection.order.map(key => {
    const node = snapshot.projection.nodes[key]!
    return {
      key,
      kind: node.kind,
      status: node.status,
      content: node.content,
      detail: node.detail,
      toolName: node.toolName,
      settled: node.settled,
    }
  })
}

function appendAgent(session: WorkSession, event: Parameters<WorkSession['appendAgent']>[0], at: number) {
  session.appendAgent(event, at)
}

describe('WorkSession', () => {
  it('pauses open tools immediately, preserves finished tools and approvals, and resumes only unfinished work', () => {
    const session = new WorkSession('conversation-1')
    session.startRun({ runId: 'run-1', at: 99 })
    appendAgent(session, { type: 'tool:call', toolCall: calls[0]! }, 100)
    appendAgent(session, { type: 'tool:result', toolResult: results[0]! }, 101)
    appendAgent(session, { type: 'tool:call', toolCall: calls[1]! }, 102)
    appendAgent(session, {
      type: 'approval:state', requestId: 'approval-1', requestKind: 'permission', state: 'requested', question: 'Allow?',
    }, 103)
    appendAgent(session, { type: 'run:state', state: { phase: 'paused', updatedAt: 104 } }, 104)
    let nodes = session.getSnapshot().projection.nodes
    expect(nodes['tool:tool-1']).toMatchObject({ status: 'completed', settled: true })
    expect(nodes['tool:tool-2']).toMatchObject({ status: 'paused', settled: false })
    expect(nodes['phase:run-1']).toMatchObject({ status: 'paused', settled: false })
    expect(nodes['approval:approval-1']).toMatchObject({ status: 'waiting', settled: false })
    appendAgent(session, { type: 'run:state', state: { phase: 'awaiting_approval', updatedAt: 105 } }, 105)
    nodes = session.getSnapshot().projection.nodes
    expect(nodes['tool:tool-2']).toMatchObject({ status: 'running', settled: false })
    expect(nodes['tool:tool-1']).toMatchObject({ status: 'completed', settled: true })
  })

  it('settles incomplete streamed tool arguments when a stream is interrupted and never revives them on resume', () => {
    const session = new WorkSession('conversation-1')
    session.startRun({ runId: 'run-1', at: 99 })
    appendAgent(session, { type: 'stream:start' }, 100)
    appendAgent(session, { type: 'stream:thinking_delta', text: 'Inspecting' }, 101)
    appendAgent(session, { type: 'stream:tool_call_delta', toolCallId: 'partial', toolName: 'read_file', partialJson: '{"path":' }, 102)
    appendAgent(session, { type: 'run:state', state: { phase: 'paused', updatedAt: 103 } }, 103)
    expect(Object.values(session.getSnapshot().projection.nodes).filter(node => !node.settled).every(node => node.status === 'paused')).toBe(true)
    const refreshed = projectWorkProjection(session.getSnapshot().projection)
    const interruptedEvents = session.appendAgent({ type: 'stream:end', interrupted: true }, 104)
    const live = interruptedEvents.reduce(applyTaskFlowEvent, refreshed)
    expect(live.nodes['tool:partial']).toMatchObject({ status: 'interrupted', settled: true })
    appendAgent(session, { type: 'run:state', state: { phase: 'thinking', updatedAt: 105 } }, 105)
    expect(session.getSnapshot().projection.nodes['tool:partial']).toMatchObject({ status: 'interrupted', settled: true })
    expect(Object.values(session.getSnapshot().projection.nodes).filter(node => node.kind === 'reasoning')).toEqual([
      expect.objectContaining({ status: 'interrupted', settled: true }),
    ])
  })

  it('keeps a tool interrupted by pause settled after resume and replay', () => {
    const session = new WorkSession('conversation-1')
    session.startRun({ runId: 'run-1', at: 99 })
    appendAgent(session, { type: 'tool:call', toolCall: calls[0]! }, 100)
    appendAgent(session, { type: 'run:state', state: { phase: 'paused', updatedAt: 101 } }, 101)
    appendAgent(session, { type: 'tool:result', toolResult: {
      ...results[0]!, isError: true, errorKind: 'abort', interruption: { kind: 'pause', resumable: true },
    } }, 102)
    appendAgent(session, { type: 'run:state', state: { phase: 'thinking', updatedAt: 103 } }, 103)
    expect(session.getSnapshot().projection.nodes['tool:tool-1']).toMatchObject({ status: 'interrupted', settled: true })
    const replay = new WorkSession('conversation-1')
    expect(replay.projection.replace(session.log.getEvents())).toEqual(session.getSnapshot().projection)
  })

  it('keeps approvals outside a run out of conversation history', () => {
    const session = new WorkSession('conversation-1')

    expect(session.appendAgent({
      type: 'approval:state',
      requestId: 'settings-approval',
      requestKind: 'permission',
      state: 'requested',
      question: 'Allow this device capability?',
    }, 90)).toEqual([])
    expect(session.log.getEvents()).toEqual([])

    session.startRun({ runId: 'run-1', objective: 'Inspect the project', at: 99 })
    const events = session.appendAgent({
      type: 'approval:state',
      requestId: 'tool-approval',
      requestKind: 'permission',
      state: 'requested',
      question: 'Allow this tool?',
    }, 100)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'approval.requested', runId: 'run-1' })
  })

  it('resets normalizer coordinates when activating a different conversation', () => {
    const session = new WorkSession('conversation-1')
    session.replaceFromTurns([userTurn])
    session.activate('conversation-2', 'conversation-2', [{ ...userTurn, id: 'user-2' }])
    appendAgent(session, {
      type: 'turn:start',
      turn: { ...userTurn, id: 'user-3', metadata: { workRunId: 'run-3' } },
    }, 200)

    const snapshot = session.getSnapshot()
    expect(snapshot.projection.sessionId).toBe('conversation-2')
    expect(snapshot.window.conversationId).toBe('conversation-2')
    expect(snapshot.projection.nodes['input:user-3']).toBeDefined()
  })

  it('projects live and restored facts into the same stable nodes', () => {
    const live = new WorkSession('conversation-1')
    live.startRun({ runId: 'run-1', objective: userTurn.content, at: 99 })
    appendAgent(live, { type: 'turn:start', turn: userTurn }, 100)
    appendAgent(live, { type: 'stream:start' }, 101)
    appendAgent(live, { type: 'stream:thinking_delta', text: '分析目录和' }, 102)
    appendAgent(live, { type: 'stream:thinking_delta', text: '关键文件' }, 103)
    appendAgent(live, { type: 'stream:delta', text: '先检查代码。' }, 104)
    appendAgent(live, { type: 'stream:end' }, 105)
    appendAgent(live, { type: 'turn:complete', turn: assistantTurn }, 110)
    appendAgent(live, { type: 'tool:call', toolCall: calls[0]! }, 111)
    appendAgent(live, { type: 'tool:call', toolCall: calls[1]! }, 112)
    appendAgent(live, { type: 'tool:result', toolResult: results[1]! }, 113)
    appendAgent(live, { type: 'tool:result', toolResult: results[0]! }, 114)

    const restored = new WorkSession('conversation-1')
    restored.replaceFromTurns([userTurn, assistantTurn, resultTurn])

    expect(visible(restored.getSnapshot())).toEqual(visible(live.getSnapshot()))
  })

  it('never restores legacy turns as an active run', () => {
    const interruptedAssistant: AgentTurn = {
      ...assistantTurn,
      id: 'assistant-interrupted',
      metadata: { ...assistantTurn.metadata, interrupted: true },
    }

    for (const turns of [
      [userTurn],
      [userTurn, assistantTurn],
      [userTurn, interruptedAssistant],
      [userTurn, assistantTurn, resultTurn],
    ]) {
      const restored = new WorkSession('conversation-1')
      restored.replaceFromTurns(turns)
      expect(restored.getSnapshot().projection.activeRunId).toBeUndefined()
      expect(restored.log.getEvents().at(-1)?.type).toBe('run.completed')
    }
  })

  it('keeps parallel tool results at their call positions', () => {
    const session = new WorkSession('conversation-1')
    session.replaceFromTurns([userTurn, assistantTurn])
    appendAgent(session, { type: 'tool:result', toolResult: results[1]! }, 121)
    appendAgent(session, { type: 'tool:result', toolResult: results[0]! }, 122)
    const projection = session.getSnapshot().projection
    expect(projection.order.slice(-2)).toEqual(['tool:tool-1', 'tool:tool-2'])
    expect(projection.nodes['tool:tool-1']).toMatchObject({ status: 'completed', detail: 'ok' })
    expect(projection.nodes['tool:tool-2']).toMatchObject({ status: 'completed', detail: 'found' })
  })

  it('retains interrupted reasoning instead of removing it', () => {
    const session = new WorkSession('conversation-1')
    session.startRun({ runId: 'run-1', at: 99 })
    appendAgent(session, { type: 'turn:start', turn: userTurn }, 100)
    appendAgent(session, { type: 'stream:start' }, 101)
    appendAgent(session, { type: 'stream:thinking_delta', text: '正在定位问题' }, 102)
    appendAgent(session, { type: 'stream:end', interrupted: true }, 103)
    const node = Object.values(session.getSnapshot().projection.nodes).find(candidate => candidate.kind === 'reasoning')
    expect(node).toMatchObject({ content: '正在定位问题', status: 'interrupted', settled: true })
  })

  it('settles and binds an interrupted persisted stream when restoring after shutdown', () => {
    const interrupted = new WorkSession('conversation-1')
    interrupted.startRun({ runId: 'run-1', at: 99 })
    appendAgent(interrupted, { type: 'turn:start', turn: userTurn }, 100)
    appendAgent(interrupted, { type: 'stream:start' }, 101)
    appendAgent(interrupted, { type: 'stream:thinking_delta', text: '正在定位问题' }, 102)
    appendAgent(interrupted, { type: 'stream:delta', text: '已找到一部分' }, 103)
    const persistedEvents = interrupted.log.getEvents()
    const recoveredTurn: AgentTurn = {
      id: 'recovered-assistant-103',
      role: 'assistant',
      content: '已找到一部分',
      timestamp: 103,
      metadata: {
        thinking: { content: '正在定位问题', source: 'provider', status: 'interrupted' },
      },
    }

    const restored = new WorkSession('conversation-1')
    restored.replaceFromEvents(persistedEvents, [userTurn, recoveredTurn])
    const snapshot = restored.getSnapshot()
    const reasoning = Object.values(snapshot.projection.nodes).find(node => node.kind === 'reasoning')
    const answer = Object.values(snapshot.projection.nodes).find(node => node.kind === 'answer')
    const appendedEvents = restored.log.getEvents().filter(event => event.seq > persistedEvents.at(-1)!.seq)

    expect(snapshot.projection.activeRunId).toBeUndefined()
    expect(reasoning).toMatchObject({
      content: '正在定位问题',
      status: 'interrupted',
      settled: true,
      turnId: recoveredTurn.id,
    })
    expect(answer).toMatchObject({
      content: '已找到一部分',
      status: 'interrupted',
      settled: true,
      turnId: recoveredTurn.id,
    })
    expect(appendedEvents.map(event => event.type)).toEqual([
      'stream.committed',
      'stream.committed',
      'turn.completed',
      'step.completed',
      'run.completed',
    ])
    expect(restored.log.getEvents().every((event, index, events) => (
      index === 0 || event.seq === events[index - 1]!.seq + 1
    ))).toBe(true)
  })

  it('uses one canonical sequence across run and agent facts', () => {
    const session = new WorkSession('conversation-1')
    session.startRun({ runId: 'run-1', at: 100 })
    appendAgent(session, { type: 'stream:start' }, 101)
    appendAgent(session, { type: 'stream:delta', text: 'working' }, 102)
    expect(session.log.getEvents().map(event => event.seq)).toEqual([1, 2, 3, 4])
    expect(new Set(session.log.getEvents().map(event => event.eventId)).size).toBe(4)
  })

  it('rejects non-contiguous projection input', () => {
    const session = new WorkSession('conversation-1')
    expect(() => session.projection.apply({
      schemaVersion: 1,
      eventId: 'gap',
      conversationId: 'conversation-1',
      threadId: 'conversation-1',
      seq: 2,
      at: 100,
      source: 'agent',
      provenance: 'live',
      type: 'stream.started',
      runId: 'run-1',
      stepId: 'run-1:step:1',
      itemId: 'run-1:step:1:answer',
      payload: { channel: 'answer' },
    })).toThrow('expected seq 1, received 2')
  })

  it('bounds the event window while preserving the complete streamed response', () => {
    const session = new WorkSession('conversation-1')
    session.startRun({ runId: 'run-1', at: 100 })
    appendAgent(session, { type: 'turn:start', turn: userTurn }, 101)
    appendAgent(session, { type: 'stream:start' }, 102)
    const chunkCount = DEFAULT_CONVERSATION_EVENT_WINDOW_LIMIT + 500
    for (let index = 0; index < chunkCount; index += 1) {
      appendAgent(session, { type: 'stream:delta', text: 'x' }, 103 + index)
    }

    const snapshot = session.getSnapshot()
    const answer = Object.values(snapshot.projection.nodes).find(node => node.kind === 'answer')
    expect(answer?.content).toHaveLength(chunkCount)
    expect(snapshot.window.eventCount).toBe(DEFAULT_CONVERSATION_EVENT_WINDOW_LIMIT)
    expect(snapshot.window.hasMore).toBe(true)
    expect(session.log.getEvents()[0]?.seq).toBeGreaterThan(1)
  })

  it('keeps previously published snapshots stable across later deltas', () => {
    const session = new WorkSession('conversation-1')
    session.startRun({ runId: 'run-1', at: 100 })
    appendAgent(session, { type: 'turn:start', turn: userTurn }, 101)
    appendAgent(session, { type: 'stream:start' }, 102)
    appendAgent(session, { type: 'stream:delta', text: 'first' }, 103)
    const first = session.getSnapshot()

    appendAgent(session, { type: 'stream:delta', text: ' second' }, 104)
    const second = session.getSnapshot()
    const firstAnswer = Object.values(first.projection.nodes).find(node => node.kind === 'answer')
    const secondAnswer = Object.values(second.projection.nodes).find(node => node.kind === 'answer')

    expect(firstAnswer?.content).toBe('first')
    expect(secondAnswer?.content).toBe('first second')
  })

  it('keeps the exact newest canonical event window after wrapping', () => {
    const log = new ConversationEventLog('conversation-1')
    for (let index = 0; index < DEFAULT_CONVERSATION_EVENT_WINDOW_LIMIT + 137; index += 1) {
      log.append({
        eventId: `event-${index}`,
        source: 'agent',
        type: 'runtime.event',
        payload: { kind: 'benchmark', payload: index },
      })
    }
    const events = log.getEvents()
    expect(events).toHaveLength(DEFAULT_CONVERSATION_EVENT_WINDOW_LIMIT)
    expect(events[0]?.seq).toBe(138)
    expect(events.at(-1)?.seq).toBe(DEFAULT_CONVERSATION_EVENT_WINDOW_LIMIT + 137)
    expect(events.every((event, index) => index === 0 || event.seq === events[index - 1]!.seq + 1)).toBe(true)
  })

  it('preserves planned tool order and releases completed-run indexes', () => {
    const session = new WorkSession('conversation-1')
    session.startRun({ runId: 'run-1', at: 100 })
    appendAgent(session, { type: 'stream:start' }, 101)
    appendAgent(session, { type: 'stream:delta', text: 'working' }, 102)
    appendAgent(session, { type: 'stream:end' }, 103)
    appendAgent(session, {
      type: 'turn:complete',
      turn: { ...assistantTurn, content: 'working', toolCalls: calls, metadata: { ...assistantTurn.metadata, workRunId: 'run-1' } },
    }, 104)
    appendAgent(session, { type: 'tool:call', toolCall: calls[1]! }, 105)
    appendAgent(session, { type: 'tool:call', toolCall: calls[0]! }, 106)
    appendAgent(session, { type: 'tool:result', toolResult: results[1]! }, 107)
    appendAgent(session, { type: 'tool:result', toolResult: results[0]! }, 108)

    const beforeCompletion = session.getSnapshot().projection.order
    expect(beforeCompletion.indexOf('tool:tool-1')).toBeLessThan(beforeCompletion.indexOf('tool:tool-2'))

    session.finishRun({ outcome: 'completed', at: 109 })
    const internals = session.projection as unknown as {
      responseSequenceByRun: Map<string, number>
      toolPlacements: Map<string, unknown>
    }
    expect(internals.responseSequenceByRun.size).toBe(0)
    expect(internals.toolPlacements.size).toBe(0)
  })
})
