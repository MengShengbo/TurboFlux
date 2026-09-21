import type { AgentEventType } from '@turboflux/agent-runtime/agentEngine'
import type { AgentAttachment, AgentCapabilitySelection, AgentRunState, AgentTurn, ApprovalPolicy } from '@turboflux/contracts/agentTypes'
import type { WorkRun } from '@turboflux/contracts/workExecutionTypes'
import type {
  AnyAppendConversationEventInput,
  AppendConversationEventInput,
  ConversationEventProvenance,
  ConversationEventType,
  ConversationRunOutcome,
  ConversationStepOutcome,
  ConversationStreamChannel,
} from '@turboflux/contracts/conversationEvent'

export interface ConversationEventNormalizerOptions {
  now?: () => number
}

export interface NormalizeAgentEventOptions {
  at?: number
  provenance?: ConversationEventProvenance
}

export interface StartConversationRunInput {
  runId: string
  objective?: string
  at?: number
  provenance?: ConversationEventProvenance
}

export interface FinishConversationRunInput {
  outcome: ConversationRunOutcome
  error?: string
  at?: number
  provenance?: ConversationEventProvenance
  run?: WorkRun
  state?: AgentRunState
}

export interface RecordConversationInputState {
  inputId: string
  intent: 'turn' | 'steer' | 'queued-turn'
  state: string
  text?: string
  reason?: string
  attachments?: AgentAttachment[]
  capabilities?: AgentCapabilitySelection
  approvalPolicy?: ApprovalPolicy
  automationId?: string
  automationRunId?: string
  runId?: string
  turnId?: string
  at?: number
  provenance?: ConversationEventProvenance
}

function encoded(value: string): string {
  return encodeURIComponent(value)
}

function stepOutcome(outcome: ConversationRunOutcome): ConversationStepOutcome {
  if (outcome === 'completed' || outcome === 'partial') return 'completed'
  if (outcome === 'failed') return 'failed'
  if (outcome === 'cancelled') return 'cancelled'
  return 'interrupted'
}

export class ConversationEventNormalizer {
  private readonly now: () => number
  private conversationId: string
  private threadId: string
  private runId: string | undefined
  private runTerminal = false
  private fallbackRunSequence = 0
  private stepIndex = 0
  private currentStepId: string | undefined
  private currentStepOpen = false
  private readonly activeChannels = new Set<ConversationStreamChannel>()
  private readonly deltaSequences = new Map<ConversationStreamChannel, number>()
  private runStateSequence = 0
  private runtimeSequence = 0
  private notificationSequence = 0

  constructor(conversationId: string, threadId = conversationId, options: ConversationEventNormalizerOptions = {}) {
    this.conversationId = conversationId
    this.threadId = threadId
    this.now = options.now ?? Date.now
  }

  activate(conversationId: string, threadId = conversationId, at = this.now()): readonly AnyAppendConversationEventInput[] {
    const previousConversationId = this.conversationId
    this.conversationId = conversationId
    this.threadId = threadId
    this.resetRun()
    return [this.event('conversation.activated', { previousConversationId }, {
      at,
      source: 'workbench',
      provenance: 'live',
      eventId: this.eventId('conversation', 'activated', String(at)),
    })]
  }

  startRun(input: StartConversationRunInput): readonly AnyAppendConversationEventInput[] {
    if (this.runId && !this.runTerminal) {
      if (this.runId === input.runId) return []
      throw new Error(`Cannot start run ${input.runId} while run ${this.runId} is active`)
    }
    this.runId = input.runId
    this.runTerminal = false
    this.stepIndex = 0
    this.currentStepId = undefined
    this.currentStepOpen = false
    this.activeChannels.clear()
    this.deltaSequences.clear()
    this.runStateSequence = 0
    return [this.event('run.started', { objective: input.objective }, {
      at: input.at,
      source: 'workbench',
      provenance: input.provenance,
      runId: input.runId,
      eventId: this.eventId('run', input.runId, 'started'),
    })]
  }

