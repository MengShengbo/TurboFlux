import type { AgentStateProvider, APIConfig, APIModel, ContextReservoirEntry, ContextSegment, WorkspaceInfo } from '../../state/types'
import type { FastContextModelConfig, ModelCapabilities, TurboFluxApiConfigProfile, TurboFluxProvider } from '../config'
import type { ApprovalPolicy, NativeReasoningConfig } from '../../shared/agentTypes'

export interface AgentRuntimeConfig {
  provider: TurboFluxProvider
  apiKey: string
  baseUrl: string
  model: string
  contextWindow: number
  maxTokens: number
  modelCapabilities?: ModelCapabilities
  approvalPolicy?: ApprovalPolicy
  reasoning?: NativeReasoningConfig
  apiConfigs?: TurboFluxApiConfigProfile[]
  activeApiConfigId?: string
  fastContextModel?: FastContextModelConfig
}

export interface RuntimeTokenUsageEvent {
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  cached?: number
  totalInputTokens?: number
  totalTokens?: number
  cacheHitRate?: number
}

function normalizeContextSegments(segments: ContextSegment[]): ContextSegment[] {
  const normalized: ContextSegment[] = []
  const sorted = segments.slice().sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  for (const segment of sorted) {
    const covered = new Set(segment.coveredTurnIds || [])
    for (let index = normalized.length - 1; index >= 0; index -= 1) {
      const existing = normalized[index]
      const sameBoundary = existing.startMessageId === segment.startMessageId && existing.endMessageId === segment.endMessageId
      const overlaps = covered.size > 0 && (existing.coveredTurnIds || []).some(id => covered.has(id))
      if (sameBoundary || overlaps) normalized.splice(index, 1)
    }
    normalized.push({
      ...segment,
      coveredTurnIds: segment.coveredTurnIds ? [...segment.coveredTurnIds] : undefined,
      createdAt: segment.createdAt ?? Date.now(),
    })
  }
  return normalized
}

export class DefaultAgentStateProvider implements AgentStateProvider {
  private contextSegments: ContextSegment[] = []
  private contextReservoir: ContextReservoirEntry[] = []
  private conversationId: string | null
  private totalTokens = { input: 0, output: 0, cached: 0 }
  private tokenUsageListeners = new Set<(event: RuntimeTokenUsageEvent) => void>()

  constructor(
    private config: AgentRuntimeConfig,
    private workspacePath: string,
    options: { conversationId?: string; conversationPrefix?: string } = {},
  ) {
    const prefix = options.conversationPrefix || 'agent'
    this.conversationId = options.conversationId || `${prefix}-${Date.now()}`
  }

  updateConfig(config: AgentRuntimeConfig): void {
    this.config = config
  }

  getActiveConfig(): APIConfig | null {
    return this.apiConfigFromRuntimeConfig(this.config)
  }

  getFastContextConfig(): APIConfig | null {
    const selected = this.getFastContextProfile()
    if (!selected) return this.getActiveConfig()
    return this.apiConfigFromProfile(selected)
  }

  getFastContextModel(): APIModel | null {
    const selected = this.getFastContextProfile()
    if (!selected) return this.getActiveModel()
    return {
      id: selected.model,
      name: selected.model,
      provider: selected.provider,
      contextWindow: selected.contextWindow,
      maxTokens: selected.maxTokens,
    }
  }

  private getFastContextProfile(): TurboFluxApiConfigProfile | undefined {
    if (this.config.fastContextModel?.mode !== 'api-config') return undefined
    const id = this.config.fastContextModel.apiConfigId
    if (!id) return undefined
    return this.config.apiConfigs?.find(profile => profile.id === id)
  }

  private apiConfigFromRuntimeConfig(config: AgentRuntimeConfig): APIConfig | null {
    if (!config.apiKey || !config.baseUrl || !config.model) return null
    return {
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      defaultModel: config.model,
      contextWindow: config.contextWindow,
      maxTokens: config.maxTokens,
      modelCapabilities: config.modelCapabilities,
      reasoning: config.reasoning,
    }
  }

  private apiConfigFromProfile(profile: TurboFluxApiConfigProfile): APIConfig | null {
    if (!profile.apiKey || !profile.baseUrl || !profile.model) return null
    return {
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      defaultModel: profile.model,
      contextWindow: profile.contextWindow,
      maxTokens: profile.maxTokens,
      modelCapabilities: profile.modelCapabilities,
      reasoning: profile.reasoning,
    }
  }

  getActiveModel(): APIModel | null {
    return {
      id: this.config.model,
      name: this.config.model,
      provider: this.config.provider,
      contextWindow: this.config.contextWindow,
      maxTokens: this.config.maxTokens,
    }
  }

  getWorkspace(): WorkspaceInfo | null {
    return {
      path: this.workspacePath,
      name: this.workspacePath.split(/[\\/]/).pop() || 'workspace',
    }
  }

  getConversationId(): string | null {
    return this.conversationId
  }

  getContextSegments(): ContextSegment[] {
    return this.contextSegments
  }

  addContextSegment(segment: ContextSegment): void {
    this.contextSegments = normalizeContextSegments([...this.contextSegments, segment])
  }

  setContextSegments(segments: ContextSegment[]): void {
    this.contextSegments = normalizeContextSegments(segments)
  }

  getContextReservoir(): ContextReservoirEntry[] {
    return this.contextReservoir
  }

  addContextReservoirEntry(entry: ContextReservoirEntry): void {
    const createdAt = entry.createdAt ?? Date.now()
    const nextEntry = { ...entry, createdAt }
    const existingIndex = this.contextReservoir.findIndex(existing =>
      existing.startMessageId === nextEntry.startMessageId
      && existing.endMessageId === nextEntry.endMessageId
    )

    if (existingIndex >= 0) {
      this.contextReservoir = this.contextReservoir.map((existing, index) =>
        index === existingIndex ? nextEntry : existing
      )
      return
    }

    this.contextReservoir = [...this.contextReservoir, nextEntry]
  }

  setContextReservoir(entries: ContextReservoirEntry[]): void {
    this.contextReservoir = entries.map(entry => ({
      ...entry,
      createdAt: entry.createdAt ?? Date.now(),
    }))
  }

  getLanguage(): string {
    return 'en'
  }

  recordTokenUsage(usage: { model: string; inputTokens: number; outputTokens: number; provider: string; cached?: number; totalInputTokens?: number }): void {
    this.totalTokens.input += usage.inputTokens
    this.totalTokens.output += usage.outputTokens
    this.totalTokens.cached += usage.cached ?? 0
    const totalInput = usage.totalInputTokens ?? usage.inputTokens + (usage.cached ?? 0)
    const total = this.totalTokens.input + this.totalTokens.output + this.totalTokens.cached
    const event: RuntimeTokenUsageEvent = {
      ...usage,
      totalInputTokens: totalInput,
      totalTokens: total,
      cacheHitRate: totalInput > 0 ? (usage.cached ?? 0) / totalInput : 0,
    }
    for (const listener of this.tokenUsageListeners) listener(event)
  }

  getTotalTokens(): { input: number; output: number; cached: number } {
    return this.totalTokens
  }

  onTokenUsage(listener: (event: RuntimeTokenUsageEvent) => void): () => void {
    this.tokenUsageListeners.add(listener)
    return () => this.tokenUsageListeners.delete(listener)
  }
}
