import type {
  AgentAttachment,
  AgentCapabilitySelection,
  AgentRunState,
  AgentTurn,
  ApprovalPolicy,
  TokenUsage,
  ModelRequestRecord,
  ToolCall,
  ToolResult,
} from './agentTypes'
import type { ContextCompactionState } from './stateTypes'
import type { WorkflowSurfaceSpec } from './workflowSurfaceTypes'
import type { WorkExecutionSnapshot, WorkRun } from './workExecutionTypes'

export const CONVERSATION_EVENT_SCHEMA_VERSION = 1 as const

export type ConversationEventSource = 'agent' | 'flow' | 'workbench' | 'runtime' | 'migration'
export type ConversationEventProvenance = 'live' | 'restored' | 'migrated'
export type ConversationRunOutcome = 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted'
export type ConversationStepOutcome = 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type ConversationStreamChannel = 'answer' | 'thinking'

export interface ConversationEventPayloadMap {
  'conversation.activated': { previousConversationId?: string }
  'run.started': { objective?: string }
  'run.state_changed': { state: AgentRunState }
  'run.completed': { outcome: ConversationRunOutcome; error?: string; run?: WorkRun; state?: AgentRunState }
  'execution.updated': { snapshot: WorkExecutionSnapshot }
  'turn.started': { turn: AgentTurn }
  'turn.completed': { turn: AgentTurn }
  'step.started': { index: number; model?: string; protocol?: string }
  'step.completed': { index: number; outcome: ConversationStepOutcome; error?: string }
  'stream.started': { channel: ConversationStreamChannel }
  'stream.delta': { channel: ConversationStreamChannel; text: string }
  'stream.committed': { channel: ConversationStreamChannel; text: string }
  'stream.ended': { channel: ConversationStreamChannel; interrupted: boolean }
  'tool.delta': { toolCallId: string; toolName: string; partialJson: string }
  'tool.proposed': { toolCall: ToolCall }
  'tool.completed': { toolResult: ToolResult }
  'approval.requested': { requestId: string; kind: 'permission' | 'input'; question: string; options?: string[]; reason?: string; toolName?: string; path?: string; ui?: WorkflowSurfaceSpec }
  'approval.resolved': { requestId: string; decision?: string }
  'approval.cancelled': { requestId: string; reason?: string }
  'input.state_changed': {
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
  }
  'usage.updated': { usage: TokenUsage; requestId?: string; attemptId?: string }
  'model.request_updated': { request: ModelRequestRecord }
  'context.compaction': { state: ContextCompactionState }
  'runtime.event': { kind: string; payload?: unknown }
  'notification.raised': { level: 'info' | 'success' | 'warning' | 'error'; message: string }
  'notification.acknowledged': { notificationId: string }
}

export type ConversationEventType = keyof ConversationEventPayloadMap

export interface ConversationEventEnvelope<T extends ConversationEventType = ConversationEventType> {
  schemaVersion: typeof CONVERSATION_EVENT_SCHEMA_VERSION
  eventId: string
  conversationId: string
  threadId: string
  runId?: string
  turnId?: string
  stepId?: string
  itemId?: string
  seq: number
  generation?: number
  at: number
  source: ConversationEventSource
  provenance: ConversationEventProvenance
  type: T
  payload: ConversationEventPayloadMap[T]
}

export type AnyConversationEvent = {
  [Type in ConversationEventType]: ConversationEventEnvelope<Type>
}[ConversationEventType]

export interface AppendConversationEventInput<T extends ConversationEventType> {
  eventId?: string
  conversationId?: string
  threadId?: string
  runId?: string
  turnId?: string
  stepId?: string
  itemId?: string
  at?: number
  generation?: number
  source: ConversationEventSource
  provenance?: ConversationEventProvenance
  type: T
  payload: ConversationEventPayloadMap[T]
}

export type AnyAppendConversationEventInput = {
  [Type in ConversationEventType]: AppendConversationEventInput<Type>
}[ConversationEventType]

export interface ConversationEventWindowSnapshot {
  schemaVersion: typeof CONVERSATION_EVENT_SCHEMA_VERSION
  conversationId: string
  threadId: string
  baseSeq: number
  lastSeq: number
  eventCount: number
  droppedEventCount: number
  hasMore: boolean
}
