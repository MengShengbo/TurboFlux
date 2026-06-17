import type { AgentMode, AgentTurn } from '../../shared/agentTypes'
import type { ContextSegment } from '../../state/types'

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
  contextSegments?: ContextSegment[]
}

export interface ConversationIndex {
  conversations: ConversationMeta[]
}
