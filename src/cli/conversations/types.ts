import type { AgentAttachment, AgentMode, AgentTurn, ToolCall, ToolResult } from '../../shared/agentTypes'
import type { ContextCompactionState, ContextSegment } from '../../state/types'
import type { ContextReservoirEntry } from '../../state/types'

export interface ConversationMeta {
  id: string
  title: string
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
  activeTurns?: AgentTurn[]
  contextSegments?: ContextSegment[]
  contextReservoir?: ContextReservoirEntry[]
  contextCompactionState?: ContextCompactionState | null
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
}

export interface ConversationPendingPaste {
  placeholder: string
  text: string
}

export interface ConversationDraftState {
  text: string
  attachments?: AgentAttachment[]
  pendingPastes?: ConversationPendingPaste[]
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
