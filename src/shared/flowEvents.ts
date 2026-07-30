import { randomUUID } from 'node:crypto'
import type { AgentAttachment, AgentMode, AgentRunState, TaskPriority, TokenUsage } from './agentTypes'

export const FLOW_EVENT_SCHEMA_VERSION = 2 as const

export type FlowInputIntent = 'turn' | 'steer' | 'queued-turn'
export type FlowRunOutcome = 'succeeded' | 'failed' | 'interrupted' | 'cancelled'
export type FlowToolOutcome = 'completed' | 'failed' | 'cancelled'
export type FlowApprovalKind = 'permission' | 'input'
export type FlowApprovalDecision = 'allow-once' | 'allow-run' | 'allow-session' | 'deny' | 'answered'

export interface FlowTaskToolCall {
  toolCallId: string
  toolName: string
  status: 'running' | 'completed' | 'error' | 'cancelled'
  path?: string
  result?: string
}

export interface FlowActiveTask {
  taskId: string
  title: string
  priority: TaskPriority
  progress: number
  toolCalls: FlowTaskToolCall[]
  startedAt: number
}

export type FlowEventPayload =
  | { type: 'thread.activated'; previousThreadId?: string }
  | { type: 'run.started'; objective?: string }
  | { type: 'run.state_changed'; state: AgentRunState }
  | { type: 'run.stopping'; reason?: string }
  | { type: 'run.completed'; outcome: FlowRunOutcome; error?: string }
  | { type: 'session.mode_changed'; mode: AgentMode }
  | { type: 'usage.updated'; usage: TokenUsage }
  | { type: 'task.active_changed'; task: FlowActiveTask | null }
  | { type: 'fast_context.started'; runId: string }
  | { type: 'fast_context.progressed'; runId: string; phase?: string; files?: number; hits?: number }
  | { type: 'fast_context.completed'; runId: string; files: number; hits: number }
  | { type: 'tool.draft_changed'; name: string; partialJson: string }
  | { type: 'tool.draft_cleared' }
  | { type: 'input.draft_changed'; text: string; attachmentIds: string[] }
  | { type: 'input.submitted'; intent: FlowInputIntent; text: string; attachmentIds: string[]; attachments?: AgentAttachment[] }
  | { type: 'input.durable' }
  | { type: 'input.accepted' }
  | { type: 'input.rejected'; reason: string }
  | { type: 'input.committed' }
  | { type: 'input.restored'; reason: string }
  | { type: 'input.queued'; position: number }
  | { type: 'input.removed'; reason: string }
  | { type: 'approval.requested'; kind: FlowApprovalKind; toolName?: string; reason?: string }
  | { type: 'approval.presented' }
  | { type: 'approval.resolved'; decision: FlowApprovalDecision }
  | { type: 'approval.cancelled'; reason: string }
  | { type: 'tool.proposed'; name: string }
  | { type: 'tool.awaiting_approval'; name: string }
  | { type: 'tool.running'; name: string }
  | { type: 'tool.completed'; name: string; outcome: FlowToolOutcome; error?: string }
  | { type: 'stream.started'; channel: 'answer' | 'thinking' }
  | { type: 'stream.delta'; channel: 'answer' | 'thinking'; text: string }
  | { type: 'stream.committed'; channel: 'answer' | 'thinking'; text: string }
  | { type: 'stream.ended'; channel: 'answer' | 'thinking'; interrupted: boolean }
  | { type: 'runtime.started'; kind: string; label?: string }
  | { type: 'runtime.completed'; kind: string; outcome: FlowToolOutcome; error?: string }
  | { type: 'notification.raised'; priority: number; category: string; message?: string }
  | { type: 'notification.acknowledged' }
  | { type: 'journal.flush_started'; queued: number }
  | { type: 'journal.flushed'; queued: number; durationMs: number }
  | { type: 'journal.degraded'; error: string }

export type FlowEventType = FlowEventPayload['type']

export type FlowPayloadFor<T extends FlowEventType> =
  Extract<FlowEventPayload, { type: T }> extends infer Payload
    ? Payload extends { type: T }
      ? Omit<Payload, 'type'>
      : never
    : never

export interface FlowEventEnvelope<T extends FlowEventType = FlowEventType> {
  schemaVersion: typeof FLOW_EVENT_SCHEMA_VERSION
  eventId: string
  sessionId: string
  threadId: string
  runId?: string
  turnId?: string
  itemId?: string
  seq: number
  at: number
  type: T
  payload: FlowPayloadFor<T>
}

export type AnyFlowEvent = {
  [Type in FlowEventType]: FlowEventEnvelope<Type>
}[FlowEventType]

export interface CreateFlowEventInput<T extends FlowEventType> {
  sessionId: string
  threadId: string
  runId?: string
  turnId?: string
  itemId?: string
  type: T
  payload: FlowPayloadFor<T>
  at?: number
  eventId?: string
}

export class FlowEventFactory {
  private readonly nextSeqByThread = new Map<string, number>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID,
  ) {}

  create<T extends FlowEventType>(input: CreateFlowEventInput<T>): FlowEventEnvelope<T> {
    const seq = (this.nextSeqByThread.get(input.threadId) ?? 0) + 1
    this.nextSeqByThread.set(input.threadId, seq)
    return {
      schemaVersion: FLOW_EVENT_SCHEMA_VERSION,
      eventId: input.eventId ?? this.createId(),
      sessionId: input.sessionId,
      threadId: input.threadId,
      runId: input.runId,
      turnId: input.turnId,
      itemId: input.itemId,
      seq,
      at: input.at ?? this.now(),
      type: input.type,
      payload: input.payload,
    }
  }

  observe(event: Pick<AnyFlowEvent, 'threadId' | 'seq'>): void {
    const current = this.nextSeqByThread.get(event.threadId) ?? 0
    if (event.seq > current) this.nextSeqByThread.set(event.threadId, event.seq)
  }

  getLastSequence(threadId: string): number {
    return this.nextSeqByThread.get(threadId) ?? 0
  }
}
