import { describe, expect, it } from 'vitest'
import { ApprovalCoordinator } from '../../core/runtime/approvalCoordinator'
import {
  FlowEventFactory,
  type AnyFlowEvent,
  type FlowEventType,
  type FlowPayloadFor,
} from '../../shared/flowEvents'
import { TerminalInputStateMachine } from '../components/input/terminalInputStateMachine'
import { projectTranscriptCellWindow } from '../components/transcriptWindowing'
import { selectPrimaryActivity } from './flowSelectors'
import { FlowStore } from './flowStore'
import { GOLDEN_TRACE_NAMES } from './goldenTraces'

interface TraceIdentity {
  runId?: string
  turnId?: string
  itemId?: string
}

function createTrace(
  threadId = 'thread-1',
  store = new FlowStore(),
  options: { activate?: boolean } = {},
) {
  let timestamp = 0
  let eventId = 0
  const sessionId = threadId
  const factory = new FlowEventFactory(() => ++timestamp, () => `event-${threadId}-${++eventId}`)
  if (options.activate !== false) store.activateThread(sessionId, threadId)
  return {
    store,
    emit<Type extends FlowEventType>(type: Type, payload: FlowPayloadFor<Type>, identity: TraceIdentity = {}) {
      return store.dispatch(factory.create({ sessionId, threadId, type, payload, ...identity }) as AnyFlowEvent)
    },
    state() {
      return store.getThread(threadId)!
    },
  }
}

function expectCleanTrace(trace: ReturnType<typeof createTrace>): void {
  expect(trace.state().violations).toEqual([])
}

