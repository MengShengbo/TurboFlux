import { isAbsolute, join, relative } from 'path'
import type { CodeMapNode, CodeSearchHit } from '../shared/codeIndexTypes'
import type { SubAgentEvent, SubAgentEvidence, SubAgentDefinition } from '../shared/subAgentTypes'
import type { NativeReasoningConfig } from '../shared/agentTypes'
import type { ToolExecutor } from '../tools/executor'
import type { ModelCapabilities } from './config'
import { getFastContextTuning, type FastContextLevel } from './fastContextTypes'
import { createTurboFluxRequestHeaders } from './clientIdentity'
import { resolveNativeReasoningRequest } from './modelRegistry'
import {
  downgradeReasoningEffort,
  extractUnsupportedRequestParam,
  isReasoningEffortValueError,
  removeAnthropicCompatibleRequestParam,
  removeOpenAICompatibleRequestParam,
} from './requestCompatibility'
import { loadAgentsFromDir, type LoadedAgent } from './agents/loader'
import type { SkillRuntime } from './skills/runtime'
import type { LoadedSkill } from './skills/loader'
import {
  ModelProtocolRequestError,
  buildModelProtocolUrl,
  formatProtocolAttempt,
  formatProtocolFailure,
  planModelProtocols,
  shouldFallbackProtocol,
  toProtocolAttempt,
  toResponsesInput,
  toResponsesTools,
  type ModelProtocol,
  type ModelProtocolAttempt,
} from './modelProtocol'

export { type SubAgentDefinition }

// ── 动态代理注册表 ────────────────────────────────────────────────

const dynamicAgents = new Map<string, LoadedAgent>()

/**
 * 从 .turboflux/agents/ 加载动态代理定义，合并到注册表
 */
export function loadDynamicAgents(workspacePath: string): void {
  const loaded = loadAgentsFromDir(workspacePath)
  for (const agent of loaded) {
    dynamicAgents.set(agent.id, agent)
  }
}

function resolveWorkspacePath(workspacePath: string, pathValue: unknown): string {
  const path = String(pathValue || '')
  if (!path) return workspacePath
  return isAbsolute(path) ? path : join(workspacePath, path)
}

function toWorkspaceRelative(workspacePath: string, filePath: string): string {
  const rel = isAbsolute(filePath) ? relative(workspacePath, filePath) : filePath
  return rel.replace(/\\/g, '/').replace(/^[./]+/, '')
}

function normalizeCodeSearchHits(value: unknown): CodeSearchHit[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is CodeSearchHit => item && typeof item === 'object' && typeof (item as CodeSearchHit).path === 'string')
}

function collectCodeMapEvidence(nodes: CodeMapNode[], workspacePath: string): SubAgentEvidence[] {
  const evidence: SubAgentEvidence[] = []
  const visit = (node: CodeMapNode): void => {
    if (node.path) {
      evidence.push({
        path: toWorkspaceRelative(workspacePath, node.path),
        startLine: node.startLine || node.line || 1,
        endLine: node.endLine || node.line || 1,
        preview: `${node.title}${node.summary ? ` - ${node.summary}` : ''}`,
        reason: 'codemap',
        symbol: node.kind === 'symbol' ? node.title : undefined,
      })
    }
    for (const child of node.children || []) visit(child)
  }
  for (const node of nodes) visit(node)
  return evidence
}

function formatCodeMapNode(node: CodeMapNode, lines: string[], depth = 0): void {
  const indent = '  '.repeat(depth)
  const loc = node.path ? ` ${node.path}${node.line ? `:${node.line}` : ''}` : ''
  lines.push(`${indent}- ${node.title}${loc}${node.summary ? ` - ${node.summary}` : ''}`)
  for (const child of (node.children || []).slice(0, 12)) {
    formatCodeMapNode(child, lines, depth + 1)
  }
}

/**
 * 运行时注册一个新代理（agent 自注册的基础）
 * 如果代理有关联的 skills，会自动注册到 SkillRuntime
 */
export function registerAgent(def: SubAgentDefinition, skillRuntime?: SkillRuntime): void {
  const loaded = def as LoadedAgent
  dynamicAgents.set(def.id, loaded)

  // 自动注册代理关联的 skills
  if (loaded.skills && loaded.skills.length > 0 && skillRuntime) {
    const agentSkills: LoadedSkill[] = loaded.skills.map(skillId => ({
      id: skillId,
      name: skillId,
      command: `/${skillId}`,
      description: `Skill registered by agent: ${def.id}`,
      category: 'custom' as const,
      systemPrompt: '',
      source: 'system' as const,
      filePath: `[agent:${def.id}]`,
      rawContent: '',
    }))
    skillRuntime.registerSkills(agentSkills)
  }
}

/**
 * 获取单个代理定义 — 先查动态，再查硬编码
 */
export function getSubAgentDefinition(type: string): SubAgentDefinition | undefined {
  return dynamicAgents.get(type) ?? DEFINITIONS[type]
}

/**
 * 获取所有代理定义（动态 + 硬编码），动态优先
 */
export function getAllAgentDefinitions(): SubAgentDefinition[] {
  const map = new Map<string, SubAgentDefinition>()
  for (const def of Object.values(DEFINITIONS)) {
    map.set(def.id, def)
  }
  for (const [id, def] of dynamicAgents) {
    map.set(id, def)
  }
  return [...map.values()]
}

/**
 * 获取所有可用的 agent type ID 列表
 */
export function getAvailableAgentTypes(): string[] {
  return getAllAgentDefinitions().map(d => d.id)
}

/**
 * 将所有动态代理关联的 skills 同步到 SkillRuntime
 * 在 SkillRuntime 初始化后调用一次即可
 */
