import type { AgentEventType } from '@turboflux/agent-runtime/agentEngine'
import type { AgentTurn } from '@turboflux/contracts/agentTypes'
import {
  ConversationEventLog,
  ConversationEventNormalizer,
  type AnyAppendConversationEventInput,
  type AnyConversationEvent,
  type ConversationEventWindowSnapshot,
  type FinishConversationRunInput,
  type RecordConversationInputState,
  type StartConversationRunInput,
} from '@turboflux/conversations/events/index'
import { WorkProjectionEngine, type WorkProjectionSnapshot } from '@turboflux/presentation/workProjection'

import type { WorkSessionSnapshot } from '@turboflux/presentation/workTypes'
export type { WorkSessionSnapshot } from '@turboflux/presentation/workTypes'

export class WorkSession {
  private generation = 0
  readonly log: ConversationEventLog
  readonly normalizer: ConversationEventNormalizer
  readonly projection: WorkProjectionEngine

  constructor(sessionId: string, threadId = sessionId) {
    this.log = new ConversationEventLog(sessionId, threadId)
    this.normalizer = new ConversationEventNormalizer(sessionId, threadId)
    this.projection = new WorkProjectionEngine(sessionId, threadId)
  }

  getSnapshot(): WorkSessionSnapshot {
    return {
      schemaVersion: 1,
      window: this.log.getSnapshot(),
      projection: { ...this.projection.getSnapshot(), generation: this.generation },
    }
  }

  startRun(input: StartConversationRunInput): readonly AnyConversationEvent[] {
    return this.append(this.normalizer.startRun(input))
  }

  finishRun(input: FinishConversationRunInput): readonly AnyConversationEvent[] {
    return this.append(this.normalizer.finishRun(input))
  }

  appendAgent(event: AgentEventType, at = Date.now()): readonly AnyConversationEvent[] {
    return this.append(this.normalizer.normalizeAgent(event, { at }))
  }

  recordInputState(input: RecordConversationInputState): readonly AnyConversationEvent[] {
    return this.append(this.normalizer.recordInputState(input))
  }

  acknowledgeNotification(notificationId: string, at = Date.now()): readonly AnyConversationEvent[] {
    return this.append(this.normalizer.acknowledgeNotification(notificationId, at))
  }

  replaceFromTurns(turns: readonly AgentTurn[]): WorkSessionSnapshot {
    this.generation += 1
    const current = this.log.getSnapshot()
    this.normalizer.activate(current.conversationId, current.threadId)
    this.log.replay([])
    this.projection.activate(current.conversationId, current.threadId)
    this.append(this.normalizer.restoreTurns(turns))
    return this.getSnapshot()
  }

  replaceFromEvents(events: readonly AnyConversationEvent[], turns: readonly AgentTurn[] = []): WorkSessionSnapshot {
    this.generation = events.reduce((generation, event) => Math.max(generation, event.generation ?? 0), this.generation)
    const current = this.log.getSnapshot()
    const conversationId = events[0]?.conversationId ?? current.conversationId
    const threadId = events[0]?.threadId ?? current.threadId
    this.normalizer.activate(conversationId, threadId)
    this.log.activate(conversationId, threadId)
    this.log.replay(events)
    this.projection.replace(events)
    this.settleRestoredRun(events, turns)
    return this.getSnapshot()
  }

  activate(sessionId: string, threadId = sessionId, turns: readonly AgentTurn[] = []): WorkSessionSnapshot {
    this.log.activate(sessionId, threadId)
    this.projection.activate(sessionId, threadId)
    return this.replaceFromTurns(turns)
  }

  private append(inputs: readonly AnyAppendConversationEventInput[]): readonly AnyConversationEvent[] {
    const events = this.log.appendMany(inputs.map(input => ({ ...input, generation: this.generation })))
    for (const event of events) this.projection.apply(event)
    return events
  }

  private settleRestoredRun(events: readonly AnyConversationEvent[], turns: readonly AgentTurn[]): void {
    const runId = this.projection.getSnapshot().activeRunId
    if (!runId) return

    const completedStepIds = new Set(events.flatMap(event => (
      event.type === 'step.completed' && event.runId === runId && event.stepId ? [event.stepId] : []
    )))
    const stepEvent = [...events].reverse().find(event => (
      event.runId === runId && event.stepId && !completedStepIds.has(event.stepId)
    ))
    const stepId = stepEvent?.stepId
    const stepStarted = stepId
      ? [...events].reverse().find(event => event.type === 'step.started' && event.stepId === stepId)
      : undefined
    const recoveredTurn = [...turns].reverse().find(turn => (
      turn.role === 'assistant'
      && turn.id.startsWith('recovered-assistant-')
      && (!turn.metadata?.workRunId || turn.metadata.workRunId === runId)
      && (!stepStarted || turn.timestamp >= stepStarted.at)
    ))
    const at = recoveredTurn?.timestamp ?? events.at(-1)?.at ?? Date.now()
    const eventId = (kind: string): string => (
      `${encodeURIComponent(this.log.getSnapshot().threadId)}:canonical:restored:${encodeURIComponent(runId)}:${kind}`
    )
    const terminalEvents: AnyAppendConversationEventInput[] = []

    if (recoveredTurn) {
      const thinking = recoveredTurn.metadata?.thinking?.content
      if (thinking) {
        terminalEvents.push({
          eventId: eventId('thinking:committed'),
          runId,
          turnId: recoveredTurn.id,
          stepId,
          itemId: stepId ? `${stepId}:thinking` : `${recoveredTurn.id}:thinking`,
          at,
          source: 'migration',
          provenance: 'restored',
          type: 'stream.committed',
          payload: { channel: 'thinking', text: thinking },
        })
      }
      if (recoveredTurn.content) {
        terminalEvents.push({
          eventId: eventId('answer:committed'),
          runId,
          turnId: recoveredTurn.id,
          stepId,
          itemId: stepId ? `${stepId}:answer` : `${recoveredTurn.id}:answer`,
          at,
          source: 'migration',
          provenance: 'restored',
          type: 'stream.committed',
          payload: { channel: 'answer', text: recoveredTurn.content },
        })
      }
      terminalEvents.push({
        eventId: eventId('turn:completed'),
        runId,
        turnId: recoveredTurn.id,
        stepId,
        itemId: recoveredTurn.id,
        at,
        source: 'migration',
        provenance: 'restored',
        type: 'turn.completed',
        payload: { turn: recoveredTurn },
      })
    }

    if (stepId) {
      terminalEvents.push({
        eventId: eventId(`step:${encodeURIComponent(stepId)}:completed`),
        runId,
        stepId,
        at,
        source: 'migration',
        provenance: 'restored',
        type: 'step.completed',
        payload: {
          index: stepStarted?.type === 'step.started' ? stepStarted.payload.index : 1,
          outcome: 'interrupted',
        },
      })
    }
    terminalEvents.push({
      eventId: eventId('run:completed'),
      runId,
      at,
      source: 'migration',
      provenance: 'restored',
      type: 'run.completed',
      payload: { outcome: 'interrupted' },
    })
    this.append(terminalEvents)
  }
}
