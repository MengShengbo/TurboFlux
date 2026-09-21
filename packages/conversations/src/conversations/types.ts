import type { AgentAttachment, AgentCapabilitySelection, AgentMode, AgentTurn, ApprovalPolicy, ModelRequestRecord, ToolCall, ToolResult } from '@turboflux/contracts/agentTypes'
import type { ContextCompactionState, ContextSegment } from '@turboflux/contracts/stateTypes'
import type { ContextReservoirEntry } from '@turboflux/contracts/stateTypes'
import type { WorkExecutionSnapshot } from '@turboflux/contracts/workExecutionTypes'
import type { ModelSurfaceState } from '@turboflux/contracts/modelSurfaceTypes'
import type { WorkflowInstanceState } from '@turboflux/contracts/workflowSurfaceTypes'
import type { AnyConversationEvent } from '../events/index'

export interface ConversationMeta {
  id: string
  title: string
  titleSource?: 'generated' | 'custom'
  workspacePath: string
  createdAt: number
  updatedAt: number
  mode: AgentMode
  model: string
  provider: string
  turnCount: number
}

export interface PersistedConversation extends ConversationMeta {
  turns: AgentTurn[]
  canonicalEvents?: AnyConversationEvent[]
  modelRequests?: ModelRequestRecord[]
  activeTurns?: AgentTurn[]
  contextSegments?: ContextSegment[]
  contextReservoir?: ContextReservoirEntry[]
  contextCompactionState?: ContextCompactionState | null
  workExecution?: WorkExecutionSnapshot
  modelSurface?: ModelSurfaceState
  interactionState?: ConversationInteractionState
  recovery?: {
    interrupted: boolean
    truncatedJournal: boolean
    unresolvedToolCalls: number
  }
}

export interface ConversationQueuedInput {
  id: string
  prompt: string
  attachments?: AgentAttachment[]
  capabilities?: AgentCapabilitySelection
  approvalPolicy?: ApprovalPolicy
  automationId?: string
  automationRunId?: string
}

export interface ConversationPendingPaste {
  placeholder: string
  text: string
}

export interface ConversationDraftState {
  text: string
  attachments?: AgentAttachment[]
  files?: Array<{
    id: string
    type: 'image' | 'file'
    path: string
    mime: string
    filename: string
    size: number
  }>
  pendingPastes?: ConversationPendingPaste[]
  capabilities?: AgentCapabilitySelection
}

export interface ConversationPendingSteering {
  id: string
  text: string
}

export interface ConversationPendingApproval {
  requestId: string
  requestKind: 'permission' | 'input'
  question: string
  toolName?: string
  path?: string
}

export interface ConversationInteractionState {
  queuedInputs: ConversationQueuedInput[]
  draft: ConversationDraftState
  pendingSteering: ConversationPendingSteering[]
  pendingApprovals: ConversationPendingApproval[]
  workflow?: WorkflowInstanceState
}

export interface ConversationIndex {
  conversations: ConversationMeta[]
}

export type ConversationJournalEntry =
  | { version: 1; type: 'meta'; timestamp: number; meta: ConversationMeta }
  | { version: 1; type: 'snapshot'; timestamp: number; conversation: PersistedConversation }
  | { version: 1; type: 'turn'; timestamp: number; turn: AgentTurn }
  | { version: 1; type: 'stream_start'; timestamp: number }
  | { version: 1; type: 'stream_delta'; timestamp: number; text: string }
  | { version: 1; type: 'stream_thinking_delta'; timestamp: number; text: string }
  | { version: 1; type: 'stream_end'; timestamp: number; interrupted: boolean }
  | { version: 1; type: 'tool_call'; timestamp: number; toolCall: ToolCall }
  | { version: 1; type: 'tool_result'; timestamp: number; toolResult: ToolResult }
  | {
      version: 1
      type: 'state'
      timestamp: number
      activeTurns: AgentTurn[]
      contextSegments: ContextSegment[]
      contextReservoir: ContextReservoirEntry[]
    }
  | {
      version: 2
      type: 'context_compaction'
      timestamp: number
      state: ContextCompactionState
      activeTurns?: AgentTurn[]
      contextSegments?: ContextSegment[]
      contextReservoir?: ContextReservoirEntry[]
    }
  | { version: 2; type: 'queue_state'; timestamp: number; inputs: ConversationQueuedInput[] }
  | { version: 2; type: 'draft_state'; timestamp: number; draft: ConversationDraftState }
  | { version: 2; type: 'input_state'; timestamp: number; inputId: string; intent: 'steer'; state: 'accepted' | 'committed' | 'rejected'; text: string; reason?: string }
  | { version: 2; type: 'approval_state'; timestamp: number; requestId: string; requestKind: 'permission' | 'input'; state: 'requested' | 'resolved' | 'cancelled'; decision?: string; question: string; toolName?: string; path?: string }
  | { version: 3; type: 'canonical_event'; timestamp: number; event: AnyConversationEvent }
  | { version: 4; type: 'workflow_state'; timestamp: number; workflow: WorkflowInstanceState | null }
