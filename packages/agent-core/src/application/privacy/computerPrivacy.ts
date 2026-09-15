import type { AgentEventType } from '../../core/agentEngine'
import type { ActiveTaskContext } from '../../core/taskManager'
import type { AgentSession, AgentTurn } from '../../shared/agentTypes'
import {
  COMPUTER_DETAIL_REDACTED,
  COMPUTER_ERROR_REDACTED,
  COMPUTER_RESULT_REDACTED,
  redactComputerToolCall,
  redactComputerToolResult,
  redactComputerContextSegments,
  redactComputerReservoir,
  redactComputerSegment,
  redactComputerTurn,
  redactComputerTurns,
  turnContainsComputerActivity,
} from '../../shared/computerPrivacy'
import { isBuiltInComputerTool } from '../../shared/computerToolPresentation'
import type { ContextHandoff, ContextHandoffFacts, ContextReservoirEntry, ContextSegment } from '../../state/types'
import type { ConversationJournalEntry, PersistedConversation } from '../conversations/types'
import type { AnyConversationEvent } from '../events/index'
import type { ModelSurfaceState } from '../../shared/modelSurfaceTypes'

export {
  COMPUTER_DETAIL_REDACTED,
  COMPUTER_ERROR_REDACTED,
  COMPUTER_RESULT_REDACTED,
  redactComputerToolCall,
  redactComputerToolResult,
  redactComputerTurn,
  redactComputerTurns,
} from '../../shared/computerPrivacy'

export { redactComputerContextSegments, redactComputerReservoir } from '../../shared/computerPrivacy'

export function redactComputerActiveTask(context: ActiveTaskContext | null): ActiveTaskContext | null {
  if (!context) return null
  return {
    ...context,
    toolCalls: context.toolCalls.map(toolCall => {
      if (!isBuiltInComputerTool(toolCall.toolName)) return toolCall
      return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        status: toolCall.status,
        result: toolCall.result === undefined
          ? undefined
          : toolCall.status === 'error' || toolCall.status === 'cancelled'
            ? COMPUTER_ERROR_REDACTED
            : COMPUTER_RESULT_REDACTED,
      }
    }),
  }
}

function redactComputerSession(session: AgentSession): AgentSession {
  return {
    ...session,
    turns: redactComputerTurns(session.turns),
    modelSurface: session.modelSurface ? redactComputerModelSurface(session.modelSurface) : undefined,
  }
}

export function redactComputerModelSurface(state: ModelSurfaceState): ModelSurfaceState {
  return {
    ...state,
    events: state.events.map(event => {
      if (event.kind === 'turn') return { ...event, turn: redactComputerTurn(event.turn) }
      if (event.kind === 'replacement') return { ...event, turns: redactComputerTurns(event.turns) }
      return { ...event }
    }),
    snapshotHeads: { ...state.snapshotHeads },
    replacementHistory: (state.replacementHistory ?? []).map(record => ({ ...record })),
    sourceTurnIds: [...(state.sourceTurnIds ?? [])],
    sourceTurnFingerprints: [...(state.sourceTurnFingerprints ?? [])],
  }
}

export function redactComputerAgentEvent(event: AgentEventType, turns: AgentTurn[] = []): AgentEventType {
  switch (event.type) {
    case 'turn:start':
    case 'turn:complete':
      return { ...event, turn: redactComputerTurn(event.turn) }
    case 'tool:call':
      return { ...event, toolCall: redactComputerToolCall(event.toolCall) }
    case 'tool:result':
      return { ...event, toolResult: redactComputerToolResult(event.toolResult) }
    case 'stream:tool_call_delta':
      return isBuiltInComputerTool(event.toolName) ? { ...event, partialJson: '{}' } : event
    case 'session:complete':
      return { ...event, session: redactComputerSession(event.session) }
    case 'active:task':
      return { ...event, context: redactComputerActiveTask(event.context) }
    case 'task:system':
      return { ...event, context: redactComputerActiveTask(event.context) }
    case 'context:segment_created':
      return { ...event, segment: redactComputerSegment(event.segment, turns) }
    default:
      return event
  }
}

export function redactComputerConversation(conversation: PersistedConversation): PersistedConversation {
  const reservoirTurns = conversation.contextReservoir?.flatMap(entry => entry.turns) || []
  const allTurns = [
    ...conversation.turns,
    ...(conversation.activeTurns || []),
    ...reservoirTurns,
  ]
  return {
    ...conversation,
    turns: redactComputerTurns(conversation.turns),
    activeTurns: conversation.activeTurns ? redactComputerTurns(conversation.activeTurns) : undefined,
    contextSegments: conversation.contextSegments
      ? redactComputerContextSegments(conversation.contextSegments, allTurns)
      : undefined,
    contextReservoir: conversation.contextReservoir
      ? redactComputerReservoir(conversation.contextReservoir)
      : undefined,
    modelSurface: conversation.modelSurface
      ? redactComputerModelSurface(conversation.modelSurface)
      : undefined,
    canonicalEvents: conversation.canonicalEvents?.map(event => redactComputerCanonicalEvent(event)),
  }
}

function redactComputerCanonicalEvent(event: AnyConversationEvent): AnyConversationEvent {
  switch (event.type) {
    case 'turn.started':
    case 'turn.completed':
      return {
        ...event,
        payload: { ...event.payload, turn: redactComputerTurn(event.payload.turn) },
      }
    case 'tool.delta':
      return isBuiltInComputerTool(event.payload.toolName)
        ? { ...event, payload: { ...event.payload, partialJson: '{}' } }
        : event
    case 'tool.proposed':
      return {
        ...event,
        payload: { ...event.payload, toolCall: redactComputerToolCall(event.payload.toolCall) },
      }
    case 'tool.completed':
      return {
        ...event,
        payload: { ...event.payload, toolResult: redactComputerToolResult(event.payload.toolResult) },
      }
    default:
      return event
  }
}

export function redactComputerJournalEntry(entry: ConversationJournalEntry): ConversationJournalEntry {
  switch (entry.type) {
    case 'snapshot':
      return { ...entry, conversation: redactComputerConversation(entry.conversation) }
    case 'turn':
      return { ...entry, turn: redactComputerTurn(entry.turn) }
    case 'tool_call':
      return { ...entry, toolCall: redactComputerToolCall(entry.toolCall) }
    case 'tool_result':
      return { ...entry, toolResult: redactComputerToolResult(entry.toolResult) }
    case 'state': {
      const allTurns = [...entry.activeTurns, ...entry.contextReservoir.flatMap(item => item.turns)]
      return {
        ...entry,
        activeTurns: redactComputerTurns(entry.activeTurns),
        contextSegments: redactComputerContextSegments(entry.contextSegments, allTurns),
        contextReservoir: redactComputerReservoir(entry.contextReservoir),
      }
    }
    case 'context_compaction': {
      const activeTurns = entry.activeTurns || []
      const reservoir = entry.contextReservoir || []
      const allTurns = [...activeTurns, ...reservoir.flatMap(item => item.turns)]
      return {
        ...entry,
        activeTurns: entry.activeTurns ? redactComputerTurns(entry.activeTurns) : undefined,
        contextSegments: entry.contextSegments
          ? redactComputerContextSegments(entry.contextSegments, allTurns)
          : undefined,
        contextReservoir: entry.contextReservoir
          ? redactComputerReservoir(entry.contextReservoir)
          : undefined,
      }
    }
    case 'canonical_event':
      return { ...entry, event: redactComputerCanonicalEvent(entry.event) }
    default:
      return entry
  }
}