export function syncAgentSkills(skillRuntime: SkillRuntime): void {
  for (const [, agent] of dynamicAgents) {
    const loaded = agent as LoadedAgent
    if (!loaded.skills || loaded.skills.length === 0) continue

    const agentSkills: LoadedSkill[] = loaded.skills.map(skillId => ({
      id: skillId,
      name: skillId,
      command: `/${skillId}`,
      description: `Skill registered by agent: ${agent.id}`,
      category: 'custom' as const,
      systemPrompt: '',
      source: 'system' as const,
      filePath: `[agent:${agent.id}]`,
      rawContent: '',
    }))
    skillRuntime.registerSkills(agentSkills)
  }
}

// ── 内置代理定义 ──────────────────────────────────────────────────

const DEFINITIONS: Record<string, SubAgentDefinition> = {
  fast_context: {
    id: 'fast_context',
    label: 'Fast Context',
    description: 'Fast issue-localization code map for large repositories. Use when you need ranked candidate files, roles, and evidence before deciding what to read.',
    driver: 'main-model',
    systemPrompt: buildFastContextSystemPrompt('medium'),
    maxTurns: 8,
    maxParallel: 6,
    temperature: 0,
    thinking: 'disabled',
  },
  explorer: {
    id: 'explorer',
    label: 'Explorer',
    description: 'Deep multi-file investigation. Use for tracing call chains, understanding a feature end-to-end, or auditing a complex subsystem.',
    driver: 'deepseek-flash',
    systemPrompt: `You are a deep-dive code investigator. Trace call chains, read implementations, follow imports, and produce a grounded report with file:line citations.

Tools available: search_content, read_file, search_files.
Strategy:
1. Identify entry points via search_content.
2. Read implementations — follow function calls and imports across files.
3. Parallelize independent reads in the same turn.
4. Report findings as concrete file:line references with brief code excerpts.
Do NOT summarize from filenames alone. Every claim must come from code you read.`,
    maxTurns: 6,
    maxParallel: 6,
    thinking: 'disabled',
  },
  reviewer: {
    id: 'reviewer',
    label: 'Reviewer',
    description: 'Code review for bugs, security issues, and design problems.',
    driver: 'deepseek-flash',
    systemPrompt: `You are a code reviewer. Read the relevant source files and identify bugs, security vulnerabilities, performance issues, and design problems.

Tools available: search_content, read_file, search_files.
For each finding, cite the exact file:line and quote the problematic code. Categorize as: bug / security / performance / design. Suggest a concrete fix.`,
    maxTurns: 5,
    maxParallel: 6,
    thinking: 'disabled',
  },
  git_inspector: {
    id: 'git_inspector',
    label: 'Git Inspector',
    description: 'Analyze recent git changes: what was modified, why, and what the diff shows.',
    driver: 'deepseek-flash',
    systemPrompt: `You analyze git history and diffs to explain recent changes.

Tools available: search_content, read_file, search_files.
Focus on: what changed, which files were affected, likely intent. Return a concise summary with file:line citations.`,
    maxTurns: 4,
    maxParallel: 4,
    thinking: 'disabled',
  },
}

export function buildFastContextSystemPrompt(level: FastContextLevel = 'medium'): string {
  const tuning = getFastContextTuning(level)
  const depthContract = tuning.level === 'low'
    ? 'Fast location pass: form at least two hypotheses, identify the likely entry and implementation, and stop once 2-4 read-confirmed candidates answer the objective.'
    : tuning.level === 'max'
      ? 'Architecture pass: form at least four independent hypotheses, trace the complete caller-to-core-to-state/persistence flow, inspect tests and failure paths, and actively search for evidence that disproves the leading interpretation.'
      : 'Engineering pass: form at least three hypotheses, trace the caller-to-core relationship plus relevant state/config boundaries, and return 3-7 read-confirmed candidates.'
  return `You are FastContext, a read-only code intelligence subagent for large repositories. Deterministic retrieval gives you recall, but you own semantic understanding. Your job is to rewrite the objective into independent search hypotheses, challenge the prefetched candidates, trace the real execution path, and return a compact ranked code map grounded in files and line ranges.

Depth level: ${tuning.level}
Depth contract: ${depthContract}
Before finalizing, make at least ${tuning.minimumSearchCalls} model-directed search call(s) and ${tuning.minimumReadCalls} model-directed read_file call(s).

Tools:
- search_content(pattern, path?, file_pattern?, case_sensitive?)
- search_files(pattern)
- search_symbols(query, path?, symbol_kind?)
- get_codemap(query, path?)
- read_file(path, offset?, limit?)

Strategy:
1. Follow the depth contract above. Cover exact identifiers/text, likely ownership modules, and runtime/call-chain behavior as appropriate for this level. Search more than one naming convention.
2. Run independent searches in parallel. Use search_symbols for declarations, search_content for literals and references, search_files for naming hypotheses, and get_codemap only as orientation.
3. Treat deterministic prefetch as untrusted leads. You MUST run your own search wave and MUST read the strongest source slices yourself.
4. Trace relationships, not just mentions: entry/caller -> implementation -> state or persistence -> tests/error path. For lifecycle questions, identify the true execution core and at least one caller.
5. As soon as a search reveals the probable execution core, read that implementation before spending more turns on peripheral files. A search-confirmed core is not enough when it can still be read.
6. Disprove attractive false positives. Documentation, index barrels, tests, and generic entry files rank below concrete runtime implementations unless the objective specifically asks for them.
7. Return a concise final report that starts with exactly "RANKED_CODE_MAP". Include 3-7 ranked candidates with path, line range, role, confidence, and why. Then list "EXECUTION_FLOW", "SEARCHES_TRIED", and "UNCERTAINTY".

Rules:
- Never describe files you have not read.
- Every ranked candidate must be supported by a read_file result from this run.
- Prioritize source, entry, schema/config, and failing-path files over README-style context.
- Prefer narrow, targeted reads (offset+limit) over full-file reads.
- Avoid dumping many related files. Five strong candidates beat twenty weak ones.
- Use search_content pagination and context windows when a broad query is truncated or crowded.
- If the objective contains Chinese or mixed UI text, search both exact text and nearby component/style naming guesses.
- Your final report is the ranking authority. Local scoring is only a fallback if your report is missing or unusable.
- Do NOT expose hidden reasoning. Call tools and return concise, evidence-backed findings.`
}

