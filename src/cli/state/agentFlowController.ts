import type { AgentEventType } from '../../core/agentEngine'
import { FlowEventFactory, type AnyFlowEvent, type FlowApprovalDecision, type FlowEventType, type FlowPayloadFor } from '../../shared/flowEvents'
import type { ConversationQueuedInput } from '../conversations/types'
import { FlowStore } from './flowStore'
import { selectIsForegroundBusy, selectQueuedInputs, type FlowPromptProjection } from './flowSelectors'

export class AgentFlowController {
  readonly store = new FlowStore()
  private readonly factory: FlowEventFactory
  private threadId: string
  private sessionId: string
  private activeRunId: string | null = null
  private runSequence = 0
  private stopping = false
  private readonly startedStreams = new Set<'answer' | 'thinking'>()
  private readonly proposedTools = new Set<string>()
  private readonly runtimeItems = new Set<string>()

  constructor(sessionId: string, factory = new FlowEventFactory()) {
    this.factory = factory
    this.sessionId = sessionId
    this.threadId = sessionId
    this.store.activateThread(sessionId, sessionId)
    this.dispatch('thread.activated', {}, {})
  }

  activateThread(sessionId: string, threadId = sessionId): void {
    const previousThreadId = this.threadId
    this.sessionId = sessionId
    this.threadId = threadId
    this.activeRunId = null
    this.stopping = false
    this.startedStreams.clear()
    this.proposedTools.clear()
    this.runtimeItems.clear()
    this.store.activateThread(sessionId, threadId)
    this.dispatch('thread.activated', { previousThreadId }, {})
  }

