import type { AgentMode, AgentTurn, ToolCall, ToolResult } from '../../shared/agentTypes'
import type { ContextSegment } from '../../state/types'
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
  recovery?: {
    interrupted: boolean
    truncatedJournal: boolean
    unresolvedToolCalls: number
  }
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
