import type {
  AgentMode,
  AgentTool,
  AgentSession,
  AgentTurn,
  AgentConfig,
  ContextPolicyMode,
  ToolCall,
  ToolResult,
  TaskPriority,
  TaskStatus,
  TaskNode,
  TokenUsage,
  AnthropicThinkingBlock,
} from '../shared/agentTypes'
import { generateSessionId, generateTurnId } from '../shared/agentTypes'
import type { MemoryKind, MemoryScope } from '../shared/memoryTypes'
import { buildSystemPrompt, invalidateStaticPromptCache } from './systemPrompt'
import { TaskManager, type TaskTreeNode } from './taskManager'
import { CacheMonitor } from './cacheMonitor'
import { toolsToOpenAIFormat, toolsToAnthropicFormat, getToolByName, validateToolArgs } from './toolRegistry'
import { applyEdit, stripLineNumberPrefix } from './editHelpers'
import { canComputeDiff, computeHunks, summarizeHunks } from './diffCompute'
import { ContextManager, extractStructuredSummary, formatSummaryAsContext } from './contextManager'
import { autoCompactThreshold, blockingContextLimit, recapThreshold, resolveContextPolicyProfile } from './contextPolicy'
import { countMessagesTokens, countTurnishTokens } from './tokenCounter'
import { resolveNativeReasoningRequest } from './modelRegistry'
import { TurnStrategyPlanner, type TurnStrategy } from './turnStrategy'
import { createDefaultPipeline, type PermissionPipeline } from './permissions'
import type { FastContextScanEvent, FastContextScanResult } from './fastContextTypes'
import type { TerminalSessionInfo } from '../shared/terminalTypes'
import type { RuntimeTask } from '../shared/runtimeTaskTypes'
import { runFastContextSubagent } from './fastContextSubagent'
import { isMcpTool, parseMcpToolName, executeMcpTool, getMcpAgentTools, validateMcpToolArgs } from './mcp/toolBridge'
import type { McpClient } from './mcp/client'
import type { SubAgentEvent, SubAgentEvidence } from '../shared/subAgentTypes'
import type { CodeMapNode, CodeSearchHit, CodeSymbolKind } from '../shared/codeIndexTypes'
import { resolvePath, toWorkspaceRelative } from './pathUtils'
import { normalizeBaseUrl } from './normalizeBaseUrl'
import { createTurboFluxRequestHeaders } from './clientIdentity'
import {
  ModelProtocolRequestError,
  buildModelProtocolUrl,
  formatProtocolAttempt,
  formatProtocolFailure,
  planModelProtocols,
  protocolLabel,
  shouldFallbackProtocol,
  toProtocolAttempt,
  toResponsesInput,
  toResponsesTools,
  type ModelProtocol,
  type ModelProtocolAttempt,
} from './modelProtocol'
import {
  formatCodeMap,
} from './toolDispatcher'
import { getSubAgentDefinition, runSubAgent, loadDynamicAgents, getAvailableAgentTypes } from './subAgent'
import type { ToolExecutor, WebSearchResult } from '../tools/executor'
import type { AgentStateProvider, APIConfig, APIModel, ContextReservoirEntry, ContextSegment, WorkspaceInfo } from '../state/types'
import type { TreeNode } from '../shared/types'
import { parseTextToolCalls, stripTextToolCallMarkup } from '../shared/toolCallMarkup'
import { detectGitRepo, fetchGitInfo, formatGitStatusForPrompt, gitCommitCheckpoint, gitResetToCommit } from './gitService'
import { hashText } from './fileIO'
import { RuntimeTaskManager } from './runtime/runtimeTaskManager'
import { SubAgentTaskManager, type SubAgentTaskSnapshot } from './runtime/subAgentTaskManager'

type TaskSystemCreationEvent = {
  status: 'planning' | 'creating' | 'completed' | 'error'
  toolName?: string
  expectedCount?: number
  createdCount?: number
  title?: string
  startedAt?: number
  updatedAt: number
  error?: string
}

export function splitTurnsForCompaction(turns: AgentTurn[], keepRecent: number): { oldTurns: AgentTurn[]; recentTurns: AgentTurn[] } {
  let splitIndex = Math.max(0, turns.length - Math.max(1, keepRecent))
  while (splitIndex > 0 && turns[splitIndex]?.role === 'tool_result') {
    splitIndex -= 1
  }
  return {
    oldTurns: turns.slice(0, splitIndex),
    recentTurns: turns.slice(splitIndex),
  }
}

const CANCELLED_TOOL_RESULT_TEXT = 'Cancelled before the tool completed.'

function contentBlocks(message: Record<string, unknown>): Array<Record<string, unknown>> {
  if (Array.isArray(message.content)) {
    return message.content.filter(block => block && typeof block === 'object') as Array<Record<string, unknown>>
  }
  if (typeof message.content === 'string' && message.content) {
    return [{ type: 'text', text: message.content }]
  }
  return []
}

export function normalizeAnthropicToolMessages(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const normalized: Array<Record<string, unknown>> = []

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const blocks = contentBlocks(message)
    const toolUseIds = message.role === 'assistant'
      ? blocks
          .filter(block => block.type === 'tool_use' && typeof block.id === 'string')
          .map(block => block.id as string)
      : []

    if (toolUseIds.length === 0) {
      if (message.role === 'user' && blocks.some(block => block.type === 'tool_result')) {
        const nonToolBlocks = blocks.filter(block => block.type !== 'tool_result')
        if (nonToolBlocks.length > 0) normalized.push({ ...message, content: nonToolBlocks })
      } else {
        normalized.push(message)
      }
      continue
    }

    normalized.push(message)
    const expectedIds = new Set(toolUseIds)
    const resultsById = new Map<string, Record<string, unknown>>()
    const trailingUserBlocks: Array<Record<string, unknown>> = []
    let nextIndex = index + 1

    while (nextIndex < messages.length && messages[nextIndex]?.role === 'user') {
      for (const block of contentBlocks(messages[nextIndex])) {
        const resultId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
        if (block.type === 'tool_result' && expectedIds.has(resultId)) {
          if (!resultsById.has(resultId)) resultsById.set(resultId, block)
        } else if (block.type !== 'tool_result') {
          trailingUserBlocks.push(block)
        }
      }
      nextIndex += 1
    }

    const resultBlocks = toolUseIds.map(toolUseId => resultsById.get(toolUseId) ?? {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: CANCELLED_TOOL_RESULT_TEXT,
      is_error: true,
    })
    normalized.push({ role: 'user', content: [...resultBlocks, ...trailingUserBlocks] })
    index = nextIndex - 1
  }

  return normalized
}

type PromptModuleSnapshot = {
  id: string
  label: string
  hash: string
  chars: number
  stable: boolean
}

export type AgentEventType =
  | { type: 'turn:start'; turn: AgentTurn }
  | { type: 'turn:complete'; turn: AgentTurn }
  | { type: 'tool:call'; toolCall: ToolCall }
  | { type: 'tool:result'; toolResult: ToolResult }
  | { type: 'task:update'; taskId: string; status: string; progress: number }
  | { type: 'mode:change'; from: AgentMode; to: AgentMode }
  | { type: 'session:complete'; session: AgentSession }
  | { type: 'error'; error: string }
  | { type: 'notification'; message: string; level: 'info' | 'success' | 'warning' | 'error' }
  | { type: 'model:protocol'; phase: 'attempt' | 'fallback' | 'success'; protocol: ModelProtocol; url: string; message?: string }
  | { type: 'stream:delta'; text: string }
  | { type: 'stream:thinking_delta'; text: string }
  | { type: 'stream:tool_call_delta'; toolCallId: string; toolName: string; partialJson: string }
  | { type: 'stream:start' }
  | { type: 'stream:end'; interrupted?: boolean }
  | { type: 'stream:usage'; usage: TokenUsage }
  | { type: 'ask:user'; question: string; options?: string[]; reason?: string; command?: string; requestId?: string; toolName?: string; path?: string }
  | { type: 'active:task'; context: import('./taskManager').ActiveTaskContext | null }
  | { type: 'terminal:sessions'; sessions: TerminalSessionInfo[] }
  | { type: 'runtime-task:finished'; task: RuntimeTask }
  | {
    type: 'task:system'
    context: import('./taskManager').ActiveTaskContext | null
    tree: TaskTreeNode[]
    creation?: TaskSystemCreationEvent | null
  }
  | { type: 'context:segment_created'; segment: ContextSegment }
  | { type: 'checkpoint:attached'; assistantMessageId: string; checkpointId: string; checkpointLabel: string }
  | { type: 'fast_context:event'; event: FastContextScanEvent }
  | { type: 'fast_context:complete'; result: FastContextScanResult }
  | { type: 'subagent:start'; agentId: string; agentType: string; label: string; objective: string; runKind: 'fast_context' | 'spawn_agent' }
  | { type: 'subagent:end'; agentId: string; agentType: string; ok: boolean; elapsedMs: number; runKind: 'fast_context' | 'spawn_agent' }
  | { type: 'cache:diagnostic'; result: { broken: boolean; reason: string; tokenDrop: number; likelyTtlExpiry: boolean } }
  | { type: 'cache:modules'; modules: PromptModuleSnapshot[] }

export type AgentEventListener = (event: AgentEventType) => void

function shouldOmitSamplingTemperature(config: APIConfig): boolean {
  return resolveNativeReasoningRequest(config.defaultModel, config.reasoning, config.provider, config.modelCapabilities)?.omitTemperature === true
}

function extractUnsupportedRequestParam(error?: string): string | null {
  if (!error) return null
  const quoted = error.match(/Unsupported parameter:\s*["'`]?([A-Za-z0-9_.-]+)["'`]?/i)
  if (quoted?.[1]) return quoted[1]
  const named = error.match(/(?:unknown|unrecognized|unsupported|invalid)\s+(?:parameter|field|key|argument)\s*[:=]?\s*["'`]?([A-Za-z0-9_.-]+)["'`]?/i)
  if (named?.[1]) return named[1]
  if (!/(?:extra inputs?|extra fields?|not permitted|not allowed|unsupported|unrecognized)/i.test(error)) return null
  const knownOptionalParams = [
    'cache_control', 'anthropic-beta', 'output_config', 'thinking', 'reasoning_effort',
    'reasoning', 'temperature', 'stream_options', 'parallel_tool_calls', 'tool_choice',
    'tools', 'prompt_cache_key', 'prompt_cache_retention', 'store',
  ]
  return knownOptionalParams.find(param => error.toLowerCase().includes(param.toLowerCase())) || null
}

function removeOpenAICompatibleRequestParam(body: Record<string, unknown>, param: string): boolean {
  const rootParam = param.split('.')[0]
  const removable = new Set([
    'temperature', 'max_output_tokens', 'max_completion_tokens', 'max_tokens',
    'stream_options', 'tools', 'tool_choice', 'parallel_tool_calls',
    'thinking', 'reasoning', 'reasoning_effort', 'output_config',
    'prompt_cache_key', 'prompt_cache_retention', 'store',
  ])
  if (!removable.has(rootParam)) return false
  const aliases = new Set<string>([rootParam])
  if (rootParam === 'max_output_tokens' || rootParam === 'max_completion_tokens' || rootParam === 'max_tokens') {
    aliases.add('max_output_tokens')
    aliases.add('max_completion_tokens')
    aliases.add('max_tokens')
  }
  if (rootParam === 'tools' || rootParam === 'tool_choice' || rootParam === 'parallel_tool_calls') {
    aliases.add('tools')
    aliases.add('tool_choice')
    aliases.add('parallel_tool_calls')
  }
  if (rootParam === 'thinking' || rootParam === 'reasoning' || rootParam === 'reasoning_effort' || rootParam === 'output_config') {
    aliases.add('thinking')
    aliases.add('reasoning')
    aliases.add('reasoning_effort')
    aliases.add('output_config')
  }

  let removed = false
  for (const key of aliases) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      delete body[key]
      removed = true
    }
  }
  return removed
}

function removeAnthropicCompatibleRequestParam(
  body: Record<string, unknown>,
  headers: Record<string, string>,
  param: string,
): boolean {
  const pathParts = param.split('.')
  const rootParam = pathParts[0]
  const nestedParam = pathParts[pathParts.length - 1]
  if (rootParam === 'cache_control' || nestedParam === 'cache_control') {
    let removed = false
    const strip = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(strip)
      if (!value || typeof value !== 'object') return value
      const output: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'cache_control') {
          removed = true
          continue
        }
        output[key] = strip(child)
      }
      return output
    }
    for (const key of ['system', 'messages', 'tools']) {
      if (body[key] !== undefined) body[key] = strip(body[key])
    }
    return removed
  }
  if (rootParam === 'anthropic-beta' || rootParam === 'anthropic_beta') {
    if (headers['anthropic-beta'] === undefined) return false
    delete headers['anthropic-beta']
    return true
  }
  const removable = new Set(['temperature', 'thinking', 'output_config', 'tool_choice'])
  if (!removable.has(rootParam) || !Object.prototype.hasOwnProperty.call(body, rootParam)) return false
  delete body[rootParam]
  return true
}

function stableHash(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize)
    if (input && typeof input === 'object') {
      const record = input as Record<string, unknown>
      const output: Record<string, unknown> = {}
      for (const key of Object.keys(record).sort()) output[key] = normalize(record[key])
      return output
    }
    return input
  }
  const text = JSON.stringify(normalize(value))
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) + text.charCodeAt(i)
  }
  return (hash >>> 0).toString(36)
}