  finishRun(input: FinishConversationRunInput): readonly AnyAppendConversationEventInput[] {
    if (!this.runId || this.runTerminal) return []
    const events: AnyAppendConversationEventInput[] = []
    if (this.currentStepOpen) {
      events.push(...this.finishStep(stepOutcome(input.outcome), input.at, input.provenance, input.error))
    }
    const runId = this.runId
    events.push(this.event('run.completed', {
      outcome: input.outcome,
      error: input.error,
      ...(input.run ? { run: input.run } : {}),
      ...(input.state ? { state: input.state } : {}),
    }, {
      at: input.at,
      source: 'workbench',
      provenance: input.provenance,
      runId,
      eventId: input.provenance === 'restored'
        ? this.eventId('run', runId, 'restored', 'completed')
        : this.eventId('run', runId, 'completed'),
    }))
    this.runTerminal = true
    return events
  }

  recordInputState(input: RecordConversationInputState): readonly AnyAppendConversationEventInput[] {
    return [this.event('input.state_changed', {
      inputId: input.inputId,
      intent: input.intent,
      state: input.state,
      text: input.text,
      reason: input.reason,
      attachments: input.attachments,
      capabilities: input.capabilities,
      approvalPolicy: input.approvalPolicy,
      automationId: input.automationId,
      automationRunId: input.automationRunId,
    }, {
      at: input.at,
      source: 'workbench',
      provenance: input.provenance,
      runId: input.runId || this.runId,
      turnId: input.turnId,
      itemId: input.inputId,
      eventId: this.eventId('input', input.inputId, input.state),
    })]
  }

  acknowledgeNotification(notificationId: string, at = this.now()): readonly AnyAppendConversationEventInput[] {
    return [this.event('notification.acknowledged', { notificationId }, {
      at,
      source: 'workbench',
      provenance: 'live',
      itemId: notificationId,
      eventId: this.eventId('notification', notificationId, 'acknowledged'),
    })]
  }