  handle(event: AgentEventType): AnyFlowEvent[] {
    const emitted: AnyFlowEvent[] = []
    const publish = <Type extends FlowEventType>(
      type: Type,
      payload: FlowPayloadFor<Type>,
      identity: { runId?: string; turnId?: string; itemId?: string } = {},
    ) => emitted.push(this.dispatch(type, payload, identity))

    switch (event.type) {
      case 'run:state': {
        if (event.state.phase === 'completed') {
          if (this.activeRunId) {
            publish('run.state_changed', { state: event.state }, { runId: this.activeRunId })
            this.completeRun(this.stopping ? 'interrupted' : 'succeeded', undefined, publish)
          }
        } else if (event.state.phase !== 'idle') {
          this.ensureRun(publish)
          publish('run.state_changed', { state: event.state }, { runId: this.activeRunId || undefined })
          if (event.state.phase === 'aborting' && this.activeRunId) {
            this.stopping = true
            publish('run.stopping', { reason: event.state.detail }, { runId: this.activeRunId })
          }
        }
        break
      }
      case 'turn:start':
        if (event.turn.role === 'user') {
          this.ensureRun(publish)
          const existing = this.store.getThread(this.threadId)?.inputs[event.turn.id]
          if (!existing) {
            publish('input.submitted', {
              intent: 'turn',
              text: event.turn.content,
              attachmentIds: event.turn.metadata?.attachments?.map(attachment => attachment.id) || [],
              attachments: event.turn.metadata?.attachments,
            }, { runId: this.activeRunId || undefined, turnId: event.turn.id, itemId: event.turn.id })
            publish('input.durable', {}, { runId: this.activeRunId || undefined, turnId: event.turn.id, itemId: event.turn.id })
          }
          if (existing?.status !== 'committed') {
            publish('input.committed', {}, { runId: this.activeRunId || undefined, turnId: event.turn.id, itemId: event.turn.id })
          }
        }
        break
      case 'input:state': {
        const existing = this.store.getThread(this.threadId)?.inputs[event.inputId]
        if (!existing) {
          publish('input.submitted', { intent: 'steer', text: event.text, attachmentIds: [] }, {
            runId: this.activeRunId || undefined,
            itemId: event.inputId,
          })
          publish('input.durable', {}, { runId: this.activeRunId || undefined, itemId: event.inputId })
        }
        if (event.state === 'accepted') publish('input.accepted', {}, { runId: this.activeRunId || undefined, itemId: event.inputId })
        if (event.state === 'committed' && existing?.status !== 'committed') {
          publish('input.committed', {}, { runId: this.activeRunId || undefined, itemId: event.inputId })
        }
        if (event.state === 'rejected') {
          publish('input.rejected', { reason: event.reason || 'rejected' }, { runId: this.activeRunId || undefined, itemId: event.inputId })
          publish('input.restored', { reason: event.reason || 'rejected' }, { runId: this.activeRunId || undefined, itemId: event.inputId })
        }
        break
      }
      case 'approval:state':
        if (event.state === 'requested') {
          publish('approval.requested', { kind: event.requestKind, toolName: event.toolName }, {
            runId: this.activeRunId || undefined,
            itemId: event.requestId,
          })
          if (event.requestKind === 'permission' && event.toolName) {
            publish('tool.awaiting_approval', { name: event.toolName }, {
              runId: this.activeRunId || undefined,
              itemId: event.requestId,
            })
          }
        } else if (event.state === 'resolved') {
          publish('approval.resolved', { decision: normalizeApprovalDecision(event.requestKind, event.decision) }, {
            runId: this.activeRunId || undefined,
            itemId: event.requestId,
          })
          if (event.requestKind === 'permission' && event.toolName && event.decision !== 'deny') {
            publish('tool.running', { name: event.toolName }, {
              runId: this.activeRunId || undefined,
              itemId: event.requestId,
            })
          }
        } else {
          publish('approval.cancelled', { reason: 'request cancelled' }, {
            runId: this.activeRunId || undefined,
            itemId: event.requestId,
          })
        }
        break
      case 'ask:user':
        break
      case 'tool:call':
        this.ensureRun(publish)
        publish('tool.draft_cleared', {}, { itemId: event.toolCall.id })
        this.proposedTools.add(event.toolCall.id)
        publish('tool.proposed', { name: event.toolCall.name }, {
          runId: this.activeRunId || undefined,
          itemId: event.toolCall.id,
        })
        break
      case 'tool:result':
        publish('tool.draft_cleared', {}, { itemId: event.toolResult.toolCallId })
        if (!this.proposedTools.has(event.toolResult.toolCallId)) {
          publish('tool.proposed', { name: event.toolResult.name }, {
            runId: this.activeRunId || undefined,
            itemId: event.toolResult.toolCallId,
          })
        }
        publish('tool.completed', {
          name: event.toolResult.name,
          outcome: event.toolResult.errorKind === 'abort' ? 'cancelled' : event.toolResult.isError ? 'failed' : 'completed',
          error: event.toolResult.isError ? event.toolResult.output : undefined,
        }, { runId: this.activeRunId || undefined, itemId: event.toolResult.toolCallId })
        break
      case 'stream:start':
        this.ensureRun(publish)
        publish('tool.draft_cleared', {}, { runId: this.activeRunId || undefined })
        this.startStream('answer', publish)
        break
      case 'stream:delta':
        this.startStream('answer', publish)
        publish('stream.delta', { channel: 'answer', text: event.text }, {
          runId: this.activeRunId || undefined,
          itemId: this.streamItemId('answer'),
        })
        break
      case 'stream:thinking_delta':
        this.startStream('thinking', publish)
        publish('stream.delta', { channel: 'thinking', text: event.text }, {
          runId: this.activeRunId || undefined,
          itemId: this.streamItemId('thinking'),
        })
        break
      case 'stream:tool_call_delta':
        this.ensureRun(publish)
        publish('tool.draft_changed', {
          name: event.toolName || 'tool',
          partialJson: event.partialJson,
        }, {
          runId: this.activeRunId || undefined,
          itemId: event.toolCallId,
        })
        break
      case 'stream:usage':
        publish('usage.updated', { usage: event.usage }, { runId: this.activeRunId || undefined })
        break
      case 'stream:end':
        for (const channel of this.startedStreams) {
          publish('stream.ended', { channel, interrupted: event.interrupted === true }, {
            runId: this.activeRunId || undefined,
            itemId: this.streamItemId(channel),
          })
        }
        publish('tool.draft_cleared', {}, { runId: this.activeRunId || undefined })
        this.startedStreams.clear()
        break
      case 'subagent:start': {
        if (event.runKind !== 'spawn_agent') break
        const id = `subagent:${event.agentId}`
        if (!this.runtimeItems.has(id)) {
          this.runtimeItems.add(id)
          publish('runtime.started', { kind: 'subagent', label: event.label }, { itemId: id })
        }
        break
      }
      case 'subagent:end': {
        if (event.runKind !== 'spawn_agent') break
        const id = `subagent:${event.agentId}`
        if (!this.runtimeItems.has(id)) {
          this.runtimeItems.add(id)
          publish('runtime.started', { kind: 'subagent', label: event.agentType }, { itemId: id })
        }
        publish('runtime.completed', {
          kind: 'subagent',
          outcome: event.ok ? 'completed' : 'failed',
          error: event.ok ? undefined : `${event.agentType} failed`,
        }, { itemId: id })
        break
      }
      case 'active:task':
        publish('task.active_changed', {
          task: event.context
            ? {
                ...event.context,
                toolCalls: event.context.toolCalls.map(toolCall => ({ ...toolCall })),
              }
            : null,
        }, { runId: this.activeRunId || undefined })
        break
      case 'fast_context:event': {
        const current = this.store.getThread(this.threadId)?.fastContext
        if (current?.runId !== event.runId || current.status !== 'running') {
          publish('fast_context.started', { runId: event.runId }, { runId: this.activeRunId || undefined })
        }
        publish('fast_context.progressed', {
          runId: event.runId,
          phase: event.event.type === 'phase' ? event.event.phase : undefined,
          files: event.event.type === 'progress' ? event.event.files : undefined,
          hits: event.event.type === 'progress' ? event.event.hits : undefined,
        }, { runId: this.activeRunId || undefined })
        break
      }
      case 'fast_context:complete':
        publish('fast_context.completed', {
          runId: event.runId,
          files: event.result.filesScanned,
          hits: event.result.hits.length,
        }, { runId: this.activeRunId || undefined })
        break
      case 'terminal:sessions':
        for (const session of event.sessions) {
          if (session.status !== 'starting' && session.status !== 'running') continue
          const id = `terminal:${session.id}`
          if (this.runtimeItems.has(id)) continue
          this.runtimeItems.add(id)
          publish('runtime.started', { kind: 'terminal', label: session.title }, { itemId: id })
        }
        break
      case 'runtime-task:finished': {
        const terminalSessionId = event.task.kind === 'terminal' && typeof event.task.metadata?.sessionId === 'string'
          ? event.task.metadata.sessionId
          : null
        const id = terminalSessionId ? `terminal:${terminalSessionId}` : event.task.id
        if (!this.runtimeItems.has(id)) {
          this.runtimeItems.add(id)
          publish('runtime.started', { kind: event.task.kind, label: event.task.command }, { itemId: id })
        }
        publish('runtime.completed', {
          kind: event.task.kind,
          outcome: event.task.status === 'completed' ? 'completed' : event.task.status === 'failed' ? 'failed' : 'cancelled',
          error: event.task.error,
        }, { itemId: id })
        break
      }
      case 'notification':
        publish('notification.raised', {
          priority: event.level === 'error' ? 100 : event.level === 'warning' ? 80 : event.level === 'success' ? 40 : 20,
          category: event.level,
        }, { itemId: `notification-${Date.now()}-${emitted.length}` })
        break
      case 'mode:change':
        publish('session.mode_changed', { mode: event.to }, { runId: this.activeRunId || undefined })
        break
      case 'error':
        this.completeRun('failed', event.error, publish)
        break
      case 'session:complete':
        this.completeRun(this.stopping ? 'interrupted' : 'succeeded', undefined, publish)
        break
    }
    return emitted
  }