function stripRuntimeBlocksFromText(content: string): string {
  return content
    .replace(/\n{0,2}<runtime_context>[\s\S]*?<\/runtime_context>\n?/g, '\n')
    .replace(/\n{0,2}<additional_instructions>[\s\S]*?<\/additional_instructions>\n?/g, '\n')
    .replace(/\n{0,2}<recent_files>[\s\S]*?<\/recent_files>\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function appendRuntimeContextToLatestUserMessage(
  messages: Array<Record<string, unknown>>,
  text: string,
  provider: 'openai' | 'anthropic',
): boolean {
  if (!text.trim()) return false

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user') continue

    if (typeof message.content === 'string') {
      message.content = `${message.content}\n\n${text}`
      return true
    }

    if (Array.isArray(message.content)) {
      ;(message.content as Array<Record<string, unknown>>).push({
        type: 'text',
        text,
      })
      return true
    }
  }

  return false
}

function hasCompleteToolPayloads(calls: Array<{ name: string; argumentsJson: string }>): boolean {
  if (calls.length === 0) return false
  return calls.every(call => {
    if (!call.name.trim()) return false
    try {
      JSON.parse(call.argumentsJson || '{}')
      return true
    } catch {
      return false
    }
  })
}

type FastContextBackgroundStatus = 'started' | 'running' | 'busy' | 'unavailable'

interface FastContextBackgroundStart {
  status: FastContextBackgroundStatus
  objective: string
  promise: Promise<FastContextScanResult | null> | null
  taskId?: string
}

export class AgentEngine {
  private session: AgentSession
  private taskManager: TaskManager
  private listeners: Set<AgentEventListener> = new Set()
  private abortController: AbortController | null = null
  private currentStreamId: number | null = null
  private pendingCheckpoint: { hash: string; message: string } | null = null
  private isPaused: boolean = false
  private pausePromise: Promise<void> | null = null
  private pauseResolve: (() => void) | null = null
  private unsubscribeTaskManager: (() => void) | null = null
  private contextManager: ContextManager = new ContextManager()
  private pendingAskUserResolve: ((response: string) => void) | null = null
  private queuedAskUserResponse: string | null = null
  private toolCallTaskMap: Map<string, string> = new Map()
  private touchedFilePaths: Set<string> = new Set()
  private filePreimages: Map<string, string | null> = new Map()
  private runtimeAppendSystemPrompt: string | null = null
  private fastContextObjective: string | null = null
  private fastContextPack: string | null = null
  private fastContextRunPromise: Promise<FastContextScanResult | null> | null = null
  private fastContextRunObjective: string | null = null
  private fastContextAbortController: AbortController | null = null
  private fastContextRuntimeTaskId: string | null = null
  private fastContextGeneration = 0
  private standaloneFastContextRunPromise: Promise<FastContextScanResult | null> | null = null
  private standaloneFastContextAbortController: AbortController | null = null
  private standaloneFastContextRuntimeTaskId: string | null = null
  // Registry of background PTY sessions the agent has spawned via
  // run_command(run_in_background=true). Tracks the command + start time so
  // list_terminals / read_terminal can label them. Foreground commands use
  // the legacy exec path and do not need a session.
  private agentBackgroundSessions: Map<string, { command: string; startedAt: number }> = new Map()
  private turnStrategyPlanner: TurnStrategyPlanner = new TurnStrategyPlanner()
  private currentTurnStrategy: TurnStrategy | null = null
  private codemapSummary: string | null = null
  // Bug 4 fix: previously a boolean "fetched once per run" flag meant the
  // model was stuck with the codemap of whatever the first user message
  // happened to be — switching topics mid-conversation never refreshed it.
  // Now we store a stable cache key derived from (route + workspace +
  // normalized query tokens) and only re-fetch when that key changes,
  // keeping per-turn cost low while staying responsive to topic shifts.
  private codemapCacheKey: string | null = null
  /**
   * Workspace skeleton — a STABLE per-workspace primer fed to Fast Context
   * (and other subagents) ahead of any objective.
   *
   * Why separate from `codemapSummary`? codemapSummary is query-aware — it
   * mutates with every topic shift, which destroys DeepSeek V4's prefix-
   * cache locality. The skeleton is intentionally objective-agnostic:
   * top-level directory tree only, computed once per workspace, kept
   * deterministic so V4's cache prefix detector recognizes the same
   * unit across every Fast Context call. Once persisted, every later
   * invocation pays 1/10 input price for the skeleton portion.
   *
   * Cache is keyed by absolute workspace path. Invalidated when the
   * workspace changes (resetForNewSession / resetForNewRun handle this
   * by clearing the field). Not invalidated on file edits — directory
   * structure rarely shifts within a single session and a slightly
   * stale skeleton is strictly better than a cold cache.
   */
  private workspaceSkeleton: string | null = null
  private workspaceSkeletonPath: string | null = null
  private gitEnabled: boolean = false
  private cachedGitStatus: string | null = null
  private gitDetected: boolean = false
  // Workspace long-term memory (M1: static loaders only).
  // Injection text is owned by the main process MemoryService — we just
  // cache the latest copy plus its fingerprint so we don't re-IPC every turn.
  // Re-fetched lazily when (workspacePath, fingerprint) changes; the main
  // process produces the fingerprint from on-disk mtimes so user edits to
  // CLAUDE.md / .cursorrules / etc. propagate without explicit invalidation.
  private workspaceMemoryText: string | null = null
  private workspaceMemoryWorkspace: string | null = null
  private workspaceMemoryBuiltAt: number = 0
  private cacheMonitor = new CacheMonitor()
  private permissions: PermissionPipeline = createDefaultPipeline()
  /** Files preserved from the last compaction so the model doesn't lose
   * working context. Injected once into the next user message, then cleared. */
  private preservedFiles: Array<{ path: string; content: string }> = []
  private compressionPreparedTurnCount: number = 0
  private currentRunToolNames: string[] = []
  private currentRunReadFiles: Set<string> = new Set()
  private currentRunSuccessfulReadFiles: Set<string> = new Set()
  private currentRunSearches: Set<string> = new Set()
  private currentRunSuccessfulSearches: Set<string> = new Set()
  private currentRunExplorePacks: Set<string> = new Set()
  private conclusionGuardAttempts: number = 0
  private disabledToolNames: Set<string> = new Set()
  private pendingAssistantMessageId: string | null = null
  // Snapshot of the chat message id for the assistant turn that just finished
  // streaming. Used to attach an auto/explicit checkpoint produced AFTER that
  // turn back to the SAME message instead of leaking onto the next assistant
  // turn (Bug #12). Set by createAssistantTurn, consumed and cleared by
  // executeToolCalls.
  private lastAssistantMessageId: string | null = null
  private currentRunPromise: Promise<AgentTurn[]> | null = null
  private forceContextCompactionBeforeNextCall = false
  private contextLimitRetryInProgress = false

  private toolExecutor: ToolExecutor
  private stateProvider: AgentStateProvider
  private subAgentTaskManager: SubAgentTaskManager
  private mcpClient: McpClient | null = null

  setMcpClient(client: McpClient): void {
    this.mcpClient = client
  }

  constructor(
    private config: AgentConfig,
    toolExecutor: ToolExecutor,
    stateProvider: AgentStateProvider,
    subAgentTaskManager?: SubAgentTaskManager,
  ) {
    this.toolExecutor = toolExecutor
    this.stateProvider = stateProvider
    this.subAgentTaskManager = subAgentTaskManager || new SubAgentTaskManager({
      workspacePath: config.workspacePath || '',
      runtimeTaskManager: new RuntimeTaskManager({ defaultOwnerSessionId: config.conversationId }),
      ownerSessionId: config.conversationId,
      storageDir: false,
    })
    this.permissions.setApprovalPolicy(config.approvalPolicy || 'agent')
    const now = Date.now()
    this.session = {
      id: generateSessionId(),
      mode: config.mode,
      turns: [],
      currentTaskId: null,
      createdAt: now,
      updatedAt: now,
      workspacePath: config.workspacePath,
      workspaceName: config.workspaceName,
      totalTokens: { input: 0, output: 0 },
    }
    this.taskManager = new TaskManager()

    // 加载动态代理定义（.turboflux/agents/*.md）
    if (config.workspacePath) {
      loadDynamicAgents(config.workspacePath)
    }
    this.unsubscribeTaskManager = this.taskManager.subscribe(event => {
      if (event.type === 'task:created' || event.type === 'task:updated') {
        this.emit({
          type: 'task:update',
          taskId: event.task.id,
          status: event.task.status,
          progress: event.task.progress,
        })
        this.emitActiveTaskContext()
      }

      if (event.type === 'tasks:cleared') {
        this.emitActiveTaskContext()
      }
    })
  }

  destroy(): void {
    this.unsubscribeTaskManager?.()
    this.abortController?.abort()
    this.fastContextAbortController?.abort()
    this.standaloneFastContextAbortController?.abort()
    this.abortController = null
    this.fastContextAbortController = null
    this.standaloneFastContextAbortController = null
    this.currentStreamId = null
    this.subAgentTaskManager.destroy()
    this.listeners.clear()
  }

  getMode(): AgentMode {
    return this.session.mode
  }

  setMode(mode: AgentMode): void {
    const oldMode = this.session.mode
    this.session.mode = mode
    this.config.mode = mode
    invalidateStaticPromptCache()
    this.emit({ type: 'mode:change', from: oldMode, to: mode })
  }

  setAppendSystemPrompt(appendSystemPrompt: string | undefined): void {
    this.config.appendSystemPrompt = appendSystemPrompt
  }

  setEnabledSkills(skills: AgentConfig['enabledSkills']): void {
    this.config.enabledSkills = skills
  }

  /** 热重载动态代理定义 */
  reloadAgents(): void {
    if (this.config.workspacePath) {
      loadDynamicAgents(this.config.workspacePath)
    }
  }

  setFastContextObjective(objective: string | undefined): void {
    this.fastContextObjective = objective?.trim() || null
    this.fastContextPack = null
  }

  async runFastContextObjective(objective: string): Promise<FastContextScanResult | null> {
    const run = this.startFastContextBackground(objective)
    return run.promise
  }

  private startFastContextBackground(
    objective: string,
    tuning?: { maxTurns?: number; maxParallel?: number },
  ): FastContextBackgroundStart {
    const nextObjective = objective.trim()
    if (!nextObjective || !this.config.workspacePath) {
      return { status: 'unavailable', objective: nextObjective, promise: null }
    }
    if (this.fastContextRunPromise) {
      return {
        status: this.fastContextRunObjective === nextObjective ? 'running' : 'busy',
        objective: this.fastContextRunObjective || nextObjective,
        promise: this.fastContextRunPromise,
        taskId: this.fastContextRuntimeTaskId || undefined,
      }
    }

    this.setFastContextObjective(nextObjective)
    this.fastContextRunObjective = nextObjective
    const controller = new AbortController()
    const parentSignal = this.abortController?.signal
    const abortFromParent = () => controller.abort()
    if (parentSignal?.aborted) controller.abort()
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true })
    this.fastContextAbortController = controller

    const generation = ++this.fastContextGeneration
    const started = this.subAgentTaskManager.startTask<FastContextScanResult | null>({
      kind: 'fast_context',
      agentType: 'fast_context',
      label: 'FastContext',
      objective: nextObjective,
      workspacePath: this.config.workspacePath,
      ownerSessionId: this.config.conversationId,
      controller,
      run: ({ signal, recordEvent, taskId }) => this.runFastContextScan(nextObjective, {
        signal,
        injectPack: true,
        maxTurns: tuning?.maxTurns,
        maxParallel: tuning?.maxParallel,
        generation,
        agentId: taskId,
        recordEvent: event => recordEvent(event),
      }),
      isSuccess: result => result !== null,
      getError: () => 'FastContext scan did not complete',
    })
    const promise = started.promise
    this.fastContextRunPromise = promise
    this.fastContextRuntimeTaskId = started.task.id
    void promise.finally(() => {
      parentSignal?.removeEventListener('abort', abortFromParent)
      if (this.fastContextRunPromise === promise) {
        this.fastContextRunPromise = null
        this.fastContextRunObjective = null
        this.fastContextRuntimeTaskId = null
      }
      if (this.fastContextAbortController === controller) {
        this.fastContextAbortController = null
      }
    })
    return { status: 'started', objective: nextObjective, promise, taskId: started.task.id }
  }

  private clearFastContextBackground(): void {
    this.fastContextGeneration += 1
    if (this.fastContextRuntimeTaskId) {
      void this.subAgentTaskManager.stopTask(this.fastContextRuntimeTaskId, 'FastContext background scan cleared').catch(() => {})
    }
    this.fastContextAbortController?.abort()
    this.fastContextAbortController = null
    this.fastContextRunPromise = null
    this.fastContextRunObjective = null
    this.fastContextRuntimeTaskId = null
    this.fastContextObjective = null
    this.fastContextPack = null
  }

  isRunning(): boolean {
    return Boolean(this.currentRunPromise)
  }

  isFastContextRunning(): boolean {
    return Boolean(this.fastContextRunPromise || this.standaloneFastContextRunPromise)
  }

  async runStandaloneFastContextObjective(objective: string): Promise<FastContextScanResult | null> {
    const nextObjective = objective.trim()
    if (!nextObjective) return null
    if (this.currentRunPromise) {
      throw new Error('FastContext cannot run as a background command while the main agent is running.')
    }
    if (this.standaloneFastContextRunPromise) return this.standaloneFastContextRunPromise
    const controller = new AbortController()
    this.standaloneFastContextAbortController = controller
    const started = this.subAgentTaskManager.startTask<FastContextScanResult | null>({
      kind: 'fast_context',
      agentType: 'fast_context',
      label: 'FastContext',
      objective: nextObjective,
      workspacePath: this.config.workspacePath || '',
      ownerSessionId: this.config.conversationId,
      controller,
      run: ({ signal, recordEvent, taskId }) => this.runFastContextScan(nextObjective, {
        signal,
        injectPack: false,
        agentId: taskId,
        recordEvent: event => recordEvent(event),
      }),
      isSuccess: result => result !== null,
      getError: () => 'FastContext scan did not complete',
    })
    const promise = started.promise
    this.standaloneFastContextRuntimeTaskId = started.task.id
    this.standaloneFastContextRunPromise = promise
    void promise.finally(() => {
      if (this.standaloneFastContextRunPromise === promise) {
        this.standaloneFastContextRunPromise = null
        this.standaloneFastContextAbortController = null
        this.standaloneFastContextRuntimeTaskId = null
      }
    })
    return promise
  }

  setContextPolicy(mode: ContextPolicyMode): void {
    this.config.contextPolicy = mode
    this.compressionPreparedTurnCount = 0
  }

  setApprovalPolicy(policy: NonNullable<AgentConfig['approvalPolicy']>): void {
    this.config.approvalPolicy = policy
    this.permissions.setApprovalPolicy(policy)
  }

  getApprovalPolicy(): NonNullable<AgentConfig['approvalPolicy']> {
    return this.permissions.getApprovalPolicy()
  }

  isGitEnabled(): boolean {
    return this.gitEnabled
  }

  setGitEnabled(enabled: boolean): void {
    this.gitEnabled = enabled
    this.config.gitEnabled = enabled
    this.session.gitEnabled = enabled
    if (!enabled) this.cachedGitStatus = null
    this.invalidateStaticPromptCache()
  }

  async detectAndEnableGit(): Promise<boolean> {
    if (!this.config.workspacePath || this.gitDetected) return this.gitEnabled
    this.gitDetected = true
    const isRepo = await detectGitRepo(this.config.workspacePath, this.toolExecutor)
    if (isRepo && this.config.gitEnabled === true) {
      this.setGitEnabled(true)
    }
    return this.gitEnabled
  }

  private invalidateStaticPromptCache(): void {
    invalidateStaticPromptCache()
  }

  private async refreshGitStatus(): Promise<void> {
    if (!this.gitEnabled || !this.config.workspacePath) return
    const info = await fetchGitInfo(this.config.workspacePath, this.toolExecutor).catch(() => null)
    this.cachedGitStatus = info ? formatGitStatusForPrompt(info) : null
  }

  async compactContext(): Promise<void> {
    const keepRecent = resolveContextPolicyProfile(this.config.contextPolicy).keepRecentTurns
    const nonSystemTurns = this.session.turns.filter(t => t.role !== 'system')
    if (nonSystemTurns.length <= keepRecent) return

    const { oldTurns, recentTurns } = splitTurnsForCompaction(nonSystemTurns, keepRecent)
    if (oldTurns.length === 0) return

    const firstVisibleOldTurn = oldTurns.find(turn => turn.role === 'user' || turn.role === 'assistant')
    const lastVisibleOldTurn = [...oldTurns].reverse().find(turn => turn.role === 'user' || turn.role === 'assistant')
    if (!firstVisibleOldTurn || !lastVisibleOldTurn) return

    const startMessageId = firstVisibleOldTurn.id
    const endMessageId = lastVisibleOldTurn.id
    const originalCharCount = oldTurns.reduce((sum, t) => sum + this.countTurnChars(t), 0)

    let summary: string
    let isModelGenerated: boolean
    try {
      summary = await this.generateContinuationSummary(oldTurns, recentTurns)
      if (!summary.trim()) throw new Error('Empty summary')
      isModelGenerated = true
    } catch {
      const structured = extractStructuredSummary(oldTurns)
      summary = formatSummaryAsContext(structured)
      isModelGenerated = false
    }

    const existingSegments = this.stateProvider.getContextSegments()
    const alreadyCovered = existingSegments.some(segment =>
      segment.startMessageId === startMessageId && segment.endMessageId === endMessageId
    )
    if (!alreadyCovered) {
      const segment: ContextSegment = {
        startMessageId,
        endMessageId,
        summary,
        isModelGenerated,
        kind: isModelGenerated ? 'compact' : 'structured',
        originalCharCount,
        isValid: true,
        createdAt: Date.now(),
        coveredTurnIds: oldTurns.map(turn => turn.id),
      }
      this.stateProvider.addContextSegment(segment)
      this.emit({ type: 'context:segment_created', segment })
    }

    this.addReservoirEntry(startMessageId, endMessageId, oldTurns, 'manual', originalCharCount)

    const systemTurns = this.session.turns.filter(t => t.role === 'system')
    this.session.turns = [...systemTurns, ...recentTurns]
    this.contextManager.reset()
    this.cacheMonitor.resetBaseline()
  }

  getTokenUsage(): { input: number; output: number } {
    const turns = this.session.turns
    let input = 0, output = 0
    for (const turn of turns) {
      if (turn.metadata?.tokens) {
        input += turn.metadata.tokens.input || 0
        output += turn.metadata.tokens.output || 0
      }
    }
    return { input, output }
  }

  getContextUsage(): TokenUsage {
    return this.contextManager.getLastProviderUsage()
  }

  getContextSegments(): ContextSegment[] {
    return this.stateProvider.getContextSegments()
  }

  setContextSegments(segments: ContextSegment[]): void {
    this.stateProvider.setContextSegments(segments)
  }

  getContextReservoir(): ContextReservoirEntry[] {
    return this.stateProvider.getContextReservoir()
  }

  setContextReservoir(entries: ContextReservoirEntry[]): void {
    this.stateProvider.setContextReservoir(entries)
  }

  getFullConversationTurns(): AgentTurn[] {
    const systemTurns = this.session.turns.filter(turn => turn.role === 'system')
    const liveTurns = this.session.turns.filter(turn => turn.role !== 'system')
    const orderedIds: string[] = []
    const turnsById = new Map<string, AgentTurn>()
    const addTurn = (turn: AgentTurn) => {
      if (!turnsById.has(turn.id)) orderedIds.push(turn.id)
      turnsById.set(turn.id, turn)
    }
    this.stateProvider.getContextReservoir()
      .slice()
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      .forEach(entry => entry.turns.forEach(addTurn))
    liveTurns.forEach(addTurn)
    return [...systemTurns, ...orderedIds.map(id => turnsById.get(id)!).filter(Boolean)]
  }

  resetSession(): void {
    const now = Date.now()
    this.restoreFromMessages([])
    this.stateProvider.setContextSegments([])
    this.stateProvider.setContextReservoir([])
    this.session.id = generateSessionId()
    this.session.currentTaskId = null
    this.session.createdAt = now
    this.session.updatedAt = now
    this.session.totalTokens = { input: 0, output: 0 }
  }

  restoreFromTurns(turns: AgentTurn[]): void {
    const resultByToolCallId = new Map<string, ToolResult>()
    for (const turn of turns) {
      if (turn.role !== 'tool_result' || !turn.toolResults) continue
      for (const result of turn.toolResults) {
        resultByToolCallId.set(result.toolCallId, result)
      }
    }

    this.restoreFromMessages(turns.map(turn => {
      const toolCalls = turn.toolCalls?.map(toolCall => {
        const result = resultByToolCallId.get(toolCall.id)
        return {
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
          result: result?.output,
          isError: result?.isError,
          status: result ? (result.isError ? 'error' : 'completed') : undefined,
          changeSummary: result?.changeSummary,
        }
      })

      return {
        id: turn.id,
        role: turn.role,
        content: turn.content,
        timestamp: turn.timestamp,
        metadata: {
          ...(turn.metadata ?? {}),
          ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
        },
      }
    }))

    this.session.id = generateSessionId()
    this.session.createdAt = turns[0]?.timestamp ?? Date.now()
    this.session.updatedAt = turns[turns.length - 1]?.timestamp ?? Date.now()
    this.session.totalTokens = turns.reduce((total, turn) => ({
      input: total.input + (turn.metadata?.tokens?.input ?? 0),
      output: total.output + (turn.metadata?.tokens?.output ?? 0),
    }), { input: 0, output: 0 })
  }

  setDisabledTools(toolNames: string[]): void {
    this.disabledToolNames = new Set(toolNames)
    this.config.disabledTools = toolNames
  }

  attachPendingAssistantMessageId(messageId: string): void {
    this.pendingAssistantMessageId = messageId
  }

  getSession(): AgentSession {
    return this.session
  }

  getTaskManager(): TaskManager {
    return this.taskManager
  }

  /**
   * Restore session from persisted ChatMessage data.
   * Reconstructs toolCalls, toolResults, and metadata from the serialized format.
   */
  resetContextTracking(): void {
    this.contextManager.reset()
    this.cacheMonitor.reset()
  }

  restoreFromMessages(messages: Array<{
    id?: string
    role: string
    content: string
    timestamp?: number
    metadata?: {
      model?: string
      tokens?: number | TokenUsage
      duration?: number
      checkpointHash?: string
      checkpointMessage?: string
      checkpointId?: string
      checkpointLabel?: string
      reasoningEnabled?: boolean
      reasoningEffort?: NonNullable<AgentTurn['metadata']>['reasoningEffort']
      thinking?: NonNullable<AgentTurn['metadata']>['thinking']
      rawReasoningPayload?: NonNullable<AgentTurn['metadata']>['rawReasoningPayload']
      attachments?: NonNullable<AgentTurn['metadata']>['attachments']
      toolCalls?: Array<{
        id?: string
        name: string
        arguments: Record<string, unknown>
        result?: string
        isError?: boolean
        status?: string
        changeSummary?: {
          path: string
          operation: 'write' | 'edit' | 'delete'
          addedLines?: number
          removedLines?: number
          totalLines?: number
          preview?: string
          oldPreview?: string
          before?: string
          after?: string
        }
      }>
      detectedSkills?: string[]
      isStreaming?: boolean
    }
  }>): void {
    this.contextManager.reset()
    this.cacheMonitor.reset()
    this.session.turns = this.session.turns.filter(t => t.role === 'system')
    this.taskManager.clear()
    this.toolCallTaskMap.clear()
    this.currentRunToolNames = []
    this.currentRunReadFiles.clear()
    this.currentRunSuccessfulReadFiles.clear()
    this.currentRunSearches.clear()
    this.currentRunSuccessfulSearches.clear()
    this.currentRunExplorePacks.clear()
    this.conclusionGuardAttempts = 0
    this.compressionPreparedTurnCount = 0
    this.codemapSummary = null
    this.codemapCacheKey = null
    this.workspaceMemoryText = null
    this.workspaceMemoryWorkspace = null
    this.workspaceMemoryBuiltAt = 0
    this.pendingAssistantMessageId = null
    this.lastAssistantMessageId = null

    let restoredTimestampFallback = Date.now()
    for (const msg of messages) {
      if (msg.role === 'system') continue

      const timestamp = typeof msg.timestamp === 'number' ? msg.timestamp : restoredTimestampFallback++
      const meta = msg.metadata

      if (msg.role === 'user') {
        this.session.turns.push({
          id: msg.id || generateTurnId(),
          role: 'user',
          content: msg.content,
          timestamp,
          metadata: meta?.attachments?.length
            ? { attachments: meta.attachments.map(attachment => ({ ...attachment })) }
            : undefined,
        })
      } else if (msg.role === 'assistant') {
        // Reconstruct toolCalls from ChatMessage.metadata.toolCalls (ToolCallInfo[])
        let toolCalls: ToolCall[] | undefined
        let toolResults: ToolResult[] | undefined

        if (meta?.toolCalls && meta.toolCalls.length > 0) {
          const restoredIds = meta.toolCalls.map((tc, idx) => tc.id || `restored_tc_${idx}_${timestamp}`)

          toolCalls = meta.toolCalls.map((tc, idx) => ({
            id: restoredIds[idx],
            name: tc.name,
            arguments: tc.arguments,
          }))

          // Reconstruct toolResults from ToolCallInfo.result.
          // Only completed/error/cancelled calls have meaningful results.
          const restoredResults: ToolResult[] = []
          meta.toolCalls.forEach((tc, idx) => {
            const hasResult = tc.result !== undefined
            const hasTerminalStatus = tc.status === 'completed' || tc.status === 'error' || tc.status === 'cancelled'
            if (!hasResult && !hasTerminalStatus) return

            const result: ToolResult = {
              toolCallId: restoredIds[idx],
              name: tc.name,
              output: tc.result ?? '',
              isError: tc.isError ?? (tc.status === 'error' || tc.status === 'cancelled'),
            }
            if (tc.changeSummary) result.changeSummary = tc.changeSummary
            restoredResults.push(result)
          })
          if (restoredResults.length > 0) toolResults = restoredResults
        }

        // Reconstruct metadata
        const turnMetadata: AgentTurn['metadata'] = {}
        if (meta?.model) turnMetadata.model = meta.model
        if (typeof meta?.tokens === 'number') turnMetadata.tokens = { input: meta.tokens, output: 0 }
        else if (meta?.tokens) turnMetadata.tokens = meta.tokens
        if (meta?.duration) turnMetadata.duration = meta.duration
        if (typeof meta?.reasoningEnabled === 'boolean') turnMetadata.reasoningEnabled = meta.reasoningEnabled
        if (meta?.reasoningEffort) turnMetadata.reasoningEffort = meta.reasoningEffort
        if (meta?.thinking) turnMetadata.thinking = { ...meta.thinking, isStreaming: false }
        if (meta?.rawReasoningPayload) {
          turnMetadata.rawReasoningPayload = {
            provider: meta.rawReasoningPayload.provider,
            blocks: meta.rawReasoningPayload.blocks.map(block => ({ ...block })),
            // Preserve reasoning_content when restoring from persisted history.
            // OpenAI-compatible providers (mimo, DeepSeek-R1) require this
            // string to be echoed back on every subsequent request — dropping
            // it here means a freshly restored conversation 400s on its first
            // follow-up turn.
            ...(meta.rawReasoningPayload.reasoningContent
              ? { reasoningContent: meta.rawReasoningPayload.reasoningContent }
              : {}),
          }
        }
        const checkpointId = meta?.checkpointId || meta?.checkpointHash
        const checkpointLabel = meta?.checkpointLabel || meta?.checkpointMessage
        if (checkpointId) {
          turnMetadata.checkpointId = checkpointId
          turnMetadata.checkpointLabel = checkpointLabel
        }

        const assistantTurn: AgentTurn = {
          id: msg.id || generateTurnId(),
          role: 'assistant',
          content: msg.content,
          timestamp,
          toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
          metadata: Object.keys(turnMetadata).length > 0 ? turnMetadata : undefined,
        }

        this.session.turns.push(assistantTurn)

        if (toolResults && toolResults.length > 0) {
          this.session.turns.push({
            id: `${assistantTurn.id}:tool_results`,
            role: 'tool_result',
            content: toolResults.map(r => `${r.name}: ${r.isError ? 'error' : 'ok'} ${(r.output || '').slice(0, 500)}`).join('\n\n'),
            timestamp: timestamp + 1,
            toolResults,
          })
        }

        if (meta?.toolCalls && meta.toolCalls.length > 0) {
          this.restoreTasksFromToolCalls(meta.toolCalls, timestamp)
        }
      }
    }

    // Re-establish a token baseline from the rewound turns so the context bar
    // shows the correct occupancy instead of falling back to rough char estimates.
    const baselineSystemPrompt = buildSystemPrompt(this.config.mode, {
      workspacePath: this.config.workspacePath,
      workspaceName: this.config.workspaceName,
      profileSystemPrompt: this.config.profileSystemPrompt,
      enabledSkills: this.config.enabledSkills,
      shell: this.config.shell,
    })
    this.contextManager.restoreBaseline(this.session.turns, baselineSystemPrompt)
    this.emitActiveTaskContext()
  }

  private restoreTasksFromToolCalls(
    toolCalls: Array<{
      name: string
      arguments: Record<string, unknown>
      result?: string
      isError?: boolean
      status?: string
      changeSummary?: {
        path: string
        operation: 'write' | 'edit' | 'delete'
        addedLines?: number
        totalLines?: number
        preview?: string
        oldPreview?: string
        before?: string
        after?: string
      }
    }>,
    timestamp: number,
  ): void {
    for (const tc of toolCalls) {
      if (tc.name === 'create_task') {
        if (!this.isRestorableTaskToolCall(tc)) continue
        const args = tc.arguments || {}
        let parsedResult: Record<string, unknown> | null = null

        if (tc.result) {
          try {
            parsedResult = JSON.parse(tc.result) as Record<string, unknown>
          } catch {
            parsedResult = null
          }
        }

        const restoredId = typeof parsedResult?.id === 'string'
          ? parsedResult.id
          : `restored-task-${timestamp}-${String(args.title || 'task')}`

        this.taskManager.restoreTask({
          id: restoredId,
          title: String(args.title || parsedResult?.title || 'Task'),
          description: String(args.description || ''),
          priority: ((args.priority as TaskPriority | undefined) || (parsedResult?.priority as TaskPriority | undefined) || 'medium'),
          status: (parsedResult?.status as TaskStatus | undefined) || 'pending',
          parentId: (args.parent_id as string | undefined) || null,
          progress: (parsedResult?.status as TaskStatus | undefined) === 'completed' ? 100 : 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        const deps = args.dependencies as string[] | undefined
        if (deps && deps.length > 0) {
          for (const depId of deps) {
            this.taskManager.addDependency(restoredId, depId)
          }
        }
      }

      if (tc.name === 'create_tasks') {
        if (!this.isRestorableTaskToolCall(tc)) continue
        const args = tc.arguments || {}
        const items = args.tasks as Array<Record<string, unknown>> | undefined
        if (!Array.isArray(items)) continue

        // Try to recover ids from the parsed tool result so dependencies
        // line up. Fall back to deterministic synthetic ids if not present.
        let createdById: Record<string, unknown> | null = null
        if (tc.result) {
          try {
            const parsed = JSON.parse(tc.result) as { created?: Array<Record<string, unknown>> }
            if (parsed?.created) {
              createdById = {}
              parsed.created.forEach((c, idx) => {
                if (createdById && typeof c.id === 'string') {
                  createdById[String(idx)] = c
                  if (typeof c.ref === 'string') createdById[c.ref] = c
                }
              })
            }
          } catch { /* ignore */ }
        }

        const refToId = new Map<string, string>()
        items.forEach((raw, i) => {
          const recovered = createdById?.[String(i)] || (typeof raw.ref === 'string' ? createdById?.[raw.ref] : null)
          const restoredId = typeof (recovered as Record<string, unknown>)?.id === 'string'
            ? String((recovered as Record<string, unknown>).id)
            : `restored-task-${timestamp}-${i}-${String(raw.title || 'task')}`
          if (typeof raw.ref === 'string') refToId.set(raw.ref, restoredId)

          const resolveRef = (value: unknown): string | undefined => {
            if (typeof value !== 'string' || !value) return undefined
            return refToId.get(value) ?? value
          }

          this.taskManager.restoreTask({
            id: restoredId,
            title: String(raw.title || 'Task'),
            description: String(raw.description || ''),
            priority: ((raw.priority as TaskPriority | undefined) || 'medium'),
            status: 'pending',
            parentId: resolveRef(raw.parent_id) || null,
            progress: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          })

          const deps = raw.dependencies as unknown[] | undefined
          if (Array.isArray(deps)) {
            for (const depRef of deps) {
              const depId = resolveRef(depRef)
              if (depId) this.taskManager.addDependency(restoredId, depId)
            }
          }
        })
      }

      if (tc.name === 'update_task') {
        if (!this.isRestorableTaskToolCall(tc)) continue
        const args = tc.arguments || {}
        const taskId = args.task_id as string | undefined
        if (!taskId) continue

        this.taskManager.updateTask(taskId, {
          status: args.status as TaskStatus | undefined,
          progress: args.progress as number | undefined,
          error: args.error as string | undefined,
        })
      }
    }
  }

  private isRestorableTaskToolCall(toolCall: { name: string; result?: string; isError?: boolean; status?: string }): boolean {
    if (toolCall.isError) return false
    if (toolCall.status === 'error' || toolCall.status === 'cancelled' || toolCall.status === 'pending' || toolCall.status === 'running') return false
    if (toolCall.status === 'completed') return true
    if (!toolCall.result) return false
    if (/^(Cancelled|Aborted):/i.test(toolCall.result.trim())) return false
    return !this.isToolOutputFailure(toolCall.name, toolCall.result)
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publishRuntimeTaskFinished(task: RuntimeTask): void {
    this.emit({ type: 'runtime-task:finished', task })
  }

  abort(): void {
    this.abortController?.abort()
    this.fastContextAbortController?.abort()
    this.standaloneFastContextAbortController?.abort()
    if (this.fastContextRuntimeTaskId) {
      void this.subAgentTaskManager.stopTask(this.fastContextRuntimeTaskId, 'Parent agent aborted').catch(() => {})
    }
    if (this.standaloneFastContextRuntimeTaskId) {
      void this.subAgentTaskManager.stopTask(this.standaloneFastContextRuntimeTaskId, 'FastContext command aborted').catch(() => {})
    }
    // Per-conv stream abort: only cancel THIS engine's HTTP stream in the
    // main process, not every active stream across all conversations.
    if (this.currentStreamId !== null) {
      this.toolExecutor.streamAbort?.(this.currentStreamId).catch(() => {})
    }
    // Keep the controller alive so subsequent signal.aborted checks
    // don't NPE; destroy() is the only path that nulls it.
    if (this.isPaused && this.pauseResolve) {
      this.pauseResolve()
      this.isPaused = false
      this.pausePromise = null
      this.pauseResolve = null
    }
    if (this.pendingAskUserResolve) {
      this.pendingAskUserResolve('deny')
      this.pendingAskUserResolve = null
    }
  }

  submitAskUserResponse(response: string): void {
    if (this.pendingAskUserResolve) {
      this.pendingAskUserResolve(response)
      this.pendingAskUserResolve = null
      return
    }
    this.queuedAskUserResponse = response
  }

  private waitForAskUserResponse(): Promise<string> {
    if (this.queuedAskUserResponse !== null) {
      const response = this.queuedAskUserResponse
      this.queuedAskUserResponse = null
      return Promise.resolve(response)
    }
    return new Promise(resolve => {
      this.pendingAskUserResolve = resolve
    })
  }

  pause(): void {
    if (!this.isPaused) {
      this.isPaused = true
      this.pausePromise = new Promise(resolve => {
        this.pauseResolve = resolve
      })
    }
  }

  resume(): void {
    if (this.isPaused && this.pauseResolve) {
      this.pauseResolve()
      this.isPaused = false
      this.pausePromise = null
      this.pauseResolve = null
    }
  }

  private async waitIfPaused(): Promise<void> {
    if (this.isPaused && this.pausePromise) {
      await this.pausePromise
    }
  }

  private isContextLimitError(message: string): boolean {
    return /context (?:window|length|limit)|maximum context|prompt is too long|input length .*max_tokens.*context limit|tokens?\s*>\s*\d+/i.test(message)
  }

  private async prepareContextWindow(): Promise<void> {
    if (this.forceContextCompactionBeforeNextCall) {
      this.forceContextCompactionBeforeNextCall = false
      await this.ensureContextWindow(true)
      this.compressionPreparedTurnCount = this.session.turns.length
      return
    }

    const currentTurnCount = this.session.turns.length
    if (currentTurnCount === this.compressionPreparedTurnCount) return
    if (this.shouldCompactFromProviderUsage()) {
      await this.ensureContextWindow(true)
    } else if (this.shouldRecapFromProviderUsage()) {
      await this.createCacheSafeRecap()
    }
    this.compressionPreparedTurnCount = currentTurnCount
  }

  private currentContextWindowSettings(): { contextWindow: number; maxOutputTokens: number; model?: string; provider?: string } {
    const activeConfig = this.stateProvider.getActiveConfig()
    const activeModel = this.stateProvider.getActiveModel()
    return {
      contextWindow: activeModel?.contextWindow || activeConfig?.contextWindow || this.config.contextWindow || 200_000,
      maxOutputTokens: this.config.maxTokens || activeModel?.maxTokens || activeConfig?.maxTokens || 4096,
      model: activeModel?.id || activeConfig?.defaultModel,
      provider: activeModel?.provider || activeConfig?.provider,
    }
  }

  private providerContextTokens(): number {
    const usage = this.contextManager.getLastProviderUsage()
    if (usage.source !== 'provider' || typeof usage.input !== 'number' || usage.input <= 0) {
      return 0
    }
    return usage.input
  }

  private shouldCompactFromProviderUsage(): boolean {
    const providerTokens = this.currentContextTokensWithTokenizerTail()
    if (providerTokens <= 0 || !Number.isFinite(providerTokens)) return false
    const settings = this.currentContextWindowSettings()
    return providerTokens >= autoCompactThreshold(settings.contextWindow, settings.maxOutputTokens, this.config.contextPolicy)
  }

  private shouldRecapFromProviderUsage(): boolean {
    const providerTokens = this.currentContextTokensWithTokenizerTail()
    if (providerTokens <= 0 || !Number.isFinite(providerTokens)) return false
    const settings = this.currentContextWindowSettings()
    return providerTokens >= recapThreshold(settings.contextWindow, settings.maxOutputTokens, this.config.contextPolicy)
  }

  private currentContextTokensWithTokenizerTail(): number {
    const providerTokens = this.providerContextTokens()
    if (providerTokens <= 0) return 0
    const settings = this.currentContextWindowSettings()
    const lastUsageIndex = this.findLastProviderUsageTurnIndex()
    if (lastUsageIndex < 0 || lastUsageIndex >= this.session.turns.length - 1) {
      return providerTokens
    }
    const tailTurns = this.session.turns.slice(lastUsageIndex + 1)
    const tailCount = countTurnishTokens(tailTurns, {
      provider: settings.provider || 'custom',
      model: settings.model,
    })
    return tailCount.source === 'unavailable' ? providerTokens : providerTokens + tailCount.tokens
  }

  private findLastProviderUsageTurnIndex(): number {
    for (let index = this.session.turns.length - 1; index >= 0; index -= 1) {
      const tokens = this.session.turns[index]?.metadata?.tokens
      if (tokens?.source === 'provider' || typeof tokens?.input === 'number') {
        return index
      }
    }
    return -1
  }

  private async createCacheSafeRecap(): Promise<void> {
    const nonSystemTurns = this.session.turns.filter(t => t.role !== 'system')
    const keepRecent = resolveContextPolicyProfile(this.config.contextPolicy).recapKeepRecentTurns
    if (nonSystemTurns.length <= keepRecent + 4) return

    const { oldTurns: recapTurns, recentTurns } = splitTurnsForCompaction(nonSystemTurns, keepRecent)
    const firstVisibleTurn = recapTurns.find(turn => turn.role === 'user' || turn.role === 'assistant')
    const lastVisibleTurn = [...recapTurns].reverse().find(turn => turn.role === 'user' || turn.role === 'assistant')
    if (!firstVisibleTurn || !lastVisibleTurn) return

    const startMessageId = firstVisibleTurn.id
    const endMessageId = lastVisibleTurn.id
    const existingSegments = this.stateProvider.getContextSegments()
    const alreadyCovered = existingSegments.some(segment =>
      segment.startMessageId === startMessageId && segment.endMessageId === endMessageId
    )
    if (alreadyCovered) return

    let summary: string
    let isModelGenerated: boolean
    try {
      summary = await this.generateContinuationSummary(recapTurns, recentTurns)
      if (!summary.trim()) throw new Error('Recap generation returned empty content')
      isModelGenerated = true
    } catch {
      const structured = extractStructuredSummary(recapTurns)
      summary = formatSummaryAsContext(structured)
      isModelGenerated = false
    }

    const segment: ContextSegment = {
      startMessageId,
      endMessageId,
      summary: `<cache_safe_recap>\n${summary.trim()}\n</cache_safe_recap>`,
      isModelGenerated,
      kind: 'recap',
      originalCharCount: recapTurns.reduce((sum, turn) => sum + this.countTurnChars(turn), 0),
      isValid: true,
      createdAt: Date.now(),
      coveredTurnIds: recapTurns.map(turn => turn.id),
    }
    this.stateProvider.addContextSegment(segment)
    this.emit({ type: 'context:segment_created', segment })
    this.emit({
      type: 'notification',
      message: 'Cache-safe recap saved; keeping full conversation prefix intact.',
      level: 'info',
    })
  }

  async waitUntilIdle(): Promise<void> {
    if (this.currentRunPromise) {
      try { await this.currentRunPromise } catch { /* drain */ }
    }
  }

  async run(userMessage: string, options?: { reuseLastUserTurn?: boolean; attachments?: NonNullable<AgentTurn['metadata']>['attachments'] }): Promise<AgentTurn[]> {
    if (this.currentRunPromise) {
      throw new Error('AgentEngine.run() called while a previous run is still in flight')
    }
    if (this.standaloneFastContextRunPromise) {
      throw new Error('AgentEngine.run() called while a standalone FastContext scan is still in flight')
    }
    const runPromise = (async () => {
    await this.detectAndEnableGit()
    this.abortController = new AbortController()
    this.runtimeAppendSystemPrompt = null
    this.currentRunToolNames = []
    this.currentRunReadFiles.clear()
    this.currentRunSuccessfulReadFiles.clear()
    this.currentRunSearches.clear()
    this.currentRunSuccessfulSearches.clear()
    this.currentRunExplorePacks.clear()
    this.conclusionGuardAttempts = 0
    this.contextLimitRetryInProgress = false
    this.preservedFiles = []
    this.codemapSummary = null
    this.codemapCacheKey = null
    this.workspaceMemoryText = null
    this.workspaceMemoryWorkspace = null
    this.workspaceMemoryBuiltAt = 0
    // Replay tool-call evidence from any turns we just restored so the
    // evidence guard sees "prior reads/searches in this conversation" as
    // valid evidence on the very first model turn of the new run. Without
    // this, restoreFromMessages + run() would always start with empty
    // currentRun* sets and the conclusion guard would fire spuriously
    // (Bug #19).
    this.replayEvidenceFromExistingTurns()

    const canReuseLastUserTurn = options?.reuseLastUserTurn
      && this.session.turns[this.session.turns.length - 1]?.role === 'user'
      && this.session.turns[this.session.turns.length - 1]?.content === userMessage

    const newTurns: AgentTurn[] = []
    if (!canReuseLastUserTurn) {
      const userTurn = this.createUserTurn(userMessage, options?.attachments)
      this.session.turns.push(userTurn)
      this.emit({ type: 'turn:start', turn: userTurn })
      newTurns.push(userTurn)
    }

    const fastContextPreludeTurn = this.createFastContextPreludeTurn(userMessage)
    if (fastContextPreludeTurn) {
      this.session.turns.push(fastContextPreludeTurn)
      this.emit({ type: 'turn:complete', turn: fastContextPreludeTurn })
      newTurns.push(fastContextPreludeTurn)
    }

    if (this.fastContextObjective && !this.fastContextPack) {
      this.startFastContextBackground(this.fastContextObjective)
    }

    const effectiveMaxTurns = this.config.maxTurns || 30

    let longRunNoticeShown = false
    let consecutiveToolErrors = 0
    const MAX_CONSECUTIVE_ERRORS = 1

    try {
      let turnCount = 0
      let totalAssistantTurnCount = 0
      let consecutiveNonExecutionTurns = 0
      const longRunWarningThreshold = Math.max(effectiveMaxTurns, 10)
      const nonExecutionTurnLimit = 8

      while (true) {
        if (this.abortController?.signal.aborted) {
          break
        }

        await this.waitIfPaused()
        await this.prepareContextWindow()

        if (totalAssistantTurnCount >= effectiveMaxTurns) {
          this.emit({
            type: 'notification',
            message: `Max turns reached (${effectiveMaxTurns}). Pausing.`,
            level: 'warning',
          })
          break
        }

        const assistantTurn = await this.callModel()
        totalAssistantTurnCount++

        this.session.turns.push(assistantTurn)
        newTurns.push(assistantTurn)
        this.emit({ type: 'turn:complete', turn: assistantTurn })

        if (!assistantTurn.toolCalls || assistantTurn.toolCalls.length === 0) {

          // No tool calls — decide whether to continue or break
          const hasActiveTasks = this.taskManager.getTasksByStatus('in_progress').length > 0
          const hasPendingTasks = this.taskManager.getTasksByStatus('pending').length > 0
          const hasAnyTasks = this.taskManager.getAllTasks().length > 0

          if (!hasActiveTasks && !hasPendingTasks && !hasAnyTasks) {
            break
          }
          consecutiveNonExecutionTurns++
          if (hasPendingTasks && !hasActiveTasks) {
            if (consecutiveNonExecutionTurns >= nonExecutionTurnLimit) {
              this.emit({
                type: 'notification',
                message: 'Agent produced narration only — pausing for review.',
                level: 'warning',
              })
              break
            }
            continue
          }
          if (hasActiveTasks) {
            if (consecutiveNonExecutionTurns >= nonExecutionTurnLimit) {
              this.emit({
                type: 'notification',
                message: 'No action taken — pausing for review.',
                level: 'warning',
              })
              break
            }
            continue
          }
          break
        }

        this.runtimeAppendSystemPrompt = null

        const isOnlyTaskCreation = assistantTurn.toolCalls.every(tc =>
          tc.name === 'create_task' || tc.name === 'create_tasks' || tc.name === 'update_task' || tc.name === 'list_tasks'
        )
        if (isOnlyTaskCreation) {
          consecutiveNonExecutionTurns++
          if (consecutiveNonExecutionTurns >= nonExecutionTurnLimit) {
            this.emit({
              type: 'notification',
              message: 'Task tree only — pausing for review.',
              level: 'warning',
            })
            break
          }
        } else {
          consecutiveNonExecutionTurns = 0
          turnCount++
          if (!longRunNoticeShown && turnCount >= longRunWarningThreshold) {
            this.emit({
              type: 'notification',
              message: `Long-running session (${turnCount} turns). Consider reviewing progress.`,
              level: 'info',
            })
            longRunNoticeShown = true
          }
        }

        const toolResults = await this.executeToolCalls(assistantTurn.toolCalls!)

        const errorCount = toolResults.filter(r => r.isError).length
        if (errorCount > 0) {
          consecutiveToolErrors++
          if (consecutiveToolErrors >= MAX_CONSECUTIVE_ERRORS) {
            const retryHint = this.buildToolRetryHint(assistantTurn.toolCalls!, toolResults)
            if (retryHint) {
              this.runtimeAppendSystemPrompt = retryHint
              consecutiveToolErrors = 0
            }
          }
        } else {
          consecutiveToolErrors = Math.max(0, consecutiveToolErrors - 1)
        }

        const resultTurn = this.createToolResultTurn(toolResults)
        this.session.turns.push(resultTurn)
        newTurns.push(resultTurn)

        const hasAskUser = assistantTurn.toolCalls!.some(tc => tc.name === 'ask_user')
        if (hasAskUser) {
          const userResponse = await this.waitForAskUserResponse()
          this.pendingAskUserResolve = null

          const responseTurn = this.createUserTurn(userResponse)
          this.session.turns.push(responseTurn)
          newTurns.push(responseTurn)
          this.emit({ type: 'turn:start', turn: responseTurn })
          continue
        }
      }

      this.session.updatedAt = Date.now()
      // Finalize any in_progress leaf tasks that the model forgot to flip
      // to completed/failed. Without this, tasks where every tool call has
      // already terminated (success or fail) freeze at 99% and the parent
      // task's averaged progress never reaches 100%, even though the run
      // is over. See taskManager.finalizeOrphanedLeaves for the policy.
      const finalized = this.taskManager.finalizeOrphanedLeaves()
      if (finalized.length > 0) {
        this.emit({ type: 'active:task', context: this.taskManager.getActiveTaskContext() })
      }
      this.emit({ type: 'session:complete', session: this.session })

      await this.prepareContextWindow()
    } catch (error) {
      const errAborted = (error as { aborted?: boolean })?.aborted === true
        || this.abortController?.signal.aborted === true
      if (!errAborted) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error'
        this.emit({ type: 'error', error: errorMsg })
      }
      this.clearFastContextBackground()
      throw error
    }

    this.clearFastContextBackground()
    return newTurns
    })()
    this.currentRunPromise = runPromise
    // Always release the slot once the run settles, even on rejection.
    void runPromise.catch(() => { /* surfaced via emit + caller try/catch */ }).finally(() => {
      if (this.currentRunPromise === runPromise) {
        this.currentRunPromise = null
      }
    })
    return runPromise
  }

  /**
   * Check if the session is approaching the context window limit.
   * If so, generate a model-produced continuation summary and emit a
   * context:segment_created event so the store can persist it.
   *
   * The user never sees a conversation break — they can still scroll back,
   * edit old messages, and rollback to any checkpoint.
   */
  private async ensureContextWindow(force = false): Promise<void> {
    const activeConfig = this.stateProvider.getActiveConfig()
    if (!activeConfig || !activeConfig.apiKey) return

    if (!force) return

    if (this.contextManager.getLastProviderUsage().source === 'provider') {
      this.emit({
        type: 'notification',
        message: 'Context usage is high; compacting older conversation before the next model call.',
        level: 'info',
      })
    }

    // Keep the most recent 10 turns intact (matches the rolling-window N=10
    // from arxiv:2508.21433 — empirically optimal for SWE-bench agents).
    const keepRecent = 10
    const nonSystemTurns = this.session.turns.filter(t => t.role !== 'system')
    const { oldTurns, recentTurns } = splitTurnsForCompaction(nonSystemTurns, keepRecent)

    if (oldTurns.length === 0) return

    // Segment boundaries must be real ChatMessage ids so chatStore can
    // invalidate them after visible message edits/deletes. Hidden tool_result
    // turns are still covered because they sit between these boundary turns.
    const firstVisibleOldTurn = oldTurns.find(turn => turn.role === 'user' || turn.role === 'assistant')
    const lastVisibleOldTurn = [...oldTurns].reverse().find(turn => turn.role === 'user' || turn.role === 'assistant')
    if (!firstVisibleOldTurn || !lastVisibleOldTurn) return

    const startMessageId = firstVisibleOldTurn.id
    const endMessageId = lastVisibleOldTurn.id
    const originalCharCount = oldTurns.reduce((sum, t) => sum + this.countTurnChars(t), 0)
    const existingSegments = this.stateProvider.getContextSegments()
    const alreadyCovered = existingSegments.some(segment =>
      segment.startMessageId === startMessageId && segment.endMessageId === endMessageId
    )
    if (alreadyCovered) return

    // Find the last checkpoint in the old turns
    let checkpointId: string | undefined
    for (let i = oldTurns.length - 1; i >= 0; i--) {
      if (oldTurns[i].metadata?.checkpointId) {
        checkpointId = oldTurns[i].metadata!.checkpointId
        break
      }
    }

    // Generate the continuation summary using the model
    let summary: string
    let isModelGenerated: boolean

    try {
      summary = await this.generateContinuationSummary(oldTurns, recentTurns)
      if (!summary.trim()) throw new Error('Summary generation returned empty content')
      isModelGenerated = true
    } catch {
      const structured = extractStructuredSummary(oldTurns)
      summary = formatSummaryAsContext(structured)
      isModelGenerated = false
    }

    const segment: ContextSegment = {
      startMessageId,
      endMessageId,
      summary,
      isModelGenerated,
      kind: isModelGenerated ? 'compact' : 'structured',
      checkpointId,
      originalCharCount,
      isValid: true,
      createdAt: Date.now(),
      coveredTurnIds: oldTurns.map(turn => turn.id),
    }
    this.stateProvider.addContextSegment(segment)
    this.emit({ type: 'context:segment_created', segment })
    this.addReservoirEntry(startMessageId, endMessageId, oldTurns, 'compact', originalCharCount)

    // Post-compact file recovery: scan old turns for the most recent
    // read_file results and preserve them so the model doesn't lose
    // working context. Only the last 5 unique files are kept, capped
    // at ~5000 tokens each (20k chars) to avoid blowing the budget.
    const readFilePathByToolCallId = new Map<string, string>()
    for (const turn of oldTurns) {
      if (turn.role === 'assistant' && turn.toolCalls) {
        for (const tc of turn.toolCalls) {
          if ((tc.name === 'read_file' || tc.name === 'read_file_full') && typeof tc.arguments.path === 'string') {
            readFilePathByToolCallId.set(tc.id, tc.arguments.path as string)
          }
        }
      }
    }
    const preserved: Array<{ path: string; content: string }> = []
    const seenPaths = new Set<string>()
    const MAX_PRESERVED_FILES = 5
    const MAX_PRESERVED_CHARS = 20_000
    for (let i = oldTurns.length - 1; i >= 0; i--) {
      const turn = oldTurns[i]
      if (turn.role !== 'tool_result' || !turn.toolResults) continue
      for (const tr of turn.toolResults) {
        if (tr.name !== 'read_file' && tr.name !== 'read_file_full') continue
        const path = readFilePathByToolCallId.get(tr.toolCallId)
        if (!path || seenPaths.has(path)) continue
        seenPaths.add(path)
        const content = tr.output.length > MAX_PRESERVED_CHARS
          ? `${tr.output.slice(0, MAX_PRESERVED_CHARS)}\n… <truncated>`
          : tr.output
        preserved.push({ path, content })
        if (preserved.length >= MAX_PRESERVED_FILES) break
      }
      if (preserved.length >= MAX_PRESERVED_FILES) break
    }
    this.preservedFiles = preserved.reverse() // oldest-first for stable ordering

    // Hard-replace: discard old turns from the live session so subsequent
    // buildApiMessages() calls never see them again. The summary is
    // persisted in chatStore via the context:segment_created event above
    // and will be injected into the system prompt by buildMessages().
    // The original turns remain in chatStore.messages for UI display,
    // rollback, and edit — they are just no longer sent to the API.
    const systemTurns = this.session.turns.filter(t => t.role === 'system')
    this.session.turns = [...systemTurns, ...recentTurns]
    this.contextManager.reset()
    this.cacheMonitor.resetBaseline()
  }

  /**
   * Ask the model to generate a continuation summary for the next context window.
   * This is a hidden API call — the user does not see it as a regular message.
   */
  private async generateContinuationSummary(oldTurns: AgentTurn[], recentTurns: AgentTurn[]): Promise<string> {
    const activeConfig = this.stateProvider.getActiveConfig()

    if (!activeConfig || !activeConfig.apiKey) throw new Error('No API key configured for continuation summary')

    const provider = activeConfig.provider === 'anthropic' ? 'anthropic' : 'openai'

    // Build a compact representation of old turns for the summary prompt
    const oldTurnsSummary = oldTurns.map(turn => {
      let line = `[${turn.role}] `
      if (turn.role === 'assistant') {
        const clean = (turn.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
        line += clean.slice(0, 300)
        if (turn.toolCalls) {
          line += ` [tools: ${turn.toolCalls.map(tc => tc.name).join(', ')}]`
        }
      } else {
        line += (turn.content || '').slice(0, 200)
      }
      return line
    }).join('\n')

    const recentContext = recentTurns.map(turn => {
      let line = `[${turn.role}] `
      if (turn.role === 'assistant') {
        const clean = (turn.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
        line += clean.slice(0, 200)
      } else {
        line += (turn.content || '').slice(0, 150)
      }
      return line
    }).join('\n')

    const summaryPrompt = `You are a context compression assistant. Your job is to generate a continuation summary that will be injected into the NEXT context window so the AI can seamlessly continue this conversation.

Based on the conversation history below, produce a structured summary with these sections:

<continuation_summary>
<conversation_goal>What the user originally asked for and what they're trying to accomplish</conversation_goal>
<project_state>Current state of the project: what files exist, what's been built, what's working</project_state>
<current_task>What the AI is currently working on right now</current_task>
<recent_dialogue>Key points from the most recent exchanges (decisions made, questions answered)</recent_dialogue>
<files_touched>Files that were read, written, or edited and WHY</files_touched>
<important_decisions>Key decisions the user made (especially from ask_user responses)</important_decisions>
<open_questions>Unresolved issues or questions that still need attention</open_questions>
<rollback_anchor>If a checkpoint was created, note it here so the user can rollback</rollback_anchor>
<next_step_hint>What the AI should focus on next to continue the task</next_step_hint>
</continuation_summary>

Rules:
- Be concise but comprehensive — this summary replaces the full conversation history
- Focus on WHY things were done, not just WHAT was done
- Preserve any user preferences, constraints, or style choices mentioned
- Note any errors encountered and whether they were resolved
- Keep each section to 2-4 sentences maximum

OLDER CONVERSATION (being summarized):
${oldTurnsSummary}

RECENT CONVERSATION (still in context):
${recentContext}`

    // Make a lightweight API call — no tools, just text generation
    const messages: Array<Record<string, unknown>> = [
      { role: 'user', content: summaryPrompt },
    ]

    const url = provider === 'anthropic'
      ? `${activeConfig.baseUrl.replace(/\/$/, '')}/messages`
      : `${normalizeBaseUrl(activeConfig.baseUrl)}/chat/completions`

    const headers: Record<string, string> = createTurboFluxRequestHeaders(provider === 'anthropic'
      ? {
          'Content-Type': 'application/json',
          'x-api-key': activeConfig.apiKey,
          'anthropic-version': '2023-06-01',
          ...activeConfig.customHeaders,
        }
      : {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${activeConfig.apiKey}`,
          ...activeConfig.customHeaders,
        })

    if (activeConfig.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://turboflux.dev'
      headers['X-Title'] = 'Turboflux'
    }

    const body = provider === 'anthropic'
      ? JSON.stringify({
          model: activeConfig.defaultModel,
          max_tokens: 1500,
          messages,
          system: 'You are a context compression assistant. Generate concise, structured continuation summaries.',
        })
      : JSON.stringify({
          model: activeConfig.defaultModel,
          max_tokens: 1500,
          temperature: 0.3,
          messages: [{ role: 'system', content: 'You are a context compression assistant. Generate concise, structured continuation summaries.' }, ...messages],
        })

    const result = await this.toolExecutor.sendMessage(url, headers, body, {
      signal: this.abortController?.signal,
    })

    if (!result.success || !result.data) {
      throw new Error(result.error || 'Summary generation failed')
    }

    // Extract text from API response
    let summaryText = ''
    const responseData = result.data as {
      content?: Array<{ text?: string }>
      choices?: Array<{ message?: { content?: string } }>
    } | string
    if (provider === 'anthropic' && typeof responseData !== 'string' && responseData.content?.[0]?.text) {
      summaryText = responseData.content[0].text
    } else if (typeof responseData !== 'string' && responseData.choices?.[0]?.message?.content) {
      summaryText = responseData.choices[0].message.content
    } else if (typeof responseData === 'string') {
      summaryText = responseData
    }

    if (!summaryText) {
      throw new Error('Summary generation returned empty content')
    }

    return summaryText
  }

  private countTurnChars(turn: AgentTurn): number {
    let text = turn.content || ''
    if (turn.toolCalls) {
      for (const tc of turn.toolCalls) {
        text += ` ${tc.name} ${JSON.stringify(tc.arguments)}`
      }
    }
    if (turn.toolResults) {
      for (const tr of turn.toolResults) {
        text += ` ${tr.output}`
      }
    }
    return text.length
  }

  private addReservoirEntry(
    startMessageId: string,
    endMessageId: string,
    turns: AgentTurn[],
    source: ContextReservoirEntry['source'],
    originalCharCount = turns.reduce((sum, turn) => sum + this.countTurnChars(turn), 0),
  ): void {
    if (turns.length === 0) return
    this.stateProvider.addContextReservoirEntry({
      id: `reservoir-${startMessageId}-${endMessageId}`,
      startMessageId,
      endMessageId,
      turns: turns.map(turn => ({ ...turn })),
      source,
      originalCharCount,
      createdAt: Date.now(),
    })
    this.pruneContextReservoir()
  }

  private pruneContextReservoir(): void {
    const MAX_ENTRIES = 24
    const MAX_CHARS = 2_500_000
    const entries = this.stateProvider.getContextReservoir()
      .slice()
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    const kept: ContextReservoirEntry[] = []
    let totalChars = 0
    for (const entry of entries) {
      const chars = entry.originalCharCount || entry.turns.reduce((sum, turn) => sum + this.countTurnChars(turn), 0)
      if (kept.length >= MAX_ENTRIES || totalChars + chars > MAX_CHARS) continue
      kept.push(entry)
      totalChars += chars
    }
    this.stateProvider.setContextReservoir(kept.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)))
  }

  private autoClearStaleToolResults(): void {
    const turns = this.session.turns
    if (turns.length < 4) return

    for (let i = turns.length - 3; i >= 0; i--) {
      const turn = turns[i]
      if (turn.role === 'tool_result' && turn.toolResults) {
        const hasActiveRef = turns.slice(i + 1).some(laterTurn => {
          if (laterTurn.role !== 'assistant') return false
          const content = (laterTurn.content || '').toLowerCase()
          return turn.toolResults!.some(tr => {
            if (content.includes(tr.toolCallId.toLowerCase())) return true
            if (tr.output && tr.output.length > 40 && content.includes(tr.output.slice(0, 40).toLowerCase())) return true
            const filePath = tr.changeSummary?.path
            if (filePath && content.includes(filePath.toLowerCase())) return true
            return false
          })
        })
        if (!hasActiveRef) {
          turn.toolResults = turn.toolResults.map(tr => ({
            ...tr,
            // Aggressively truncate stale tool results: keep only a short
            // stub so the model can still see what tool ran, but the bulk
            // of the content (which is already reflected in the assistant's
            // subsequent reasoning) is dropped. Previous threshold was 200
            // chars which still left large read_file / search outputs intact.
            output: tr.output.length > 80
              ? `[cleared: ${tr.name} (${tr.output.length} chars)]`
              : tr.output,
          }))
        }
      }
    }
  }

  private buildToolRetryHint(failedToolCalls: ToolCall[], toolResults: ToolResult[]): string | null {
    const errors = toolResults.filter(r => r.isError)
    if (errors.length === 0) return null

    const errorSummary = errors.map(e => `- ${e.name}: ${e.output.slice(0, 120)}`).join('\n')
    const toolNames = [...new Set(failedToolCalls.map(tc => tc.name))].join(', ')
    const editMatchFailed = errors.some(e =>
      (e.name === 'edit_file' || e.name === 'multi_edit')
      && /(old_string not found|found \d+ occurrences|Match must be exact|multi_edit is atomic)/i.test(e.output)
    )
    const editGuidance = editMatchFailed
      ? `
Exact edit matching failed. Do not retry another similar edit_file/multi_edit call against the same snippet.
Use one of these safer paths:
- For small changes: read the nearest surrounding lines, then use a longer unique old_string with stable context.
- For broad or fragile changes: use replace_file with the complete final file content.
`
      : ''

    return `<tool_retry_hint>
The last tool call(s) failed: ${toolNames}.
Errors:
${errorSummary}
${editGuidance}

Before retrying:
1. Identify the root cause of each failure (wrong path? missing file? syntax error?)
2. Propose a concrete alternative approach — do NOT repeat the same failing call
3. If a file path was wrong, use search_files or list_directory to find the correct path first
4. If the error is environmental (missing dependency, permission), report it to the user instead of retrying
5. After fixing the approach, re-attempt with corrected parameters
</tool_retry_hint>`
  }

  private async capturePreimage(filePath: string): Promise<void> {
    if (this.filePreimages.has(filePath)) return
    try {
      const readResult = await this.toolExecutor.readFile(filePath)
      this.filePreimages.set(filePath, readResult.success ? (readResult.data ?? null) : null)
    } catch {
      this.filePreimages.set(filePath, null)
    }
  }

  private diffStats(before: string, after: string): { addedLines?: number; removedLines?: number } {
    if (!canComputeDiff(before, after)) return {}
    const stats = summarizeHunks(computeHunks(before, after))
    return { addedLines: stats.added, removedLines: stats.removed }
  }

  private invalidateCodeLookupAfterFileChange(workspacePath: string, _filePaths: string[]): void {
    if (!workspacePath) return
    this.codemapSummary = null
    this.codemapCacheKey = null
  }

  private async runFastContextScan(objective: string, options: {
    signal?: AbortSignal
    injectPack: boolean
    maxTurns?: number
    maxParallel?: number
    generation?: number
    agentId?: string
    recordEvent?: (event: FastContextScanEvent) => void
  }): Promise<FastContextScanResult | null> {
    if (!this.config.workspacePath) return null
    if (options.signal?.aborted) return null

    const isCurrent = () => options.generation === undefined || options.generation === this.fastContextGeneration
    const emitIfCurrent = (event: AgentEventType) => {
      if (isCurrent()) this.emit(event)
    }
    const onEvent = (event: FastContextScanEvent) => {
      options.recordEvent?.(event)
      emitIfCurrent({ type: 'fast_context:event', event })
    }

    // FastContext is intentionally a subagent-only path. Ordinary model
    // turns stay steady and targeted; this mode is the explicit fast lane.
    const agentId = options.agentId || `fc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const startedAt = Date.now()
    try {
      // Build (or reuse) a stable workspace skeleton primer. This is
      // deliberately objective-agnostic so repeated scans reuse the prefix.
      const skeleton = await this.maybeBuildWorkspaceSkeleton(this.config.workspacePath)
      const fastContextConfig = this.stateProvider.getFastContextConfig?.() ?? this.stateProvider.getActiveConfig()
      const fastContextModel = this.stateProvider.getFastContextModel?.() ?? this.stateProvider.getActiveModel()

      emitIfCurrent({
        type: 'subagent:start',
        agentId,
        agentType: 'fast_context',
        label: 'FastContext',
        objective,
        runKind: 'fast_context',
      })
      onEvent({ type: 'insight', text: `Building FastContext code map with ${fastContextModel?.id || 'the configured model'}`, tone: 'info' })
      const result = await runFastContextSubagent({
        workspacePath: this.config.workspacePath,
        objective,
        toolExecutor: this.toolExecutor,
        apiKey: fastContextConfig?.apiKey || '',
        baseUrl: fastContextConfig?.baseUrl || 'https://api.deepseek.com',
        provider: fastContextConfig?.provider,
        customHeaders: fastContextConfig?.customHeaders,
        reasoning: fastContextConfig?.reasoning,
        modelCapabilities: fastContextConfig?.modelCapabilities,
        model: fastContextModel?.id || fastContextConfig?.defaultModel,
        codemap: skeleton,
        maxTurns: options.maxTurns,
        maxParallel: options.maxParallel,
        abortSignal: options.signal,
        onEvent,
      })
      if (options.injectPack && !options.signal?.aborted && isCurrent()) {
        this.fastContextPack = result.filesScanned > 0 && result.hits.length > 0 ? result.evidencePack : null
      }
      emitIfCurrent({ type: 'fast_context:complete', result })
      emitIfCurrent({ type: 'subagent:end', agentId, agentType: 'fast_context', ok: true, elapsedMs: Date.now() - startedAt, runKind: 'fast_context' })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failedResult: FastContextScanResult = {
        objective,
        evidencePack: '',
        filesScanned: 0,
        hits: [],
        elapsedMs: Date.now() - startedAt,
        truncated: true,
      }
      emitIfCurrent({ type: 'subagent:end', agentId, agentType: 'fast_context', ok: false, elapsedMs: Date.now() - startedAt, runKind: 'fast_context' })
      if (options.signal?.aborted) {
        emitIfCurrent({ type: 'fast_context:complete', result: failedResult })
        return null
      }
      onEvent({
        type: 'phase',
        phase: 'error',
        insight: `FastContext code map failed: ${message.slice(0, 120)}`,
      })
      onEvent({
        type: 'insight',
        text: 'FastContext did not run. Use targeted read/search tools or retry after fixing the model connection.',
        tone: 'warning',
      })
      emitIfCurrent({ type: 'fast_context:complete', result: failedResult })
    }
    return null
  }

  private async callModel(): Promise<AgentTurn> {
    const activeConfig = this.stateProvider.getActiveConfig()
    const activeModel = this.stateProvider.getActiveModel()

    if (!activeConfig || !activeConfig.apiKey) {
      return this.createMockTurn()
    }

    const turnStrategy = this.turnStrategyPlanner.plan(this.session, this.config.mode)
    this.currentTurnStrategy = turnStrategy
    // Strategy can skip heavyweight context for pure chat, but it never
    // controls tool visibility. Modes and permission policy own that.
    const skipHeavyContext = !turnStrategy?.needsWorkspaceContext
    await Promise.all([
      skipHeavyContext ? Promise.resolve() : this.maybeFetchCodemapSummary(turnStrategy),
      skipHeavyContext ? Promise.resolve() : this.maybeRefreshWorkspaceMemory(),
      skipHeavyContext ? Promise.resolve() : this.maybeBuildWorkspaceSkeleton(this.config.workspacePath || '').then(() => undefined),
      this.refreshGitStatus(),
    ])
    // Long-conversation persona drift reminder — empty string when below threshold.
    const voiceReminderContext: string | null = null
    const strategyContext = this.turnStrategyPlanner.buildStrategyContext(turnStrategy)
    const fastContextPackForTurn = this.fastContextPack
    const dynamicRuntimeContext = [
      this.config.workspacePath
        ? this.wrapRuntimeContextSection('current_workspace', [
            `The active workspace is exactly: ${this.config.workspacePath}`,
            'Historical references to other projects are context only, not the current workspace.',
            'Do not claim a file, directory, or project was opened, inspected, or selected unless a tool result in this conversation proves it.',
            'Resolve relative filesystem paths against this active workspace.',
          ].join('\n'))
        : null,
      this.config.appendSystemPrompt,
      strategyContext,
      fastContextPackForTurn,
      this.runtimeAppendSystemPrompt,
      voiceReminderContext,
      this.cachedGitStatus ? this.wrapRuntimeContextSection('git_status', this.cachedGitStatus) : null,
      !skipHeavyContext && this.workspaceMemoryText ? this.wrapRuntimeContextSection('workspace_memory', this.workspaceMemoryText) : null,
      !skipHeavyContext && this.codemapSummary ? this.wrapRuntimeContextSection('codebase_map', this.codemapSummary) : null,
    ].filter(Boolean).join('\n\n') || undefined

    // FastContext pack is only useful for the FIRST model call in a run —
    // after that the model has already seen the evidence and subsequent turns
    // should rely on the conversation history instead. Keeping it in every
    // turn wastes tokens proportional to pack size × number of turns.
    if (fastContextPackForTurn && this.fastContextPack === fastContextPackForTurn) {
      this.fastContextPack = null
      this.fastContextObjective = null
    }

    const systemPrompt = buildSystemPrompt(this.config.mode, {
      workspacePath: this.config.workspacePath,
      workspaceName: this.config.workspaceName,
      systemPromptOverride: this.config.systemPromptOverride,
      profileSystemPrompt: this.config.profileSystemPrompt,
      enabledSkills: this.config.enabledSkills,
      provider: activeConfig.provider,
      modelId: activeConfig.defaultModel,
      shell: this.config.shell,
    })

    const startTime = Date.now()
    const protocolCandidates = planModelProtocols(activeConfig.provider, activeConfig.defaultModel)
    const preservedFiles = this.preservedFiles.map(file => ({ ...file }))
    const messagesByProvider = new Map<'openai' | 'anthropic', Array<Record<string, unknown>>>()
    const messagesFor = (provider: 'openai' | 'anthropic') => {
      const cached = messagesByProvider.get(provider)
      if (cached) return cached
      const messages = this.buildApiMessages(systemPrompt, provider)
      this.injectAppendIntoMessages(messages, dynamicRuntimeContext || '', provider)
      this.injectPreservedFilesIntoMessages(messages, provider, preservedFiles, false)
      this.enforceFinalMessageBudget(messages, provider, activeConfig, activeModel)
      messagesByProvider.set(provider, messages)
      return messages
    }
    const attempts: ModelProtocolAttempt[] = []
    if (preservedFiles.length > 0) this.preservedFiles = []

    try {
      for (let index = 0; index < protocolCandidates.length; index += 1) {
        const protocol = protocolCandidates[index]
        const url = buildModelProtocolUrl(activeConfig.baseUrl, protocol)
        this.emit({ type: 'model:protocol', phase: 'attempt', protocol, url })
        try {
          let turn: AgentTurn
          if (protocol === 'anthropic_messages') {
            const messages = messagesFor('anthropic')
            const effectiveSystemPrompt = messages.find(m => m.role === 'system' && typeof m.content === 'string')?.content as string | undefined
            turn = await this.callAnthropicAPI(activeConfig, activeModel, effectiveSystemPrompt || systemPrompt, messages, startTime, turnStrategy)
          } else if (protocol === 'openai_responses') {
            turn = await this.callOpenAIResponsesAPI(activeConfig, activeModel, messagesFor('openai'), startTime, turnStrategy)
          } else {
            turn = await this.callOpenAICompatibleAPI(activeConfig, activeModel, messagesFor('openai'), startTime, turnStrategy)
          }
          this.emit({ type: 'model:protocol', phase: 'success', protocol, url })
          return turn
        } catch (error) {
          if ((error as { aborted?: boolean })?.aborted === true || this.abortController?.signal.aborted) {
            throw error
          }
          const protocolError = error instanceof ModelProtocolRequestError
            ? error
            : new ModelProtocolRequestError(error instanceof Error ? error.message : String(error), {
              protocol,
              url,
              kind: 'internal',
            })
          const attempt = toProtocolAttempt(protocolError)
          attempts.push(attempt)
          const nextProtocol = protocolCandidates[index + 1]
          if (!nextProtocol || !shouldFallbackProtocol(protocolError)) {
            throw new Error(formatProtocolFailure(attempts))
          }
          this.emit({ type: 'stream:end' })
          this.emit({
            type: 'model:protocol',
            phase: 'fallback',
            protocol: nextProtocol,
            url: buildModelProtocolUrl(activeConfig.baseUrl, nextProtocol),
            message: `${formatProtocolAttempt(attempt)}; retrying with ${protocolLabel(nextProtocol)}`,
          })
        }
      }
      throw new Error(formatProtocolFailure(attempts))
    } catch (error) {
      const errAborted = (error as { aborted?: boolean })?.aborted === true
        || this.abortController?.signal.aborted === true
      if (errAborted) {
        throw error
      }
      const errorMsg = error instanceof Error ? error.message : 'API call failed'
      if (this.isContextLimitError(errorMsg) && !this.contextLimitRetryInProgress) {
        this.contextLimitRetryInProgress = true
        this.forceContextCompactionBeforeNextCall = true
        this.emit({
          type: 'notification',
          message: 'Provider reported context limit; compacting conversation and retrying once.',
          level: 'warning',
        })
        await this.prepareContextWindow()
        return this.callModel()
      }
      this.emit({ type: 'error', error: errorMsg })
      return this.createAssistantTurn(`**Request Error**\n\n${errorMsg}\n\nPlease check your API configuration.`)
    }
  }

  private async callAnthropicAPI(
    config: APIConfig,
    model: APIModel | null,
    systemPrompt: string,
    messages: Array<Record<string, unknown>>,
    startTime: number,
    turnStrategy?: TurnStrategy | null,
  ): Promise<AgentTurn> {
    const url = buildModelProtocolUrl(config.baseUrl, 'anthropic_messages')
    // Bug 3 fix: token-efficient-tools-2025-02-19 is a Claude 3.7 Sonnet
    // beta. Sonnet 3.5 / Sonnet 4 / Opus 4 / Haiku-3 reject the header on
    // some baseUrl proxies and the request 4xx's. Only opt in for models
    // that documented support, and let custom headers from the caller win
    // so power users can still force it on or off explicitly.
    const modelId = (config.defaultModel || '').toLowerCase()
    const supportsTokenEfficientTools = (
      modelId.includes('claude-3-7') || modelId.includes('claude-3.7')
    )
    const headers: Record<string, string> = createTurboFluxRequestHeaders({
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      ...(config.provider === 'anthropic' ? {} : { 'Authorization': `Bearer ${config.apiKey}` }),
      ...(supportsTokenEfficientTools
        ? { 'anthropic-beta': 'token-efficient-tools-2025-02-19' }
        : {}),
      ...config.customHeaders,
    })

    // Tool visibility is mode/policy based. Turn strategy may influence
    // context hints, but never hides tools from the model.
    const anthropicTools = toolsToAnthropicFormat(this.config.mode, {
      disabledTools: [],
    })

    // Inject MCP tools into Anthropic format
    if (this.mcpClient) {
      const mcpTools = getMcpAgentTools(this.mcpClient)
      for (const tool of mcpTools.sort((a, b) => a.name.localeCompare(b.name))) {
        if (this.config.mode === 'plan' && !tool.isReadOnly) continue
        anthropicTools.push({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema || {
            type: 'object',
            properties: Object.fromEntries(tool.parameters.map(p => [p.name, { type: p.type, description: p.description }])),
            required: tool.parameters.filter(p => p.required).map(p => p.name),
          },
        })
      }
    }

    // CRITICAL FIX: Anthropic only honors the LAST 4 cache_control breakpoints
    // per request. Previously every tool got cache_control, which (a) burned
    // all 4 breakpoints on tools, leaving system + history uncached, and
    // (b) ignored markers on earlier tools. Mark only the LAST tool so the
    // entire (system) + (tools-as-one-block) prefix is one cache breakpoint.
    // See: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
    const cachedTools = anthropicTools.length > 0
      ? anthropicTools.map((t, i) => i === anthropicTools.length - 1
          ? { ...(t as object), cache_control: { type: 'ephemeral' } }
          : t)
      : anthropicTools

    const maxTokens = this.config.maxTokens || config.maxTokens || 0
    const anthropicMaxTokens = maxTokens > 0 ? maxTokens : (model?.maxTokens || 8192)
    const temperature = this.config.temperature ?? config.temperature ?? 0.7
    const requestMessages = this.withAnthropicMessageCacheControl(
      normalizeAnthropicToolMessages(messages.filter(m => m.role !== 'system')),
    )
    const requestBody: Record<string, unknown> = {
      model: config.defaultModel,
      max_tokens: anthropicMaxTokens,
      temperature,
      system: [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ],
      messages: requestMessages,
      stream: true,
    }
    const reasoningRequest = resolveNativeReasoningRequest(config.defaultModel, config.reasoning, config.provider, config.modelCapabilities)
    if (reasoningRequest?.thinking) {
      const thinking = { ...reasoningRequest.thinking }
      if (thinking.budget_tokens && thinking.budget_tokens >= anthropicMaxTokens) {
        thinking.budget_tokens = Math.max(1_024, anthropicMaxTokens - 1)
      }
      requestBody.thinking = thinking
    }
    if (reasoningRequest?.outputConfig) requestBody.output_config = reasoningRequest.outputConfig
    if (reasoningRequest?.omitTemperature) delete requestBody.temperature
    if (cachedTools.length > 0) {
      requestBody.tools = cachedTools
      requestBody.tool_choice = { type: 'auto' }
    }
    this.emitPromptModuleSnapshot(systemPrompt, anthropicTools, requestMessages)
    let serializedBody = JSON.stringify(requestBody)

    // Record prompt state for cache-break detection.
    this.cacheMonitor.recordPromptState({
      systemPrompt,
      toolCount: anthropicTools.length,
      toolNames: anthropicTools.map(t => ('name' in t && typeof t.name === 'string' ? t.name : 'unknown')),
      toolSchemas: anthropicTools,
      model: config.defaultModel,
      provider: 'anthropic',
      strategy: turnStrategy?.intent,
      cacheControl: {
        system: true,
        tools: cachedTools.length > 0,
        messages: requestMessages.length > 0,
      },
      extraBodyParams: {
        max_tokens: anthropicMaxTokens,
        temperature,
        beta: headers['anthropic-beta'] ?? null,
        tool_choice: cachedTools.length > 0 ? 'auto' : null,
      },
    })

    this.emit({ type: 'stream:start' })

    // Accumulators for streaming assembly
    let textContent = ''
    let reasoningContent = ''
    const rawReasoningBlocks: AnthropicThinkingBlock[] = []
    const contentBlockTypes = new Map<number, string>()
    const contentBlockReasoningIndex = new Map<number, number>()
    const toolCallMap = new Map<string, { id: string; name: string; inputJson: string }>()
    let inputTokens = 0
    let outputTokens = 0
    // Cache economics — Anthropic reports these in message_start.usage and
    // (sometimes) message_delta.usage. They directly drive the Token Usage
    // panel so users can see real cache savings, not just billed totals.
    let cacheReadTokens = 0
    let cacheCreationTokens = 0
    let sawMessageStop = false
    // Mint the streamId BEFORE the request goes out so abort() (which
    // can fire from another tick the moment the user clicks "stop")
    // sees a non-null id that matches the one the main process will use.
    // Previously we generated this in two unrelated places (here and in
    // preload's streamMessage), so streamAbort sent a phantom id and the
    // SSE kept reading bytes + burning API quota until the upstream's
    // 5-min timeout. Pre-allocating threads the same id through both.
    const streamId = Date.now() + Math.floor(Math.random() * 1_000_000)
    this.currentStreamId = streamId
    let receivedStreamData = false

    const handleStreamLine = (line: string) => {
      receivedStreamData = true
      if (!line.startsWith('data:')) return
      const jsonStr = line.slice(5).trim()
      if (jsonStr === '[DONE]') return

      try {
        const event = JSON.parse(jsonStr)
        const eventType = event.type

        if (eventType === 'content_block_delta') {
          const delta = event.delta
          const reasoningText = this.extractStructuredReasoningDelta(delta, { allowTypedText: true })
          if (reasoningText) {
            reasoningContent += reasoningText
            const blockIndex = typeof event.index === 'number' ? event.index : -1
            if (blockIndex >= 0 && contentBlockTypes.get(blockIndex) === 'thinking') {
              const rawIndex = contentBlockReasoningIndex.get(blockIndex)
              if (rawIndex !== undefined) {
                rawReasoningBlocks[rawIndex].thinking = `${rawReasoningBlocks[rawIndex].thinking || ''}${reasoningText}`
              }
            }
            this.emit({ type: 'stream:thinking_delta', text: reasoningText })
          } else if (delta?.type === 'signature_delta' && typeof delta.signature === 'string') {
            const blockIndex = typeof event.index === 'number' ? event.index : -1
            const rawIndex = blockIndex >= 0 ? contentBlockReasoningIndex.get(blockIndex) : undefined
            if (rawIndex !== undefined && rawReasoningBlocks[rawIndex]?.type === 'thinking') {
              rawReasoningBlocks[rawIndex].signature = delta.signature
            }
          } else if (delta?.type === 'text_delta' && delta.text) {
            textContent += delta.text
            this.emit({ type: 'stream:delta', text: delta.text })
          } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
            const index = event.index
            const block = toolCallMap.get(`idx-${index}`)
            if (block) {
              block.inputJson += delta.partial_json
              this.emit({
                type: 'stream:tool_call_delta',
                toolCallId: block.id,
                toolName: block.name,
                partialJson: block.inputJson,
              })
            }
          }
        } else if (eventType === 'content_block_start') {
          const contentBlock = event.content_block
          if (typeof event.index === 'number' && contentBlock?.type) {
            contentBlockTypes.set(event.index, contentBlock.type)
          }
          if (contentBlock?.type === 'thinking') {
            const rawBlock: AnthropicThinkingBlock = {
              type: 'thinking',
              thinking: typeof contentBlock.thinking === 'string' ? contentBlock.thinking : '',
              signature: typeof contentBlock.signature === 'string' ? contentBlock.signature : undefined,
            }
            rawReasoningBlocks.push(rawBlock)
            if (typeof event.index === 'number') {
              contentBlockReasoningIndex.set(event.index, rawReasoningBlocks.length - 1)
            }
          } else if (contentBlock?.type === 'redacted_thinking' && typeof contentBlock.data === 'string') {
            rawReasoningBlocks.push({ type: 'redacted_thinking', data: contentBlock.data })
          }
          if (contentBlock?.type === 'tool_use') {
            toolCallMap.set(`idx-${event.index}`, {
              id: contentBlock.id || `toolu_${event.index}`,
              name: contentBlock.name,
              inputJson: '',
            })
          }
        } else if (eventType === 'message_stop') {
          sawMessageStop = true
        } else if (eventType === 'message_delta') {
          if (event.delta?.signature) {
            for (let index = rawReasoningBlocks.length - 1; index >= 0; index -= 1) {
              const block = rawReasoningBlocks[index]
              if (block.type === 'thinking') {
                block.signature = event.delta.signature
                break
              }
            }
          }
          if (event.usage) {
            outputTokens = event.usage.output_tokens || 0
            // Some Anthropic variants surface cache numbers on message_delta;
            // accumulate (not overwrite) so we never lose values from message_start.
            if (typeof event.usage.cache_read_input_tokens === 'number') {
              cacheReadTokens = event.usage.cache_read_input_tokens
            }
            if (typeof event.usage.cache_creation_input_tokens === 'number') {
              cacheCreationTokens = event.usage.cache_creation_input_tokens
            }
            const liveInput = inputTokens + cacheReadTokens + cacheCreationTokens
            this.emit({ type: 'stream:usage', usage: { input: liveInput, output: outputTokens, total: liveInput + outputTokens, source: 'provider' } })
          }
        } else if (eventType === 'message_start') {
          if (event.message?.usage) {
            inputTokens = event.message.usage.input_tokens || 0
            cacheReadTokens = event.message.usage.cache_read_input_tokens || 0
            cacheCreationTokens = event.message.usage.cache_creation_input_tokens || 0
            const liveInput = inputTokens + cacheReadTokens + cacheCreationTokens
            this.emit({ type: 'stream:usage', usage: { input: liveInput, output: outputTokens, total: liveInput + outputTokens, source: 'provider' } })
          }
        }
      } catch {
        // Malformed JSON chunk, skip
      }
    }
    let result = await this.toolExecutor.streamMessage(url, headers, serializedBody, handleStreamLine, {
      streamId,
      signal: this.abortController?.signal,
    })
    for (let retry = 0; !result.success && retry < 4; retry += 1) {
      if (this.abortController?.signal.aborted || receivedStreamData) break
      if (result.status !== 400 && result.status !== 422) break
      const unsupportedParam = extractUnsupportedRequestParam(result.error)
      if (!unsupportedParam || !removeAnthropicCompatibleRequestParam(requestBody, headers, unsupportedParam)) break
      this.emit({
        type: 'notification',
        level: 'warning',
        message: `Messages endpoint rejected "${unsupportedParam}"; retrying without that optional feature.`,
      })
      serializedBody = JSON.stringify(requestBody)
      result = await this.toolExecutor.streamMessage(url, headers, serializedBody, handleStreamLine, {
        streamId,
        signal: this.abortController?.signal,
      })
    }
    this.currentStreamId = null

    if (!result.success) {
      if (this.abortController?.signal.aborted) {
        const interruptedTurn = this.finishInterruptedStream(textContent, model, startTime)
        if (interruptedTurn) return interruptedTurn
        const err = new Error('aborted') as Error & { aborted?: boolean }
        err.aborted = true
        throw err
      }
      throw new ModelProtocolRequestError(result.error || 'Anthropic request failed', {
        protocol: 'anthropic_messages',
        url,
        status: result.status,
        kind: result.status ? 'http' : 'network',
        receivedStreamData,
      })
    }
    if (!sawMessageStop) {
      const parsedTextTools = parseTextToolCalls(textContent)
      const hasVisibleText = Boolean(stripTextToolCallMarkup(textContent, { stripIncomplete: true }))
      const completeToolPayloads = hasCompleteToolPayloads(
        [...toolCallMap.values()].map(block => ({ name: block.name, argumentsJson: block.inputJson })),
      )
      if (!hasVisibleText && !completeToolPayloads && parsedTextTools.toolCalls.length === 0) {
        throw new ModelProtocolRequestError('Anthropic stream ended before message_stop', {
          protocol: 'anthropic_messages',
          url,
          kind: 'response_shape',
          receivedStreamData,
        })
      }
      if (!completeToolPayloads) toolCallMap.clear()
      if (parsedTextTools.containsToolMarkup && parsedTextTools.toolCalls.length === 0) {
        textContent = stripTextToolCallMarkup(textContent, { stripIncomplete: true })
      }
    }

    // Assemble final tool calls from accumulated data
    const toolCalls: ToolCall[] = []
    for (const [, block] of toolCallMap) {
      let parsedArgs: Record<string, unknown> = {}
      try {
        parsedArgs = JSON.parse(block.inputJson || '{}')
      } catch {
        parsedArgs = {}
      }
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: parsedArgs,
      })
    }

    const contextInputTokens = inputTokens + cacheReadTokens + cacheCreationTokens
    const tokens = { input: contextInputTokens, output: outputTokens, total: contextInputTokens + outputTokens, source: 'provider' as const }
    this.session.totalTokens.input += tokens.input
    this.session.totalTokens.output += tokens.output
    this.contextManager.updateTokenCounting(tokens.input, tokens.output)

    if (inputTokens > 0 || outputTokens > 0) {
      this.stateProvider.recordTokenUsage({
        provider: config.provider,
        model: config.defaultModel,
        inputTokens: Math.max(0, inputTokens + cacheCreationTokens),
        outputTokens,
        cached: cacheReadTokens,
        totalInputTokens: inputTokens + cacheReadTokens + cacheCreationTokens,
      })
    }

    const cacheDiagnosis = this.cacheMonitor.checkCacheBreak(cacheReadTokens, cacheCreationTokens)
    if (cacheDiagnosis.broken) {
      this.emit({ type: 'cache:diagnostic', result: cacheDiagnosis })
    }

    this.emit({ type: 'stream:end' })

    return this.createAssistantTurn(textContent, toolCalls, {
      model: model?.name,
      tokens,
      duration: Date.now() - startTime,
      mode: this.config.mode,
      reasoningEnabled: reasoningRequest?.enabled,
      reasoningEffort: reasoningRequest?.reasoningEffort ?? reasoningRequest?.outputConfig?.effort,
      thinking: { content: reasoningContent, source: 'provider' },
      rawReasoningPayload: rawReasoningBlocks.length > 0
        ? { provider: 'anthropic', blocks: rawReasoningBlocks }
        : undefined,
    })
  }

  private tryParsePartialJson(json: string): boolean {
    try {
      JSON.parse(json)
      return true
    } catch {
      return false
    }
  }

  private buildOpenAITools(config: APIConfig): object[] {
    const openaiTools = toolsToOpenAIFormat(this.config.mode, {
      disabledTools: [],
      strict: config.provider === 'openai',
    })

    if (this.mcpClient) {
      const mcpTools = getMcpAgentTools(this.mcpClient)
      for (const tool of mcpTools.sort((a, b) => a.name.localeCompare(b.name))) {
        if (this.config.mode === 'plan' && !tool.isReadOnly) continue
        openaiTools.push({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema || {
              type: 'object',
              properties: Object.fromEntries(tool.parameters.map(p => [p.name, { type: p.type, description: p.description }])),
              required: tool.parameters.filter(p => p.required).map(p => p.name),
            },
          },
        })
      }
    }
    return openaiTools
  }

  private async callOpenAICompatibleAPI(
    config: APIConfig,
    model: APIModel | null,
    messages: Array<Record<string, unknown>>,
    startTime: number,
    turnStrategy?: TurnStrategy | null,
  ): Promise<AgentTurn> {
    const url = buildModelProtocolUrl(config.baseUrl, 'openai_chat')
    const headers: Record<string, string> = createTurboFluxRequestHeaders({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
      ...config.customHeaders,
    })

    if (config.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://turboflux.dev'
      headers['X-Title'] = 'Turboflux'
    }

    // Tool visibility is mode/policy based. Turn strategy may influence
    // context hints, but never hides tools from the model. This keeps the
    // static system/tool prefix stable and avoids intent misclassification
    // turning an agentic request into a no-tool chat response.
    const openaiTools = this.buildOpenAITools(config)

    const requestMessages = config.provider === 'openrouter'
      ? this.withOpenRouterCacheControl(messages)
      : messages

    const maxTokens = this.config.maxTokens || config.maxTokens || 0
    const body: Record<string, unknown> = {
      model: config.defaultModel,
      messages: requestMessages,
      stream: true,
    }
    if (!shouldOmitSamplingTemperature(config)) {
      body.temperature = this.config.temperature ?? config.temperature ?? 0.7
    }
    if (maxTokens > 0) {
      body.max_tokens = maxTokens
    }
    const reasoningRequest = resolveNativeReasoningRequest(config.defaultModel, config.reasoning, config.provider, config.modelCapabilities)
    if (reasoningRequest?.thinking) body.thinking = reasoningRequest.thinking
    if (reasoningRequest?.reasoningEffort) body.reasoning_effort = reasoningRequest.reasoningEffort
    if (reasoningRequest?.outputConfig) body.output_config = reasoningRequest.outputConfig
    if (reasoningRequest?.omitTemperature) delete body.temperature
    // OpenAI streaming spec: usage is NOT sent unless we opt in via
    // stream_options.include_usage. Without this, mimo / Kimi / DeepSeek
    // / OpenRouter / Qwen all return zero token counts, the per-call
    // record gets dropped by tokenStatsStore's zero-value guard, and
    // the Settings → Usage panel stays empty no matter how much the
    // user spends. The OpenAI Cookbook explicitly recommends always
    // setting this when you stream and care about telemetry.
    // https://platform.openai.com/docs/api-reference/chat/create#chat-create-stream_options
    body.stream_options = { include_usage: true }
    if (openaiTools.length > 0) {
      body.tools = openaiTools
      body.tool_choice = 'auto'
      // Most OpenAI-compatible providers default this to true, but some
      // (older Azure deployments, certain proxies) require explicit opt-in
      // to emit multiple tool_calls in a single assistant turn. Without
      // parallel_tool_calls=true the model is silently forced into one
      // tool call per turn, which produces the "thinks→one search→thinks"
      // loop users see in chat.
      body.parallel_tool_calls = true
    }
    if (config.provider === 'openai') {
      body.prompt_cache_key = this.buildPromptCacheKey(config.defaultModel, openaiTools)
      if (/gpt-5\.5/i.test(config.defaultModel)) {
        body.prompt_cache_retention = '24h'
      }
    }
    this.emitPromptModuleSnapshot((messages.find(m => m.role === 'system')?.content as string) || '', openaiTools, requestMessages)
    // Record prompt state for cache-break detection.
    this.cacheMonitor.recordPromptState({
      systemPrompt: (messages.find(m => m.role === 'system')?.content as string) || '',
      toolCount: openaiTools.length,
      toolNames: openaiTools.map(t => (t as { function?: { name?: string }; name?: string }).function?.name || (t as { name?: string }).name || 'unknown'),
      toolSchemas: openaiTools,
      model: config.defaultModel,
      provider: config.provider,
      strategy: turnStrategy?.intent,
      cacheControl: config.provider === 'openrouter' ? 'system+last-message' : 'auto-prefix',
      extraBodyParams: {
        max_tokens: body.max_tokens ?? null,
        temperature: body.temperature ?? null,
        stream_options: body.stream_options,
        tool_choice: body.tool_choice ?? null,
        parallel_tool_calls: body.parallel_tool_calls ?? null,
        prompt_cache_key: body.prompt_cache_key ?? null,
        prompt_cache_retention: body.prompt_cache_retention ?? null,
      },
    })

    this.emit({ type: 'stream:start' })

    let textContent = ''
    let reasoningContent = ''
    const toolCallMap = new Map<number, { id: string; name: string; argumentsJson: string }>()
    let inputTokens = 0
    let outputTokens = 0
    // Cross-provider cache hit accounting:
    //   - OpenAI:  usage.prompt_tokens_details.cached_tokens (auto-prefix cache)
    //   - DeepSeek: usage.prompt_cache_hit_tokens (disk-backed prefix cache)
    //   - Kimi/Qwen/etc: not always reported; treat as 0 silently.
    // We map all of these into a single cacheReadTokens metric so the
    // Token Usage panel shows a normalized cache-economy number across
    // providers. inputTokens here is the FULL prompt_tokens; the panel
    // computes "new tokens" as inputTokens - cacheReadTokens for clarity.
    let cacheReadTokens = 0
    let cacheMissTokens: number | null = null
    let sawTerminalEvent = false
    // Same pre-allocation pattern as the Anthropic path — the previous
    // `Date.now()` was a no-op for abort because preload re-rolled its
    // own id when sending the request. Now we own the id and forward it
    // through streamMessage so streamAbort hits the right controller.
    const streamId = Date.now() + Math.floor(Math.random() * 1_000_000)
    this.currentStreamId = streamId
    let receivedStreamData = false

    const handleStreamLine = (line: string) => {
      receivedStreamData = true
      if (!line.startsWith('data:')) return
      const jsonStr = line.slice(5).trim()
      if (jsonStr === '[DONE]') {
        sawTerminalEvent = true
        return
      }

      try {
        const chunk = JSON.parse(jsonStr)

        // Usage handling MUST come before the `!choice` early return.
        // OpenAI's streaming spec (and every compatible provider that honours
        // it) sends the usage block in a *final* chunk where `choices` is an
        // empty array — i.e. there is no choice/delta at all, only usage.
        // If we early-return on missing choice we'd silently drop the only
        // chunk that carries token counts, which is exactly the bug that
        // made the Token Usage panel stay empty for mimo/Kimi/DeepSeek/OR.
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens || inputTokens
          outputTokens = chunk.usage.completion_tokens || outputTokens
          // OpenAI auto-cache hit count.
          const openaiCached = chunk.usage.prompt_tokens_details?.cached_tokens
          if (typeof openaiCached === 'number') cacheReadTokens = openaiCached
          // DeepSeek explicit prefix cache fields.
          if (typeof chunk.usage.prompt_cache_hit_tokens === 'number') {
            cacheReadTokens = chunk.usage.prompt_cache_hit_tokens
          }
          if (typeof chunk.usage.prompt_cache_miss_tokens === 'number') {
            cacheMissTokens = chunk.usage.prompt_cache_miss_tokens
          }
          this.emit({ type: 'stream:usage', usage: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens, source: 'provider' } })
        }

        const choice = chunk.choices?.[0]
        if (!choice) return
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          sawTerminalEvent = true
        }

        const delta = choice.delta
        if (!delta) return

        const reasoningText = this.extractStructuredReasoningDelta(delta)
        if (reasoningText) {
          reasoningContent += reasoningText
          this.emit({ type: 'stream:thinking_delta', text: reasoningText })
        }

        // Text content delta
        if (delta.content) {
          textContent += delta.content
          this.emit({ type: 'stream:delta', text: delta.content })
        }

        // Tool call deltas
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            if (!toolCallMap.has(idx)) {
              toolCallMap.set(idx, {
                id: tc.id || `tc-${idx}`,
                name: tc.function?.name || '',
                argumentsJson: '',
              })
            }
            const entry = toolCallMap.get(idx)!
            if (tc.id) entry.id = tc.id
            if (tc.function?.name) entry.name = tc.function.name
            if (tc.function?.arguments) {
              entry.argumentsJson += tc.function.arguments
              this.emit({
                type: 'stream:tool_call_delta',
                toolCallId: entry.id,
                toolName: entry.name,
                partialJson: entry.argumentsJson,
              })
            }
          }
        }
      } catch {
        // Malformed JSON chunk, skip
      }
    }

    let serializedBody = JSON.stringify(body)
    let result = await this.toolExecutor.streamMessage(url, headers, serializedBody, handleStreamLine, {
      streamId,
      signal: this.abortController?.signal,
    })
    for (let retry = 0; !result.success && retry < 4; retry += 1) {
      if (this.abortController?.signal.aborted) break
      if (result.status !== 400) break
      const unsupportedParam = extractUnsupportedRequestParam(result.error)
      if (!unsupportedParam || !removeOpenAICompatibleRequestParam(body, unsupportedParam)) break
      this.emit({
        type: 'notification',
        level: 'warning',
        message: `Provider rejected "${unsupportedParam}"; retrying without that request parameter.`,
      })
      serializedBody = JSON.stringify(body)
      result = await this.toolExecutor.streamMessage(url, headers, serializedBody, handleStreamLine, {
        streamId,
        signal: this.abortController?.signal,
      })
    }
    this.currentStreamId = null

    if (!result.success) {
      if (this.abortController?.signal.aborted) {
        const interruptedTurn = this.finishInterruptedStream(textContent, model, startTime)
        if (interruptedTurn) return interruptedTurn
        const err = new Error('aborted') as Error & { aborted?: boolean }
        err.aborted = true
        throw err
      }
      throw new ModelProtocolRequestError(result.error || 'Model request failed', {
        protocol: 'openai_chat',
        url,
        status: result.status,
        kind: result.status ? 'http' : 'network',
        receivedStreamData,
      })
    }
    if (!sawTerminalEvent) {
      const parsedTextTools = parseTextToolCalls(textContent)
      const hasVisibleText = Boolean(stripTextToolCallMarkup(textContent, { stripIncomplete: true }))
      const completeToolPayloads = hasCompleteToolPayloads(
        [...toolCallMap.values()].map(entry => ({ name: entry.name, argumentsJson: entry.argumentsJson })),
      )
      if (!hasVisibleText && !completeToolPayloads && parsedTextTools.toolCalls.length === 0) {
        throw new ModelProtocolRequestError('Model stream ended before a terminal event', {
          protocol: 'openai_chat',
          url,
          kind: 'response_shape',
          receivedStreamData,
        })
      }
      if (!completeToolPayloads) toolCallMap.clear()
      if (parsedTextTools.containsToolMarkup && parsedTextTools.toolCalls.length === 0) {
        textContent = stripTextToolCallMarkup(textContent, { stripIncomplete: true })
      }
    }

    // Assemble final tool calls
    const toolCalls: ToolCall[] = []
    for (const [, entry] of toolCallMap) {
      let parsedArgs: Record<string, unknown> = {}
      try {
        parsedArgs = JSON.parse(entry.argumentsJson || '{}')
      } catch {
        parsedArgs = {}
      }
      toolCalls.push({
        id: entry.id,
        name: entry.name,
        arguments: parsedArgs,
      })
    }

    // Some OpenAI-compatible routes stream tool calls as text markup instead
    // of standard delta.tool_calls. Convert those into real tool calls and
    // keep the markup out of the assistant transcript.
    const textToolCalls = parseTextToolCalls(textContent)
    if (textToolCalls.containsToolMarkup) {
      textContent = textToolCalls.cleanedText
      if (toolCalls.length === 0 && textToolCalls.toolCalls.length > 0) {
        toolCalls.push(...textToolCalls.toolCalls)
      }
    }

    const tokens = { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens, source: 'provider' as const }
    this.session.totalTokens.input += tokens.input
    this.session.totalTokens.output += tokens.output
    this.contextManager.updateTokenCounting(tokens.input, tokens.output)

    if (inputTokens > 0 || outputTokens > 0) {
      this.stateProvider.recordTokenUsage({
        provider: config.provider,
        model: config.defaultModel,
        inputTokens: cacheMissTokens ?? Math.max(0, inputTokens - cacheReadTokens),
        outputTokens,
        cached: cacheReadTokens,
        totalInputTokens: inputTokens,
      })
    }

    const cacheDiagnosis = this.cacheMonitor.checkCacheBreak(cacheReadTokens, 0)
    if (cacheDiagnosis.broken) {
      this.emit({ type: 'cache:diagnostic', result: cacheDiagnosis })
    }

    this.emit({ type: 'stream:end' })

    return this.createAssistantTurn(textContent, toolCalls, {
      model: model?.name,
      tokens,
      duration: Date.now() - startTime,
      mode: this.config.mode,
      reasoningEnabled: reasoningRequest?.enabled,
      reasoningEffort: reasoningRequest?.reasoningEffort ?? reasoningRequest?.outputConfig?.effort,
      thinking: { content: reasoningContent, source: 'provider' },
      // Store reasoning_content so it can be passed back in subsequent turns.
      // OpenAI-compatible providers (e.g. mimo, DeepSeek-R1) require the
      // reasoning_content from the previous assistant message to be echoed
      // back verbatim, otherwise they return a 400 "Param Incorrect" error.
      rawReasoningPayload: reasoningContent
        ? { provider: 'openai-compatible', blocks: [], reasoningContent }
        : undefined,
    })
  }

  private async callOpenAIResponsesAPI(
    config: APIConfig,
    model: APIModel | null,
    messages: Array<Record<string, unknown>>,
    startTime: number,
    turnStrategy?: TurnStrategy | null,
  ): Promise<AgentTurn> {
    const protocol: ModelProtocol = 'openai_responses'
    const url = buildModelProtocolUrl(config.baseUrl, protocol)
    const headers: Record<string, string> = createTurboFluxRequestHeaders({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
      ...config.customHeaders,
    })
    if (config.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://turboflux.dev'
      headers['X-Title'] = 'Turboflux'
    }

    const chatTools = this.buildOpenAITools(config)
    const responseTools = toResponsesTools(chatTools)
    const instructions = messages
      .filter(message => message.role === 'system' || message.role === 'developer')
      .map(message => typeof message.content === 'string' ? message.content : '')
      .filter(Boolean)
      .join('\n\n')
    const input = toResponsesInput(messages)
    const maxTokens = this.config.maxTokens || config.maxTokens || 0
    const body: Record<string, unknown> = {
      model: config.defaultModel,
      instructions,
      input,
      stream: true,
      store: false,
    }
    if (!shouldOmitSamplingTemperature(config)) {
      body.temperature = this.config.temperature ?? config.temperature ?? 0.7
    }
    if (maxTokens > 0) body.max_output_tokens = maxTokens
    const reasoningRequest = resolveNativeReasoningRequest(config.defaultModel, config.reasoning, config.provider, config.modelCapabilities)
    const reasoningEffort = reasoningRequest?.reasoningEffort ?? reasoningRequest?.outputConfig?.effort
    if (reasoningEffort) body.reasoning = { effort: reasoningEffort }
    if (reasoningRequest?.omitTemperature) delete body.temperature
    if (responseTools.length > 0) {
      body.tools = responseTools
      body.tool_choice = 'auto'
      body.parallel_tool_calls = true
    }
    if (config.provider === 'openai') {
      body.prompt_cache_key = this.buildPromptCacheKey(config.defaultModel, responseTools)
      if (/gpt-5\.5/i.test(config.defaultModel)) body.prompt_cache_retention = '24h'
    }

    this.emitPromptModuleSnapshot(instructions, responseTools, input)
    this.cacheMonitor.recordPromptState({
      systemPrompt: instructions,
      toolCount: responseTools.length,
      toolNames: responseTools.map(tool => typeof tool.name === 'string' ? tool.name : 'unknown'),
      toolSchemas: responseTools,
      model: config.defaultModel,
      provider: config.provider,
      strategy: turnStrategy?.intent,
      cacheControl: 'responses-auto-prefix',
      extraBodyParams: {
        protocol,
        max_output_tokens: body.max_output_tokens ?? null,
        temperature: body.temperature ?? null,
        reasoning: body.reasoning ?? null,
        tool_choice: body.tool_choice ?? null,
        parallel_tool_calls: body.parallel_tool_calls ?? null,
        prompt_cache_key: body.prompt_cache_key ?? null,
        prompt_cache_retention: body.prompt_cache_retention ?? null,
      },
    })

    this.emit({ type: 'stream:start' })
    let textContent = ''
    let reasoningContent = ''
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let sawTerminalEvent = false
    let receivedStreamData = false
    let streamFailure = ''
    const toolCallMap = new Map<string, { id: string; name: string; argumentsJson: string }>()
    const toolCallAliases = new Map<string, string>()
    const streamId = Date.now() + Math.floor(Math.random() * 1_000_000)
    this.currentStreamId = streamId

    const ensureToolCall = (item: Record<string, any>, outputIndex?: number) => {
      const id = typeof item.call_id === 'string' && item.call_id
        ? item.call_id
        : typeof item.id === 'string' && item.id
          ? item.id
          : `call_${outputIndex ?? toolCallMap.size}`
      let entry = toolCallMap.get(id)
      if (!entry) {
        entry = {
          id,
          name: typeof item.name === 'string' ? item.name : '',
          argumentsJson: typeof item.arguments === 'string' ? item.arguments : '',
        }
        toolCallMap.set(id, entry)
      } else {
        if (typeof item.name === 'string' && item.name) entry.name = item.name
        if (typeof item.arguments === 'string' && item.arguments) entry.argumentsJson = item.arguments
      }
      if (typeof item.id === 'string') toolCallAliases.set(item.id, id)
      if (typeof item.call_id === 'string') toolCallAliases.set(item.call_id, id)
      if (typeof outputIndex === 'number') toolCallAliases.set(`idx-${outputIndex}`, id)
      return entry
    }

    const updateUsage = (usage: Record<string, any> | undefined) => {
      if (!usage) return
      inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : inputTokens
      outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : outputTokens
      const cached = usage.input_tokens_details?.cached_tokens
      if (typeof cached === 'number') cacheReadTokens = cached
      this.emit({
        type: 'stream:usage',
        usage: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens, source: 'provider' },
      })
    }

    const harvestCompletedOutput = (response: Record<string, any> | undefined) => {
      updateUsage(response?.usage)
      if (!Array.isArray(response?.output)) return
      for (const item of response.output) {
        if (!item || typeof item !== 'object') continue
        if (item.type === 'function_call') {
          ensureToolCall(item)
          continue
        }
        if (item.type !== 'message' || textContent) continue
        const completedText = Array.isArray(item.content)
          ? item.content.filter((part: any) => part?.type === 'output_text' && typeof part.text === 'string').map((part: any) => part.text).join('')
          : ''
        if (completedText) {
          textContent += completedText
          this.emit({ type: 'stream:delta', text: completedText })
        }
      }
    }

    const handleStreamLine = (line: string) => {
      receivedStreamData = true
      if (!line.startsWith('data:')) return
      const jsonText = line.slice(5).trim()
      if (!jsonText || jsonText === '[DONE]') return
      try {
        const event = JSON.parse(jsonText) as Record<string, any>
        const eventType = event.type
        if (eventType === 'response.output_text.delta' || eventType === 'response.refusal.delta') {
          if (typeof event.delta === 'string' && event.delta) {
            textContent += event.delta
            this.emit({ type: 'stream:delta', text: event.delta })
          }
        } else if (eventType === 'response.reasoning_summary_text.delta' || eventType === 'response.reasoning_text.delta') {
          if (typeof event.delta === 'string' && event.delta) {
            reasoningContent += event.delta
            this.emit({ type: 'stream:thinking_delta', text: event.delta })
          }
        } else if (eventType === 'response.output_item.added' || eventType === 'response.output_item.done') {
          if (event.item?.type === 'function_call') ensureToolCall(event.item, event.output_index)
        } else if (eventType === 'response.function_call_arguments.delta' || eventType === 'response.function_call_arguments.done') {
          const alias = typeof event.item_id === 'string'
            ? event.item_id
            : typeof event.call_id === 'string'
              ? event.call_id
              : `idx-${event.output_index ?? 0}`
          const canonicalId = toolCallAliases.get(alias) || alias
          let entry = toolCallMap.get(canonicalId)
          if (!entry) {
            entry = ensureToolCall({ call_id: canonicalId, name: event.name || '' }, event.output_index)
          }
          if (eventType.endsWith('.done') && typeof event.arguments === 'string') {
            entry.argumentsJson = event.arguments
          } else if (typeof event.delta === 'string') {
            entry.argumentsJson += event.delta
          }
          this.emit({
            type: 'stream:tool_call_delta',
            toolCallId: entry.id,
            toolName: entry.name,
            partialJson: entry.argumentsJson,
          })
        } else if (eventType === 'response.completed') {
          sawTerminalEvent = true
          harvestCompletedOutput(event.response)
        } else if (eventType === 'response.incomplete' || eventType === 'response.failed') {
          sawTerminalEvent = true
          harvestCompletedOutput(event.response)
          streamFailure = event.response?.error?.message
            || event.response?.incomplete_details?.reason
            || `${eventType}: provider did not complete the response`
        } else if (eventType === 'error') {
          sawTerminalEvent = true
          streamFailure = event.error?.message || event.message || 'Responses stream returned an error event'
        }
      } catch {
        // Ignore malformed SSE data while preserving the no-cross-protocol-after-bytes invariant.
      }
    }

    let serializedBody = JSON.stringify(body)
    let result = await this.toolExecutor.streamMessage(url, headers, serializedBody, handleStreamLine, {
      streamId,
      signal: this.abortController?.signal,
    })
    for (let retry = 0; !result.success && retry < 4; retry += 1) {
      if (this.abortController?.signal.aborted || result.status !== 400 || receivedStreamData) break
      const unsupportedParam = extractUnsupportedRequestParam(result.error)
      if (!unsupportedParam || !removeOpenAICompatibleRequestParam(body, unsupportedParam)) break
      this.emit({
        type: 'notification',
        level: 'warning',
        message: `Responses endpoint rejected "${unsupportedParam}"; retrying without that request parameter.`,
      })
      serializedBody = JSON.stringify(body)
      result = await this.toolExecutor.streamMessage(url, headers, serializedBody, handleStreamLine, {
        streamId,
        signal: this.abortController?.signal,
      })
    }
    this.currentStreamId = null

    if (!result.success) {
      if (this.abortController?.signal.aborted) {
        const interruptedTurn = this.finishInterruptedStream(textContent, model, startTime)
        if (interruptedTurn) return interruptedTurn
        const aborted = new Error('aborted') as Error & { aborted?: boolean }
        aborted.aborted = true
        throw aborted
      }
      throw new ModelProtocolRequestError(result.error || 'Responses request failed', {
        protocol,
        url,
        status: result.status,
        kind: result.status ? 'http' : 'network',
        receivedStreamData,
      })
    }
    if (streamFailure) {
      throw new ModelProtocolRequestError(streamFailure, {
        protocol,
        url,
        kind: 'stream',
        receivedStreamData,
      })
    }
    if (!sawTerminalEvent) {
      const parsedTextTools = parseTextToolCalls(textContent)
      const hasVisibleText = Boolean(stripTextToolCallMarkup(textContent, { stripIncomplete: true }))
      const completeToolPayloads = hasCompleteToolPayloads([...toolCallMap.values()].map(entry => ({
        name: entry.name,
        argumentsJson: entry.argumentsJson,
      })))
      if (!hasVisibleText && !completeToolPayloads && parsedTextTools.toolCalls.length === 0) {
        throw new ModelProtocolRequestError('Responses stream ended before a terminal event', {
          protocol,
          url,
          kind: 'response_shape',
          receivedStreamData,
        })
      }
      if (!completeToolPayloads) toolCallMap.clear()
      if (parsedTextTools.containsToolMarkup && parsedTextTools.toolCalls.length === 0) {
        textContent = stripTextToolCallMarkup(textContent, { stripIncomplete: true })
      }
    }

    const toolCalls: ToolCall[] = []
    for (const entry of toolCallMap.values()) {
      let parsedArguments: Record<string, unknown> = {}
      try {
        parsedArguments = JSON.parse(entry.argumentsJson || '{}')
      } catch {
        parsedArguments = {}
      }
      toolCalls.push({ id: entry.id, name: entry.name, arguments: parsedArguments })
    }
    const textToolCalls = parseTextToolCalls(textContent)
    if (textToolCalls.containsToolMarkup) {
      textContent = textToolCalls.cleanedText
      if (toolCalls.length === 0 && textToolCalls.toolCalls.length > 0) toolCalls.push(...textToolCalls.toolCalls)
    }

    const tokens = { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens, source: 'provider' as const }
    this.session.totalTokens.input += tokens.input
    this.session.totalTokens.output += tokens.output
    this.contextManager.updateTokenCounting(tokens.input, tokens.output)
    if (inputTokens > 0 || outputTokens > 0) {
      this.stateProvider.recordTokenUsage({
        provider: config.provider,
        model: config.defaultModel,
        inputTokens: Math.max(0, inputTokens - cacheReadTokens),
        outputTokens,
        cached: cacheReadTokens,
        totalInputTokens: inputTokens,
      })
    }
    const cacheDiagnosis = this.cacheMonitor.checkCacheBreak(cacheReadTokens, 0)
    if (cacheDiagnosis.broken) this.emit({ type: 'cache:diagnostic', result: cacheDiagnosis })
    this.emit({ type: 'stream:end' })

    return this.createAssistantTurn(textContent, toolCalls, {
      model: model?.name,
      tokens,
      duration: Date.now() - startTime,
      mode: this.config.mode,
      reasoningEnabled: reasoningRequest?.enabled,
      reasoningEffort,
      thinking: { content: reasoningContent, source: 'provider' },
      rawReasoningPayload: reasoningContent
        ? { provider: 'openai-compatible', blocks: [], reasoningContent }
        : undefined,
    })
  }

  private wrapRuntimeContextSection(tag: string, content: string): string {
    const trimmed = content.trim()
    return trimmed ? `<${tag}>\n${trimmed}\n</${tag}>` : ''
  }

  private buildPromptCacheKey(model: string, tools: unknown[]): string {
    const workspace = this.config.workspacePath || ''
    const workspaceKey = workspace.toLowerCase().replace(/[^a-z0-9._/-]+/gi, '_').slice(-96)
    const toolHash = stableHash(tools)
    const mode = this.config.mode || 'vibe'
    return `tf:${model}:${mode}:${workspaceKey}:${toolHash}`.slice(0, 240)
  }

  private emitPromptModuleSnapshot(systemPrompt: string, tools: unknown[], messages: Array<Record<string, unknown>>): void {
    const contextChars = this.stateProvider.getContextSegments().reduce((sum, segment) => sum + segment.summary.length, 0)
    const moduleText = (value: unknown) => {
      try {
        return typeof value === 'string' ? value : JSON.stringify(value)
      } catch {
        return ''
      }
    }
    const modules: PromptModuleSnapshot[] = [
      {
        id: 'system',
        label: 'System',
        hash: stableHash(systemPrompt),
        chars: systemPrompt.length,
        stable: true,
      },
      {
        id: 'tools',
        label: 'Tools',
        hash: stableHash(tools),
        chars: moduleText(tools).length,
        stable: true,
      },
      {
        id: 'workspace',
        label: 'Workspace',
        hash: stableHash({
          workspace: this.config.workspacePath,
          skeleton: this.workspaceSkeleton,
          memory: this.workspaceMemoryText,
        }),
        chars: (this.workspaceSkeleton?.length || 0) + (this.workspaceMemoryText?.length || 0),
        stable: true,
      },
      {
        id: 'context',
        label: 'Context',
        hash: stableHash(this.stateProvider.getContextSegments().map(segment => ({
          start: segment.startMessageId,
          end: segment.endMessageId,
          summary: segment.summary,
        }))),
        chars: contextChars,
        stable: false,
      },
      {
        id: 'tail',
        label: 'Tail',
        hash: stableHash(messages.slice(-4)),
        chars: moduleText(messages.slice(-4)).length,
        stable: false,
      },
    ]
    this.emit({ type: 'cache:modules', modules })
  }

  /**
   * Inject dynamic append content at the conversation tail instead of the
   * system prompt. This preserves prefix-cache stability: the system prompt
   * (identity, rules, tools, environment) stays byte-identical across turns,
   * while tool retry hints, fast-context packs, and skill overrides travel
   * after the stable history prefix.
   *
   * Claude Code uses the same trick — append content is never part of the
   * cached system prefix.
   */
  private injectAppendIntoMessages(
    messages: Array<Record<string, unknown>>,
    appendContent: string,
    provider: 'openai' | 'anthropic',
  ): void {
    if (!appendContent) return

    const appendBlock = [
      '<runtime_context>',
      'Internal execution context for this turn. Do not acknowledge, quote, translate, or roleplay this block.',
      appendContent,
      '</runtime_context>',
    ].join('\n')
    appendRuntimeContextToLatestUserMessage(messages, appendBlock, provider)
  }

  private appendTextAtConversationTail(
    messages: Array<Record<string, unknown>>,
    text: string,
    provider: 'openai' | 'anthropic',
  ): void {
    appendRuntimeContextToLatestUserMessage(messages, text, provider)
  }

  /**
   * Inject files preserved from the last compaction into the last user message.
   * This prevents "刚才看的文件去哪了" — the model retains working context
   * after old turns are summarized away. Files are injected once (then cleared)
   * and deduplicated against recent turns that already contain the same read.
   */
  private injectPreservedFilesIntoMessages(
    messages: Array<Record<string, unknown>>,
    provider: 'openai' | 'anthropic',
    sourceFiles: Array<{ path: string; content: string }> = this.preservedFiles,
    consume = true,
  ): void {
    if (sourceFiles.length === 0) return

    // Dedup: skip files already present in recent session turns.
    const recentReadPaths = new Set<string>()
    for (const turn of this.session.turns) {
      if (turn.role === 'assistant' && turn.toolCalls) {
        for (const tc of turn.toolCalls) {
          if ((tc.name === 'read_file' || tc.name === 'read_file_full') && typeof tc.arguments.path === 'string') {
            recentReadPaths.add(tc.arguments.path as string)
          }
        }
      }
    }

    const filesToInject = sourceFiles.filter(f => !recentReadPaths.has(f.path))
    if (filesToInject.length === 0) {
      if (consume) this.preservedFiles = []
      return
    }

    const parts: string[] = [
      '<recent_files>',
      'These files were recently accessed before context compression and remain relevant:',
    ]
    for (const f of filesToInject) {
      parts.push(`<file path="${f.path}">\n${f.content}\n</file>`)
    }
    parts.push('</recent_files>')
    const block = parts.join('\n\n')
    this.appendTextAtConversationTail(messages, block, provider)
    if (consume) this.preservedFiles = []
  }

  private buildApiMessages(systemPrompt: string, provider: 'openai' | 'anthropic'): Array<Record<string, unknown>> {
    const activeConfig = this.stateProvider.getActiveConfig()
    const activeModel = this.stateProvider.getActiveModel()
    const maxOutputTokens = this.config.maxTokens || activeModel?.maxTokens || 4096
    const contextWindow = activeModel?.contextWindow || activeConfig?.contextWindow || this.config.contextWindow || 200_000
    const policyProfile = resolveContextPolicyProfile(this.config.contextPolicy)
    const candidateTurns = this.buildContextCandidateTurns(contextWindow, maxOutputTokens)

    // Fetch valid context segments from the current conversation
    let contextSegments: ContextSegment[] | undefined
    const convId = this.config.conversationId || this.stateProvider.getConversationId()
    if (convId) {
      contextSegments = this.stateProvider.getContextSegments()
    }

    return this.contextManager.buildMessages(
      candidateTurns,
      systemPrompt,
      contextWindow,
      provider,
      maxOutputTokens,
      contextSegments,
      policyProfile,
      activeModel?.id || activeConfig?.defaultModel,
    )
  }

  private buildContextCandidateTurns(contextWindow: number, maxOutputTokens: number): AgentTurn[] {
    const reservoir = this.stateProvider.getContextReservoir()
      .filter(entry => entry.turns.length > 0)
      .slice()
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    if (reservoir.length === 0) return this.session.turns

    const activeConfig = this.stateProvider.getActiveConfig()
    const activeModel = this.stateProvider.getActiveModel()
    const tokenOptions = {
      provider: activeConfig?.provider || activeModel?.provider || 'custom',
      model: activeModel?.id || activeConfig?.defaultModel,
    }
    const liveTokenCount = countTurnishTokens(this.session.turns, tokenOptions)
    const reservoirTokenCount = countTurnishTokens(reservoir.flatMap(entry => entry.turns), tokenOptions)
    const policyProfile = resolveContextPolicyProfile(this.config.contextPolicy)
    const usableTokens = Math.max(4_096, contextWindow - Math.max(maxOutputTokens, 1_024))
    const targetTokens = usableTokens * policyProfile.targetRatio

    if (
      contextWindow < 256_000
      || liveTokenCount.source === 'unavailable'
      || reservoirTokenCount.source === 'unavailable'
      || liveTokenCount.tokens + reservoirTokenCount.tokens > targetTokens
    ) {
      return this.session.turns
    }

    const systemTurns = this.session.turns.filter(turn => turn.role === 'system')
    const liveNonSystem = this.session.turns.filter(turn => turn.role !== 'system')
    const seen = new Set(systemTurns.map(turn => turn.id))
    const merged: AgentTurn[] = [...systemTurns]
    for (const entry of reservoir) {
      for (const turn of entry.turns) {
        if (seen.has(turn.id)) continue
        seen.add(turn.id)
        merged.push(turn)
      }
    }
    for (const turn of liveNonSystem) {
      if (seen.has(turn.id)) continue
      seen.add(turn.id)
      merged.push(turn)
    }
    return merged
  }

  private enforceFinalMessageBudget(
    messages: Array<Record<string, unknown>>,
    provider: 'openai' | 'anthropic',
    config: APIConfig,
    model: APIModel | null,
  ): void {
    const contextWindow = model?.contextWindow || config.contextWindow || this.config.contextWindow || 200_000
    const maxOutputTokens = this.config.maxTokens || model?.maxTokens || config.maxTokens || 4096
    const limit = blockingContextLimit(contextWindow, maxOutputTokens)
    const counterOptions = { provider: config.provider || provider, model: model?.id || config.defaultModel }
    let count = countMessagesTokens(messages, counterOptions)
    if (count.source === 'unavailable' || count.tokens <= limit) return

    for (let index = 1; index < messages.length && count.tokens > limit; index += 1) {
      const message = messages[index]
      if (typeof message.content !== 'string') continue
      const content = message.content
      const isDynamicBlock = content.includes('<runtime_context>')
        || content.includes('<additional_instructions>')
        || content.includes('<recent_files>')
        || content.includes('<codebase_map>')
        || content.includes('<workspace_memory>')
        || content.includes('<git_status>')
      if (!isDynamicBlock) continue
      if (message.role === 'user') {
        message.content = stripRuntimeBlocksFromText(content)
        count = countMessagesTokens(messages, counterOptions)
        continue
      }
      message.content = `${content.slice(0, Math.max(1_000, Math.floor(limit * 1.5)))}\n<truncated_for_context_budget />`
      count = countMessagesTokens(messages, counterOptions)
    }

    for (let index = messages.length - 1; index > 0 && count.source !== 'unavailable' && count.tokens > limit; index -= 1) {
      const message = messages[index]
      if (message.role !== 'user' || typeof message.content !== 'string') continue
      const stripped = stripRuntimeBlocksFromText(message.content)
      if (stripped === message.content) continue
      message.content = stripped
      count = countMessagesTokens(messages, counterOptions)
    }

    while (count.source !== 'unavailable' && count.tokens > limit && messages.length > 2) {
      const removableIndex = messages.findIndex((message, index) =>
        index > 0
        && typeof message.content === 'string'
        && message.role !== 'user'
        && (
          message.content.includes('<runtime_context>')
          || message.content.includes('<additional_instructions>')
          || message.content.includes('<recent_files>')
          || message.content.includes('<windowed_history_summary>')
        )
      )
      if (removableIndex <= 0) break
      messages.splice(removableIndex, 1)
      count = countMessagesTokens(messages, counterOptions)
    }
  }

  private withAnthropicMessageCacheControl(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return this.withLastMessageCacheControl(messages)
  }

  private withOpenRouterCacheControl(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const withSystemCache = messages.map((message, index) => {
      if (index !== 0 || message.role !== 'system' || typeof message.content !== 'string') {
        return message
      }
      return {
        ...message,
        content: [{
          type: 'text',
          text: message.content,
          cache_control: { type: 'ephemeral' },
        }],
      }
    })
    return this.withLastMessageCacheControl(withSystemCache)
  }

  private withLastMessageCacheControl(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = messages.map(message => ({
      ...message,
      content: Array.isArray(message.content) ? [...message.content] : message.content,
    }))

    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].role === 'system') continue
      result[i] = this.addCacheControlToMessage(result[i])
      break
    }

    return result
  }

  private addCacheControlToMessage(message: Record<string, unknown>): Record<string, unknown> {
    const cacheControl = { type: 'ephemeral' }
    const content = message.content

    if (typeof content === 'string') {
      return {
        ...message,
        content: [{
          type: 'text',
          text: content,
          cache_control: cacheControl,
        }],
      }
    }

    if (Array.isArray(content)) {
      const blocks = content.map(block => (
        block && typeof block === 'object'
          ? { ...(block as Record<string, unknown>) }
          : block
      ))

      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i]
        if (!block || typeof block !== 'object') continue
        const type = (block as Record<string, unknown>).type
        if (message.role === 'assistant' && (type === 'thinking' || type === 'redacted_thinking')) {
          continue
        }
        blocks[i] = {
          ...(block as Record<string, unknown>),
          cache_control: cacheControl,
        }
        return {
          ...message,
          content: blocks,
        }
      }
    }

    return message
  }

  private extractStructuredReasoningDelta(delta: unknown, options?: { allowTypedText?: boolean }): string {
    if (!delta || typeof delta !== 'object') return ''
    const value = delta as Record<string, unknown>
    const candidates = [
      value.reasoning_content,
      value.reasoning,
      value.reasoning_text,
      value.thinking,
      value.thought,
    ]

    if (options?.allowTypedText && typeof value.type === 'string' && /reason|think|thought|analysis/i.test(value.type)) {
      candidates.push(value.text)
    }

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim()
      }
    }
    return ''
  }

  private latestUserContent(): string {
    for (let index = this.session.turns.length - 1; index >= 0; index -= 1) {
      const turn = this.session.turns[index]
      if (turn.role === 'user' && turn.content.trim()) return turn.content.trim()
    }
    return ''
  }

  private looksLikeVisibleAssistantReport(content: string): boolean {
    const normalized = content.trim()
    if (normalized.length < 120) return false
    const lines = normalized.split(/\r?\n/).filter(line => line.trim().length > 0)
    const structuredLines = lines.filter(line =>
      /^\s*(?:#{1,4}\s+|[-*]\s+|\d+\.\s+|[A-Za-z0-9_.-]+[\\/][^\s]+|`[^`]+`)/.test(line)
    ).length
    const paragraphCount = lines.filter(line => line.trim().length > 40).length
    return lines.length >= 4 && structuredLines >= 2 && paragraphCount >= 1
  }

  private async maybeFetchCodemapSummary(strategy?: TurnStrategy | null): Promise<void> {
    if (!strategy?.needsCodeMap) return
    const workspace = this.stateProvider.getWorkspace()
    const basePath = workspace?.path || ''
    const query = this.latestUserContent()
    if (!basePath || !query) return

    // Bug 4 fix: build a cache key that captures (route + workspace +
    // top-N normalized query tokens). Re-fetch when the topic shifts
    // (different route or different significant tokens) but skip the
    // network call when the user is just nudging the same topic.
    const tokens = query
      .toLowerCase()
      .replace(/[^a-z0-9_\u4e00-\u9fa5]+/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1)
      .slice(0, 6)
      .sort()
      .join(',')
    const cacheKey = `${strategy.intent}:${strategy.scope}|${basePath}|${tokens}`
    if (this.codemapCacheKey === cacheKey && this.codemapSummary) return

    // Optimistically claim the key so concurrent turns don't race the IPC.
    // If the fetch fails we leave codemapSummary null but keep the key —
    // the next user message with different tokens will retry naturally.
    this.codemapCacheKey = cacheKey
    try {
      const response = await this.toolExecutor.getCodeMap({
        workspacePath: basePath,
        query,
        maxPaths: 6,
        maxChildrenPerPath: 4,
      }) as { success: boolean; data?: { map?: CodeMapNode[] | CodeMapNode; relatedPaths?: string[] }; map?: CodeMapNode[] | CodeMapNode; relatedPaths?: string[] }
      const map = response.data?.map ?? response.map
      if (!response.success || !map) return
      const nodes = Array.isArray(map) ? map : [map]
      if (nodes.length === 0) return
      const relatedPaths = response.data?.relatedPaths ?? response.relatedPaths
      const related = relatedPaths?.length ? `\nRelated paths:\n${relatedPaths.map((p: string) => `- ${p}`).join('\n')}` : ''
      this.codemapSummary = `${nodes.map(node => this.formatCodeMap(node)).join('\n')}${related}`.slice(0, 5000)
    } catch (err) {
      this.emit({ type: 'error', error: `CodeMap refresh failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  /**
   * Build a STABLE workspace skeleton primer for subagent calls.
   *
   * Used by Fast Context / Explorer / Reviewer to seed a deterministic
   * cache prefix unit that DeepSeek V4 can persist (see SubAgentInvocation.codemap).
   *
   * Stability is the whole point — this primer must be IDENTICAL across
   * every subagent call in the same workspace, otherwise V4's prefix
   * cache detection misses and we eat full input price every time. So:
   * - Cached by absolute workspace path; computed at most once per
   *   workspace per session.
   * - Never includes the user's query, timestamps, or anything random.
   * - Falls back to null on error (caller treats null as "no primer";
   *   the runner skips the codemap-priming pair entirely in that case).
   *
   * Source: `workspace:list-tree` (cheap, sync, no LLM, no index dependency).
   * We trim to top 2 levels of folders + a handful of marker files at root,
   * which is plenty for the model to pick which path to grep first while
   * staying small enough that the primer doesn't dominate the prompt.
   */
  private async maybeBuildWorkspaceSkeleton(workspacePath: string): Promise<string | undefined> {
    if (!workspacePath) return undefined
    if (this.workspaceSkeleton && this.workspaceSkeletonPath === workspacePath) {
      return this.workspaceSkeleton
    }
    // Different workspace from the cached one ⇒ invalidate.
    if (this.workspaceSkeletonPath !== workspacePath) {
      this.workspaceSkeleton = null
      this.workspaceSkeletonPath = workspacePath
    }
    try {
      const tree = await this.toolExecutor.listTree(workspacePath)
      if (!tree.success || !tree.data) return undefined

      // Filter out noise (deps, build outputs, .git) so the skeleton stays
      // signal-dense. Keep this list deterministic — same input ⇒ same
      // output, which is critical for cache locality.
      const SKIP_DIR_NAMES = new Set([
        'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
        'vendor', 'release', '.next', '.turbo', '.cache', '.parcel-cache',
        '.vscode', '.idea', '.kiro', '.claude', '.turboflux', '.turboforge',
        '__pycache__', 'target', '.gradle', '.mvn',
      ])
      const SKIP_FILE_NAMES = new Set([
        'package-lock.json', 'bun.lock', 'yarn.lock', 'pnpm-lock.yaml',
        'Cargo.lock', 'poetry.lock', 'Pipfile.lock', '.DS_Store',
      ])

      // Surface a few "marker" root files (package.json, tsconfig, etc.)
      // upfront so the model knows the project type at a glance.
      const MARKER_FILES = new Set([
        'package.json', 'tsconfig.json', 'pyproject.toml', 'Cargo.toml',
        'go.mod', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json',
        'requirements.txt', 'README.md', 'BLUEPRINT.md', 'AGENTS.md',
        '.gitignore', 'vite.config.ts', 'webpack.config.js', 'Dockerfile',
      ])

      type Node = { name: string; type: 'folder' | 'file'; children?: Node[] }
      const root = tree.data as Node
      const lines: string[] = []
      lines.push(`workspace_root: ${root.name}`)

      // Root-level markers first.
      const rootChildren = (root.children || []).slice().sort((a, b) => a.name.localeCompare(b.name))
      const rootMarkers = rootChildren.filter(n => n.type === 'file' && MARKER_FILES.has(n.name))
      if (rootMarkers.length > 0) {
        lines.push('markers:')
        for (const m of rootMarkers) lines.push(`  - ${m.name}`)
      }

      // Top-level folders + their immediate children. Two levels is enough
      // structure to navigate from; deeper trees blow the primer past
      // useful budget.
      const rootFolders = rootChildren.filter(n => n.type === 'folder' && !SKIP_DIR_NAMES.has(n.name))
      const MAX_TOP_FOLDERS = 24
      const MAX_CHILDREN_PER_FOLDER = 14
      lines.push('top_level:')
      for (const folder of rootFolders.slice(0, MAX_TOP_FOLDERS)) {
        const visibleChildren = (folder.children || [])
          .filter(c => {
            if (c.type === 'folder') return !SKIP_DIR_NAMES.has(c.name)
            return !SKIP_FILE_NAMES.has(c.name)
          })
          .sort((a, b) => {
            // Folders before files, then alphabetical — deterministic.
            if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
            return a.name.localeCompare(b.name)
          })
          .slice(0, MAX_CHILDREN_PER_FOLDER)
        const childList = visibleChildren
          .map(c => c.type === 'folder' ? `${c.name}/` : c.name)
          .join(', ')
        lines.push(`  ${folder.name}/${childList ? ` — ${childList}` : ''}`)
      }
      if (rootFolders.length > MAX_TOP_FOLDERS) {
        lines.push(`  (… ${rootFolders.length - MAX_TOP_FOLDERS} more top-level folder(s) omitted)`)
      }

      const skeleton = lines.join('\n')
      // Hard cap so a sprawling monorepo can't bloat the primer past
      // the cache-friendly sweet spot. ~3 KB ≈ 750 tokens, well within
      // V4's prefix unit threshold.
      this.workspaceSkeleton = skeleton.slice(0, 3000)
      return this.workspaceSkeleton
    } catch {
      // Tree fetch failed — return undefined so the runner skips the
      // primer pair entirely instead of seeding a half-broken one.
      return undefined
    }
  }

  /**
   * Pull the latest workspace memory snapshot from the main process.
   *
   * Caching strategy: the main MemoryService keys its own cache by file
   * mtimes, so calling memoryList every turn is cheap when nothing changed
   * (one stat per known rule file, no parsing). We additionally short-
   * circuit on `builtAt` to avoid even the IPC round-trip on back-to-back
   * turns within ~10s of each other; if the user was actively editing a
   * rule file we want the new content fast, so the TTL is intentionally
   * short.
   *
   * Failure mode: any IPC error leaves the previous text intact rather
   * than nulling it out. Stale-but-present is strictly better than
   * losing the user's project rules just because a stat call hiccupped.
   */
  private async maybeRefreshWorkspaceMemory(): Promise<void> {
    const workspace = this.stateProvider.getWorkspace()
    const wsPath = workspace?.path || ''
    if (!wsPath) {
      this.workspaceMemoryText = null
      this.workspaceMemoryWorkspace = null
      this.workspaceMemoryBuiltAt = 0
      return
    }

    const now = Date.now()
    const sameWorkspace = this.workspaceMemoryWorkspace === wsPath
    const fresh = sameWorkspace && (now - this.workspaceMemoryBuiltAt) < 10_000
    if (fresh) return

    // Query-aware path: if we have a recent user message, ask the main
    // process to rank rules by relevance and trim to a tighter budget.
    // Falls back to full snapshot on any error or when no message yet.
    const latestUserMessage = (() => {
      for (let i = this.session.turns.length - 1; i >= 0; i--) {
        const t = this.session.turns[i]
        if (t.role === 'user' && t.content.trim()) return t.content
      }
      return ''
    })()

    if (latestUserMessage && typeof this.toolExecutor.memoryGetRelevantInjection === 'function') {
      try {
        const resp = await this.toolExecutor.memoryGetRelevantInjection({
          workspacePath: wsPath,
          query: latestUserMessage,
        })
        if (resp?.success && typeof resp.text === 'string') {
          this.workspaceMemoryText = resp.text.trim() || null
          this.workspaceMemoryWorkspace = wsPath
          this.workspaceMemoryBuiltAt = now
          return
        }
      } catch {
        // fall through to full snapshot
      }
    }

    try {
      const response = await this.toolExecutor.memoryList(wsPath)
      if (!response?.success || !response.data?.snapshot) {
        if (!sameWorkspace) {
          this.workspaceMemoryText = null
          this.workspaceMemoryWorkspace = wsPath
          this.workspaceMemoryBuiltAt = now
        }
        return
      }
      const text = response.data.snapshot.injectionText.trim()
      this.workspaceMemoryText = text.length > 0 ? text : null
      this.workspaceMemoryWorkspace = wsPath
      this.workspaceMemoryBuiltAt = now
    } catch {
      // Keep prior text on transient IPC failure.
    }
  }

  private buildEvidenceGuardHint(): string | null {
    // If the model already performed any read operations (read_file,
    // list_directory, search_*, get_codemap, explore_code), it has gathered evidence.
    // Don't force a retry — trust the model's judgment on when to conclude.
    if (this.currentRunReadFiles.size > 0) return null
    if (this.currentRunSuccessfulSearches.size > 0) return null
    if (this.currentRunExplorePacks.size > 0) return null
    if (this.currentRunToolNames.some(n => n === 'list_directory' || n === 'get_codemap')) return null
    return this.buildEvidencePolicyContext(this.currentTurnStrategy, 'retry')
  }

  private buildEvidencePolicyContext(strategy?: TurnStrategy | null, phase: 'pre' | 'retry' = 'pre'): string | null {
    if (!strategy?.requiresEvidence) return null
    const maxAttempts = 1
    if (phase === 'retry' && this.conclusionGuardAttempts >= maxAttempts) return null

    const hasSearchEvidence = this.currentRunSuccessfulSearches.size > 0
    const hasDirectRead = this.currentRunSuccessfulReadFiles.size > 0
    if (hasSearchEvidence && hasDirectRead) return null

    const tag = phase === 'retry' ? 'evidence_guard' : 'evidence_policy'
    if (phase === 'retry') {
      return `<${tag} intent="${strategy.intent}" scope="${strategy.scope}">
You already searched. NO more search tools this turn. Use read_file on the most relevant prior hits (or read_file_full only if exact whole-file contents are required), then answer with file anchors.
</${tag}>`
    }
    return `<${tag} intent="${strategy.intent}" scope="${strategy.scope}">
Before high-confidence claims: locate authoritative code via search_symbols/search_content/get_codemap, then read_file at least one high-signal source. Use read_file_full only for exact whole-file needs. Answer with verified anchors; state residual uncertainty plainly.
</${tag}>`
  }

  private recordToolUsage(name: string, args: Record<string, unknown>): void {
    this.currentRunToolNames.push(name)
    if ((name === 'read_file' || name === 'read_file_full') && typeof args.path === 'string') {
      this.currentRunReadFiles.add(args.path)
    }
    if (name.startsWith('search_') || name === 'get_codemap') {
      const query = (args.query || args.pattern || '') as string
      this.currentRunSearches.add(`${name}:${query}`)
    }
    if (name === 'explore_code') {
      const objective = (args.objective || '') as string
      this.currentRunSearches.add(`${name}:${objective}`)
    }
  }

  private recordSuccessfulToolUsage(name: string, args: Record<string, unknown>, output: string): void {
    if (this.isToolOutputFailure(name, output)) return
    if ((name === 'read_file' || name === 'read_file_full') && typeof args.path === 'string') {
      this.currentRunSuccessfulReadFiles.add(args.path)
    }
    // Bug 1 fix: search_files was excluded here while recordToolUsage()
    // already adds it to currentRunSearches via the name.startsWith('search_')
    // branch. The asymmetry meant evidence_guard's hasSearchEvidence
    // (currentRunSuccessfulSearches.size > 0) could never be satisfied by a
    // pure search_files-driven run, so the model was forced to retry even
    // after a successful filename scan. Treat search_files exactly like the
    // other search_* tools and gate "no hits" output the same way.
    if (
      name === 'search_files'
      || name === 'search_content'
      || name === 'search_symbols'
      || name === 'get_codemap'
    ) {
      if (/^(No matches found|No matching files found|No codemap found)$/i.test(output.trim())) return
      const query = (args.query || args.pattern || '') as string
      this.currentRunSuccessfulSearches.add(`${name}:${query}`)
    }
    if (name === 'explore_code') {
      if (/FastContext background scan (?:started|is already)/i.test(output)) return
      if (/no concrete candidates found|did not return high-signal files/i.test(output)) return
      const objective = (args.objective || '') as string
      this.currentRunExplorePacks.add(objective || 'explore_code')
      this.currentRunSuccessfulSearches.add(`${name}:${objective}`)
    }
  }

  private isToolOutputFailure(name: string, output: string): boolean {
    const trimmed = output.trim()
    if ((name === 'read_file' || name === 'read_file_full') && !/^Error(?:\s|\(|:)/.test(trimmed)) return false
    return /^Error(?:\s|\(|:)/.test(trimmed)
      || /^Tool execution error:/i.test(trimmed)
      || /^Unknown tool:/i.test(trimmed)
  }

  private getTaskToolStatus(result: ToolResult): 'completed' | 'error' | 'cancelled' {
    const trimmed = result.output.trim()
    if (/^(Cancelled|Aborted):/i.test(trimmed)) return 'cancelled'
    return result.isError ? 'error' : 'completed'
  }

  /**
   * Walk the existing session.turns and re-record each historical tool call
   * + result into currentRun* sets so the evidence guard treats restored
   * reads/searches as valid evidence in the new run (Bug #19).
   */
  private replayEvidenceFromExistingTurns(): void {
    const resultsByCallId = new Map<string, ToolResult>()
    for (const turn of this.session.turns) {
      if (turn.role !== 'tool_result' || !turn.toolResults) continue
      for (const result of turn.toolResults) {
        resultsByCallId.set(result.toolCallId, result)
      }
    }

    for (const turn of this.session.turns) {
      if (turn.role !== 'assistant' || !turn.toolCalls || turn.toolCalls.length === 0) continue
      for (const tc of turn.toolCalls) {
        this.recordToolUsage(tc.name, tc.arguments)
        const result = resultsByCallId.get(tc.id)
        if (result && !result.isError) {
          this.recordSuccessfulToolUsage(tc.name, tc.arguments, result.output || '')
        }
      }
    }
  }

  private async executeToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    if (toolCalls.length === 0) return []

    // Partition tool calls into batches: consecutive concurrency-safe tools run in parallel,
    // non-safe tools run serially (inspired by Claude Code's StreamingToolExecutor)
    const batches = this.partitionToolCalls(toolCalls)
    const allResults: ToolResult[] = []

    for (const batch of batches) {
      if (this.abortController?.signal.aborted) break

      if (batch.isConcurrencySafe && batch.toolCalls.length > 1) {
        // Run concurrency-safe batch in parallel
        const parallelResults = await this.executeToolsConcurrently(batch.toolCalls)
        allResults.push(...parallelResults)
      } else {
        // Run non-safe or single-tool batch serially
        for (const tc of batch.toolCalls) {
          if (this.abortController?.signal.aborted) break

          // Auto-link to current active task
          this.linkToolCallToActiveTask(tc)
          this.emitActiveTaskContext()

          this.emit({ type: 'tool:call', toolCall: tc })
          const result = await this.executeSingleTool(tc)
          allResults.push(result)
          this.emit({ type: 'tool:result', toolResult: result })

          // Update task tool call status after completion
          this.updateTaskToolCallStatus(tc.id, this.getTaskToolStatus(result), result.output)
          this.emitActiveTaskContext()
        }
      }
    }

    const completedIds = new Set(allResults.map(result => result.toolCallId))
    for (const toolCall of toolCalls) {
      if (completedIds.has(toolCall.id)) continue
      this.linkToolCallToActiveTask(toolCall)
      this.emit({ type: 'tool:call', toolCall })
      const result: ToolResult = {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: CANCELLED_TOOL_RESULT_TEXT,
        isError: true,
        errorKind: 'abort',
      }
      allResults.push(result)
      this.emit({ type: 'tool:result', toolResult: result })
      this.updateTaskToolCallStatus(toolCall.id, 'cancelled', result.output)
    }
    if (completedIds.size !== allResults.length) this.emitActiveTaskContext()

    // Auto-create checkpoint if there are file modifications without explicit checkpoint
    // This ensures code changes are always recoverable even if AI forgets to checkpoint
    const hasFileOperations = toolCalls.some(tc =>
      ['write_file', 'replace_file', 'edit_file', 'multi_edit', 'delete_file'].includes(tc.name)
    )
    const hasExplicitCheckpoint = toolCalls.some(tc => tc.name === 'create_checkpoint')

    if (hasFileOperations && !hasExplicitCheckpoint && !this.pendingCheckpoint && this.config.workspacePath) {
      try {
        const filePaths = Array.from(this.touchedFilePaths)
        if (filePaths.length === 0) return allResults
        const preimages = this.filePreimages.size > 0 ? Object.fromEntries(this.filePreimages) : undefined
        const result = await this.toolExecutor.checkpointCreate?.(this.config.workspacePath, `Auto-checkpoint after file operations`, filePaths, 'auto', preimages) as { checkpointId?: string; label?: string } | undefined
        if (result?.checkpointId) {
          this.pendingCheckpoint = {
            hash: result.checkpointId,
            message: result.label || `Auto-checkpoint after file operations`,
          }
          this.touchedFilePaths.clear()
          this.filePreimages.clear()
        }
      } catch (err) {
        this.emit({ type: 'error', error: `Auto-checkpoint failed: ${err instanceof Error ? err.message : String(err)}` })
      }
    }

    // Bind any pending checkpoint (auto OR explicit create_checkpoint) to the
    // assistant turn that produced these tool calls, not to the next one. The
    // old behavior carried pendingCheckpoint into createAssistantTurn for the
    // following model call, which (a) attached the rollback metadata to the
    // wrong message and (b) silently orphaned the checkpoint when the run
    // ended before another model call arrived (abort, max turns, error path).
    if (this.pendingCheckpoint) {
      let latestAssistantTurn: AgentTurn | undefined
      for (let i = this.session.turns.length - 1; i >= 0; i--) {
        const candidate = this.session.turns[i]
        if (candidate.role === 'assistant') {
          latestAssistantTurn = candidate
          break
        }
      }
      if (latestAssistantTurn) {
        latestAssistantTurn.metadata = {
          ...(latestAssistantTurn.metadata || {}),
          checkpointId: this.pendingCheckpoint.hash,
          checkpointLabel: this.pendingCheckpoint.message,
        }
      }
      if (this.lastAssistantMessageId) {
        this.emit({
          type: 'checkpoint:attached',
          assistantMessageId: this.lastAssistantMessageId,
          checkpointId: this.pendingCheckpoint.hash,
          checkpointLabel: this.pendingCheckpoint.message,
        })
      }
      this.pendingCheckpoint = null
      this.lastAssistantMessageId = null
    }

    return allResults
  }

  private async executeToolsConcurrently(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    // Emit all tool:call events first so UI shows them as "in progress" simultaneously
    for (const tc of toolCalls) {
      this.linkToolCallToActiveTask(tc)
    }
    this.emitActiveTaskContext()

    for (const tc of toolCalls) {
      this.emit({ type: 'tool:call', toolCall: tc })
    }

    // Execute all in parallel
    const promises = toolCalls.map(async (tc) => {
      if (this.abortController?.signal.aborted) {
        const result: ToolResult = {
          toolCallId: tc.id,
          name: tc.name,
          output: 'Cancelled: aborted',
          isError: true,
        }
        this.updateTaskToolCallStatus(tc.id, 'cancelled', result.output)
        return result
      }
      const result = await this.executeSingleTool(tc)
      this.emit({ type: 'tool:result', toolResult: result })
      this.updateTaskToolCallStatus(tc.id, this.getTaskToolStatus(result), result.output)
      return result
    })

    const results = await Promise.all(promises)
    this.emitActiveTaskContext()
    return results
  }

  private linkToolCallToActiveTask(toolCall: ToolCall): void {
    const path = this.extractToolCallPath(toolCall)
    const linkedTaskId = this.taskManager.addToolCallToActiveTask({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      status: 'running',
      path,
    })
    if (linkedTaskId) {
      this.toolCallTaskMap.set(toolCall.id, linkedTaskId)
    }
  }

  private updateTaskToolCallStatus(toolCallId: string, status: 'completed' | 'error' | 'cancelled', result?: string): void {
    const taskId = this.toolCallTaskMap.get(toolCallId)
    if (taskId) {
      this.taskManager.updateToolCallStatus(taskId, toolCallId, status, result)
      return
    }
    const activeCtx = this.taskManager.getActiveTaskContext()
    if (!activeCtx) return
    this.taskManager.updateToolCallStatus(activeCtx.taskId, toolCallId, status, result)
  }

  private emitActiveTaskContext(): void {
    const ctx = this.taskManager.getActiveTaskContext()
    this.emit({ type: 'active:task', context: ctx })
    this.emitTaskSystem()
  }

  private async emitTerminalSessions(): Promise<void> {
    const result = await this.toolExecutor.ptyList?.()
    if (!result?.success) {
      this.emit({ type: 'terminal:sessions', sessions: [] })
      return
    }
    const rawSessions = (result.sessions || result.data || []) as TerminalSessionInfo[]
    const sessions = rawSessions.filter(s => s.isAgentSession || this.agentBackgroundSessions.has(s.id))
    this.emit({ type: 'terminal:sessions', sessions })
  }

  private async getTerminalSession(sessionId: string): Promise<TerminalSessionInfo | undefined> {
    const result = await this.toolExecutor.ptyList?.()
    if (!result?.success) return undefined
    const rawSessions = (result.sessions || result.data || []) as TerminalSessionInfo[]
    return rawSessions.find(s => s.id === sessionId)
  }

  private emitTaskSystem(creation?: TaskSystemCreationEvent | null): void {
    this.emit({
      type: 'task:system',
      context: this.taskManager.getActiveTaskContext(),
      tree: this.taskManager.getFullTree(),
      creation,
    })
  }

  private extractToolCallPath(toolCall: ToolCall): string | undefined {
    const args = toolCall.arguments
    return args.path as string | undefined
      || args.cwd as string | undefined
      || args.directory as string | undefined
      || args.file_path as string | undefined
  }

  private isWriteToolCall(toolCall: ToolCall): boolean {
    return this.resolveToolDefinition(toolCall.name)?.isReadOnly === false
  }

  private resolveToolDefinition(name: string): AgentTool | undefined {
    return getToolByName(name) || (this.mcpClient ? getMcpAgentTools(this.mcpClient).find(tool => tool.name === name) : undefined)
  }

  private isReadAfterWriteSensitiveToolCall(toolCall: ToolCall): boolean {
    return ['read_file', 'read_file_full', 'list_directory', 'search_files', 'search_content', 'search_symbols', 'get_codemap', 'explore_code', 'web_search'].includes(toolCall.name)
  }

  private partitionToolCalls(toolCalls: ToolCall[]): Array<{ isConcurrencySafe: boolean; toolCalls: ToolCall[] }> {
    const batches: Array<{ isConcurrencySafe: boolean; toolCalls: ToolCall[] }> = []
    let hasSeenWrite = false

    for (const tc of toolCalls) {
      const tool = this.resolveToolDefinition(tc.name)
      const isReadAfterWrite = hasSeenWrite && this.isReadAfterWriteSensitiveToolCall(tc)
      const isSafe = (tool?.isConcurrencySafe ?? false) && !isReadAfterWrite

      if (isSafe && batches.length > 0 && batches[batches.length - 1].isConcurrencySafe) {
        batches[batches.length - 1].toolCalls.push(tc)
      } else {
        batches.push({ isConcurrencySafe: isSafe, toolCalls: [tc] })
      }

      if (this.isWriteToolCall(tc)) {
        hasSeenWrite = true
      }
    }

    return batches
  }

  private async executeSingleTool(toolCall: ToolCall): Promise<ToolResult> {
    const tool = this.resolveToolDefinition(toolCall.name)

    if (!tool) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Error: unknown tool "${toolCall.name}"`,
        isError: true,
      }
    }

    if (this.config.mode === 'plan' && !tool.isReadOnly) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Error: plan mode is read-only; switch to vibe mode before using "${toolCall.name}".`,
        isError: true,
        errorKind: 'permission',
      }
    }

    if (this.disabledToolNames.has(toolCall.name)) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Error: tool "${toolCall.name}" is disabled for this request by the user's instruction.`,
        isError: true,
      }
    }

    if (tool.requiredMode && !tool.requiredMode.includes(this.config.mode)) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Error: tool "${toolCall.name}" is not available in ${this.config.mode} mode. Switch to ${tool.requiredMode.join(' or ')} mode.`,
        isError: true,
      }
    }

    // Validate tool arguments
    const validation = isMcpTool(toolCall.name) && tool.inputSchema
      ? validateMcpToolArgs(tool.inputSchema, toolCall.arguments)
      : validateToolArgs(toolCall.name, toolCall.arguments)
    if (!validation.valid) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Error: ${validation.error}`,
        isError: true,
      }
    }

    const permissionError = await this.checkToolPermission(toolCall)
    if (permissionError) return permissionError

    this.recordToolUsage(toolCall.name, toolCall.arguments)

    try {
      const executionArgs = toolCall.name === 'run_command'
        ? { ...toolCall.arguments, approved: true }
        : toolCall.arguments
      const output = await this.dispatchTool(toolCall.name, executionArgs)

      // Layer 0: Large result truncation.
      // When a tool returns a very large output, keep only a short preview
      // in the context window. The model is told the full output was truncated
      // and can re-read the file with offset/limit if it needs more detail.
      // Threshold: 20 000 chars ≈ 5 000 tokens — large enough to cover most
      // useful reads (400 lines × ~50 chars/line = 20 000) while preventing
      // single tool calls from consuming the entire context budget.
      // read_file is exempt because it already has its own pagination via
      // offset/limit; truncating it here would break the pagination contract.
      const LARGE_RESULT_THRESHOLD = 20_000
      const LARGE_RESULT_PREVIEW = 2_000
      const isExemptFromTruncation = toolCall.name === 'read_file' || toolCall.name === 'read_file_full'
      const truncatedOutput = (!isExemptFromTruncation && output.length > LARGE_RESULT_THRESHOLD)
        ? `${output.slice(0, LARGE_RESULT_PREVIEW)}\n… <output truncated: ${output.length} chars total. Use a more specific query or read_file with offset/limit to get the relevant section.>`
        : output

      const isOutputFailure = this.isToolOutputFailure(toolCall.name, truncatedOutput)
      const result: ToolResult = {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: truncatedOutput,
        isError: isOutputFailure,
      }
      if (!isOutputFailure) {
        this.recordSuccessfulToolUsage(toolCall.name, toolCall.arguments, truncatedOutput)
      }

      // Build change summary for file write/edit/delete operations.
      // Attach size-capped before/after snapshots so the UI can render
      // real unified diffs lazily (folded card = zero diff work).
      const workspacePath = this.stateProvider.getWorkspace()?.path || ''
      const resolvedPath = (toolCall.arguments.path as string)
        ? this.resolvePath(workspacePath, toolCall.arguments.path as string)
        : ''

      if (toolCall.name === 'write_file' && !isOutputFailure) {
        const content = (toolCall.arguments.content as string) || ''
        const lines = content.split('\n')
        const before = this.filePreimages.get(resolvedPath) ?? ''
        const after = content
        result.changeSummary = {
          path: (toolCall.arguments.path as string) || '',
          operation: 'write',
          totalLines: lines.length,
          preview: lines.slice(0, 20).join('\n'),
          ...this.diffStats(before, after),
          ...(canComputeDiff(before, after) ? { before, after } : {}),
        }
      }

      if (toolCall.name === 'replace_file' && !isOutputFailure) {
        const content = (toolCall.arguments.content as string) || ''
        const lines = content.split('\n')
        const before = this.filePreimages.get(resolvedPath) ?? ''
        const after = content
        result.changeSummary = {
          path: (toolCall.arguments.path as string) || '',
          operation: 'edit',
          totalLines: lines.length,
          preview: lines.slice(0, 20).join('\n'),
          ...this.diffStats(before, after),
          ...(canComputeDiff(before, after) ? { before, after } : {}),
        }
      }

      if (toolCall.name === 'edit_file' && !isOutputFailure) {
        const oldContent = (toolCall.arguments.old_content as string) || ''
        const newContent = (toolCall.arguments.new_content as string) || ''
        const oldLines = oldContent.split('\n').length
        const newLines = newContent.split('\n').length
        let totalLines = newLines
        let afterFileContent = ''
        let hasAfterSnapshot = false
        try {
          const editedPath = this.resolvePath(
            this.stateProvider.getWorkspace()?.path || '',
            (toolCall.arguments.path as string) || '',
          )
          const reread = await this.toolExecutor.readFile(editedPath)
          if (reread.success && typeof reread.data === 'string') {
            totalLines = reread.data.split('\n').length
            afterFileContent = reread.data
            hasAfterSnapshot = true
          }
        } catch {
        }
        const before = this.filePreimages.get(resolvedPath) ?? ''
        const after = afterFileContent
        result.changeSummary = {
          path: (toolCall.arguments.path as string) || '',
          operation: 'edit',
          totalLines,
          oldPreview: oldContent.split('\n').slice(0, 5).join('\n'),
          preview: newContent.split('\n').slice(0, 5).join('\n'),
          ...(hasAfterSnapshot ? this.diffStats(before, after) : {}),
          ...(hasAfterSnapshot && canComputeDiff(before, after) ? { before, after } : {}),
        }
      }

      if (toolCall.name === 'multi_edit' && !isOutputFailure) {
        const before = this.filePreimages.get(resolvedPath) ?? ''
        let after = ''
        let hasAfterSnapshot = false
        try {
          const reread = await this.toolExecutor.readFile(resolvedPath)
          if (reread.success && typeof reread.data === 'string') {
            after = reread.data
            hasAfterSnapshot = true
          }
        } catch {
        }
        const afterLines = hasAfterSnapshot ? after.split('\n').length : undefined
        result.changeSummary = {
          path: (toolCall.arguments.path as string) || '',
          operation: 'edit',
          totalLines: afterLines,
          ...(hasAfterSnapshot ? this.diffStats(before, after) : {}),
          ...(hasAfterSnapshot && canComputeDiff(before, after) ? { before, after } : {}),
        }
      }

      if (toolCall.name === 'delete_file' && !isOutputFailure) {
        const before = this.filePreimages.get(resolvedPath) ?? ''
        result.changeSummary = {
          path: (toolCall.arguments.path as string) || '',
          operation: 'delete',
          ...this.diffStats(before, ''),
          ...(canComputeDiff(before, '') ? { before, after: '' } : {}),
        }
      }

      return result
    } catch (error) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Tool execution error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }
  }

  private async checkToolPermission(toolCall: ToolCall): Promise<ToolResult | null> {
    const permissionArgs = toolCall.name === 'run_command'
      ? { ...toolCall.arguments, approved: false }
      : toolCall.arguments
    const result = this.permissions.check(toolCall.name, permissionArgs)

    if (result.verdict === 'allow') return null

    if (result.verdict === 'deny') {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Error: Blocked by permission policy. ${result.reason || 'Operation not permitted'}`,
        isError: true,
        errorKind: 'permission',
      }
    }

    const command = typeof toolCall.arguments.command === 'string'
      ? toolCall.arguments.command
      : undefined
    this.emit({
      type: 'ask:user',
      requestId: toolCall.id,
      toolName: toolCall.name,
      path: this.extractToolCallPath(toolCall),
      question: command
        ? `允许执行这个命令吗？`
        : `允许执行 ${toolCall.name} 吗？`,
      options: ['allow-once', 'allow-session', 'deny'],
      reason: result.reason || 'Operation requires approval',
      command,
    })

    const response = await this.waitForAskUserResponse()
    const decision = this.parsePermissionDecision(response)
    if (decision === 'deny') {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Error: User denied permission. ${result.reason || 'Operation requires approval'}`,
        isError: true,
        errorKind: 'permission',
      }
    }

    if (decision === 'allow-session') {
      this.permissions.grantSession(toolCall.name, this.computePermissionFingerprint(toolCall))
    }

    return null
  }

  private parsePermissionDecision(response: string): 'allow-once' | 'allow-session' | 'deny' {
    const normalized = response.trim().toLowerCase()
    if (['allow-session', 'always', 'all', 'a', 'session', '一直允许', '本次会话允许'].includes(normalized)) {
      return 'allow-session'
    }
    if (['deny', 'no', 'n', 'false', '拒绝', '不允许', '否'].includes(normalized)) {
      return 'deny'
    }
    return 'allow-once'
  }

  private computePermissionFingerprint(toolCall: ToolCall): string {
    if (toolCall.name === 'run_command') {
      return String(toolCall.arguments.command || '').trim().slice(0, 100)
    }
    if (toolCall.name === 'delete_file') {
      return String(toolCall.arguments.path || '')
    }
    return JSON.stringify(toolCall.arguments).slice(0, 200)
  }

  private emitSubAgentProgress(agentType: string, label: string, event: SubAgentEvent): void {
    if (event.type === 'turn_start') {
      this.emit({
        type: 'fast_context:event',
        event: { type: 'phase', phase: 'scanning', wave: event.turn, maxWaves: event.maxTurns, insight: `${label} turn ${event.turn}` },
      })
      this.emit({
        type: 'fast_context:event',
        event: { type: 'worker', id: `spawn-${agentType}-${event.turn}`, label: `${label} turn ${event.turn}`, status: 'running' },
      })
    } else if (event.type === 'model_wait') {
      this.emit({
        type: 'fast_context:event',
        event: { type: 'insight', text: `${label} model pending (${Math.floor(event.elapsedMs / 1000)}s)`, tone: 'info' },
      })
    } else if (event.type === 'model_retry') {
      this.emit({
        type: 'fast_context:event',
        event: { type: 'insight', text: `${label} retrying model request: ${event.reason}`, tone: 'warning' },
      })
    } else if (event.type === 'tool_call') {
      const argSummary = (() => { try { return JSON.stringify(event.args).slice(0, 120) } catch { return '' } })()
      this.emit({
        type: 'fast_context:event',
        event: { type: 'file', path: `${event.tool}(${argSummary})`, status: 'discovered', workerId: `spawn-${agentType}-${event.turn}`, reason: event.tool },
      })
    } else if (event.type === 'tool_result') {
      this.emit({
        type: 'fast_context:event',
        event: { type: 'insight', text: event.summary, tone: event.ok ? 'info' : 'warning' },
      })
    } else if (event.type === 'evidence') {
      this.emit({
        type: 'fast_context:event',
        event: {
          type: 'hit',
          hit: {
            path: event.evidence.path,
            line: event.evidence.startLine,
            startLine: event.evidence.startLine,
            endLine: event.evidence.endLine,
            preview: event.evidence.preview,
            reason: event.evidence.reason,
          },
        },
      })
    } else if (event.type === 'turn_complete') {
      this.emit({
        type: 'fast_context:event',
        event: { type: 'worker', id: `spawn-${agentType}-${event.turn}`, label: `${label} turn ${event.turn}`, status: 'completed' },
      })
    } else if (event.type === 'error') {
      this.emit({
        type: 'fast_context:event',
        event: { type: 'insight', text: `${label} error: ${event.message}`, tone: 'warning' },
      })
    }
  }

  private formatSubAgentTask(task: SubAgentTaskSnapshot): string {
    const runtime = task.runtimeTask
    const lines = [
      `Agent ID: ${task.id}`,
      `Type: ${task.agentType}`,
      `Status: ${runtime.status}`,
      `Objective: ${task.objective}`,
      `Started: ${new Date(task.startedAt).toISOString()}`,
    ]
    if (runtime.endedAt) lines.push(`Ended: ${new Date(runtime.endedAt).toISOString()}`)
    if (runtime.error) lines.push(`Error: ${runtime.error}`)
    if (task.transcriptPath) lines.push(`Transcript: ${task.transcriptPath}`)

    if (task.result && task.kind === 'fast_context') {
      const result = task.result as Partial<FastContextScanResult>
      lines.push('', result.evidencePack?.trim() || `FastContext scanned ${result.filesScanned || 0} file(s).`)
    } else if (task.result) {
      const result = task.result as {
        ok?: boolean
        turns?: number
        elapsedMs?: number
        finalText?: string
        evidence?: SubAgentEvidence[]
        error?: string
      }
      lines.push('', `<subagent_report type="${task.agentType}" turns="${result.turns || 0}" elapsed_ms="${result.elapsedMs || 0}">`)
      lines.push('', 'final_report:', result.finalText || result.error || '(empty)', '')
      const evidence = result.evidence || []
      if (evidence.length > 0) {
        lines.push('evidence (top 12):')
        for (const item of evidence.slice(0, 12)) {
          const preview = item.preview.split('\n').slice(0, 3).map(line => `    ${line.replace(/\s+/g, ' ').trim().slice(0, 200)}`).join('\n')
          lines.push(`  - ${item.path}:L${item.startLine}-${item.endLine} · ${item.reason}`)
          if (preview) lines.push(preview)
        }
        if (evidence.length > 12) lines.push(`  (... ${evidence.length - 12} more evidence range(s))`)
      }
      lines.push('', '</subagent_report>')
    }
    return lines.join('\n')
  }

  private async dispatchTool(name: string, args: Record<string, unknown>): Promise<string> {
    const workspace = this.stateProvider.getWorkspace()
    const basePath = workspace?.path || ''

    switch (name) {
      case 'read_file':
      case 'read_file_full': {
        const filePath = this.resolvePath(basePath, args.path as string)
        const isFullRead = name === 'read_file_full'
        const offset = isFullRead ? undefined : args.offset as number | undefined
        const requestedLimit = isFullRead ? undefined : args.limit as number | undefined
        const limit = isFullRead ? undefined : requestedLimit ?? 180
        // with_line_numbers defaults true: cat -n style output makes
        // edit_file / multi_edit far more reliable because the model can
        // see exact line positions when planning targeted edits.
        const withLineNumbers = isFullRead
          ? args.with_line_numbers === true
          : args.with_line_numbers !== false

        const result = await this.toolExecutor.readFile(filePath)
        if (!result.success) {
          const relPath = this.toWorkspaceRelative(basePath, filePath)
          throw new Error(`File not found — resolved path: ${relPath}. Use search_files or list_directory to verify the correct path.`)
        }

        const rawContent = result.data ?? ''
        const allLines = rawContent.split('\n')
        const totalLines = allLines.length
        const startLine = offset || 1
        const start = Math.max(0, startLine - 1)
        const end = limit ? start + limit : totalLines
        const slice = allLines.slice(start, end)
        const returnedLines = slice.length

        // Render with line numbers in cat -n format
        const formatLine = (lineText: string, idx: number) =>
          `${String(start + idx + 1).padStart(6, ' ')}→${lineText}`
        const content = withLineNumbers
          ? slice.map(formatLine).join('\n')
          : slice.join('\n')

        // If there is more content, hint continuation. Default read_file is
        // intentionally sliced so the model does not pull a huge file into
        // context when it only needs a local region.
        const truncated = (start + returnedLines) < totalLines
        if (!isFullRead && limit && truncated) {
          const nextOffset = startLine + returnedLines
          const fullHint = requestedLimit
            ? `call read_file with offset=${nextOffset}, limit=${limit} to continue`
            : `showing the first ${returnedLines} lines by default; call read_file with offset=${nextOffset}, limit=${limit} to continue, or read_file_full only when exact complete file content is required`
          return `[lines ${startLine}-${startLine - 1 + returnedLines} of ${totalLines}; ${fullHint}]\n${content}`
        }
        return content
      }

      case 'write_file': {
        const filePath = this.resolvePath(basePath, args.path as string)
        await this.capturePreimage(filePath)
        const result = await this.toolExecutor.writeFile(filePath, args.content as string, {
          source: 'ai',
          label: 'AI write_file',
          expectNotExists: true,
        })
        if (result.success) {
          this.touchedFilePaths.add(filePath)
          this.invalidateCodeLookupAfterFileChange(basePath, [filePath])
        }
        return result.success ? `File written: ${args.path}` : `Error: ${result.error}`
      }

      case 'replace_file': {
        const filePath = this.resolvePath(basePath, args.path as string)
        const existing = await this.toolExecutor.readFile(filePath)
        if (!existing.success) {
          return `Error: replace_file requires an existing file - ${existing.error || 'file not found'}`
        }
        await this.capturePreimage(filePath)
        const result = await this.toolExecutor.writeFile(filePath, args.content as string, {
          source: 'ai',
          label: 'AI replace_file',
          expectedHash: hashText(existing.data || ''),
        })
        if (result.success) {
          this.touchedFilePaths.add(filePath)
          this.invalidateCodeLookupAfterFileChange(basePath, [filePath])
        }
        return result.success ? `File replaced: ${args.path}` : `Error: ${result.error}`
      }

      case 'edit_file': {
        const filePath = this.resolvePath(basePath, args.path as string)
        await this.capturePreimage(filePath)
        const readResult = await this.toolExecutor.readFile(filePath)
        if (!readResult.success) return `Error: unable to read file - ${readResult.error}`

        let content = readResult.data!
        const oldContent = stripLineNumberPrefix(args.old_content as string)
        const newContent = stripLineNumberPrefix(args.new_content as string)
        const replaceAll = args.replace_all === true

        const editResult = applyEdit(content, oldContent, newContent, replaceAll, args.path as string)
        if ('error' in editResult) return `Error: ${editResult.error}`
        content = editResult.content

        const writeResult = await this.toolExecutor.writeFile(filePath, content, {
          source: 'ai',
          label: 'AI edit_file',
          expectedHash: hashText(readResult.data || ''),
        })
        if (writeResult.success) {
          this.touchedFilePaths.add(filePath)
          this.invalidateCodeLookupAfterFileChange(basePath, [filePath])
        }
        return writeResult.success
          ? `File edited: ${args.path}${replaceAll ? ` (${editResult.replacements} replacements)` : ''}`
          : `Error: ${writeResult.error}`
      }

      case 'multi_edit': {
        const filePath = this.resolvePath(basePath, args.path as string)
        const rawEdits = args.edits
        if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
          return `Error: edits must be a non-empty array`
        }
        await this.capturePreimage(filePath)
        const readResult = await this.toolExecutor.readFile(filePath)
        if (!readResult.success) return `Error: unable to read file - ${readResult.error}`

        let content = readResult.data!
        const summary: string[] = []
        for (let i = 0; i < rawEdits.length; i += 1) {
          const edit = rawEdits[i] as Record<string, unknown>
          if (!edit || typeof edit !== 'object') {
            return `Error: edit #${i + 1} is not an object`
          }
          const oldContent = stripLineNumberPrefix(edit.old_string as string)
          const newContent = stripLineNumberPrefix(edit.new_string as string)
          const replaceAll = edit.replace_all === true
          if (typeof oldContent !== 'string' || typeof newContent !== 'string') {
            return `Error: edit #${i + 1} is missing old_string or new_string`
          }
          const stepResult = applyEdit(content, oldContent, newContent, replaceAll, `${args.path} (edit #${i + 1})`)
          if ('error' in stepResult) {
            return `Error: ${stepResult.error}. No edits applied (multi_edit is atomic).`
          }
          content = stepResult.content
          summary.push(`#${i + 1}${replaceAll ? ` ×${stepResult.replacements}` : ''}`)
        }

        const writeResult = await this.toolExecutor.writeFile(filePath, content, {
          source: 'ai',
          label: 'AI multi_edit',
          expectedHash: hashText(readResult.data || ''),
        })
        if (writeResult.success) {
          this.touchedFilePaths.add(filePath)
          this.invalidateCodeLookupAfterFileChange(basePath, [filePath])
        }
        return writeResult.success
          ? `File edited: ${args.path} (${rawEdits.length} edits applied: ${summary.join(', ')})`
          : `Error: ${writeResult.error}`
      }

      case 'list_directory': {
        const dirPath = this.resolvePath(basePath, args.path as string)
        const result = await this.toolExecutor.listTree(dirPath)
        if (!result.success) return `Error: ${result.error}`

        const formatTree = (node: TreeNode, depth = 0): string => {
          const indent = '  '.repeat(depth)
          const lines = [`${indent}[${node.type === 'folder' ? 'DIR' : 'FILE'}] ${node.name}`]
          if (node.children && (args.recursive || depth === 0)) {
            for (const child of node.children) {
              lines.push(formatTree(child, depth + 1))
            }
          }
          return lines.join('\n')
        }

        return result.data ? formatTree(result.data) : 'Empty directory'
      }

      case 'search_files': {
        const dirPath = args.path ? this.resolvePath(basePath, args.path as string) : basePath
        const result = await this.toolExecutor.searchFiles(args.pattern as string, dirPath)
        if (!result.success) return `Error: ${result.error}`
        const matches = (result.data?.matches || []).map(p => this.toWorkspaceRelative(basePath, p))
        const lines = matches.slice(0, 80)
        if (result.data?.truncated && matches.length > 0) {
          lines.push('... more matches truncated')
        }
        return matches.length > 0 ? lines.join('\n') : 'No matching files found'
      }

      case 'search_content': {
        const dirPath = args.path ? this.resolvePath(basePath, args.path as string) : basePath
        const filePattern = (args.file_pattern || args.glob) as string | undefined
        // Default to case-insensitive (grep -i ergonomics). Models can opt back
        // into case sensitivity when needed.
        const caseSensitive = args.case_sensitive === true
        const result = this.toolExecutor.searchContentPage
          ? await this.toolExecutor.searchContentPage(args.pattern as string, dirPath, filePattern, !caseSensitive, {
              offset: args.offset as number | undefined,
              limit: args.head_limit as number | undefined,
              contextBefore: args.context_before as number | undefined,
              contextAfter: args.context_after as number | undefined,
              multiline: args.multiline === true,
              fileType: args.file_type as string | undefined,
            })
          : await this.toolExecutor.searchContent(args.pattern as string, dirPath, filePattern, !caseSensitive)
        if (!result.success) return `Error: ${result.error}`
        const page = this.toolExecutor.searchContentPage
          ? result.data as { hits?: import('../tools/executor').SearchContentHit[]; truncated?: boolean; offset?: number; limit?: number; totalMatches?: number }
          : { hits: Array.isArray(result.data) ? result.data : [], truncated: false, offset: 0, limit: 50, totalMatches: Array.isArray(result.data) ? result.data.length : 0 }
        if (!page.hits?.length) return 'No matches found'
        const formatted = this.formatContentSearchResults(page.hits)
        return page.truncated
          ? `${formatted}\n\nMore matches available; continue with offset=${Number(page.offset || 0) + page.hits.length}.`
          : formatted
      }

      case 'search_symbols': {
        if (!basePath) return `Error: no workspace selected`
        const kind = args.symbol_kind as CodeSymbolKind | undefined
        const response = await this.toolExecutor.searchCodeSymbols({
          workspacePath: basePath,
          query: args.query as string,
          path: args.path as string | undefined,
          kinds: kind ? [kind] : undefined,
          limit: 20,
        })
        if (!response.success) return `Error: ${response.error || 'symbol search failed'}`
        return this.formatCodeSearchHits(response.data || [])
      }

      case 'get_codemap': {
        if (!basePath) return `Error: no workspace selected`
        const response = await this.toolExecutor.getCodeMap({
          workspacePath: basePath,
          query: args.query as string,
          targetPaths: typeof args.path === 'string' ? [args.path] : undefined,
          path: args.path as string | undefined,
          maxPaths: 8,
          maxChildrenPerPath: 5,
        })
        if (!response.success) return `Error: ${response.error || 'codemap search failed'}`
        const map = response.data?.map
        if (!map || (Array.isArray(map) && map.length === 0)) return 'No codemap found'
        const nodes = Array.isArray(map) ? map : [map]
        const related = response.data?.relatedPaths?.length ? `\n\nRelated paths:\n${response.data.relatedPaths.map((p: string) => `- ${p}`).join('\n')}` : ''
        return `${nodes.map(node => this.formatCodeMap(node)).join('\n')}${related}`
      }

      case 'web_search': {
        if (typeof this.toolExecutor.webSearch !== 'function') {
          return 'Error: web_search is not available in this runtime'
        }
        const query = String(args.query || '').trim()
        if (!query) return 'Error: query is required'
        const response = await this.toolExecutor.webSearch({
          query,
          limit: args.limit,
          region: args.region,
          freshness: args.freshness,
          domains: args.domains,
        })
        if (!response.success) return `Error: ${response.error || 'web search failed'}`
        const data = response.data
        if (!data?.results?.length) return `No web results found for "${query}"`
        return this.formatWebSearchResults(data.query, data.provider, data.results)
      }

      case 'explore_code': {
        if (!basePath) return `Error: no workspace selected`
        const objective = String(args.objective || '').trim()
        if (!objective) return `Error: objective is required`
        const thoroughness = args.thoroughness === 'quick'
          ? 'quick'
          : args.thoroughness === 'very_thorough'
            ? 'very_thorough'
            : 'medium'
        const context = typeof args.context === 'string' && args.context.trim()
          ? `\n\nParent context:\n${args.context.trim()}`
          : ''
        const maxTurns = thoroughness === 'quick' ? 5 : thoroughness === 'very_thorough' ? 12 : 8
        const maxParallel = thoroughness === 'quick' ? 4 : 6
        const scanObjective = `${objective}\n\nThoroughness: ${thoroughness}${context}`
        const background = this.startFastContextBackground(scanObjective, { maxTurns, maxParallel })
        if (background.status === 'unavailable') return 'Error: FastContext requires an open workspace.'
        if (background.status === 'busy') {
          return `FastContext background scan is already working on: ${background.objective}\nAgent ID: ${background.taskId || 'unavailable'}\nContinue now with targeted search/read tools; do not wait or call explore_code again.`
        }
        if (background.status === 'running') {
          return `FastContext background scan is already running for this objective. Agent ID: ${background.taskId || 'unavailable'}. Continue now with targeted search/read tools; evidence will be injected automatically when ready.`
        }
        return `FastContext background scan started. Agent ID: ${background.taskId}. Continue now with targeted search_content/search_symbols/get_codemap and read_file calls; do not wait. Ranked evidence will be injected automatically on a later model turn.`
      }

      case 'list_memories': {
        if (!basePath) return 'Error: no workspace selected'
        const limit = typeof args.limit === 'number' ? args.limit : undefined
        const response = await this.toolExecutor.memoryQuery({
          workspacePath: basePath,
          query: typeof args.query === 'string' ? args.query : undefined,
          kind: typeof args.kind === 'string'
            ? (args.kind as MemoryKind)
            : undefined,
          scope: typeof args.scope === 'string'
            ? (args.scope as MemoryScope)
            : undefined,
          limit,
        })
        if (!response.success) return `Error: ${response.error || 'memory query failed'}`
        const items = response.data?.items || []
        if (items.length === 0) return 'No memories matched the filter.'
        const lines = items.map((item: { kind: string; confidence: string | number; text: string; source: string; tags?: string[] }) => {
          const tagBits = item.tags?.length ? ` [${item.tags.slice(0, 3).join(', ')}]` : ''
          return `- (${item.kind}, ${item.confidence}) ${item.text}\n  source: ${item.source}${tagBits}`
        })
        return `Found ${items.length} memor${items.length === 1 ? 'y' : 'ies'}:\n${lines.join('\n')}`
      }

      case 'remember': {
        if (!basePath) return 'Error: no workspace selected'
        const text = args.text as string
        if (!text || typeof text !== 'string') return 'Error: text parameter is required'
        // Handle tags: accept array or comma-separated string
        let tags: string[] | undefined
        if (Array.isArray(args.tags)) {
          tags = args.tags.filter((t: unknown) => typeof t === 'string')
        } else if (typeof args.tags === 'string') {
          tags = args.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
        }
        const result = await this.toolExecutor.memoryRemember({
          workspacePath: basePath,
          text,
          kind: typeof args.kind === 'string' ? args.kind : undefined,
          tags,
          confidence: typeof args.confidence === 'string' ? args.confidence : undefined,
          conversationId: this.config.conversationId || this.stateProvider.getConversationId() || undefined,
        })
        if (!result.success) return `Error: ${result.error || 'remember failed'}`
        if (result.data?.deduplicated) return `Memory updated (deduplicated with existing entry): ${result.data.id}`
        return `Memory stored: ${result.data?.id}`
      }

      case 'forget': {
        if (!basePath) return 'Error: no workspace selected'
        const id = args.id as string
        if (!id || typeof id !== 'string') return 'Error: id parameter is required'
        const reason = typeof args.reason === 'string' ? args.reason : undefined
        const result = await this.toolExecutor.memoryForget({
          workspacePath: basePath,
          id,
          reason,
        })
        if (!result.success) return `Error: ${result.error || 'forget failed'}`
        return `Memory forgotten: ${id}`
      }

      case 'run_command': {
        const cwd = args.cwd ? this.resolvePath(basePath, args.cwd as string) : basePath
        const env = args.env as Record<string, string> | undefined
        const timeout = args.timeout as number | undefined
        const approved = args.approved === true
        const runInBackground = args.run_in_background === true

        if (runInBackground) {
          const command = args.command as string
          const validation = await this.toolExecutor.validateCommand?.(command, cwd)
          if (validation && !validation.success) {
            return `Error: ${validation.error || 'command failed sandbox validation'}`
          }

          const ptyResult = await this.toolExecutor.ptyCreate?.({ cwd, env })
          const sessionId = ptyResult?.data?.sessionId
          if (!sessionId) {
            return `Error: failed to spawn agent terminal${ptyResult?.error ? ` — ${ptyResult.error}` : ''}`
          }
          const terminalLogPath = ptyResult.data?.session?.logPath
          const writeResult = await this.toolExecutor.ptyWrite?.(sessionId, `${command}\n`)
          if (!writeResult?.success) {
            await this.toolExecutor.ptyKill?.(sessionId)
            await this.emitTerminalSessions()
            return `Error: failed to start background command — ${writeResult?.error || 'unknown error'}`
          }
          this.agentBackgroundSessions.set(sessionId, { command, startedAt: Date.now() })
          await this.emitTerminalSessions()
          return `Background command started in agent terminal ${sessionId}\nCommand: ${command}${terminalLogPath ? `\nLog: ${terminalLogPath}` : ''}\nUse read_terminal(session_id="${sessionId}") to view output, write_terminal to send stdin, or kill_terminal to stop.`
        }

        // Foreground: exec-based path for one-shot commands
        const foregroundCommand = args.command as string
        try {
          const result = await this.toolExecutor.runCommand(foregroundCommand, cwd, env, timeout, approved)
          const commandOutput = result.data
          const outputSections: string[] = []
          if (commandOutput?.stdout) outputSections.push(`stdout:\n${commandOutput.stdout}`)
          if (commandOutput?.stderr) outputSections.push(`stderr:\n${commandOutput.stderr}`)
          if (commandOutput?.truncated) outputSections.push('[command output truncated]')
          if (commandOutput?.logPath) outputSections.push(`log: ${commandOutput.logPath}`)
          const formattedOutput = outputSections.join('\n\n') || 'No output'
          const statusDetails = [
            `code ${commandOutput?.exitCode ?? 'unknown'}`,
            commandOutput?.timedOut ? 'timed out' : '',
          ].filter(Boolean).join(', ')
          if (!result.success) {
            return `Error (${statusDetails})${result.error ? `: ${result.error}` : ''}\n${formattedOutput}`
          }
          return `Command executed successfully (${statusDetails}):\n${formattedOutput}`
        } catch (e) {
          return `Error executing command: ${e instanceof Error ? e.message : String(e)}`
        }
      }

      case 'read_terminal': {
        const sessionId = args.session_id as string
        if (!sessionId) return `Error: session_id is required`
        const tail = typeof args.tail_lines === 'number' ? args.tail_lines : 200
        const sinceSeq = typeof args.since_seq === 'number' ? args.since_seq : 0
        const result = await this.toolExecutor.ptyGetBuffer?.(sessionId)
        if (!result?.success) return `Error: ${result?.error || 'failed to read terminal buffer'}`
        await this.emitTerminalSessions()
        const session = result.session as { status: string; exitCode?: number; cwd: string; logPath?: string } | undefined
        const allChunks = (result.chunks || []) as Array<{ seq: number; data: string }>
        // Filter by since_seq so polling loops only see new output. Each
        // chunk carries a monotonic seq from terminalManager.
        const chunks = sinceSeq > 0 ? allChunks.filter((c: { seq: number }) => c.seq > sinceSeq) : allChunks
        const combined = chunks.map((c: { data: string }) => c.data).join('')
        // Strip ANSI escapes for model readability — terminal UI keeps them.
        // eslint-disable-next-line no-control-regex
        const stripped = combined.replace(/\u001B(?:[@-Z\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, '')
        const lines = stripped.split('\n')
        const tailed = tail > 0 ? lines.slice(-tail) : lines
        const truncatedNotice = tail > 0 && lines.length > tail
          ? `[showing last ${tailed.length} of ${lines.length} lines]\n`
          : ''
        const lastSeq = allChunks.length > 0 ? allChunks[allChunks.length - 1].seq : 0
        const sinceNotice = sinceSeq > 0
          ? ` • since_seq=${sinceSeq} • new_chunks=${chunks.length}`
          : ''
        const statusLine = session
          ? `[session ${sessionId} • status=${session.status}${typeof session.exitCode === 'number' ? ` • exit=${session.exitCode}` : ''} • cwd=${session.cwd}${session.logPath ? ` • log=${session.logPath}` : ''} • last_seq=${lastSeq}${sinceNotice}]`
          : `[session ${sessionId} • last_seq=${lastSeq}${sinceNotice}]`
        const body = chunks.length === 0 && sinceSeq > 0
          ? '[no new output since last read]'
          : `${truncatedNotice}${tailed.join('\n')}`
        return `${statusLine}\n${body}`
      }

      case 'write_terminal': {
        const sessionId = args.session_id as string
        const data = args.data as string
        if (!sessionId) return `Error: session_id is required`
        if (typeof data !== 'string' || data.length === 0) return `Error: data is required`
        const result = await this.toolExecutor.ptyWrite?.(sessionId, data)
        if (!result?.success) return `Error: ${result?.error || 'failed to write terminal stdin'}`
        await this.emitTerminalSessions()
        return `Wrote ${Buffer.byteLength(data)} byte(s) to terminal ${sessionId}.`
      }

      case 'kill_terminal': {
        const sessionId = args.session_id as string
        if (!sessionId) return `Error: session_id is required`
        // Try interrupting the current command first (Ctrl+C semantics);
        // fall back to killing the session entirely if the model passes
        // hard=true (or interrupt fails).
        const hard = args.hard === true
        if (!hard) {
          const interrupt = await this.toolExecutor.ptyInterruptCommand?.(sessionId)
          if (interrupt && interrupt.success) {
            await new Promise(resolve => setTimeout(resolve, 750))
            const session = await this.getTerminalSession(sessionId)
            if (!session || session.status !== 'running') {
              this.agentBackgroundSessions.delete(sessionId)
              await this.emitTerminalSessions()
              return `Terminal ${sessionId} interrupted and exited.`
            }
            // A plain stdin Ctrl+C is not reliable without a real PTY, so
            // fall through to process-tree termination when the shell is
            // still alive after the graceful attempt.
            await this.emitTerminalSessions()
          }
        }
        const killed = await this.toolExecutor.ptyKill?.(sessionId)
        if (killed && killed.success) {
          this.agentBackgroundSessions.delete(sessionId)
          await this.emitTerminalSessions()
          return `Terminal ${sessionId} terminated.`
        }
        return `Error: failed to kill terminal ${sessionId} — ${killed?.error || 'unknown error'}`
      }

      case 'list_terminals': {
        const result = await this.toolExecutor.ptyList?.()
        if (!result?.success) return `Error: ${result?.error || 'failed to list terminals'}`
        const rawSessions = (result.sessions || []) as Array<{ isAgentSession?: boolean; id: string; status: string; exitCode?: number; cwd: string; logPath?: string }>
        const sessions = rawSessions.filter(s => s.isAgentSession || this.agentBackgroundSessions.has(s.id))
        await this.emitTerminalSessions()
        if (sessions.length === 0) return 'No agent terminal sessions active.'
        const lines = sessions.map((s: { id: string; status: string; exitCode?: number; cwd: string; logPath?: string }) => {
          const meta = this.agentBackgroundSessions.get(s.id)
          const cmd = meta ? ` • last: ${meta.command}` : ''
          const exit = typeof s.exitCode === 'number' ? ` • exit=${s.exitCode}` : ''
          const log = s.logPath ? ` • log=${s.logPath}` : ''
          return `- ${s.id} • ${s.status}${exit} • cwd=${s.cwd}${log}${cmd}`
        })
        return `${sessions.length} agent terminal session(s):\n${lines.join('\n')}`
      }

      case 'delete_file': {
        const filePath = this.resolvePath(basePath, args.path as string)
        const existing = await this.toolExecutor.readFile(filePath)
        if (!existing.success) return `Error: unable to read file before deletion - ${existing.error}`
        await this.capturePreimage(filePath)
        const result = await this.toolExecutor.deleteFile(filePath, {
          source: 'ai',
          label: 'AI delete_file',
          expectedHash: hashText(existing.data || ''),
        })
        if (result.success) {
          this.touchedFilePaths.add(filePath)
          this.invalidateCodeLookupAfterFileChange(basePath, [filePath])
        }
        return result.success ? `File deleted: ${args.path}` : `Error: ${result.error}`
      }

      case 'create_task': {
        const creationStartedAt = Date.now()
        this.emitTaskSystem({
          status: 'creating',
          toolName: 'create_task',
          expectedCount: 1,
          createdCount: 0,
          title: args.title as string | undefined,
          startedAt: creationStartedAt,
          updatedAt: creationStartedAt,
        })
        const task = this.taskManager.createTask({
          title: args.title as string,
          description: args.description as string,
          priority: args.priority as TaskPriority,
          parentId: args.parent_id as string | undefined,
          order: args.order as number | undefined,
          metadata: args.metadata as TaskNode['metadata'] | undefined,
        })
        const deps = args.dependencies as string[] | undefined
        if (deps && deps.length > 0) {
          const failed: string[] = []
          for (const depId of deps) {
            if (!this.taskManager.addDependency(task.id, depId)) {
              failed.push(depId)
            }
          }
          if (failed.length > 0) {
            return JSON.stringify({ id: task.id, title: task.title, status: task.status, priority: task.priority, dependencies: task.dependencies, warning: `Some dependencies could not be added (tasks not found or would create cycle): ${failed.join(', ')}` })
          }
        }
        this.emitTaskSystem({
          status: 'completed',
          toolName: 'create_task',
          expectedCount: 1,
          createdCount: 1,
          title: task.title,
          startedAt: creationStartedAt,
          updatedAt: Date.now(),
        })
        this.emit({ type: 'active:task', context: this.taskManager.getActiveTaskContext() })
        return JSON.stringify({ id: task.id, title: task.title, status: task.status, priority: task.priority, dependencies: task.dependencies })
      }

      case 'create_tasks': {
        const items = args.tasks as Array<Record<string, unknown>> | undefined
        if (!Array.isArray(items) || items.length === 0) {
          return `Error: 'tasks' must be a non-empty array`
        }
        const creationStartedAt = Date.now()
        this.emitTaskSystem({
          status: 'planning',
          toolName: 'create_tasks',
          expectedCount: items.length,
          createdCount: 0,
          title: items.length === 1 ? String(items[0]?.title || 'Task') : `${items.length} tasks`,
          startedAt: creationStartedAt,
          updatedAt: creationStartedAt,
        })
        // Local refs let one call describe a whole tree without needing
        // ids that won't exist until the create runs.
        const refToId = new Map<string, string>()
        const resolveRef = (value: unknown): string | undefined => {
          if (typeof value !== 'string' || !value) return undefined
          return refToId.get(value) ?? value
        }
        const created: Array<{ id: string; ref?: string; title: string; status: TaskStatus; priority: TaskPriority }> = []
        const warnings: string[] = []

        for (let i = 0; i < items.length; i++) {
          const raw = items[i] || {}
          const title = raw.title as string | undefined
          const description = raw.description as string | undefined
          const priority = raw.priority as TaskPriority | undefined
          if (!title || !description || !priority) {
            warnings.push(`tasks[${i}]: missing required field (title/description/priority)`)
            continue
          }
          let task
          try {
            task = this.taskManager.createTask({
              title,
              description,
              priority,
              parentId: resolveRef(raw.parent_id),
              order: raw.order as number | undefined,
              metadata: raw.metadata as TaskNode['metadata'] | undefined,
            })
          } catch (e) {
            warnings.push(`tasks[${i}] (${title}): ${(e as Error).message}`)
            continue
          }
          const localRef = typeof raw.ref === 'string' ? raw.ref : undefined
          if (localRef) refToId.set(localRef, task.id)

          const deps = raw.dependencies as unknown[] | undefined
          if (Array.isArray(deps) && deps.length > 0) {
            for (const depRef of deps) {
              const depId = resolveRef(depRef)
              if (!depId || !this.taskManager.addDependency(task.id, depId)) {
                warnings.push(`tasks[${i}] (${title}): dependency '${String(depRef)}' not added`)
              }
            }
          }
          created.push({ id: task.id, ref: localRef, title: task.title, status: task.status, priority: task.priority })
          this.emitTaskSystem({
            status: 'creating',
            toolName: 'create_tasks',
            expectedCount: items.length,
            createdCount: created.length,
            title: task.title,
            startedAt: creationStartedAt,
            updatedAt: Date.now(),
          })
        }

        this.emitTaskSystem({
          status: warnings.length > 0 && created.length === 0 ? 'error' : 'completed',
          toolName: 'create_tasks',
          expectedCount: items.length,
          createdCount: created.length,
          title: created.at(-1)?.title || `${items.length} tasks`,
          startedAt: creationStartedAt,
          updatedAt: Date.now(),
          error: warnings.length > 0 ? warnings.slice(0, 2).join('; ') : undefined,
        })
        this.emit({ type: 'active:task', context: this.taskManager.getActiveTaskContext() })
        return JSON.stringify(warnings.length > 0 ? { created, warnings } : { created })
      }

      case 'update_task': {
        const taskId = args.task_id as string
        // Pre-check: marking a parent task as completed silently no-ops in
        // taskManager when not all children are completed yet. Surface that
        // as an explicit tool error so the LLM knows to finish subtasks
        // first instead of looping confused (Bug #9).
        if (args.status === 'in_progress') {
          const existing = this.taskManager.getTask(taskId)
          if (existing && !this.taskManager.areDependenciesMet(taskId)) {
            const blocked = existing.dependencies.filter(depId => {
              const dep = this.taskManager.getTask(depId)
              return dep && dep.status !== 'completed'
            })
            if (blocked.length > 0) {
              return `Error: cannot start task ${taskId} — dependencies not met: ${blocked.join(', ')}`
            }
          }
        }
        if (args.status === 'completed') {
          const existing = this.taskManager.getTask(taskId)
          if (existing && existing.children.length > 0) {
            const childTasks = this.taskManager.getChildTasks(taskId)
            const pending = childTasks.filter(c => c.status !== 'completed')
            if (pending.length > 0) {
              const titles = pending.slice(0, 4).map(c => `${c.id} (${c.status})`).join(', ')
              return `Error: cannot mark parent task ${taskId} as completed while ${pending.length} child task(s) remain unfinished: ${titles}${pending.length > 4 ? ', ...' : ''}. Complete or fail the children first.`
            }
          }
        }
        const task = this.taskManager.updateTask(taskId, {
          status: args.status as TaskStatus,
          progress: args.progress as number | undefined,
          error: args.error as string | undefined,
        })
        if (!task) return `Error: task ${taskId} not found`
        // Force-emit task tree snapshot so the UI panel updates immediately
        this.emit({ type: 'active:task', context: this.taskManager.getActiveTaskContext() })
        return JSON.stringify({ id: task.id, title: task.title, status: task.status, progress: task.progress })
      }

      case 'add_task_dependency': {
        const ok = this.taskManager.addDependency(
          args.task_id as string,
          args.dependency_id as string,
        )
        if (!ok) return `Error: failed to add dependency. Check that both tasks exist, the dependency is not a self-reference, and no cycle would be created.`
        this.emit({ type: 'active:task', context: this.taskManager.getActiveTaskContext() })
        return `Dependency added: ${args.task_id} now depends on ${args.dependency_id}`
      }

      case 'remove_task_dependency': {
        const ok = this.taskManager.removeDependency(
          args.task_id as string,
          args.dependency_id as string,
        )
        if (!ok) return `Error: failed to remove dependency`
        this.emit({ type: 'active:task', context: this.taskManager.getActiveTaskContext() })
        return `Dependency removed: ${args.task_id} no longer depends on ${args.dependency_id}`
      }

      case 'list_tasks': {
        const tasks = args.parent_id
          ? this.taskManager.getChildTasks(args.parent_id as string)
          : args.status
            ? this.taskManager.getTasksByStatus(args.status as TaskStatus)
            : this.taskManager.getRootTasks()
        return JSON.stringify(tasks.map(t => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          progress: t.progress,
          children: t.children.length,
        })))
      }

      case 'ask_user': {
        this.emit({
          type: 'ask:user',
          question: args.question as string,
          options: args.options as string[] | undefined,
          reason: args.reason as string | undefined,
          command: args.command as string | undefined,
        })
        return `[Awaiting user response] ${args.question}`
      }

      case 'notify_user': {
        this.emit({ type: 'notification', message: args.message as string, level: (args.type as 'info' | 'success' | 'warning' | 'error') || 'info' })
        return `Notification sent`
      }

      case 'create_checkpoint': {
        if (!basePath) {
          return `Error: no workspace selected`
        }
        const checkpointMessage = args.message as string
        const filePaths = Array.from(this.touchedFilePaths)
        if (filePaths.length === 0) {
          return `No AI-touched files to checkpoint`
        }

        if (this.gitEnabled) {
          const gitResult = await gitCommitCheckpoint(basePath, checkpointMessage, filePaths, this.toolExecutor)
          if (!gitResult.ok) return `Error: git checkpoint failed — ${gitResult.error}`
          if (gitResult.nothingToCommit) return `Checkpoint skipped — nothing to commit`
          this.pendingCheckpoint = { hash: gitResult.hash || 'HEAD', message: checkpointMessage }
          this.touchedFilePaths.clear()
          this.filePreimages.clear()
          await this.refreshGitStatus()
          return `Git checkpoint: ${gitResult.hash} — ${checkpointMessage}`
        }

        const preimages = this.filePreimages.size > 0 ? Object.fromEntries(this.filePreimages) : undefined
        const result = await this.toolExecutor.checkpointCreate?.(basePath, checkpointMessage, filePaths, 'explicit', preimages)
        if (!result?.success) {
          return `Error: failed to create checkpoint - ${result?.error}`
        }
        const cpResult = result as { checkpointId?: string; label?: string; shortId?: string }
        if (!cpResult.checkpointId) return `No changes to checkpoint`
        this.pendingCheckpoint = { hash: cpResult.checkpointId, message: cpResult.label || checkpointMessage }
        this.touchedFilePaths.clear()
        this.filePreimages.clear()
        return `Checkpoint created: ${cpResult.shortId} - ${checkpointMessage}`
      }

      case 'list_checkpoints': {
        if (!basePath) return 'Error: no workspace selected'
        const result = await this.toolExecutor.checkpointList?.(basePath, args.limit as number | undefined)
        if (!result?.success) return `Error: ${result?.error || 'unable to list checkpoints'}`
        const checkpoints = result.data || []
        if (checkpoints.length === 0) return 'No local history checkpoints.'
        return checkpoints.map((checkpoint: any) =>
          `- ${checkpoint.id} • ${checkpoint.label} • ${checkpoint.fileCount} file(s) • ${new Date(checkpoint.timestamp).toISOString()}`
        ).join('\n')
      }

      case 'restore_checkpoint': {
        if (!basePath) return 'Error: no workspace selected'
        const result = await this.toolExecutor.checkpointRestore?.(basePath, args.checkpoint_id as string)
        if (!result?.success) return `Error: ${result?.error || 'checkpoint restore failed'}`
        this.codemapSummary = null
        this.codemapCacheKey = null
        const restored = result.data?.restoredFiles || []
        const safety = result.data?.safetyCheckpointId ? `\nSafety checkpoint: ${result.data.safetyCheckpointId}` : ''
        return `Restored ${restored.length} file(s) from checkpoint.${safety}`
      }

      case 'prune_checkpoints': {
        if (!basePath) return 'Error: no workspace selected'
        const keepCount = typeof args.keep_count === 'number' ? args.keep_count : 50
        const result = await this.toolExecutor.checkpointPrune?.(basePath, keepCount)
        return result?.success ? `Kept the newest ${keepCount} checkpoint(s).` : `Error: ${result?.error || 'checkpoint prune failed'}`
      }

      case 'generate_change_summary': {
        const filesChanged = args.files_changed as string[]
        const summary = args.summary as string
        const reason = args.reason as string | undefined
        const risks = args.risks as string | undefined

        let output = `## Change Summary\n\n${summary}\n\n`
        output += `**Files changed:** ${filesChanged.join(', ')}\n`
        if (reason) output += `**Reason:** ${reason}\n`
        if (risks) output += `**Risks:** ${risks}\n`

        return output
      }

      case 'list_agents': {
        const tasks = this.subAgentTaskManager.listTasks()
        if (tasks.length === 0) return 'No subagent tasks found.'
        return tasks.map(task => {
          const elapsedMs = (task.runtimeTask.endedAt || Date.now()) - task.startedAt
          return `[${task.runtimeTask.status}] ${task.id} · ${task.agentType} · ${elapsedMs}ms\n  ${task.objective}`
        }).join('\n')
      }

      case 'read_agent': {
        const agentId = String(args.agent_id || '').trim()
        if (!agentId) return 'Error: agent_id is required'
        const task = this.subAgentTaskManager.getTask(agentId)
        if (!task) return `Error: unknown agent_id "${agentId}".`
        const transcript = this.subAgentTaskManager.readTranscript(agentId, {
          offset: typeof args.offset === 'number' ? args.offset : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        })
        const lines = [this.formatSubAgentTask(task)]
        if (transcript.records.length > 0) {
          lines.push('', `Transcript records ${transcript.offset}-${transcript.nextOffset - 1} of ${transcript.total}:`)
          transcript.records.forEach((record, index) => {
            let detail: string
            if (record.type === 'start') detail = `${record.task.agentType} started`
            else if (record.type === 'event') {
              try { detail = JSON.stringify(record.event).slice(0, 1200) } catch { detail = '[unserializable event]' }
            } else if (record.type === 'result') detail = `result ${record.status}${record.error ? `: ${record.error}` : ''}`
            else detail = `${record.status}${record.error ? `: ${record.error}` : ''}`
            lines.push(`${transcript.offset + index}: ${record.type} · ${detail}`)
          })
          if (transcript.nextOffset < transcript.total) lines.push(`Next offset: ${transcript.nextOffset}`)
        }
        return lines.join('\n')
      }

      case 'cancel_agent': {
        const agentId = String(args.agent_id || '').trim()
        if (!agentId) return 'Error: agent_id is required'
        try {
          const task = await this.subAgentTaskManager.stopTask(agentId)
          return `Subagent ${agentId} is ${task.status}.`
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`
        }
      }

      case 'spawn_agent': {
        const agentType = String(args.agent_type || '').trim()
        const objective = String(args.objective || '').trim()
        const extraContext = typeof args.context === 'string' ? args.context.trim() : ''
        if (!agentType) return 'Error: agent_type is required'
        if (!objective) return 'Error: objective is required'
        const def = getSubAgentDefinition(agentType)
        if (!def) return `Error: unknown agent_type "${agentType}". Available: ${getAvailableAgentTypes().join(', ')}.`
        if (def.id === 'fast_context') {
          if (!this.config.workspacePath) return 'Error: no workspace path set'
          const objective = (args.objective as string | undefined) || 'Locate relevant files for the current task'
          const background = this.startFastContextBackground(objective)
          if (background.status === 'unavailable') return 'Error: FastContext requires an open workspace.'
          if (background.status === 'busy') {
            return `FastContext is already running on: ${background.objective}. Agent ID: ${background.taskId || 'unavailable'}. Continue with normal targeted read/search tools.`
          }
          if (background.status === 'running') {
            return `FastContext is already running for this objective. Agent ID: ${background.taskId || 'unavailable'}. Continue with normal targeted read/search tools.`
          }
          return `FastContext subagent started in the background. Agent ID: ${background.taskId}. Continue with normal targeted read/search tools; use read_agent for persisted progress/results.`
        }
        if (!this.config.workspacePath) {
          return 'Error: no workspace open; cannot spawn subagent.'
        }
        const startedAt = Date.now()
        const enrichedObjective = extraContext ? `${objective}\n\nAdditional context from parent agent:\n${extraContext}` : objective
        const started = this.subAgentTaskManager.startTask<Awaited<ReturnType<typeof runSubAgent>>>({
          kind: 'agent',
          agentType: def.id,
          label: def.label,
          objective,
          workspacePath: this.config.workspacePath,
          ownerSessionId: this.config.conversationId,
          run: async ({ signal, recordEvent }) => {
            const onSubEvent = (event: SubAgentEvent) => {
              recordEvent(event)
              this.emitSubAgentProgress(def.id, def.label, event)
            }
            const skeleton = await this.maybeBuildWorkspaceSkeleton(this.config.workspacePath!)
            const activeConfig = this.stateProvider.getActiveConfig()
            const activeModel = this.stateProvider.getActiveModel()
            return runSubAgent({
              definition: def,
              objective: enrichedObjective,
              workspacePath: this.config.workspacePath!,
              toolExecutor: this.toolExecutor,
              apiKey: activeConfig?.apiKey || '',
              baseUrl: activeConfig?.baseUrl || 'https://api.deepseek.com',
              provider: activeConfig?.provider,
              customHeaders: activeConfig?.customHeaders,
              model: activeModel?.id || activeConfig?.defaultModel,
              codemap: skeleton,
              abortSignal: signal,
              onEvent: onSubEvent,
            })
          },
          isSuccess: result => result.ok,
          getError: result => result.error || 'Subagent failed',
        })
        this.emit({
          type: 'subagent:start',
          agentId: started.task.id,
          agentType: def.id,
          label: def.label,
          objective,
          runKind: 'spawn_agent',
        })
        void started.promise.then(
          result => this.emit({
            type: 'subagent:end',
            agentId: started.task.id,
            agentType: def.id,
            ok: result.ok,
            elapsedMs: Date.now() - startedAt,
            runKind: 'spawn_agent',
          }),
          () => this.emit({
            type: 'subagent:end',
            agentId: started.task.id,
            agentType: def.id,
            ok: false,
            elapsedMs: Date.now() - startedAt,
            runKind: 'spawn_agent',
          }),
        )
        return `Subagent ${def.label} started in the background. Agent ID: ${started.task.id}. Use read_agent to inspect progress/results, list_agents to list tasks, or cancel_agent to stop it.`
      }

      case 'use_skill': {
        const skillId = args.skill_id as string
        const reason = args.reason as string | undefined
        return reason ? `Skill noted: ${skillId} (${reason})` : `Skill noted: ${skillId}`
      }

      default:
        if (this.mcpClient && isMcpTool(name)) {
          const result = await executeMcpTool(this.mcpClient, name, args)
          if (result.isError) throw new Error(result.output)
          return result.output
        }
        return `Unknown tool: ${name}`
    }
  }

  private formatContentSearchResults(results: Array<{ file: string; line: number; text: string; startLine?: number; endLine?: number; snippet?: string; content?: string }>): string {
    const MAX_HITS = 40
    const hits = results.slice(0, MAX_HITS)
    const basePath = this.stateProvider.getWorkspace()?.path || ''
    const lines = hits.flatMap(r => {
      const startLine = r.startLine ?? r.line
      const endLine = r.endLine ?? r.line
      const body = r.snippet || r.content || r.text || ''
      return [
        `@@ ${this.toWorkspaceRelative(basePath, r.file)}:${startLine}-${endLine} (match ${r.line})`,
        body,
      ]
    })
    if (results.length > MAX_HITS) {
      lines.push(`... ${results.length - MAX_HITS} more matches truncated`)
    }
    return lines.join('\n')
  }

  private formatCodeSearchHits(hits: CodeSearchHit[]): string {
    if (hits.length === 0) return 'No matches found'
    return hits.flatMap(hit => [
      `@@ ${hit.path}:${hit.startLine}-${hit.endLine} (match ${hit.line})`,
      hit.preview || `${hit.title} · ${hit.subtitle}`,
    ]).join('\n')
  }

  private formatCodeMap(node: CodeMapNode, depth = 0): string {
    return formatCodeMap(node, depth)
  }

  private formatWebSearchResults(query: string, provider: string, results: WebSearchResult[]): string {
    const attr = (value: string): string => String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240)
    const clean = (value: string | undefined): string => String(value || '').replace(/\s+/g, ' ').trim()

    const lines = [
      `<web_search_results query="${attr(query)}" provider="${attr(provider)}" count="${results.length}">`,
    ]
    results.forEach((result, index) => {
      const title = clean(result.title) || '(untitled)'
      const snippet = clean(result.snippet)
      lines.push(`${index + 1}. ${title}`)
      lines.push(`   url: ${result.url}`)
      if (snippet) lines.push(`   snippet: ${snippet}`)
      if (result.source) lines.push(`   source: ${clean(result.source)}`)
      if (result.publishedDate) lines.push(`   published: ${clean(result.publishedDate)}`)
    })
    lines.push('</web_search_results>')
    return lines.join('\n')
  }

  private resolvePath(basePath: string, relativePath: string): string {
    return resolvePath(basePath, relativePath)
  }

  /**
   * 将绝对路径转为 workspace 相对路径。
   * 返回给 AI 的路径统一用相对路径，避免 AI 在绝对/相对路径之间混淆。
   */
  private toWorkspaceRelative(basePath: string, filePath: string): string {
    return toWorkspaceRelative(basePath, filePath)
  }

  private createUserTurn(content: string, attachments?: NonNullable<AgentTurn['metadata']>['attachments']): AgentTurn {
    return {
      id: generateTurnId(),
      role: 'user',
      content,
      timestamp: Date.now(),
      metadata: attachments?.length
        ? { attachments: attachments.map(attachment => ({ ...attachment })) }
        : undefined,
    }
  }

  private createFastContextPreludeTurn(userMessage: string): AgentTurn | null {
    if (!this.fastContextObjective) return null
    const objective = this.fastContextObjective || userMessage
    const hasChinese = /[\u4e00-\u9fa5]/.test(objective)
    const text = hasChinese
      ? '我先快速检索相关实现代码。'
      : "I'll search for the relevant implementation context first."
    return this.createAssistantTurn(text, undefined, { mode: this.config.mode })
  }

  private createAssistantTurn(
    content: string,
    toolCalls?: ToolCall[],
    metadata?: AgentTurn['metadata']
  ): AgentTurn {
    let finalMetadata: AgentTurn['metadata'] = { ...metadata }
    // Snapshot the chat message id of THIS finishing assistant turn into
    // lastAssistantMessageId so executeToolCalls can attach any checkpoint
    // produced by the tools to this same message (Bug #12). pendingCheckpoint
    // is intentionally NOT consumed here — it has already been bound to the
    // previous assistant turn by the previous executeToolCalls call.
    // Bug 6 fix: only consume pendingAssistantMessageId when it was actually
    // attached. On error/abort short-circuit paths callModel returns through
    // createAssistantTurn without a stream:start having fired, so
    // pendingAssistantMessageId is null. Overwriting unconditionally would
    // clear the previous successful assistant message id and orphan any
    // pending checkpoint about to be bound by executeToolCalls.
    let turnId = generateTurnId()
    if (this.pendingAssistantMessageId) {
      turnId = this.pendingAssistantMessageId
      this.lastAssistantMessageId = this.pendingAssistantMessageId
      this.pendingAssistantMessageId = null
    }

    let finalContent = content
    const thinkingContent = finalMetadata.thinking?.content
    if (!finalContent.trim() && thinkingContent && this.looksLikeVisibleAssistantReport(thinkingContent)) {
      finalContent = thinkingContent
      finalMetadata = {
        ...finalMetadata,
        thinking: undefined,
        rawReasoningPayload: undefined,
      }
    }

    return {
      id: turnId,
      role: 'assistant',
      content: finalContent,
      timestamp: Date.now(),
      toolCalls,
      metadata: finalMetadata,
    }
  }

  private finishInterruptedStream(textContent: string, model: APIModel | null, startTime: number): AgentTurn | null {
    const visibleText = stripTextToolCallMarkup(textContent, { stripIncomplete: true })
    this.emit({ type: 'stream:end', interrupted: true })
    if (!visibleText) return null
    return this.createAssistantTurn(visibleText, undefined, {
      model: model?.name,
      duration: Date.now() - startTime,
      mode: this.config.mode,
      interrupted: true,
    })
  }

  private createToolResultTurn(results: ToolResult[]): AgentTurn {
    return {
      id: generateTurnId(),
      role: 'tool_result',
      content: results.map(r => `${r.name}: ${r.isError ? '[failed]' : '[ok]'} ${(r.output || '').slice(0, 500)}`).join('\n\n'),
      timestamp: Date.now(),
      toolResults: results,
    }
  }

  private createMockTurn(): AgentTurn {
    return this.createAssistantTurn(
      `**Mock Response** (No API key configured)\n\nPlease configure your API key in the bottom-left corner to enable AI features.`,
      undefined,
      { mode: this.config.mode }
    )
  }

  private emit(event: AgentEventType): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}