export interface RunSubAgentOptions {
  definition: SubAgentDefinition
  objective: string
  workspacePath: string
  toolExecutor: ToolExecutor
  apiKey: string
  baseUrl: string
  provider?: string
  customHeaders?: Record<string, string>
  reasoning?: NativeReasoningConfig
  modelCapabilities?: ModelCapabilities
  model?: string
  codemap?: string | null
  abortSignal?: AbortSignal
  requestTimeoutMs?: number
  retrievalContext?: string
  initialEvidence?: SubAgentEvidence[]
  requireGroundedReport?: boolean
  minimumSearchCalls?: number
  minimumReadCalls?: number
  onEvent?: (event: SubAgentEvent) => void
}

export interface SubAgentResult {
  ok: boolean
  turns: number
  elapsedMs: number
  finalText?: string
  evidence?: SubAgentEvidence[]
  error?: string
  truncated?: boolean
}

interface ToolCallRequest {
  id: string
  function: { name: string; arguments: string }
}

type SubAgentMessage = { role: string; content: string; tool_calls?: ToolCallRequest[]; tool_call_id?: string }

const TRANSIENT_HTTP_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504])
const TRANSIENT_RETRY_DELAYS_MS = [300, 900, 1_800]
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
])

function removeCompatibleRequestParam(
  protocol: ModelProtocol,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  param: string,
): boolean {
  return protocol === 'anthropic_messages'
    ? removeAnthropicCompatibleRequestParam(body, headers, param)
    : removeOpenAICompatibleRequestParam(body, param)
}

