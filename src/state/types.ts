import type { AgentMode, AgentTurn, TokenUsage } from '../shared/agentTypes'
import type { MemoryKind, MemoryScope } from '../shared/memoryTypes'

export interface APIConfig {
  provider: 'openai' | 'anthropic' | 'deepseek' | 'openrouter' | 'custom'
  apiKey: string
  baseUrl: string
  defaultModel: string
  contextWindow?: number
  maxTokens?: number
  temperature?: number
  customHeaders?: Record<string, string>
}

export interface APIModel {
  id: string
  name: string
  provider: string
  contextWindow: number
  maxTokens: number
  supportsThinking?: boolean
  supportsVision?: boolean
}

export interface WorkspaceInfo {
  path: string
  name: string
}

export interface ContextSegment {
  startMessageId: string
  endMessageId: string
  summary: string
  isModelGenerated: boolean
  kind?: 'recap' | 'compact' | 'manual' | 'structured'
  checkpointId?: string
  originalCharCount: number
  isValid: boolean
  createdAt?: number
}

export interface ContextReservoirEntry {
  id: string
  startMessageId: string
  endMessageId: string
  turns: AgentTurn[]
  source: 'compact' | 'manual'
  originalCharCount: number
  createdAt?: number
}

export interface AgentStateProvider {
  getActiveConfig(): APIConfig | null
  getActiveModel(): APIModel | null
  getWorkspace(): WorkspaceInfo | null
  getConversationId(): string | null
  getContextSegments(): ContextSegment[]
  addContextSegment(segment: ContextSegment): void
  setContextSegments(segments: ContextSegment[]): void
  getContextReservoir(): ContextReservoirEntry[]
  addContextReservoirEntry(entry: ContextReservoirEntry): void
  setContextReservoir(entries: ContextReservoirEntry[]): void
  getLanguage(): string

  recordTokenUsage(usage: { model: string; inputTokens: number; outputTokens: number; provider: string; cached?: number; totalInputTokens?: number }): void
}
