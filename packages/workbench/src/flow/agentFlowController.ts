import type { AgentEventType } from '@turboflux/agent-runtime/agentEngine'
import { describeBrowserToolActivity } from '@turboflux/contracts/browserToolPresentation'
import { describeComputerToolActivity } from '@turboflux/contracts/computerToolPresentation'
import { FlowEventFactory, type AnyFlowEvent, type FlowApprovalDecision, type FlowEventType, type FlowPayloadFor } from '@turboflux/contracts/flowEvents'
import type { ConversationQueuedInput } from '@turboflux/conversations/conversations/index'
import { FlowStore } from './flowStore'
import { selectIsForegroundBusy, selectQueuedInputs, type FlowPromptProjection } from './flowSelectors'

export type AgentFlowEventListener = (event: AnyFlowEvent) => void

function resultSummary(text: string | undefined): string | undefined {
  const normalized = text
    ?.replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return undefined
  const sentenceEnd = normalized.search(/[。！？!?]/)
  const sentence = sentenceEnd >= 0 ? normalized.slice(0, sentenceEnd + 1) : normalized
  return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence
}

export class AgentFlowController {
  readonly store = new FlowStore()
  private readonly listeners = new Set<AgentFlowEventListener>()
  private readonly factory: FlowEventFactory
  private threadId: string
  private sessionId: string
  private activeRunId: string | null = null
  private activeObjective: string | undefined
  private activeResult: string | undefined
  private streamedAnswer = ''
  private runSequence = 0
  private streamSequence = 0
  private stopping = false
  private readonly startedStreams = new Set<'answer' | 'thinking'>()
  private readonly sampledStreams = new Set<'answer' | 'thinking'>()
  private readonly sampledToolDrafts = new Set<string>()
  private readonly proposedTools = new Set<string>()
  private readonly runtimeItems = new Set<string>()
  private notificationSequence = 0

  constructor(sessionId: string, factory = new FlowEventFactory()) {
    this.factory = factory
    this.sessionId = sessionId
    this.threadId = sessionId
    this.store.activateThread(sessionId, sessionId)
  }