  draftChanged(text: string, attachmentIds: string[]): AnyFlowEvent {
    return this.dispatch('input.draft_changed', { text, attachmentIds }, {})
  }

  setPersistenceStatus(error: Error | null): AnyFlowEvent {
    return error
      ? this.dispatch('journal.degraded', { error: error.message }, {})
      : this.dispatch('journal.flushed', { queued: 0, durationMs: 0 }, {})
  }

  updateUsage(usage: import('../../shared/agentTypes').TokenUsage): AnyFlowEvent {
    return this.dispatch('usage.updated', { usage }, { runId: this.activeRunId || undefined })
  }

  presentApproval(requestId: string): AnyFlowEvent {
    return this.dispatch('approval.presented', {}, {
      runId: this.activeRunId || undefined,
      itemId: requestId,
    })
  }

  startRun(objective: string): AnyFlowEvent[] {
    const emitted: AnyFlowEvent[] = []
    const publish = <Type extends FlowEventType>(
      type: Type,
      payload: FlowPayloadFor<Type>,
      identity: { runId?: string; turnId?: string; itemId?: string } = {},
    ) => emitted.push(this.dispatch(type, payload, identity))
    this.ensureRun(publish, objective)
    return emitted
  }

  finishRun(outcome: 'succeeded' | 'failed' | 'interrupted' | 'cancelled', error?: string): AnyFlowEvent[] {
    const emitted: AnyFlowEvent[] = []
    const publish = <Type extends FlowEventType>(
      type: Type,
      payload: FlowPayloadFor<Type>,
      identity: { runId?: string; turnId?: string; itemId?: string } = {},
    ) => emitted.push(this.dispatch(type, payload, identity))
    this.completeRun(outcome, error, publish)
    return emitted
  }

  isForegroundBusy(): boolean {
    const state = this.store.getThread(this.threadId)
    return state ? selectIsForegroundBusy(state) : false
  }

  getQueuedInputs(): FlowPromptProjection[] {
    const state = this.store.getThread(this.threadId)
    return state ? selectQueuedInputs(state) : []
  }