async function fetchWithTimeout(url: string, init: RequestInit, parentSignal?: AbortSignal, timeoutMs = 120_000): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort()
  if (parentSignal?.aborted) controller.abort()
  else parentSignal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (timedOut && !parentSignal?.aborted) {
      throw new Error(`Model request timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener('abort', abort)
  }
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      const error = new Error('Aborted')
      error.name = 'AbortError'
      reject(error)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function errorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (typeof current === 'object') {
      const code = (current as { code?: unknown }).code
      if (typeof code === 'string') return code
      current = (current as { cause?: unknown }).cause
      continue
    }
    break
  }
  return undefined
}

function isTransientNetworkError(error: unknown): boolean {
  const code = errorCode(error)
  if (code && TRANSIENT_NETWORK_CODES.has(code)) return true
  return error instanceof TypeError && /fetch failed|network|socket/i.test(error.message)
}

function retryAfterMs(response: Response): number {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return 200
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(2_000, seconds * 1_000))
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, Math.min(2_000, at - Date.now())) : 200
}

async function fetchWithTransientRetry(
  url: string,
  init: RequestInit,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  onRetry: (attempt: number, delayMs: number, reason: string) => void,
): Promise<Response> {
  const startedAt = Date.now()
  let lastError: unknown

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const remainingMs = timeoutMs - (Date.now() - startedAt)
    if (remainingMs < 1) {
      throw lastError || new Error(`Model request timed out after ${timeoutMs}ms`)
    }

    try {
      const response = await fetchWithTimeout(url, init, parentSignal, remainingMs)
      if (attempt < 4 && TRANSIENT_HTTP_STATUSES.has(response.status)) {
        const requestedDelay = Math.max(retryAfterMs(response), TRANSIENT_RETRY_DELAYS_MS[attempt - 1] || 1_800)
        const delayMs = Math.min(requestedDelay, Math.max(0, remainingMs - 1))
        onRetry(attempt + 1, delayMs, `API ${response.status}`)
        await response.body?.cancel().catch(() => undefined)
        await abortableDelay(delayMs, parentSignal)
        continue
      }
      return response
    } catch (error) {
      lastError = error
      const isAbort = parentSignal?.aborted || (error instanceof Error && error.name === 'AbortError')
      const isTimeout = error instanceof Error && /timed out after \d+ms/i.test(error.message)
      if (attempt === 4 || isAbort || isTimeout || !isTransientNetworkError(error)) throw error

      const elapsedMs = Date.now() - startedAt
      const delayMs = Math.min(TRANSIENT_RETRY_DELAYS_MS[attempt - 1] || 1_800, Math.max(0, timeoutMs - elapsedMs - 1))
      if (delayMs <= 0) throw error
      onRetry(attempt + 1, delayMs, formatSubAgentError(error))
      await abortableDelay(delayMs, parentSignal)
    }
  }

  throw lastError || new Error('Model request failed')
}

function toAnthropicMessages(messages: SubAgentMessage[]): Array<Record<string, unknown>> {
  const source = messages.filter(message => message.role !== 'system')
  const normalized: Array<Record<string, unknown>> = []
  for (let index = 0; index < source.length; index += 1) {
    const message = source[index]
    if (message.role === 'assistant' && message.tool_calls?.length) {
      normalized.push({
        role: 'assistant',
        content: [
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
          ...message.tool_calls.map(toolCall => ({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: JSON.parse(toolCall.function.arguments || '{}'),
          })),
        ],
      })
      continue
    }
    if (message.role === 'tool') {
      const results: Array<Record<string, unknown>> = []
      let nextIndex = index
      while (nextIndex < source.length && source[nextIndex].role === 'tool') {
        const toolMessage = source[nextIndex]
        results.push({ type: 'tool_result', tool_use_id: toolMessage.tool_call_id, content: toolMessage.content })
        nextIndex += 1
      }
      normalized.push({
        role: 'user',
        content: results,
      })
      index = nextIndex - 1
      continue
    }
    normalized.push({ role: message.role, content: message.content })
  }
  return normalized
}

export async function runSubAgent(options: RunSubAgentOptions): Promise<SubAgentResult> {
  const {
    definition,
    objective,
    workspacePath,
    toolExecutor,
    apiKey,
    baseUrl,
    provider,
    customHeaders,
    model,
    codemap,
    abortSignal,
    onEvent,
    reasoning,
    modelCapabilities,
  } = options
  const requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? 120_000)
  const startedAt = Date.now()
  const emit = (event: SubAgentEvent) => onEvent?.(event)

  const messages: SubAgentMessage[] = []

  messages.push({ role: 'system', content: definition.systemPrompt })

  if (codemap) {
    messages.push({ role: 'user', content: `Workspace structure:\n${codemap}` })
    messages.push({ role: 'assistant', content: 'READY' })
  }

  const retrievalContext = options.retrievalContext?.trim()
  messages.push({
    role: 'user',
    content: [
      `Objective: ${objective}`,
      retrievalContext ? `\nDeterministic prefetch (grounded starting points, not proof):\n${retrievalContext}` : '',
      '\nBuild a ranked code map: likely entry points, implementations, callers/config/schema, and suspected root-cause evidence. Be fast and precise.',
    ].filter(Boolean).join('\n'),
  })

  const tools = [
    {
      type: 'function',
      function: {
        name: 'search_content',
        description: 'Grep for a regex pattern across the codebase',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path: { type: 'string' },
            file_pattern: { type: 'string' },
            case_sensitive: { type: 'boolean' },
            offset: { type: 'number' },
            head_limit: { type: 'number' },
            context_before: { type: 'number' },
            context_after: { type: 'number' },
            multiline: { type: 'boolean' },
            file_type: { type: 'string' },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a bounded line range without loading the whole file. offset is 1-based.',
        parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['path'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_files',
        description: 'Find files by glob pattern',
        parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_symbols',
        description: 'Search code symbols such as functions, classes, interfaces, types, constants, and components',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            path: { type: 'string' },
            symbol_kind: { type: 'string', enum: ['class', 'function', 'interface', 'type', 'enum', 'constant'] },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_codemap',
        description: 'Generate a compact project map for a feature area or path before drilling into files',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            path: { type: 'string' },
          },
          required: ['query'],
        },
      },
    },
  ]

  const modelId = model?.trim()
  if (!modelId) {
    const message = `Subagent ${definition.label} requires an active model from the main agent.`
    emit({ type: 'error', message })
    return { ok: false, finalText: '', evidence: [], turns: 0, elapsedMs: Date.now() - startedAt, truncated: false, error: message }
  }
  let turn = 0
  const collectedEvidence: SubAgentEvidence[] = [...(options.initialEvidence || [])]
  const evidenceKeys = new Set(collectedEvidence.map(evidence => `${evidence.path}:${evidence.startLine}-${evidence.endLine}:${evidence.reason}`))
  let searchRecoveryUsed = false
  let reportRecoveryUsed = false
  let modelSearchCalls = 0
  let modelReadCalls = 0
  let resolvedProtocol: ModelProtocol | null = null
  const isFastContextDefinition = definition.id === 'fast_context'
  const strictFastContext = isFastContextDefinition && options.requireGroundedReport === true
  const minimumSearchCalls = strictFastContext ? Math.max(1, Math.floor(options.minimumSearchCalls ?? 1)) : 0
  const minimumReadCalls = strictFastContext ? Math.max(1, Math.floor(options.minimumReadCalls ?? 1)) : 0

  const addEvidence = (evidence: SubAgentEvidence): void => {
    const key = `${evidence.path}:${evidence.startLine}-${evidence.endLine}:${evidence.reason}`
    if (evidenceKeys.has(key)) return
    evidenceKeys.add(key)
    collectedEvidence.push(evidence)
  }

  const hasReadEvidence = (): boolean => collectedEvidence.some(evidence => /(?:file read|read confirmation|prefetch read)/i.test(evidence.reason))
  const hasModelReadEvidence = (): boolean => collectedEvidence.some(evidence => evidence.reason === 'file read')
  const validateFastContextReport = (text: string): string | null => {
    const normalized = text.trim()
    if (modelSearchCalls < minimumSearchCalls) return `final report requires ${minimumSearchCalls} model search calls; only ${modelSearchCalls} completed`
    if (modelReadCalls < minimumReadCalls) return `final report requires ${minimumReadCalls} model read calls; only ${modelReadCalls} completed`
    if (!/^RANKED_CODE_MAP\b/m.test(normalized)) return 'final report must start with RANKED_CODE_MAP'
    if (!/\bEXECUTION_FLOW\b/m.test(normalized)) return 'final report is missing EXECUTION_FLOW'
    if (!/\bSEARCHES_TRIED\b/m.test(normalized)) return 'final report is missing SEARCHES_TRIED'
    if (!/\bUNCERTAINTY\b/m.test(normalized)) return 'final report is missing UNCERTAINTY'
    const readPaths = new Set(collectedEvidence.filter(evidence => evidence.reason === 'file read').map(evidence => evidence.path.replace(/\\/g, '/')))
    if (readPaths.size === 0) return 'final report has no model-read evidence'
    if (![...readPaths].some(path => normalized.includes(path))) return 'ranked candidates are not grounded in model-read files'
    return null
  }

  while (turn < definition.maxTurns) {
    if (abortSignal?.aborted) break
    turn++
    emit({ type: 'turn_start', turn, maxTurns: definition.maxTurns })

    let messageText = ''
    let responseToolCalls: ToolCallRequest[] = []
    const waitStartedAt = Date.now()
    emit({ type: 'model_wait', turn, elapsedMs: 0, timeoutMs: requestTimeoutMs })
    const waitTimer = setInterval(() => {
      emit({ type: 'model_wait', turn, elapsedMs: Date.now() - waitStartedAt, timeoutMs: requestTimeoutMs })
    }, 5_000)
    try {
      const providerHint = provider === 'anthropic' ? 'anthropic' : provider === 'openai' ? 'openai' : 'custom'
      const plannedProtocols: ModelProtocol[] = planModelProtocols(providerHint, modelId)
      const protocolCandidates: ModelProtocol[] = resolvedProtocol
        ? [resolvedProtocol, ...plannedProtocols.filter(protocol => protocol !== resolvedProtocol)]
        : plannedProtocols
      const protocolAttempts: ModelProtocolAttempt[] = []
      let parsedResponse = false

      for (let protocolIndex = 0; protocolIndex < protocolCandidates.length; protocolIndex += 1) {
        const protocol: ModelProtocol = protocolCandidates[protocolIndex]
        const url = buildModelProtocolUrl(baseUrl, protocol)
        const requestMessages = messages.map(message => ({ ...message })) as Array<Record<string, unknown>>
        const requestBody: Record<string, unknown> = protocol === 'anthropic_messages'
          ? {
              model: modelId,
              system: definition.systemPrompt,
              messages: toAnthropicMessages(messages),
              tools: tools.map(tool => ({
                name: tool.function.name,
                description: tool.function.description,
                input_schema: tool.function.parameters,
              })),
              temperature: definition.temperature ?? 0,
              max_tokens: definition.maxOutputTokens || 4096,
            }
          : protocol === 'openai_responses'
            ? {
                model: modelId,
                instructions: definition.systemPrompt,
                input: toResponsesInput(requestMessages),
                tools: toResponsesTools(tools),
                temperature: definition.temperature ?? 0,
                max_output_tokens: definition.maxOutputTokens || 4096,
                store: false,
              }
            : {
                model: modelId,
                messages,
                tools,
                temperature: definition.temperature ?? 0,
                max_tokens: definition.maxOutputTokens || 4096,
                stream: false,
              }
        const reasoningRequest = resolveNativeReasoningRequest(modelId, reasoning, provider, modelCapabilities)
        const reasoningEffort = reasoningRequest?.reasoningEffort ?? reasoningRequest?.outputConfig?.effort
        if (protocol === 'anthropic_messages') {
          if (reasoningRequest?.thinking) requestBody.thinking = reasoningRequest.thinking
          if (reasoningRequest?.outputConfig) requestBody.output_config = reasoningRequest.outputConfig
        } else if (protocol === 'openai_responses') {
          if (reasoningEffort) requestBody.reasoning = { effort: reasoningEffort }
          requestBody.parallel_tool_calls = true
        } else {
          if (reasoningRequest?.thinking) requestBody.thinking = reasoningRequest.thinking
          if (reasoningRequest?.reasoningEffort) requestBody.reasoning_effort = reasoningRequest.reasoningEffort
          if (reasoningRequest?.outputConfig) requestBody.output_config = reasoningRequest.outputConfig
          requestBody.parallel_tool_calls = true
        }
        if (reasoningRequest?.omitTemperature) delete requestBody.temperature
        const headers: Record<string, string> = createTurboFluxRequestHeaders(protocol === 'anthropic_messages'
          ? {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              ...(provider === 'anthropic' ? {} : { 'Authorization': `Bearer ${apiKey}` }),
              ...customHeaders,
            }
          : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, ...customHeaders })
        let res: Response | undefined
        let errorText = ''
        for (let compatibilityAttempt = 0; compatibilityAttempt < 4; compatibilityAttempt += 1) {
          res = await fetchWithTransientRetry(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
          }, abortSignal, requestTimeoutMs, (attempt, delayMs, reason) => {
            emit({ type: 'model_retry', turn, attempt, delayMs, reason })
          })
          if (res.ok) break
          errorText = await res.text()
          if (isReasoningEffortValueError(errorText)) {
            const fallback = downgradeReasoningEffort(requestBody)
            if (fallback) {
              emit({
                type: 'model_retry',
                turn,
                attempt: compatibilityAttempt + 2,
                delayMs: 0,
                reason: `Provider rejected reasoning effort ${fallback.from}; retrying with ${fallback.to}.`,
              })
              continue
            }
          }
          const unsupportedParam = extractUnsupportedRequestParam(errorText)
          if (
            compatibilityAttempt >= 3
            || (res.status !== 400 && res.status !== 422)
            || !unsupportedParam
            || !removeCompatibleRequestParam(protocol, requestBody, headers, unsupportedParam)
          ) break
          emit({
            type: 'model_retry',
            turn,
            attempt: compatibilityAttempt + 2,
            delayMs: 0,
            reason: `Provider rejected "${unsupportedParam}"; retrying without that optional parameter.`,
          })
        }
        if (!res) throw new Error('Model request returned no response')

        if (!res.ok) {
          if (!errorText) errorText = await res.text()
          const protocolError = new ModelProtocolRequestError(`HTTP ${res.status}: ${errorText || 'empty response'}`, {
            protocol,
            url,
            status: res.status,
            kind: 'http',
          })
          const attempt = toProtocolAttempt(protocolError)
          protocolAttempts.push(attempt)
          const nextProtocol = protocolCandidates[protocolIndex + 1]
          if (nextProtocol && shouldFallbackProtocol(protocolError)) {
            emit({
              type: 'model_retry',
              turn,
              attempt: protocolIndex + 2,
              delayMs: 0,
              reason: `Protocol fallback: ${formatProtocolAttempt(attempt)} -> ${buildModelProtocolUrl(baseUrl, nextProtocol)}`,
            })
            continue
          }
          const failure = formatProtocolFailure(protocolAttempts)
          emit({ type: 'error', message: failure })
          return { ok: false, turns: turn, elapsedMs: Date.now() - startedAt, error: failure }
        }

        const response: any = await res.json()
        if (protocol === 'anthropic_messages') {
          const blocks = Array.isArray(response.content) ? response.content : []
          messageText = blocks.filter((block: any) => block.type === 'text').map((block: any) => block.text || '').join('')
          responseToolCalls = blocks.filter((block: any) => block.type === 'tool_use').map((block: any) => ({
            id: block.id,
            function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
          }))
        } else if (protocol === 'openai_responses') {
          if (!Array.isArray(response.output)) {
            const message = `Responses endpoint ${url} returned no output array.`
            emit({ type: 'error', message })
            return { ok: false, turns: turn, elapsedMs: Date.now() - startedAt, error: message }
          }
          messageText = response.output
            .filter((item: any) => item?.type === 'message' && Array.isArray(item.content))
            .flatMap((item: any) => item.content)
            .filter((item: any) => (item?.type === 'output_text' || item?.type === 'refusal') && typeof item.text === 'string')
            .map((item: any) => item.text)
            .join('')
          responseToolCalls = response.output
            .filter((item: any) => item?.type === 'function_call' && typeof item.name === 'string')
            .map((item: any, index: number) => ({
              id: item.call_id || item.id || `call_${index}`,
              function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : '{}' },
            }))
        } else {
          const choice = response.choices?.[0]
          if (!choice) {
            const message = `Chat Completions endpoint ${url} returned no response choice.`
            emit({ type: 'error', message })
            return { ok: false, turns: turn, elapsedMs: Date.now() - startedAt, error: message }
          }
          messageText = choice.message?.content || ''
          responseToolCalls = choice.message?.tool_calls || []
        }
        resolvedProtocol = protocol
        parsedResponse = true
        break
      }

      if (!parsedResponse) {
        const failure = formatProtocolFailure(protocolAttempts)
        emit({ type: 'error', message: failure })
        return { ok: false, turns: turn, elapsedMs: Date.now() - startedAt, error: failure }
      }
    } catch (e: any) {
      if (e.name === 'AbortError') return { ok: false, turns: turn, elapsedMs: Date.now() - startedAt, error: 'Aborted' }
      const message = formatSubAgentError(e)
      emit({ type: 'error', message })
      return { ok: false, turns: turn, elapsedMs: Date.now() - startedAt, error: message }
    } finally {
      clearInterval(waitTimer)
    }

    if (responseToolCalls.length === 0) {
      if (strictFastContext && modelSearchCalls < minimumSearchCalls && turn < definition.maxTurns) {
        const remaining = minimumSearchCalls - modelSearchCalls
        messages.push({ role: 'assistant', content: messageText })
        messages.push({
          role: 'user',
          content: `The deterministic prefetch is only a lead set. Run at least ${remaining} more independent search call(s) now using alternate identifiers, references, filenames, or runtime terms before ranking anything.`,
        })
        continue
      }
      const missingRequiredRead = strictFastContext
        ? (!hasModelReadEvidence() || modelReadCalls < minimumReadCalls)
        : !hasReadEvidence()
      if (isFastContextDefinition && missingRequiredRead && collectedEvidence.length > 0 && turn < definition.maxTurns) {
        const remaining = Math.max(1, minimumReadCalls - modelReadCalls)
        messages.push({ role: 'assistant', content: messageText })
        messages.push({
          role: 'user',
          content: `Quality gate: candidate paths are not enough, and prefetched snippets are not proof. Make at least ${remaining} more read_file call(s) yourself on the strongest runtime candidates, inspect exact line ranges, and trace the relationships required by this depth level.`,
        })
        continue
      }
      if (isFastContextDefinition && collectedEvidence.length === 0 && !searchRecoveryUsed && turn < definition.maxTurns) {
        messages.push({ role: 'assistant', content: messageText })
        messages.push({
          role: 'user',
          content: 'Recovery search: the first pass produced no concrete evidence. Rewrite the objective into exact identifiers, visible text, and likely file globs; run a different search strategy before concluding.',
        })
        searchRecoveryUsed = true
        continue
      }
      if (strictFastContext) {
        const reportError = validateFastContextReport(messageText)
        if (reportError && !reportRecoveryUsed && turn < definition.maxTurns) {
          messages.push({ role: 'assistant', content: messageText })
          messages.push({
            role: 'user',
            content: `Final report rejected: ${reportError}. Return the required RANKED_CODE_MAP now using only files you personally read. Include EXECUTION_FLOW, SEARCHES_TRIED, and UNCERTAINTY. Do not call more tools unless a missing fact makes the report impossible.`,
          })
          reportRecoveryUsed = true
          continue
        }
        if (reportError) {
          emit({ type: 'error', message: `FastContext final report rejected: ${reportError}` })
          return { ok: false, turns: turn, elapsedMs: Date.now() - startedAt, evidence: collectedEvidence, truncated: true, error: reportError }
        }
      }
      emit({ type: 'final', text: messageText })
      emit({ type: 'turn_complete', turn, calls: 0 })
      return { ok: true, turns: turn, elapsedMs: Date.now() - startedAt, finalText: messageText, evidence: collectedEvidence }
    }

    const toolCalls = responseToolCalls.slice(0, definition.maxParallel)
    messages.push({ role: 'assistant', content: messageText, tool_calls: toolCalls })
    const entries = toolCalls.map(tc => {
      let args: Record<string, any> = {}
      try { args = JSON.parse(tc.function.arguments) } catch {}
      emit({ type: 'tool_call', tool: tc.function.name, args, turn })
      if (tc.function.name === 'read_file') modelReadCalls += 1
      else if (['search_content', 'search_files', 'search_symbols', 'get_codemap'].includes(tc.function.name)) modelSearchCalls += 1
      return { tc, args }
    })
    const results = await Promise.all(entries.map(async entry => {
      if (abortSignal?.aborted) {
        return {
          entry,
          result: {
            ok: false,
            output: 'Aborted.',
            summary: `${entry.tc.function.name} aborted`,
            evidence: [],
          } satisfies ToolExecResult,
        }
      }
      try {
        const result = await executeSubAgentTool(entry.tc.function.name, entry.args, workspacePath, toolExecutor)
        return { entry, result }
      } catch (error) {
        const message = formatSubAgentError(error)
        return {
          entry,
          result: {
            ok: false,
            output: `Tool failed: ${message}`,
            summary: `${entry.tc.function.name} failed: ${message}`,
            evidence: [],
          } satisfies ToolExecResult,
        }
      }
    }))

    for (const { entry, result } of results) {
      const { tc } = entry
      emit({ type: 'tool_result', tool: tc.function.name, ok: result.ok, summary: result.summary, turn })

      for (const ev of result.evidence) {
        addEvidence(ev)
        emit({ type: 'evidence', evidence: ev })
      }

      messages.push({ role: 'tool' as any, tool_call_id: tc.id, content: result.output })
    }

    emit({ type: 'turn_complete', turn, calls: results.length })

    if (strictFastContext && turn === definition.maxTurns - 1) {
      messages.push({
        role: 'user',
        content: 'One turn remains. Synthesize the final RANKED_CODE_MAP now. Do not call more tools. Include EXECUTION_FLOW, SEARCHES_TRIED, and UNCERTAINTY, and rank only files you read yourself.',
      })
    }

    if (
      isFastContextDefinition
      && results.length > 0
      && results.every(({ result }) => result.ok)
      && results.every(({ result }) => result.evidence.length === 0)
      && !searchRecoveryUsed
      && turn < definition.maxTurns
    ) {
      messages.push({
        role: 'user',
        content: 'The last search wave returned no matches. Rewrite the query once using narrower and broader variants, related filenames, symbols, and visible text; do not conclude until one alternate search has run.',
      })
      searchRecoveryUsed = true
    }
  }

  return { ok: true, turns: turn, elapsedMs: Date.now() - startedAt, evidence: collectedEvidence, truncated: turn >= definition.maxTurns }
}

interface ToolExecResult {
  ok: boolean
  output: string
  summary: string
  evidence: SubAgentEvidence[]
}

async function executeSubAgentTool(name: string, args: Record<string, any>, workspacePath: string, executor: ToolExecutor): Promise<ToolExecResult> {
  const evidence: SubAgentEvidence[] = []

  switch (name) {
    case 'search_content': {
      const pattern = String(args.pattern || '').trim()
      if (!pattern) {
        return { ok: false, output: 'Search pattern is required.', summary: 'grep failed: missing pattern', evidence }
      }
      const basePath = args.path ? resolveWorkspacePath(workspacePath, args.path) : workspacePath
      const filePattern = typeof args.file_pattern === 'string' ? args.file_pattern : undefined
      const caseInsensitive = args.case_sensitive === true ? false : true
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0))
      const headLimit = Math.max(1, Math.min(200, Math.floor(Number(args.head_limit) || 40)))
      const contextBefore = Math.max(0, Math.min(12, Math.floor(Number(args.context_before) || 0)))
      const contextAfter = Math.max(0, Math.min(12, Math.floor(Number(args.context_after) || 0)))
      const usingPagedSearch = typeof executor.searchContentPage === 'function'
      const res = usingPagedSearch
        ? await executor.searchContentPage!(pattern, basePath, filePattern, caseInsensitive, {
            offset,
            limit: headLimit,
            contextBefore,
            contextAfter,
            multiline: args.multiline === true,
            fileType: typeof args.file_type === 'string' ? args.file_type : undefined,
          })
        : await executor.searchContent(pattern, basePath, filePattern, caseInsensitive)
      if (!res.success) {
        const error = res.error || 'unknown search error'
        return { ok: false, output: `Search failed: ${error}`, summary: `grep "${pattern}" failed: ${error}`, evidence }
      }
      const page = usingPagedSearch
        ? res.data as { hits?: Array<{ file: string; line: number; text: string; context?: string }>; totalMatches?: number; truncated?: boolean }
        : { hits: Array.isArray(res.data) ? res.data : [], totalMatches: Array.isArray(res.data) ? res.data.length : 0, truncated: false }
      const pageHits = page.hits || []
      if (pageHits.length === 0) {
        return { ok: true, output: 'No matches found.', summary: `grep "${pattern}" → 0 hits`, evidence }
      }
      const hits = pageHits.slice(0, headLimit)
      const lines: string[] = []
      for (const hit of hits) {
        const relPath = toWorkspaceRelative(workspacePath, hit.file)
        lines.push(`${relPath}:${hit.line}: ${hit.text}`)
        if (hit.context) lines.push(hit.context.split('\n').map(line => `  ${line}`).join('\n'))
        evidence.push({
          path: relPath,
          startLine: Math.max(1, hit.line - 2),
          endLine: hit.line + 2,
          preview: hit.text,
          reason: `grep: ${pattern}`,
        })
      }
      if (page.truncated) lines.push(`[More matches available. Continue with offset=${offset + hits.length}.]`)
      return { ok: true, output: lines.join('\n'), summary: `grep "${pattern}" → ${hits.length} hits`, evidence }
    }

    case 'read_file': {
      const requestedPath = String(args.path || '').trim()
      if (!requestedPath) {
        return { ok: false, output: 'File path is required.', summary: 'read failed: missing path', evidence }
      }
      const filePath = resolveWorkspacePath(workspacePath, requestedPath)
      const relativePath = toWorkspaceRelative(workspacePath, filePath)
      const offset = Math.max(0, Math.floor(Number(args.offset) || 1) - 1)
      const limit = Math.max(1, Math.min(400, Math.floor(Number(args.limit) || 80)))
      const rangeResult = executor.readFileRange
        ? await executor.readFileRange(filePath, offset, limit)
        : null
      const res = rangeResult || await executor.readFile(filePath)
      if (!res.success || !res.data) {
        const error = res.error || 'file not found'
        return { ok: false, output: `Read failed: ${error}`, summary: `read ${relativePath} failed: ${error}`, evidence }
      }
      const rangeData = rangeResult?.data
      if (rangeData && !rangeData.content) {
        return {
          ok: false,
          output: `Read failed: ${relativePath} has no content at line ${offset + 1}. Retry with a lower offset or search for the current symbol location.`,
          summary: `read ${relativePath}:${offset + 1} failed: offset beyond content`,
          evidence,
        }
      }
      const slice = rangeData
        ? rangeData.content.split('\n')
        : String(res.data).split('\n').slice(offset, offset + limit)
      const preview = slice.slice(0, 10).join('\n')
      evidence.push({
        path: relativePath,
        startLine: offset + 1,
        endLine: offset + slice.length,
        preview,
        reason: 'file read',
      })
      const outputLines = slice.map((line, index) => `${offset + index + 1} | ${line}`)
      if (rangeData?.truncated) outputLines.push(`[More lines available. Continue with offset=${offset + slice.length + 1}.]`)
      return { ok: true, output: outputLines.join('\n'), summary: `read ${relativePath}:${offset + 1}-${offset + slice.length}`, evidence }
    }

    case 'search_files': {
      const pattern = args.pattern || '**/*.ts'
      const res = await executor.searchFiles(pattern, workspacePath)
      if (!res.success) {
        const error = res.error || 'unknown file search error'
        return { ok: false, output: `File search failed: ${error}`, summary: `glob "${pattern}" failed: ${error}`, evidence }
      }
      if (!res.data?.matches?.length) {
        return { ok: true, output: 'No files found.', summary: `glob "${pattern}" → 0 files`, evidence }
      }
      const matches = res.data.matches.slice(0, 20)
      const relPaths = matches.map(m => toWorkspaceRelative(workspacePath, m))
      for (const relPath of relPaths.slice(0, 8)) {
        evidence.push({
          path: relPath,
          startLine: 1,
          endLine: 1,
          preview: relPath,
          reason: `glob: ${pattern}`,
        })
      }
      return { ok: true, output: relPaths.join('\n'), summary: `glob "${pattern}" → ${matches.length} files`, evidence }
    }

    case 'search_symbols': {
      const query = String(args.query || '').trim()
      if (!query) return { ok: true, output: 'No symbol query provided.', summary: 'symbol search skipped', evidence }
      const res = await executor.searchCodeSymbols({
        workspacePath,
        query,
        path: typeof args.path === 'string' ? args.path : undefined,
        kind: typeof args.symbol_kind === 'string' ? args.symbol_kind : undefined,
        kinds: typeof args.symbol_kind === 'string' ? [args.symbol_kind] : undefined,
        limit: 20,
      })
      const hits = normalizeCodeSearchHits(res.data).slice(0, 15)
      if (!res.success) {
        const error = res.error || 'unknown symbol search error'
        return { ok: false, output: `Symbol search failed: ${error}`, summary: `symbols "${query}" failed: ${error}`, evidence }
      }
      if (hits.length === 0) {
        return { ok: true, output: 'No symbols found.', summary: `symbols "${query}" -> 0 hits`, evidence }
      }
      const lines = hits.map(hit => {
        const relPath = toWorkspaceRelative(workspacePath, hit.path)
        evidence.push({
          path: relPath,
          startLine: hit.startLine || hit.line || 1,
          endLine: hit.endLine || hit.line || 1,
          preview: hit.preview || hit.subtitle || hit.title,
          reason: `symbol: ${query}`,
          symbol: hit.symbolName || hit.title,
        })
        return `${relPath}:${hit.line || hit.startLine || 1}: ${hit.title} (${hit.symbolKind || hit.source}) ${hit.preview || hit.subtitle || ''}`.trim()
      })
      return { ok: true, output: lines.join('\n'), summary: `symbols "${query}" -> ${hits.length} hits`, evidence }
    }

    case 'get_codemap': {
      const query = String(args.query || args.path || '').trim()
      const res = await executor.getCodeMap({
        workspacePath,
        query,
        targetPaths: typeof args.path === 'string' ? [args.path] : undefined,
        path: typeof args.path === 'string' ? args.path : undefined,
        maxPaths: 8,
        maxChildrenPerPath: 5,
      })
      const map = res.data?.map
      const nodes = Array.isArray(map) ? map : map ? [map] : []
      if (!res.success) {
        const error = res.error || 'unknown codemap error'
        return { ok: false, output: `Codemap failed: ${error}`, summary: `codemap "${query}" failed: ${error}`, evidence }
      }
      if (nodes.length === 0) {
        return { ok: true, output: 'No codemap found.', summary: `codemap "${query}" -> 0 nodes`, evidence }
      }
      const lines: string[] = []
      const nodeEvidence = collectCodeMapEvidence(nodes, workspacePath)
      for (const ev of nodeEvidence.slice(0, 12)) evidence.push(ev)
      for (const node of nodes) formatCodeMapNode(node, lines)
      return { ok: true, output: lines.join('\n'), summary: `codemap "${query}" -> ${nodeEvidence.length} anchors`, evidence }
    }

    default:
      return { ok: false, output: `Unknown tool: ${name}`, summary: `unknown tool ${name}`, evidence }
  }
}

function formatSubAgentError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)

  const metadata = error as Error & { code?: unknown; address?: unknown; port?: unknown }
  const endpoint = metadata.address !== undefined
    ? `${String(metadata.address)}${metadata.port !== undefined ? `:${String(metadata.port)}` : ''}`
    : metadata.port !== undefined ? `port ${String(metadata.port)}` : ''
  const details = [metadata.code, endpoint].filter(value => value !== undefined && value !== '')
  const suffix = details.length > 0 ? ` [${details.join(' ')}]` : ''
  if (!error.cause) return `${error.message}${suffix}`

  const cause = error.cause instanceof Error
    ? formatSubAgentError(error.cause)
    : typeof error.cause === 'object' && error.cause !== null
      ? formatSubAgentError(Object.assign(new Error(String((error.cause as { message?: unknown }).message || 'request cause')), error.cause))
      : String(error.cause)
  return `${error.message}${suffix} (${cause})`
}