  normalizeAgent(event: AgentEventType, options: NormalizeAgentEventOptions = {}): readonly AnyAppendConversationEventInput[] {
    const at = options.at ?? this.now()
    const provenance = options.provenance ?? 'live'
    switch (event.type) {
      case 'run:state': {
        // Only the run owner can settle the canonical lifecycle. Engine state
        // changes may precede final task accounting and promise cleanup.
        if (['idle', 'completed', 'recoverable_error'].includes(event.state.phase) || this.runTerminal) return []
        this.ensureRun(undefined, at, provenance)
        this.runStateSequence += 1
        return [this.event('run.state_changed', { state: event.state }, {
          at,
          source: 'agent',
          provenance,
          runId: this.runId,
          eventId: this.eventId('run', this.runId!, 'state', String(this.runStateSequence)),
        })]
      }
      case 'turn:start': {
        if (event.turn.role === 'user') {
          this.ensureRun(event.turn.metadata?.workRunId || event.turn.id, at, provenance, event.turn.content)
        }
        return [this.turnEvent('turn.started', event.turn, at, provenance)]
      }
      case 'turn:complete': {
        const events: AnyAppendConversationEventInput[] = []
        const stepId = this.currentStepId
        if (event.turn.role === 'assistant') {
          const thinking = event.turn.metadata?.thinking?.content
          if (thinking) events.push(this.committedStreamEvent('thinking', thinking, event.turn.id, stepId, at, provenance))
          if (event.turn.content) events.push(this.committedStreamEvent('answer', event.turn.content, event.turn.id, stepId, at, provenance))
        }
        events.push(this.turnEvent('turn.completed', event.turn, at, provenance, stepId))
        return events
      }
      case 'stream:start':
        this.ensureRun(undefined, at, provenance)
        return [this.startStep(at, provenance)]
      case 'stream:delta':
        return this.streamDelta('answer', event.text, at, provenance)
      case 'stream:thinking_delta':
        return this.streamDelta('thinking', event.text, at, provenance)
      case 'stream:end':
        return this.finishStep(event.interrupted ? 'interrupted' : 'completed', at, provenance)
      case 'stream:tool_call_delta': {
        const stepId = this.ensureStep(at, provenance).stepId
        return [this.event('tool.delta', {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          partialJson: event.partialJson,
        }, {
          at,
          source: 'agent',
          provenance,
          runId: this.runId,
          stepId,
          itemId: event.toolCallId,
          eventId: this.eventId('tool', event.toolCallId, 'delta', String(this.nextRuntimeSequence())),
        })]
      }
      case 'model:request':
        return [this.event('model.request_updated', { request: event.request }, {
          at, source: 'agent', provenance, runId: event.request.runId || this.runId,
          itemId: event.request.id,
          eventId: this.eventId('model-request', event.request.id, String(this.nextRuntimeSequence())),
        })]
      case 'stream:usage':
        return [this.event('usage.updated', { usage: event.usage,
          ...(event.requestId ? { requestId: event.requestId } : {}),
          ...(event.attemptId ? { attemptId: event.attemptId } : {}),
        }, {
          at,
          source: 'agent',
          provenance,
          runId: this.runId,
          stepId: this.currentStepId,
          eventId: this.eventId('usage', this.runId || 'none', String(this.nextRuntimeSequence())),
        })]
      case 'tool:call':
        this.ensureRun(undefined, at, provenance)
        return [this.event('tool.proposed', { toolCall: event.toolCall }, {
          at,
          source: 'agent',
          provenance,
          runId: this.runId,
          stepId: this.currentStepId,
          itemId: event.toolCall.id,
          eventId: this.eventId('tool', event.toolCall.id, 'proposed'),
        })]
      case 'tool:result':
        return [this.event('tool.completed', { toolResult: event.toolResult }, {
          at,
          source: 'agent',
          provenance,
          runId: this.runId,
          stepId: this.currentStepId,
          itemId: event.toolResult.toolCallId,
          eventId: this.eventId('tool', event.toolResult.toolCallId, 'completed'),
        })]
      case 'approval:state': {
        if (!this.runId || this.runTerminal) return []
        const type = event.state === 'requested'
          ? 'approval.requested'
          : event.state === 'resolved'
            ? 'approval.resolved'
            : 'approval.cancelled'
        if (type === 'approval.requested') {
          return [this.event(type, {
            requestId: event.requestId,
            kind: event.requestKind,
            question: event.question,
            options: event.options,
            reason: event.reason,
            toolName: event.toolName,
            path: event.path,
            ui: event.ui,
          }, this.itemCoordinates(event.requestId, type, at, provenance))]
        }
        if (type === 'approval.resolved') {
          return [this.event(type, { requestId: event.requestId, decision: event.decision }, this.itemCoordinates(event.requestId, type, at, provenance))]
        }
        return [this.event(type, { requestId: event.requestId, reason: 'request cancelled' }, this.itemCoordinates(event.requestId, type, at, provenance))]
      }
      case 'input:state':
        return [this.event('input.state_changed', {
          inputId: event.inputId,
          intent: 'steer',
          state: event.state,
          text: event.text,
          reason: event.reason,
        }, {
          at,
          source: 'agent',
          provenance,
          runId: this.runId,
          itemId: event.inputId,
          eventId: this.eventId('input', event.inputId, event.state),
        })]
      case 'context:compaction_started':
      case 'context:compaction_summarizing':
      case 'context:compaction_fallback':
      case 'context:compaction_committing':
      case 'context:compaction_progress':
      case 'context:compaction_completed':
      case 'context:compaction_interrupted':
      case 'context:compaction_failed':
        return [this.event('context.compaction', { state: event.state }, {
          at,
          source: 'agent',
          provenance,
          runId: this.runId,
          eventId: this.eventId('context', event.type, String(this.nextRuntimeSequence())),
        })]
      case 'notification':
        this.notificationSequence += 1
        return [this.event('notification.raised', { level: event.level, message: event.message }, {
          at,
          source: 'agent',
          provenance,
          runId: this.runId,
          itemId: `notification-${this.notificationSequence}`,
          eventId: this.eventId('notification', String(this.notificationSequence)),
        })]
      case 'work:execution': {
        const current = event.snapshot.runs.find(run => run.id === this.runId)
        if (current && ['completed', 'partial', 'failed', 'cancelled'].includes(current.status)) return []
        return [this.event('execution.updated', { snapshot: event.snapshot }, {
          at,
          source: 'agent',
          provenance,
          runId: this.runId,
          eventId: this.eventId('execution', String(this.nextRuntimeSequence())),
        })]
      }
      case 'error':
      case 'session:complete':
        return []
      case 'ask:user':
        return []
      default:
        return [this.event('runtime.event', { kind: event.type, payload: event }, {
          at,
          source: 'agent',
          provenance,
          runId: this.runId,
          stepId: this.currentStepId,
          eventId: this.eventId('runtime', event.type, String(this.nextRuntimeSequence())),
        })]
    }
  }

