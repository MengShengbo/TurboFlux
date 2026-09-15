import type { AgentMode, AgentTurn, NativeReasoningConfig, TokenUsage } from '../shared/agentTypes'
import type { MemoryKind, MemoryScope } from '../shared/memoryTypes'
import type { ModelCapabilities } from '../core/config'

export interface APIConfig {
  provider: 'openai' | 'anthropic' | 'deepseek' | 'kimi' | 'glm' | 'openrouter' | 'custom'
  apiKey: string
  baseUrl: string
  defaultModel: string
  contextWindow?: number
  maxTokens?: number
  maxOutputTokens?: number
  modelCapabilities?: ModelCapabilities
  reasoning?: NativeReasoningConfig
  temperature?: number
  customHeaders?: Record<string, string>
}

export interface APIModel {
  id: string
  name: string
  provider: string
  contextWindow: number
  maxTokens: number
  maxOutputTokens?: number
  supportsThinking?: boolean
  supportsVision?: boolean
}

export interface WorkspaceInfo {
  path: string
  name: string
}

export type ContextHandoffFileOperation = 'read' | 'write' | 'edit' | 'delete'

export interface ContextHandoffFacts {
  originalGoal?: { turnId: string; text: string }
  userRequirements: Array<{ turnId: string; text: string }>
  files: Array<{
    path: string
    operations: ContextHandoffFileOperation[]
    lastTool?: string
    lastStatus?: 'success' | 'error' | 'unknown'
  }>
  commands: Array<{
    toolCallId: string
    tool: string
    command: string
    status: 'success' | 'error' | 'unknown'
    result?: string
  }>
  decisions: Array<{ toolCallId: string; question: string; answer: string }>
  errors: Array<{ toolCallId: string; tool: string; summary: string }>
  progress: Array<{ turnId: string; text: string }>
  workspace: {
    path?: string
    gitStatus?: string
    memory?: string
    taskTree?: string
    activeTask?: string
  }
}

export interface ContextHandoff {
  version: 1
  revision: number
  createdAt: number
  startMessageId: string
  endMessageId: string
  coveredTurnIds: string[]
  source: 'compact' | 'manual'
  summarySource: 'model' | 'deterministic' | 'reused'
  modelSummary: string
  facts: ContextHandoffFacts
  document: string
  compactDocument: string
}

export type ContextCompactionPhase =
  | 'started'
  | 'summarizing'
  | 'fallback'
  | 'committing'
  | 'completed'
  | 'interrupted'
  | 'failed'

export interface ContextCompactionState {
  id: string
  phase: ContextCompactionPhase
  source: 'compact' | 'manual'
  startedAt: number
  updatedAt: number
  elapsedMs: number
  startMessageId?: string
  endMessageId?: string
  oldTurnCount?: number
  originalCharCount?: number
  progress?: number
  summarySource?: 'model' | 'deterministic' | 'reused'
  detail?: string
  error?: string
  recoverable: boolean
}

export interface ContextSegment {
  startMessageId: string
  endMessageId: string
  summary: string
  isModelGenerated: boolean
  kind?: 'recap' | 'compact' | 'manual' | 'structured'
  originalCharCount: number
  isValid: boolean
  createdAt?: number
  coveredTurnIds?: string[]
  handoff?: ContextHandoff
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
  setConversationId?(conversationId: string): void
  getContextSegments(): ContextSegment[]
  addContextSegment(segment: ContextSegment): void
  setContextSegments(segments: ContextSegment[]): void
  getContextReservoir(): ContextReservoirEntry[]
  addContextReservoirEntry(entry: ContextReservoirEntry): void
  setContextReservoir(entries: ContextReservoirEntry[]): void
  getContextCompactionState?(): ContextCompactionState | null
  setContextCompactionState?(state: ContextCompactionState | null): void
  getLanguage(): string

  recordTokenUsage(usage: { model: string; inputTokens: number; outputTokens: number; provider: string; cached?: number; totalInputTokens?: number }): void
}