describe('developer flow Golden Traces', () => {
  it('catalogues exactly twelve release-gating traces', () => {
    expect(GOLDEN_TRACE_NAMES).toHaveLength(12)
    expect(new Set(GOLDEN_TRACE_NAMES).size).toBe(12)
  })

  it('1 - commits a durable plain-text answer exactly once', () => {
    const trace = createTrace()
    trace.emit('input.submitted', { intent: 'turn', text: 'hello', attachmentIds: [] }, { itemId: 'input-1' })
    trace.emit('input.durable', {}, { itemId: 'input-1' })
    trace.emit('run.started', { objective: 'answer' }, { runId: 'run-1' })
    trace.emit('input.committed', {}, { itemId: 'input-1', runId: 'run-1' })
    trace.emit('stream.started', { channel: 'answer' }, { itemId: 'answer-1', runId: 'run-1' })
    trace.emit('stream.delta', { channel: 'answer', text: 'world' }, { itemId: 'answer-1', runId: 'run-1' })
    trace.emit('stream.committed', { channel: 'answer', text: 'world' }, { itemId: 'answer-1', runId: 'run-1' })
    trace.emit('stream.ended', { channel: 'answer', interrupted: false }, { itemId: 'answer-1', runId: 'run-1' })
    trace.emit('run.completed', { outcome: 'succeeded' }, { runId: 'run-1' })

    expect(trace.state().inputs['input-1']?.status).toBe('committed')
    expect(trace.state().streams.answer).toMatchObject({ committed: 'world', tail: '', status: 'ended' })
    expect(trace.state().run).toMatchObject({ phase: 'terminal', outcome: 'succeeded' })
    expectCleanTrace(trace)
  })

  it('2 - runs an approved write tool through one terminal state', () => {
    const trace = createTrace()
    trace.emit('run.started', {}, { runId: 'run-1' })
    trace.emit('tool.proposed', { name: 'write_file' }, { itemId: 'tool-1', runId: 'run-1' })
    trace.emit('approval.requested', { kind: 'permission', toolName: 'write_file' }, { itemId: 'approval-1', runId: 'run-1' })
    trace.emit('approval.presented', {}, { itemId: 'approval-1', runId: 'run-1' })
    trace.emit('approval.resolved', { decision: 'allow-once' }, { itemId: 'approval-1', runId: 'run-1' })
    trace.emit('tool.running', { name: 'write_file' }, { itemId: 'tool-1', runId: 'run-1' })
    trace.emit('tool.completed', { name: 'write_file', outcome: 'completed' }, { itemId: 'tool-1', runId: 'run-1' })
    trace.emit('run.completed', { outcome: 'succeeded' }, { runId: 'run-1' })

    expect(trace.state().approvals['approval-1']).toMatchObject({ status: 'resolved', decision: 'allow-once' })
    expect(trace.state().tools['tool-1']?.status).toBe('completed')
    expectCleanTrace(trace)
  })

  it('3 - settles two parallel MCP approvals in FIFO order', async () => {
    const trace = createTrace()
    const presented: string[] = []
    type Request = { id: string; toolName: string }
    const coordinator = new ApprovalCoordinator<Request, 'allow-once' | 'deny'>(
      request => {
        presented.push(request.id)
        trace.emit('approval.presented', {}, { itemId: request.id })
      },
      lifecycle => {
        if (lifecycle.state === 'requested') {
          trace.emit('approval.requested', { kind: 'permission', toolName: lifecycle.request.toolName }, { itemId: lifecycle.request.id })
        } else if (lifecycle.state === 'resolved') {
          trace.emit('approval.resolved', { decision: lifecycle.decision! }, { itemId: lifecycle.request.id })
        } else {
          trace.emit('approval.cancelled', { reason: 'aborted' }, { itemId: lifecycle.request.id })
        }
      },
    )
    const first = coordinator.request({ id: 'mcp-1', toolName: 'mcp_read' }, { cancelDecision: 'deny' })
    const second = coordinator.request({ id: 'mcp-2', toolName: 'mcp_list' }, { cancelDecision: 'deny' })

    expect(presented).toEqual(['mcp-1'])
    coordinator.resolve('mcp-1', 'allow-once')
    expect(presented).toEqual(['mcp-1', 'mcp-2'])
    coordinator.resolve('mcp-2', 'allow-once')

    await expect(Promise.all([first, second])).resolves.toEqual(['allow-once', 'allow-once'])
    expect(trace.state().approvalQueue).toEqual([])
    expectCleanTrace(trace)
  })

  it('4 - commits one accepted steer without duplicating its item', () => {
    const trace = createTrace()
    trace.emit('run.started', {}, { runId: 'run-1' })
    trace.emit('input.submitted', { intent: 'steer', text: 'also test it', attachmentIds: [] }, { itemId: 'steer-1', runId: 'run-1' })
    trace.emit('input.durable', {}, { itemId: 'steer-1', runId: 'run-1' })
    trace.emit('input.accepted', {}, { itemId: 'steer-1', runId: 'run-1' })
    trace.emit('input.committed', {}, { itemId: 'steer-1', runId: 'run-1' })

    expect(Object.keys(trace.state().inputs)).toEqual(['steer-1'])
    expect(trace.state().inputs['steer-1']?.status).toBe('committed')
    expectCleanTrace(trace)
  })

  it('5 - restores a steer rejected at the terminal gate', () => {
    const trace = createTrace()
    trace.emit('run.started', {}, { runId: 'run-1' })
    trace.emit('input.submitted', { intent: 'steer', text: 'late guidance', attachmentIds: ['image-1'] }, { itemId: 'steer-1' })
    trace.emit('input.durable', {}, { itemId: 'steer-1' })
    trace.emit('run.completed', { outcome: 'succeeded' }, { runId: 'run-1' })
    trace.emit('input.rejected', { reason: 'turn already completed' }, { itemId: 'steer-1' })
    trace.emit('input.restored', { reason: 'turn already completed' }, { itemId: 'steer-1' })

    expect(trace.state().draft).toEqual({ text: 'late guidance', attachmentIds: ['image-1'] })
    expect(trace.state().inputs['steer-1']?.status).toBe('restored')
    expectCleanTrace(trace)
  })

  it('6 - keeps queued input on hold after a recoverable error', () => {
    const trace = createTrace()
    trace.emit('run.started', {}, { runId: 'run-1' })
    trace.emit('input.submitted', { intent: 'queued-turn', text: 'run tests', attachmentIds: [] }, { itemId: 'queue-1' })
    trace.emit('input.durable', {}, { itemId: 'queue-1' })
    trace.emit('input.queued', { position: 0 }, { itemId: 'queue-1' })
    trace.emit('run.completed', { outcome: 'failed', error: 'provider unavailable' }, { runId: 'run-1' })

    expect(trace.state().inputQueue).toEqual(['queue-1'])
    expect(trace.state().inputs['queue-1']?.status).toBe('queued')
    expectCleanTrace(trace)
  })

  it('7 - restores prompt attachments when interrupted before first token', () => {
    const trace = createTrace()
    trace.emit('input.submitted', { intent: 'turn', text: 'inspect image', attachmentIds: ['image-1'] }, { itemId: 'input-1' })
    trace.emit('input.durable', {}, { itemId: 'input-1' })
    trace.emit('run.started', {}, { runId: 'run-1' })
    trace.emit('input.accepted', {}, { itemId: 'input-1' })
    trace.emit('run.stopping', { reason: 'user interrupt' }, { runId: 'run-1' })
    trace.emit('run.completed', { outcome: 'interrupted' }, { runId: 'run-1' })
    trace.emit('input.rejected', { reason: 'interrupted before response' }, { itemId: 'input-1' })
    trace.emit('input.restored', { reason: 'interrupted before response' }, { itemId: 'input-1' })

    expect(trace.state().draft).toEqual({ text: 'inspect image', attachmentIds: ['image-1'] })
    expect(trace.state().streams.answer.status).toBe('idle')
    expectCleanTrace(trace)
  })

  it('8 - closes an in-flight tool after crash recovery', () => {
    const trace = createTrace()
    trace.emit('run.started', {}, { runId: 'run-1' })
    trace.emit('tool.proposed', { name: 'run_command' }, { itemId: 'tool-1' })
    trace.emit('tool.running', { name: 'run_command' }, { itemId: 'tool-1' })
    trace.emit('tool.completed', { name: 'run_command', outcome: 'cancelled', error: 'interrupted by restart' }, { itemId: 'tool-1' })
    trace.emit('run.completed', { outcome: 'failed', error: 'process restarted' }, { runId: 'run-1' })

    expect(trace.state().tools['tool-1']).toMatchObject({ status: 'cancelled', error: 'interrupted by restart' })
    expectCleanTrace(trace)
  })

  it('9 - preserves committed stream source through long-table resize', () => {
    const trace = createTrace()
    const table = Array.from({ length: 200 }, (_, index) => `| ${index} | value ${index} |`).join('\n')
    trace.emit('run.started', {}, { runId: 'run-1' })
    trace.emit('stream.started', { channel: 'answer' }, { itemId: 'answer-1' })
    trace.emit('stream.delta', { channel: 'answer', text: table.slice(0, 500) }, { itemId: 'answer-1' })
    trace.emit('stream.committed', { channel: 'answer', text: table.slice(0, 500) }, { itemId: 'answer-1' })
    trace.emit('stream.delta', { channel: 'answer', text: table.slice(500) }, { itemId: 'answer-1' })
    trace.emit('stream.committed', { channel: 'answer', text: table.slice(500) }, { itemId: 'answer-1' })
    trace.emit('stream.ended', { channel: 'answer', interrupted: false }, { itemId: 'answer-1' })
    const committed = trace.state().streams.answer.committed
    const narrow = projectTranscriptCellWindow([{ id: 'answer-1', estimatedRows: 220 }], {}, 30, 0)
    const wide = projectTranscriptCellWindow([{ id: 'answer-1', estimatedRows: 110 }], {}, 30, 0)

    expect(committed).toBe(table)
    expect(narrow.totalRows).toBeGreaterThan(wide.totalRows)
    expect(trace.state().streams.answer.tail).toBe('')
    expectCleanTrace(trace)
  })

  it('10 - isolates a background-thread approval from the active draft', () => {
    const store = new FlowStore()
    const foreground = createTrace('foreground', store)
    foreground.emit('input.draft_changed', { text: 'keep typing', attachmentIds: [] })
    const background = createTrace('background', store, { activate: false })
    background.emit('run.started', { objective: 'subagent task' }, { runId: 'run-bg' })
    background.emit('approval.requested', { kind: 'permission', toolName: 'subagent/read_file', reason: 'background' }, { itemId: 'approval-bg' })

    expect(store.getSnapshot().activeThreadId).toBe('foreground')
    expect(foreground.state().draft.text).toBe('keep typing')
    expect(selectPrimaryActivity(background.state())).toMatchObject({ kind: 'action-required', detail: 'subagent/read_file' })
    expectCleanTrace(foreground)
    expectCleanTrace(background)
  })

  it('11 - bounds mounted cells for a ten-thousand-line transcript', () => {
    const cells = Array.from({ length: 10_000 }, (_, index) => ({ id: `line-${index}`, estimatedRows: 1 }))
    const window = projectTranscriptCellWindow(cells, {}, 50, 0, 12)

    expect(window.endIndex - window.startIndex).toBeLessThanOrEqual(74)
    expect(window.totalRows).toBe(10_000)
  })

  it('12 - keeps Enter inside paste and IME bursts without losing characters', () => {
    const input = new TerminalInputStateMachine()
    const received: string[] = []
    for (const [index, character] of Array.from('pasted').entries()) {
      input.notePlainText(character, index * 2)
      received.push(character)
    }
    expect(input.shouldInsertNewline(20)).toBe(true)
    input.noteInsertedNewline(20)
    received.push('\n')
    input.notePlainText('中文', 22)
    received.push('中文')

    expect(received.join('')).toBe('pasted\n中文')
    expect(input.getSnapshot().mode).toBe('paste-burst')
  })
})