  subscribe(listener: AgentFlowEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  activateThread(sessionId: string, threadId = sessionId): void {
    const previousThreadId = this.threadId
    const threadWasEvicted = !this.store.getThread(threadId)
    this.sessionId = sessionId
    this.threadId = threadId
    this.activeRunId = null
    this.activeObjective = undefined
    this.activeResult = undefined
    this.streamedAnswer = ''
    this.streamSequence = 0
    this.stopping = false
    this.startedStreams.clear()
    this.sampledStreams.clear()
    this.sampledToolDrafts.clear()
    this.proposedTools.clear()
    this.runtimeItems.clear()
    if (threadWasEvicted) this.factory.reset(threadId)
    this.store.activateThread(sessionId, threadId)
    this.dispatch('thread.activated', { previousThreadId }, {})
  }

  resetForHistoryRewrite(): void {
    this.activeRunId = null
    this.activeObjective = undefined
    this.activeResult = undefined
    this.streamedAnswer = ''
    this.streamSequence = 0
    this.stopping = false
    this.startedStreams.clear()
    this.sampledStreams.clear()
    this.sampledToolDrafts.clear()
    this.proposedTools.clear()
    this.runtimeItems.clear()
    this.factory.reset(this.threadId)
    this.store.resetThread(this.sessionId, this.threadId)
    this.dispatch('thread.activated', {}, {})
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
          this.ensureRun(publish, undefined, event.turn.metadata?.workRunId)
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
      case 'turn:complete':
        if (event.turn.role === 'assistant') {
          this.activeResult = resultSummary(event.turn.content) || this.activeResult
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
          publish('approval.requested', {
            kind: event.requestKind,
            toolName: flowToolName(event.toolName),
            reason: event.reason,
            question: event.question,
            options: event.options,
            path: event.path,
            ui: event.ui,
          }, {
            runId: this.activeRunId || undefined,
            itemId: event.requestId,
          })
          if (event.requestKind === 'permission' && event.toolName) {
            publish('tool.awaiting_approval', { name: flowToolName(event.toolName) || event.toolName }, {
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
            publish('tool.running', { name: flowToolName(event.toolName) || event.toolName }, {
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
        this.sampledToolDrafts.delete(event.toolCall.id)
        this.ensureRun(publish)
        publish('tool.draft_cleared', {}, {
          runId: this.activeRunId || undefined,
          itemId: event.toolCall.id,
        })
        this.proposedTools.add(event.toolCall.id)
        publish('tool.proposed', { name: flowToolName(event.toolCall.name) || event.toolCall.name }, {
          runId: this.activeRunId || undefined,
          itemId: event.toolCall.id,
        })
        break
      case 'tool:result':
        this.sampledToolDrafts.delete(event.toolResult.toolCallId)
        publish('tool.draft_cleared', {}, {
          runId: this.activeRunId || undefined,
          itemId: event.toolResult.toolCallId,
        })
        if (!this.proposedTools.has(event.toolResult.toolCallId)) {
          publish('tool.proposed', { name: flowToolName(event.toolResult.name) || event.toolResult.name }, {
            runId: this.activeRunId || undefined,
            itemId: event.toolResult.toolCallId,
          })
        }
        publish('tool.completed', {
          name: flowToolName(event.toolResult.name) || event.toolResult.name,
          outcome: event.toolResult.errorKind === 'abort' ? 'cancelled' : event.toolResult.isError ? 'failed' : 'completed',
          error: event.toolResult.isError ? event.toolResult.output : undefined,
        }, { runId: this.activeRunId || undefined, itemId: event.toolResult.toolCallId })
        break
      case 'stream:start':
        this.ensureRun(publish)
        this.streamSequence += 1
        this.streamedAnswer = ''
        publish('tool.draft_cleared', {}, { runId: this.activeRunId || undefined })
        break
      case 'stream:delta':
        this.startStream('answer', publish)
        this.streamedAnswer = `${this.streamedAnswer}${event.text}`.slice(-2_000)
        if (this.sampledStreams.has('answer')) break
        this.sampledStreams.add('answer')
        publish('stream.delta', { channel: 'answer', text: event.text }, {
          runId: this.activeRunId || undefined,
          itemId: this.streamItemId('answer'),
        })
        break
      case 'stream:thinking_delta':
        this.startStream('thinking', publish)
        if (this.sampledStreams.has('thinking')) break
        this.sampledStreams.add('thinking')
        publish('stream.delta', { channel: 'thinking', text: event.text }, {
          runId: this.activeRunId || undefined,
          itemId: this.streamItemId('thinking'),
        })
        break
      case 'stream:tool_call_delta':
        if (this.sampledToolDrafts.has(event.toolCallId)) break
        this.sampledToolDrafts.add(event.toolCallId)
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
        this.activeResult = resultSummary(this.streamedAnswer) || this.activeResult
        for (const channel of this.startedStreams) {
          publish('stream.ended', { channel, interrupted: event.interrupted === true }, {
            runId: this.activeRunId || undefined,
            itemId: this.streamItemId(channel),
          })
        }
        publish('tool.draft_cleared', {}, { runId: this.activeRunId || undefined })
        this.startedStreams.clear()
        this.sampledStreams.clear()
        this.sampledToolDrafts.clear()
        break
      case 'subagent:start': {
        const id = `subagent:${event.agentId}`
        if (!this.runtimeItems.has(id)) {
          this.runtimeItems.add(id)
          publish('runtime.started', { kind: 'subagent', label: event.label }, {
            runId: this.activeRunId || undefined,
            itemId: id,
          })
        }
        break
      }
      case 'subagent:end': {
        const id = `subagent:${event.agentId}`
        if (!this.runtimeItems.has(id)) {
          this.runtimeItems.add(id)
          publish('runtime.started', { kind: 'subagent', label: event.agentType }, {
            runId: this.activeRunId || undefined,
            itemId: id,
          })
        }
        publish('runtime.completed', {
          kind: 'subagent',
          outcome: event.ok ? 'completed' : 'failed',
          error: event.ok ? undefined : `${event.agentType} failed`,
        }, { runId: this.activeRunId || undefined, itemId: id })
        this.runtimeItems.delete(id)
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
      case 'terminal:sessions':
        break
      case 'runtime-task:created':
      case 'runtime-task:updated': {
        if (!event.task.presentation || this.runtimeItems.has(event.task.id)) break
        this.runtimeItems.add(event.task.id)
        publish('runtime.started', {
          kind: event.task.presentation.kind,
          label: event.task.presentation.title,
        }, { runId: this.activeRunId || undefined, itemId: event.task.id })
        break
      }
      case 'runtime-task:finished': {
        const id = event.task.id
        if (!this.runtimeItems.has(id)) {
          if (!event.task.presentation) break
          this.runtimeItems.add(id)
          publish('runtime.started', {
            kind: event.task.presentation.kind,
            label: event.task.presentation.title,
          }, { runId: this.activeRunId || undefined, itemId: id })
        }
        publish('runtime.completed', {
          kind: event.task.kind,
          outcome: event.task.status === 'completed' ? 'completed' : event.task.status === 'failed' ? 'failed' : 'cancelled',
          error: event.task.error,
        }, { runId: this.activeRunId || undefined, itemId: id })
        this.runtimeItems.delete(id)
        break
      }
      case 'notification':
        this.notificationSequence += 1
        publish('notification.raised', {
          priority: event.level === 'error' ? 100 : event.level === 'warning' ? 80 : event.level === 'success' ? 40 : 20,
          category: event.level,
        }, { itemId: `notification-${Date.now()}-${this.notificationSequence}` })
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

  updateUsage(usage: import('@turboflux/contracts/agentTypes').TokenUsage): AnyFlowEvent {
    return this.dispatch('usage.updated', { usage }, { runId: this.activeRunId || undefined })
  }

  acknowledgeNotification(notificationId: string, threadId = this.threadId): AnyFlowEvent | null {
    const thread = this.store.getThread(threadId)
    const notification = thread?.notifications[notificationId]
    if (!notification || notification.acknowledged) return null
    if (threadId === this.threadId) return this.dispatch('notification.acknowledged', {}, { itemId: notificationId })
    const event = this.factory.create({
      sessionId: thread.sessionId,
      threadId,
      type: 'notification.acknowledged',
      payload: {},
      itemId: notificationId,
    })
    this.store.dispatch(event)
    return event
  }

  presentApproval(requestId: string): AnyFlowEvent {
    return this.dispatch('approval.presented', {}, {
      runId: this.activeRunId || undefined,
      itemId: requestId,
    })
  }

  startRun(objective: string, runId?: string): AnyFlowEvent[] {
    const emitted: AnyFlowEvent[] = []
    const publish = <Type extends FlowEventType>(
      type: Type,
      payload: FlowPayloadFor<Type>,
      identity: { runId?: string; turnId?: string; itemId?: string } = {},
    ) => emitted.push(this.dispatch(type, payload, identity))
    this.ensureRun(publish, objective, runId)
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
      capabilities: input.capabilities,
      approvalPolicy: input.approvalPolicy,
      automationId: input.automationId,
      automationRunId: input.automationRunId,
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

  private ensureRun(
    publish: <Type extends FlowEventType>(type: Type, payload: FlowPayloadFor<Type>, identity?: { runId?: string; turnId?: string; itemId?: string }) => void,
    objective?: string,
    runId?: string,
  ): void {
    if (this.activeRunId) {
      if (objective && !this.activeObjective) this.activeObjective = objective
      return
    }
    this.runSequence += 1
    this.activeRunId = runId || `run-${this.threadId}-${this.runSequence}`
    this.activeObjective = objective
    this.activeResult = undefined
    this.streamedAnswer = ''
    this.streamSequence = 0
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
    if (outcome === 'succeeded' || outcome === 'failed') {
      publish('notification.raised', {
        priority: outcome === 'failed' ? 100 : 50,
        category: outcome === 'failed' ? 'run-failed' : 'result-ready',
        message: outcome === 'failed' ? error : this.activeResult || this.activeObjective,
      }, { itemId: `result:${runId}` })
    }
    this.activeRunId = null
    this.activeObjective = undefined
    this.activeResult = undefined
    this.streamedAnswer = ''
    this.stopping = false
    this.startedStreams.clear()
    this.sampledStreams.clear()
    this.sampledToolDrafts.clear()
    this.proposedTools.clear()
  }

  private startStream(
    channel: 'answer' | 'thinking',
    publish: <Type extends FlowEventType>(type: Type, payload: FlowPayloadFor<Type>, identity?: { runId?: string; turnId?: string; itemId?: string }) => void,
  ): void {
    this.ensureRun(publish)
    if (this.streamSequence === 0) this.streamSequence = 1
    if (this.startedStreams.has(channel)) return
    this.startedStreams.add(channel)
    this.sampledStreams.delete(channel)
    publish('stream.started', { channel }, {
      runId: this.activeRunId || undefined,
      itemId: this.streamItemId(channel),
    })
  }

  private streamItemId(channel: 'answer' | 'thinking'): string {
    return `${this.activeRunId || 'run-none'}-stream-${this.streamSequence}-${channel}`
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
    for (const listener of this.listeners) listener(flowEvent)
    return flowEvent
  }
}

function flowToolName(name?: string): string | undefined {
  if (!name) return undefined
  return describeComputerToolActivity(name, {}, 'running')?.title
    || describeBrowserToolActivity(name, {}, 'running')?.title
    || name
}

function normalizeApprovalDecision(kind: 'permission' | 'input', decision?: string): FlowApprovalDecision {
  if (kind === 'input') return 'answered'
  if (decision === 'allow-once' || decision === 'allow-run' || decision === 'allow-session' || decision === 'deny') return decision
  return decision === 'allow' ? 'allow-once' : 'deny'
}