  enqueueInput(input: ConversationQueuedInput): AnyFlowEvent[] {
    const emitted: AnyFlowEvent[] = []
    const state = this.store.getThread(this.threadId)
    if (state?.inputs[input.id] && state.inputQueue.includes(input.id)) return emitted
    const position = state?.inputQueue.length ?? 0
    emitted.push(this.dispatch('input.submitted', {
      intent: 'queued-turn',
      text: input.prompt,
      attachmentIds: input.attachments?.map(attachment => attachment.id) || [],
      attachments: input.attachments,
    }, { itemId: input.id }))
    emitted.push(this.dispatch('input.durable', {}, { itemId: input.id }))
    emitted.push(this.dispatch('input.queued', { position }, { itemId: input.id }))
    return emitted
  }

  replaceQueue(inputs: ConversationQueuedInput[]): AnyFlowEvent[] {
    const emitted: AnyFlowEvent[] = []
    const currentIds = [...(this.store.getThread(this.threadId)?.inputQueue ?? [])]
    for (const id of currentIds) {
      emitted.push(this.dispatch('input.removed', { reason: 'replaced' }, { itemId: id }))
    }
    for (const input of inputs) emitted.push(...this.enqueueInput(input))
    return emitted
  }

  takeNextQueuedInput(): FlowPromptProjection | null {
    const next = this.getQueuedInputs()[0]
    if (!next) return null
    this.dispatch('input.removed', { reason: 'dequeued' }, { itemId: next.id })
    return next
  }

  syncQueue(inputs: ConversationQueuedInput[]): AnyFlowEvent[] {
    const emitted: AnyFlowEvent[] = []
    const nextIds = new Set(inputs.map(input => input.id))
    const currentIds = [...(this.store.getThread(this.threadId)?.inputQueue ?? [])]
    for (const id of currentIds) {
      if (!nextIds.has(id)) emitted.push(this.dispatch('input.removed', { reason: 'dequeued' }, { itemId: id }))
    }
    for (const input of inputs) emitted.push(...this.enqueueInput(input))
    return emitted
  }

  private ensureRun(publish: <Type extends FlowEventType>(type: Type, payload: FlowPayloadFor<Type>, identity?: { runId?: string; turnId?: string; itemId?: string }) => void, objective?: string): void {
    if (this.activeRunId) return
    this.runSequence += 1
    this.activeRunId = `run-${this.threadId}-${this.runSequence}`
    this.stopping = false
    this.proposedTools.clear()
    publish('run.started', { objective }, { runId: this.activeRunId })
  }

  private completeRun(
    outcome: 'succeeded' | 'failed' | 'interrupted' | 'cancelled',
    error: string | undefined,
    publish: <Type extends FlowEventType>(type: Type, payload: FlowPayloadFor<Type>, identity?: { runId?: string; turnId?: string; itemId?: string }) => void,
  ): void {
    if (!this.activeRunId) return
    const runId = this.activeRunId
    publish('run.completed', { outcome, error }, { runId })
    this.activeRunId = null
    this.stopping = false
    this.startedStreams.clear()
    this.proposedTools.clear()
  }

  private startStream(
    channel: 'answer' | 'thinking',
    publish: <Type extends FlowEventType>(type: Type, payload: FlowPayloadFor<Type>, identity?: { runId?: string; turnId?: string; itemId?: string }) => void,
  ): void {
    this.ensureRun(publish)
    if (this.startedStreams.has(channel)) return
    this.startedStreams.add(channel)
    publish('stream.started', { channel }, {
      runId: this.activeRunId || undefined,
      itemId: this.streamItemId(channel),
    })
  }

  private streamItemId(channel: 'answer' | 'thinking'): string {
    return `${this.activeRunId || 'run-none'}-${channel}`
  }

  private dispatch<Type extends FlowEventType>(
    type: Type,
    payload: FlowPayloadFor<Type>,
    identity: { runId?: string; turnId?: string; itemId?: string },
  ): AnyFlowEvent {
    const event = this.factory.create({
      sessionId: this.sessionId,
      threadId: this.threadId,
      type,
      payload,
      ...identity,
    })
    const flowEvent = event as AnyFlowEvent
    this.store.dispatch(flowEvent)
    return flowEvent
  }
}

function normalizeApprovalDecision(kind: 'permission' | 'input', decision?: string): FlowApprovalDecision {
  if (kind === 'input') return 'answered'
  if (decision === 'allow-once' || decision === 'allow-run' || decision === 'allow-session' || decision === 'deny') return decision
  return decision === 'allow' ? 'allow-once' : 'deny'
}