  restoreTurns(turns: readonly AgentTurn[]): readonly AnyAppendConversationEventInput[] {
    this.resetRun()
    const events: AnyAppendConversationEventInput[] = []
    let lastTurnAt: number | undefined
    for (const turn of turns) {
      const at = turn.timestamp
      if (turn.role === 'user') {
        if (lastTurnAt !== undefined) {
          events.push(...this.finishRun({ outcome: 'interrupted', at: lastTurnAt, provenance: 'restored' }))
        }
        this.ensureRun(turn.metadata?.workRunId || turn.id, at, 'restored', turn.content)
        events.push(this.turnEvent('turn.started', turn, at, 'restored'))
        lastTurnAt = at
        continue
      }
      if (turn.role === 'assistant') {
        this.ensureRun(turn.metadata?.workRunId, at, 'restored')
        const started = this.startStep(at, 'restored')
        events.push(started)
        const thinking = turn.metadata?.thinking?.content
        if (thinking) events.push(this.committedStreamEvent('thinking', thinking, turn.id, started.stepId, at, 'restored'))
        if (turn.content) events.push(this.committedStreamEvent('answer', turn.content, turn.id, started.stepId, at, 'restored'))
        events.push(...this.finishStep(turn.metadata?.interrupted ? 'interrupted' : 'completed', at, 'restored'))
        events.push(this.turnEvent('turn.completed', turn, at, 'restored', started.stepId))
        for (const toolCall of turn.toolCalls || []) {
          events.push(this.event('tool.proposed', { toolCall }, {
            at,
            source: 'migration',
            provenance: 'restored',
            runId: this.runId,
            turnId: turn.id,
            stepId: started.stepId,
            itemId: toolCall.id,
            eventId: this.eventId('tool', toolCall.id, 'proposed'),
          }))
        }
        const interrupted = turn.metadata?.interrupted === true
        if (interrupted || !turn.toolCalls?.length) {
          events.push(...this.finishRun({
            outcome: interrupted ? 'interrupted' : 'completed',
            at,
            provenance: 'restored',
          }))
        }
        lastTurnAt = at
        continue
      }
      this.ensureRun(turn.metadata?.workRunId, at, 'restored')
      for (const toolResult of turn.toolResults || []) {
        events.push(this.event('tool.completed', { toolResult }, {
          at,
          source: 'migration',
          provenance: 'restored',
          runId: turn.metadata?.workRunId || this.runId,
          stepId: this.currentStepId,
          itemId: toolResult.toolCallId,
          eventId: this.eventId('tool', toolResult.toolCallId, 'completed'),
        }))
      }
      lastTurnAt = at
    }
    if (lastTurnAt !== undefined) {
      events.push(...this.finishRun({ outcome: 'interrupted', at: lastTurnAt, provenance: 'restored' }))
    }
    this.resetRun()
    return events
  }

  private streamDelta(
    channel: ConversationStreamChannel,
    text: string,
    at: number,
    provenance: ConversationEventProvenance,
  ): readonly AnyAppendConversationEventInput[] {
    const { stepId, started } = this.ensureStep(at, provenance)
    const events: AnyAppendConversationEventInput[] = [...started]
    if (!this.activeChannels.has(channel)) {
      this.activeChannels.add(channel)
      this.deltaSequences.set(channel, 0)
      events.push(this.event('stream.started', { channel }, {
        at,
        source: 'agent',
        provenance,
        runId: this.runId,
        stepId,
        itemId: `${stepId}:${channel}`,
        eventId: this.eventId('stream', stepId, channel, 'started'),
      }))
    }
    const deltaSequence = (this.deltaSequences.get(channel) ?? 0) + 1
    this.deltaSequences.set(channel, deltaSequence)
    events.push(this.event('stream.delta', { channel, text }, {
      at,
      source: 'agent',
      provenance,
      runId: this.runId,
      stepId,
      itemId: `${stepId}:${channel}`,
      eventId: this.eventId('stream', stepId, channel, 'delta', String(deltaSequence)),
    }))
    return events
  }

  private startStep(at: number, provenance: ConversationEventProvenance): AppendConversationEventInput<'step.started'> {
    this.stepIndex += 1
    this.currentStepId = `${this.runId || this.threadId}:step:${this.stepIndex}`
    this.currentStepOpen = true
    this.activeChannels.clear()
    this.deltaSequences.clear()
    return this.event('step.started', { index: this.stepIndex }, {
      at,
      source: 'agent',
      provenance,
      runId: this.runId,
      stepId: this.currentStepId,
      eventId: this.eventId('step', this.currentStepId, 'started'),
    })
  }

  private ensureStep(at: number, provenance: ConversationEventProvenance): {
    stepId: string
    started: readonly AnyAppendConversationEventInput[]
  } {
    this.ensureRun(undefined, at, provenance)
    if (this.currentStepOpen && this.currentStepId) return { stepId: this.currentStepId, started: [] }
    const started = this.startStep(at, provenance)
    return { stepId: started.stepId!, started: [started] }
  }

  private finishStep(
    outcome: ConversationStepOutcome,
    at = this.now(),
    provenance: ConversationEventProvenance = 'live',
    error?: string,
  ): readonly AnyAppendConversationEventInput[] {
    if (!this.currentStepOpen || !this.currentStepId) return []
    const stepId = this.currentStepId
    const events: AnyAppendConversationEventInput[] = []
    for (const channel of this.activeChannels) {
      events.push(this.event('stream.ended', { channel, interrupted: outcome !== 'completed' }, {
        at,
        source: 'agent',
        provenance,
        runId: this.runId,
        stepId,
        itemId: `${stepId}:${channel}`,
        eventId: this.eventId('stream', stepId, channel, 'ended'),
      }))
    }
    events.push(this.event('step.completed', { index: this.stepIndex, outcome, error }, {
      at,
      source: 'agent',
      provenance,
      runId: this.runId,
      stepId,
      eventId: this.eventId('step', stepId, 'completed'),
    }))
    this.currentStepOpen = false
    this.activeChannels.clear()
    this.deltaSequences.clear()
    return events
  }

  private ensureRun(
    preferredRunId: string | undefined,
    at: number,
    provenance: ConversationEventProvenance,
    objective?: string,
  ): void {
    if (this.runId && !this.runTerminal) return
    const runId = preferredRunId || `${this.threadId}:run:${++this.fallbackRunSequence}`
    this.startRun({ runId, objective, at, provenance })
  }

  private turnEvent<Type extends 'turn.started' | 'turn.completed'>(
    type: Type,
    turn: AgentTurn,
    at: number,
    provenance: ConversationEventProvenance,
    stepId = this.currentStepId,
  ): AppendConversationEventInput<Type> {
    return this.event(type, { turn }, {
      at,
      source: provenance === 'restored' ? 'migration' : 'agent',
      provenance,
      runId: turn.metadata?.workRunId || this.runId,
      turnId: turn.id,
      stepId,
      itemId: turn.id,
      eventId: this.eventId('turn', turn.id, type === 'turn.started' ? 'started' : 'completed'),
    })
  }

  private committedStreamEvent(
    channel: ConversationStreamChannel,
    text: string,
    turnId: string,
    stepId: string | undefined,
    at: number,
    provenance: ConversationEventProvenance,
  ): AppendConversationEventInput<'stream.committed'> {
    return this.event('stream.committed', { channel, text }, {
      at,
      source: provenance === 'restored' ? 'migration' : 'agent',
      provenance,
      runId: this.runId,
      turnId,
      stepId,
      itemId: stepId ? `${stepId}:${channel}` : `${turnId}:${channel}`,
      eventId: this.eventId('turn', turnId, channel, 'committed'),
    })
  }

  private itemCoordinates(itemId: string, type: ConversationEventType, at: number, provenance: ConversationEventProvenance) {
    return {
      at,
      source: 'agent' as const,
      provenance,
      runId: this.runId,
      stepId: this.currentStepId,
      itemId,
      eventId: this.eventId('item', itemId, type),
    }
  }

  private event<Type extends ConversationEventType>(
    type: Type,
    payload: AppendConversationEventInput<Type>['payload'],
    coordinates: Omit<AppendConversationEventInput<Type>, 'type' | 'payload'>,
  ): AppendConversationEventInput<Type> {
    return { type, payload, ...coordinates }
  }

  private eventId(...parts: string[]): string {
    return `${encoded(this.threadId)}:canonical:${parts.map(encoded).join(':')}`
  }

  private nextRuntimeSequence(): number {
    this.runtimeSequence += 1
    return this.runtimeSequence
  }

  private resetRun(): void {
    this.runId = undefined
    this.runTerminal = false
    this.stepIndex = 0
    this.currentStepId = undefined
    this.currentStepOpen = false
    this.activeChannels.clear()
    this.deltaSequences.clear()
    this.runStateSequence = 0
    this.runtimeSequence = 0
    this.notificationSequence = 0
  }
}
