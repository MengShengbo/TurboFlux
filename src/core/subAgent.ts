import { createHash } from 'node:crypto'
import { isAbsolute, join, relative } from 'path'
import type { CodeMapNode, CodeSearchHit } from '../shared/codeIndexTypes'
import type { SubAgentEvent, SubAgentEvidence, SubAgentDefinition } from '../shared/subAgentTypes'
import type { NativeReasoningConfig } from '../shared/agentTypes'
import type { ToolExecutor } from '../tools/executor'
import type { ModelCapabilities } from './config'
import { FAST_CONTEXT_TUNING, type FastContextStrategy } from './fastContextTypes'
import { FastContextEvidenceLedger, type FastContextEvidenceRecord } from './fastContextEvidenceLedger'
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
  looksLikeResponsesPreferredModel,
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
    label: 'FastContext Controller',
    description: 'Low-latency causal code retrieval with parallel tools and read-grounded edit targets.',
    driver: 'main-model',
    systemPrompt: buildFastContextSystemPrompt(),
    maxTurns: FAST_CONTEXT_TUNING.maxTurns,
    maxParallel: FAST_CONTEXT_TUNING.maxParallel,
    temperature: 0,
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

export function buildFastContextSystemPrompt(strategy: FastContextStrategy = 'autonomous-race'): string {
  return `You are FastContext, a fast read-only code-retrieval controller. You own query rewriting, ownership judgment, next-hop selection, ranking, and stopping. Local tools only perform deterministic search, bounded reads, and evidence bookkeeping. Recover the complete minimal edit frontier without touring the repository.

Tools:
- search_content(pattern, path?, file_pattern?, case_sensitive?)
- search_files(pattern)
- search_symbol(query, path?, symbol_kind?)
- read_file(path, offset?, limit?)
- submit_code_map(edit_frontier, supporting_context, unresolved, frontier_complete)

Protocol:
1. Start with two to four independent, discriminative anchors from the objective: exact identifiers, literals, configuration keys, API names, named files, stack frames, or concrete ownership hypotheses. Run independent searches in parallel.
2. Use search_symbol only for a concrete identifier. Use search_content for literals, references, registrations, imports, and semantic anchors. Search results are discovery evidence, not proof of ownership.
3. Read probable direct owners immediately. If a hit is only a caller, wrapper, example, test, or registration site, follow the imported or invoked symbol to its implementation owner.
4. After each read wave apply the edit counterfactual: if only the current edit frontier changed, would the named behavior and variants be fixed? Follow only a concrete unread symbol or path that can change the answer.
5. Batch independent searches and reads in the same turn. Do not repeat equivalent calls; exact repeats are cached and provide no new information.
6. Stop when no named unread owner can materially change the ranked edit frontier. Simple exact-owner tasks should finish early; complex tasks may use the full hard turn budget.
7. Tool results include stable evidence handles such as E1. Finish with submit_code_map alone. Each item must cite evidence_ids; never type a path or line number in the submission. Your item order is the final order.

Rules:
- The first edit_frontier item must cite at least one read-confirmed evidence handle.
- Other edit_frontier items may use exact search evidence when they are tightly coupled propagation surfaces; supporting-only files belong in supporting_context.
- Prefer runtime source, contracts, state/config, persistence, and failure paths over prose documentation or generic entry files.
- Prefer narrow, targeted reads (offset+limit) over full-file reads.
- Do not repeat an equivalent search after it fails; change the semantic hypothesis or follow a concrete next hop.
- Do not enumerate the repository, expand generic synonyms, or collect peripheral context for completeness.
- If you cannot produce a grounded submission, fail explicitly. No local semantic fallback exists.
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
  maxTransientAttempts?: number
  retrievalContext?: string
  initialEvidence?: SubAgentEvidence[]
  submissionOnly?: boolean
  userPrompt?: string
  allowedTools?: string[]
  requiredAuditPaths?: string[]
  requiredCandidatePaths?: string[]
  requireGroundedReport?: boolean
  maxCandidates?: number
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
  codeMap?: SubmittedCodeMap
}

interface ToolCallRequest {
  id: string
  function: { name: string; arguments: string }
}

export interface SubmittedCandidate {
  path: string
  startLine: number
  endLine: number
  evidenceIds: string[]
  role: string
  editKind: 'owner' | 'mirror' | 'implementation' | 'consumer' | 'test' | 'supporting'
  confidence: 'high' | 'medium' | 'low'
  why: string
}

export interface SubmittedCodeMap {
  candidates: SubmittedCandidate[]
  supportingContext: SubmittedCandidate[]
  frontierComplete: boolean
  unresolved: string[]
}

type SubAgentMessage = { role: string; content: string; tool_calls?: ToolCallRequest[]; tool_call_id?: string }

function boundToolOutput(tool: string, content: string): string {
  const limit = tool === 'read_file' ? 12_000 : 8_000
  if (content.length <= limit) return content
  const head = Math.floor(limit * 0.8)
  const tail = limit - head - 64
  return `${content.slice(0, head)}\n...[tool output bounded once for stable history]...\n${content.slice(-tail)}`
}

const TRANSIENT_HTTP_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504])
const TRANSIENT_RETRY_DELAYS_MS = [300, 900, 1_800]
const PROTOCOL_CACHE_TTL_MS = 10 * 60_000
const PROTOCOL_CACHE_MAX_ENTRIES = 64
const protocolCache = new Map<string, { protocol: ModelProtocol; expiresAt: number }>()

function protocolCacheKey(params: {
  baseUrl: string
  provider?: string
  model: string
  apiKey: string
  customHeaders?: Record<string, string>
}): string {
  const headers = Object.entries(params.customHeaders || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key.toLowerCase()}:${value}`)
    .join('\n')
  return createHash('sha256')
    .update([
      params.baseUrl.replace(/\/+$/, ''),
      params.provider || '',
      params.model,
      params.apiKey,
      headers,
    ].join('\0'))
    .digest('hex')
}

function getCachedProtocol(key: string): ModelProtocol | null {
  const cached = protocolCache.get(key)
  if (!cached) return null
  if (cached.expiresAt <= Date.now()) {
    protocolCache.delete(key)
    return null
  }
  protocolCache.delete(key)
  protocolCache.set(key, cached)
  return cached.protocol
}

function rememberProtocol(key: string, protocol: ModelProtocol): void {
  protocolCache.delete(key)
  protocolCache.set(key, { protocol, expiresAt: Date.now() + PROTOCOL_CACHE_TTL_MS })
  while (protocolCache.size > PROTOCOL_CACHE_MAX_ENTRIES) {
    const oldest = protocolCache.keys().next().value
    if (!oldest) break
    protocolCache.delete(oldest)
  }
}

export function __testClearSubAgentProtocolCache(): void {
  protocolCache.clear()
}
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
  maxAttempts = 4,
): Promise<Response> {
  const startedAt = Date.now()
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remainingMs = timeoutMs - (Date.now() - startedAt)
    if (remainingMs < 1) {
      throw lastError || new Error(`Model request timed out after ${timeoutMs}ms`)
    }

    try {
      const response = await fetchWithTimeout(url, init, parentSignal, remainingMs)
      if (attempt < maxAttempts && TRANSIENT_HTTP_STATUSES.has(response.status)) {
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
      if (attempt === maxAttempts || isAbort || isTimeout || !isTransientNetworkError(error)) throw error

      const elapsedMs = Date.now() - startedAt
      const delayMs = Math.min(TRANSIENT_RETRY_DELAYS_MS[attempt - 1] || 1_800, Math.max(0, timeoutMs - elapsedMs - 1))
      if (delayMs <= 0) throw error
      onRetry(attempt + 1, delayMs, formatSubAgentError(error))
      await abortableDelay(delayMs, parentSignal)
    }
  }

  throw lastError || new Error('Model request failed')
}

function toAnthropicMessages(messages: SubAgentMessage[], cacheCodemap = false): Array<Record<string, unknown>> {
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
    normalized.push(cacheCodemap && message.role === 'user' && message.content.startsWith('Workspace structure:')
      ? { role: message.role, content: [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }] }
      : { role: message.role, content: message.content })
  }
  return normalized
}

function subAgentPromptCacheKey(params: {
  definition: SubAgentDefinition
  model: string
  workspacePath: string
  codemap?: string | null
  tools: Array<Record<string, any>>
}): string {
  const toolNames = params.tools.map(tool => String(tool.function?.name || '')).join(',')
  const digest = createHash('sha256')
    .update([
      params.definition.id,
      params.definition.systemPrompt,
      params.workspacePath.replace(/\\/g, '/').toLowerCase(),
      params.codemap || '',
      toolNames,
    ].join('\0'))
    .digest('hex')
    .slice(0, 24)
  return `tf:subagent:${params.model}:${params.definition.id}:${digest}`.slice(0, 240)
}

function stringList(value: unknown, maxItems: number, maxLength = 240): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map(item => String(item || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map(item => item.slice(0, maxLength))
}

function normalizeEditKind(value: unknown, role: string): SubmittedCandidate['editKind'] {
  const normalized = String(value || '').trim().toLowerCase()
  if (['owner', 'mirror', 'implementation', 'consumer', 'test', 'supporting'].includes(normalized)) {
    return normalized as SubmittedCandidate['editKind']
  }
  if (/mirror|duplicate|synchron|same[- ]edit/.test(role)) return 'mirror'
  if (/root[- ]cause|owner|definition|default|schema|parser rule|state transition/.test(role)) return 'owner'
  if (/test|verification/.test(role)) return 'test'
  if (/caller|consumer|entry|lifecycle/.test(role)) return 'consumer'
  if (/implementation|core|handler|runtime/.test(role)) return 'implementation'
  return 'supporting'
}

function evidenceIdsForSubmission(
  candidate: Record<string, any>,
  workspacePath: string,
  ledger: FastContextEvidenceLedger,
): string[] {
  const explicitIds = stringList(candidate.evidence_ids ?? candidate.evidenceIds, 12, 24)
    .map(id => id.toUpperCase())
  if (explicitIds.length > 0) return explicitIds

  const legacyPath = toWorkspaceRelative(workspacePath, String(candidate.path || '').trim()).toLowerCase()
  if (!legacyPath) return []
  const startLine = Math.max(1, Math.floor(Number(candidate.start_line ?? candidate.startLine) || 1))
  const endLine = Math.max(startLine, Math.floor(Number(candidate.end_line ?? candidate.endLine) || startLine))
  return ledger.records()
    .filter(record => record.evidence.path.toLowerCase() === legacyPath
      && record.evidence.startLine <= endLine
      && record.evidence.endLine >= startLine)
    .map(record => record.id)
}

function materializeSubmittedCandidates(
  value: Record<string, any>,
  workspacePath: string,
  ledger: FastContextEvidenceLedger,
  supporting = false,
): SubmittedCandidate[] {
  const evidenceIds = evidenceIdsForSubmission(value, workspacePath, ledger)
  const records = ledger.resolve(evidenceIds)
  const role = String(value.role || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const editKind = supporting ? 'supporting' : normalizeEditKind(value.edit_kind ?? value.editKind, role.toLowerCase())
  const confidence = ['high', 'medium', 'low'].includes(value.confidence) ? value.confidence : 'medium'
  const why = String(value.why || '').replace(/\s+/g, ' ').trim().slice(0, 320)

  if (records.length === 0) {
    return [{
      path: '',
      startLine: 1,
      endLine: 1,
      evidenceIds,
      role,
      editKind,
      confidence,
      why,
    }]
  }

  const recordsByPath = new Map<string, FastContextEvidenceRecord[]>()
  for (const record of records) {
    const pathRecords = recordsByPath.get(record.evidence.path) || []
    pathRecords.push(record)
    recordsByPath.set(record.evidence.path, pathRecords)
  }

  return [...recordsByPath.values()].map(pathRecords => ({
    path: pathRecords[0].evidence.path,
    startLine: Math.min(...pathRecords.map(record => record.evidence.startLine)),
    endLine: Math.max(...pathRecords.map(record => record.evidence.endLine)),
    evidenceIds: pathRecords.map(record => record.id),
    role,
    editKind,
    confidence,
    why,
  }))
}

function parseSubmittedCodeMap(
  value: Record<string, any>,
  workspacePath: string,
  ledger: FastContextEvidenceLedger,
  maxCandidates = 10,
): SubmittedCodeMap {
  const editFrontier = Array.isArray(value.edit_frontier ?? value.editFrontier)
    ? value.edit_frontier ?? value.editFrontier
    : Array.isArray(value.candidates) ? value.candidates : []
  const supportingContext = Array.isArray(value.supporting_context ?? value.supportingContext)
    ? value.supporting_context ?? value.supportingContext
    : []
  return {
    candidates: editFrontier
      .slice(0, Math.max(1, Math.min(40, maxCandidates)))
      .flatMap((candidate: Record<string, any>) => materializeSubmittedCandidates(candidate, workspacePath, ledger))
      .slice(0, Math.max(1, Math.min(40, maxCandidates))),
    supportingContext: supportingContext
      .slice(0, 12)
      .flatMap((candidate: Record<string, any>) => materializeSubmittedCandidates(candidate, workspacePath, ledger, true))
      .slice(0, 12),
    frontierComplete: value.frontier_complete ?? value.frontierComplete ?? true,
    unresolved: [
      ...stringList(value.unresolved, 8),
      ...stringList(value.unresolved_edit_paths ?? value.unresolvedEditPaths, 8),
      ...stringList(value.rejected_hypotheses ?? value.rejectedHypotheses, 8),
      ...stringList(value.uncertainty, 8),
    ].filter((item, index, all) => all.indexOf(item) === index).slice(0, 12),
  }
}

function validateSubmittedCandidate(candidate: SubmittedCandidate, ledger: FastContextEvidenceLedger): string | null {
  if (!candidate.evidenceIds.length) return 'every submitted item requires at least one evidence_id'
  const missing = candidate.evidenceIds.filter(id => !ledger.has(id))
  if (missing.length > 0) return `unknown evidence handle(s): ${missing.join(', ')}`
  if (!candidate.path) return 'all evidence_ids for one item must resolve to the same file'
  if (!candidate.role || !candidate.why) return 'every submitted item requires role and why'
  return null
}

function validateSubmittedCodeMap(report: SubmittedCodeMap, ledger: FastContextEvidenceLedger): string | null {
  if (report.candidates.length === 0) return 'at least one grounded architecture node is required'
  const firstRecords = ledger.resolve(report.candidates[0].evidenceIds)
  if (!firstRecords.some(record => record.readConfirmed)) return 'the first edit_frontier item must cite read-confirmed evidence'
  for (const candidate of report.candidates) {
    const error = validateSubmittedCandidate(candidate, ledger)
    if (error) return error
  }
  for (const candidate of report.supportingContext) {
    const error = validateSubmittedCandidate(candidate, ledger)
    if (error) return error
  }
  return null
}

function validateRequiredAuditPaths(report: SubmittedCodeMap, requiredPaths: string[] | undefined): string | null {
  if (!requiredPaths?.length) return null
  const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase()
  const submitted = new Set(report.candidates.map(candidate => normalize(candidate.path)))
  const rejected = report.unresolved.map(item => normalize(item))
  const missing = [...new Set(requiredPaths.map(normalize))]
    .filter(path => !submitted.has(path) && !rejected.some(reason => reason.includes(path)))
  return missing.length > 0
    ? `high-confidence source seeds require an explicit disposition; include each candidate or name its full path with a source-grounded rejection: ${missing.join(', ')}`
    : null
}

function validateRequiredCandidatePaths(report: SubmittedCodeMap, requiredPaths: string[] | undefined): string | null {
  if (!requiredPaths?.length) return null
  const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase()
  const submitted = new Set(report.candidates.map(candidate => normalize(candidate.path)))
  const missing = [...new Set(requiredPaths.map(normalize))].filter(path => !submitted.has(path))
  return missing.length > 0
    ? `the implementation-frontier contract requires these read-confirmed candidates in the ranked map: ${missing.join(', ')}`
    : null
}

export function renderSubmittedCodeMap(report: SubmittedCodeMap): string {
  const lines = ['RANKED_CODE_MAP', 'EDIT_FRONTIER']
  report.candidates.forEach((candidate, index) => {
    lines.push(`${index + 1}. ${candidate.path} L${candidate.startLine}-L${candidate.endLine} kind=${candidate.editKind} role=${candidate.role} confidence=${candidate.confidence} evidence=${candidate.evidenceIds.join(',')}`)
    lines.push(`   why: ${candidate.why}`)
  })
  lines.push('', 'SUPPORTING_CONTEXT')
  lines.push(...(report.supportingContext.length > 0
    ? report.supportingContext.flatMap(item => [
        `- ${item.path} L${item.startLine}-L${item.endLine} role=${item.role} evidence=${item.evidenceIds.join(',')}`,
        `  why: ${item.why}`,
      ])
    : ['- none']))
  lines.push('', 'UNRESOLVED', ...(report.unresolved.length > 0 ? report.unresolved.map(item => `- ${item}`) : ['- none']))
  lines.push('', `FRONTIER_COMPLETE: ${report.frontierComplete ? 'yes' : 'no'}`)
  return lines.join('\n')
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
  const isFastContextDefinition = definition.id === 'fast_context'

  const messages: SubAgentMessage[] = []

  messages.push({ role: 'system', content: definition.systemPrompt })

  if (codemap) {
    messages.push({ role: 'user', content: `Workspace structure:\n${codemap}` })
    messages.push({ role: 'assistant', content: 'READY' })
  }

  const retrievalContext = options.retrievalContext?.trim()
  messages.push({
    role: 'user',
    content: options.userPrompt || [
      `Objective: ${objective}`,
      retrievalContext ? `\nCaller-supplied retrieval context (starting points, not proof):\n${retrievalContext}` : '',
      '\nBuild an architecture code map: recover execution and data flow, ownership boundaries, state/config/persistence, implementation families, change-impact edges, and failure paths. Rank the probable direct edit target first; represent supporting architecture through grounded relationships.',
    ].filter(Boolean).join('\n'),
  })

  const tools: Array<Record<string, any>> = [
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
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            offset: { type: 'number' },
            limit: { type: 'number' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_files',
        description: 'Find files by glob pattern',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_symbol',
        description: 'Search deterministic source declarations such as functions, classes, interfaces, types, constants, and components',
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
        description: 'Generate a compact graph map with typed caller and callee relationships for a feature area or path before drilling into files',
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

  if (isFastContextDefinition) {
    tools.push({
      type: 'function',
      function: {
        name: 'submit_code_map',
        description: 'Submit the final ranked, read-grounded implementation files. Call this alone when no named unread owner can materially change the ranking.',
        parameters: {
          type: 'object',
          properties: {
            edit_frontier: {
              type: 'array',
              maxItems: Math.max(1, Math.min(40, options.maxCandidates ?? 10)),
              items: {
                type: 'object',
                properties: {
                  evidence_ids: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^E\\d+$' }, description: 'Evidence handles returned by tools, in order of importance.' },
                  role: { type: 'string' },
                  edit_kind: { type: 'string', enum: ['owner', 'mirror', 'implementation', 'consumer', 'test', 'supporting'] },
                  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                  why: { type: 'string' },
                },
                required: ['evidence_ids', 'role', 'confidence', 'why'],
              },
            },
            supporting_context: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  evidence_ids: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^E\\d+$' } },
                  role: { type: 'string' },
                  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                  why: { type: 'string' },
                },
                required: ['evidence_ids', 'role', 'why'],
              },
            },
            unresolved: { type: 'array', maxItems: 8, items: { type: 'string' }, description: 'Named paths or hypotheses that remain unresolved.' },
            frontier_complete: { type: 'boolean', description: 'No named unread owner can change the ranked edit frontier.' },
          },
          required: ['edit_frontier'],
        },
      },
    })
  }
  const allowedToolNames = options.allowedTools ? new Set(options.allowedTools) : undefined
  const availableTools = allowedToolNames
    ? tools.filter(tool => allowedToolNames.has(tool.function.name))
    : tools

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
  let submissionRejections = 0
  let previousSubmissionError = ''
  const toolResultCache = new Map<string, ToolExecResult>()
  const activeProtocolCacheKey = protocolCacheKey({ baseUrl, provider, model: modelId, apiKey, customHeaders })
  let resolvedProtocol: ModelProtocol | null = getCachedProtocol(activeProtocolCacheKey)
  const strictFastContext = isFastContextDefinition && options.requireGroundedReport === true
  const turnLimit = definition.maxTurns
  const effectiveReasoning: NativeReasoningConfig | undefined = definition.thinking === 'disabled'
    ? { enabled: false, effort: 'none' }
    : definition.thinking === 'high' || definition.thinking === 'max'
      ? { ...reasoning, enabled: true, effort: definition.thinking }
      : reasoning

  const evidenceLedger = new FastContextEvidenceLedger(options.initialEvidence || [])

  const addEvidence = (evidence: SubAgentEvidence): { record: FastContextEvidenceRecord; isNew: boolean } => {
    const key = `${evidence.path}:${evidence.startLine}-${evidence.endLine}:${evidence.reason}`
    const registration = evidenceLedger.register(evidence)
    if (evidenceKeys.has(key)) return registration
    evidenceKeys.add(key)
    collectedEvidence.push(evidence)
    return registration
  }

  const hasModelReadEvidence = (): boolean => evidenceLedger.records().some(record => record.readConfirmed)

  while (turn < turnLimit) {
    if (abortSignal?.aborted) break
    turn++
    const turnStartedAt = Date.now()
    let modelElapsedMs = 0
    let turnInputTokens = 0
    let turnOutputTokens = 0
    let turnCacheReadTokens = 0
    emit({ type: 'turn_start', turn, maxTurns: turnLimit })
    let messageText = ''
    let responseToolCalls: ToolCallRequest[] = []
    const waitStartedAt = Date.now()
    const requestDeadline = waitStartedAt + requestTimeoutMs
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
        const finalizationOnly = strictFastContext
          && hasModelReadEvidence()
          && (options.submissionOnly === true || turn === turnLimit)
        const activeSystemPrompt = definition.systemPrompt
        const activeMessages = messages.map(message => ({ ...message }))
        const requestMessages = activeMessages.map(message => ({ ...message })) as Array<Record<string, unknown>>
        const requestTools = finalizationOnly
          ? availableTools.filter(tool => tool.function.name === 'submit_code_map')
          : availableTools
        const requestBody: Record<string, unknown> = protocol === 'anthropic_messages'
          ? {
              model: modelId,
              system: [{ type: 'text', text: activeSystemPrompt, cache_control: { type: 'ephemeral' } }],
              messages: toAnthropicMessages(activeMessages, Boolean(codemap)),
              tools: requestTools.map(tool => ({
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
                instructions: activeSystemPrompt,
                input: toResponsesInput(requestMessages),
                tools: toResponsesTools(requestTools),
                temperature: definition.temperature ?? 0,
                max_output_tokens: definition.maxOutputTokens || 4096,
                store: false,
              }
            : {
                model: modelId,
                messages: activeMessages,
                tools: requestTools,
                temperature: definition.temperature ?? 0,
                max_tokens: definition.maxOutputTokens || 4096,
                stream: false,
              }
        const reasoningRequest = resolveNativeReasoningRequest(modelId, effectiveReasoning, provider, modelCapabilities)
        const reasoningEffort = reasoningRequest?.reasoningEffort ?? reasoningRequest?.outputConfig?.effort
        if (protocol === 'anthropic_messages') {
          if (reasoningRequest?.thinking) requestBody.thinking = reasoningRequest.thinking
          if (reasoningRequest?.outputConfig) requestBody.output_config = reasoningRequest.outputConfig
        } else if (protocol === 'openai_responses') {
          if (reasoningEffort && reasoningEffort !== 'none') requestBody.reasoning = { effort: reasoningEffort }
          requestBody.parallel_tool_calls = true
        } else {
          if (reasoningRequest?.thinking) requestBody.thinking = reasoningRequest.thinking
          if (reasoningRequest?.reasoningEffort && reasoningRequest.reasoningEffort !== 'none') requestBody.reasoning_effort = reasoningRequest.reasoningEffort
          if (reasoningRequest?.outputConfig) requestBody.output_config = reasoningRequest.outputConfig
          requestBody.parallel_tool_calls = true
        }
        if (requestTools.length === 0) {
          delete requestBody.tools
          delete requestBody.tool_choice
          delete requestBody.parallel_tool_calls
        }
        if (protocol !== 'anthropic_messages' && (provider === 'openai' || looksLikeResponsesPreferredModel(modelId))) {
          requestBody.prompt_cache_key = subAgentPromptCacheKey({
            definition,
            model: modelId,
            workspacePath,
            codemap,
            tools: strictFastContext ? availableTools : requestTools,
          })
          if (protocol === 'openai_responses' && /gpt-5\.5/i.test(modelId)) {
            requestBody.prompt_cache_retention = '24h'
          }
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
          const remainingRequestMs = requestDeadline - Date.now()
          if (remainingRequestMs <= 0) throw new Error(`Model request timed out after ${requestTimeoutMs}ms`)
          res = await fetchWithTransientRetry(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
          }, abortSignal, remainingRequestMs, (attempt, delayMs, reason) => {
            emit({ type: 'model_retry', turn, attempt, delayMs, reason })
          }, options.maxTransientAttempts ?? 4)
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
        const responseUsage = response?.usage || {}
        turnInputTokens = Number(responseUsage.input_tokens ?? responseUsage.prompt_tokens ?? 0) || 0
        turnOutputTokens = Number(responseUsage.output_tokens ?? responseUsage.completion_tokens ?? 0) || 0
        turnCacheReadTokens = Number(
          responseUsage.input_tokens_details?.cached_tokens
          ?? responseUsage.prompt_tokens_details?.cached_tokens
          ?? responseUsage.cache_read_input_tokens
          ?? 0,
        ) || 0
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
        rememberProtocol(activeProtocolCacheKey, protocol)
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
      const detail = formatSubAgentError(e)
      const message = /Model request timed out after \d+ms/i.test(detail)
        ? `Model request timed out after ${requestTimeoutMs}ms`
        : detail
      emit({ type: 'error', message })
      return { ok: false, turns: turn, elapsedMs: Date.now() - startedAt, error: message }
    } finally {
      clearInterval(waitTimer)
      modelElapsedMs = Date.now() - waitStartedAt
    }

    const submissionCalls = responseToolCalls.filter(call => call.function.name === 'submit_code_map')

    if (submissionCalls.length > 0) {
      const submission = submissionCalls[0]
      let submissionArgs: Record<string, any> = {}
      let submissionError = responseToolCalls.length === 1 ? '' : 'submit_code_map must be called alone, without retrieval tools'
      try {
        submissionArgs = JSON.parse(submission.function.arguments || '{}')
      } catch {
        submissionError = 'submit_code_map arguments are not valid JSON'
      }
      const report = parseSubmittedCodeMap(submissionArgs, workspacePath, evidenceLedger, options.maxCandidates)
      submissionError ||= validateSubmittedCodeMap(report, evidenceLedger) || ''
      submissionError ||= validateRequiredAuditPaths(report, options.requiredAuditPaths) || ''
      submissionError ||= validateRequiredCandidatePaths(report, options.requiredCandidatePaths) || ''
      if (!submissionError) {
        const finalText = renderSubmittedCodeMap(report)
        emit({ type: 'final', text: finalText })
        emit({
          type: 'turn_complete',
          turn,
          calls: 1,
          modelElapsedMs,
          toolElapsedMs: 0,
          totalElapsedMs: Date.now() - turnStartedAt,
          inputTokens: turnInputTokens,
          outputTokens: turnOutputTokens,
          cacheReadTokens: turnCacheReadTokens,
        })
        return { ok: true, turns: turn, elapsedMs: Date.now() - startedAt, finalText, evidence: collectedEvidence, codeMap: report }
      }
      submissionRejections = previousSubmissionError === submissionError ? submissionRejections + 1 : 1
      previousSubmissionError = submissionError
      if (submissionRejections >= 2 || turn >= turnLimit) {
        const error = `FastContext submission rejected: ${submissionError}`
        emit({ type: 'error', message: error })
        return {
          ok: false,
          turns: turn,
          elapsedMs: Date.now() - startedAt,
          evidence: collectedEvidence,
          codeMap: report.candidates.length > 0 ? report : undefined,
          truncated: true,
          error,
        }
      }
      messages.push({ role: 'assistant', content: messageText, tool_calls: [submission] })
      messages.push({ role: 'tool', tool_call_id: submission.id, content: `Rejected: ${submissionError}` })
      messages.push({
        role: 'user',
        content: 'Correct only the mechanical evidence error. Read a missing candidate only when the rejection identifies it; otherwise resubmit the grounded subset immediately.',
      })
      emit({ type: 'tool_result', tool: 'submit_code_map', ok: false, summary: submissionError, turn })
      emit({
        type: 'turn_complete',
        turn,
        calls: 1,
        modelElapsedMs,
        toolElapsedMs: 0,
        totalElapsedMs: Date.now() - turnStartedAt,
        inputTokens: turnInputTokens,
        outputTokens: turnOutputTokens,
        cacheReadTokens: turnCacheReadTokens,
      })
      continue
    }

    if (responseToolCalls.length === 0) {
      if (strictFastContext && collectedEvidence.length === 0 && !searchRecoveryUsed && turn < turnLimit) {
        messages.push({ role: 'assistant', content: messageText })
        messages.push({
          role: 'user',
          content: 'Recovery search: the first pass produced no concrete evidence. Rewrite the objective into exact identifiers, visible text, and likely file globs; run a different search strategy before concluding.',
        })
        searchRecoveryUsed = true
        continue
      }
      if (strictFastContext && !hasModelReadEvidence() && turn < turnLimit) {
        messages.push({ role: 'assistant', content: messageText })
        messages.push({
          role: 'user',
          content: 'Search snippets and paths are not proof. Read the strongest implementation ranges now, then follow only concrete symbols or paths exposed by that source.',
        })
        continue
      }
      if (strictFastContext && !reportRecoveryUsed && turn < turnLimit) {
        messages.push({ role: 'assistant', content: messageText })
        messages.push({
          role: 'user',
          content: 'Do not return a prose report. Finish by calling submit_code_map with evidence_ids from the ledger.',
        })
        reportRecoveryUsed = true
        continue
      }
      if (strictFastContext) {
        const error = 'FastContext ended without a valid submit_code_map call'
        emit({ type: 'error', message: error })
        return { ok: false, turns: turn, elapsedMs: Date.now() - startedAt, evidence: collectedEvidence, truncated: true, error }
      }
      emit({ type: 'final', text: messageText })
      emit({
        type: 'turn_complete',
        turn,
        calls: 0,
        modelElapsedMs,
        toolElapsedMs: 0,
        totalElapsedMs: Date.now() - turnStartedAt,
        inputTokens: turnInputTokens,
        outputTokens: turnOutputTokens,
        cacheReadTokens: turnCacheReadTokens,
      })
      return { ok: true, turns: turn, elapsedMs: Date.now() - startedAt, finalText: messageText, evidence: collectedEvidence }
    }

    const toolCalls = responseToolCalls.slice(0, definition.maxParallel)
    messages.push({ role: 'assistant', content: messageText, tool_calls: toolCalls })
    const entries = toolCalls.map(tc => {
      let args: Record<string, any> = {}
      try { args = JSON.parse(tc.function.arguments) } catch {}
      emit({ type: 'tool_call', tool: tc.function.name, args, turn })
      return { tc, args, signature: toolCallSignature(tc.function.name, args) }
    })
    const toolWaveStartedAt = Date.now()
    const batchedSearchResults = new Map<string, unknown>()
    const batchableSearchEntries = entries.filter(entry => entry.tc.function.name === 'search_content'
      && !toolResultCache.has(entry.signature)
      && buildSearchContentBatchRequest(entry.args, workspacePath))
    if (toolExecutor.searchContentBatch && batchableSearchEntries.length >= 2) {
      const requests = batchableSearchEntries
        .map(entry => buildSearchContentBatchRequest(entry.args, workspacePath))
        .filter((request): request is NonNullable<ReturnType<typeof buildSearchContentBatchRequest>> => Boolean(request))
      try {
        const pages = await toolExecutor.searchContentBatch(requests)
        pages.forEach((page, index) => {
          const entry = batchableSearchEntries[index]
          if (entry) batchedSearchResults.set(entry.tc.id, page)
        })
      } catch {}
    }
    const results = await Promise.all(entries.map(async entry => {
      const toolStartedAt = Date.now()
      const cached = toolResultCache.get(entry.signature)
      if (cached) return { entry, result: cached, reused: true, elapsedMs: 0 }
      if (abortSignal?.aborted) {
        return {
          entry,
          result: {
            ok: false,
            output: 'Aborted.',
            summary: `${entry.tc.function.name} aborted`,
            evidence: [],
          } satisfies ToolExecResult,
          reused: false,
          elapsedMs: Date.now() - toolStartedAt,
        }
      }
      try {
        const batchResult = batchedSearchResults.get(entry.tc.id)
        const executionArgs = batchResult ? { ...entry.args, __batch_result: batchResult } : entry.args
        const result = await executeSubAgentTool(entry.tc.function.name, executionArgs, workspacePath, toolExecutor)
        if (result.ok) toolResultCache.set(entry.signature, result)
        return { entry, result, reused: false, elapsedMs: Date.now() - toolStartedAt }
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
          reused: false,
          elapsedMs: Date.now() - toolStartedAt,
        }
      }
    }))

    for (const { entry, result, reused, elapsedMs } of results) {
      const { tc } = entry
      emit({
        type: 'tool_result',
        tool: tc.function.name,
        ok: result.ok,
        summary: reused ? `${result.summary} (cached exact repeat)` : result.summary,
        turn,
        elapsedMs,
        operations: reused ? 0 : result.operations ?? 1,
        readOperations: reused ? 0 : result.readOperations ?? 0,
      })

      for (const ev of result.evidence) {
        const registration = addEvidence(ev)
        if (registration.isNew) {
          emit({ type: 'evidence', evidence: ev })
        }
      }

      const stableOutput = boundToolOutput(tc.function.name, result.output)
      const handles = evidenceLedger.format(result.evidence.map(item => evidenceLedger.register(item).record))
      messages.push({
        role: 'tool' as any,
        tool_call_id: tc.id,
        content: [reused ? '[Cached exact repeat; no new execution.]' : '', stableOutput, handles].filter(Boolean).join('\n'),
      })
    }

    emit({
      type: 'turn_complete',
      turn,
      calls: results.length,
      modelElapsedMs,
      toolElapsedMs: Date.now() - toolWaveStartedAt,
      totalElapsedMs: Date.now() - turnStartedAt,
      inputTokens: turnInputTokens,
      outputTokens: turnOutputTokens,
      cacheReadTokens: turnCacheReadTokens,
    })


    if (strictFastContext && turn === turnLimit - 1) {
      messages.push({
        role: 'user',
        content: 'The hard safety limit allows one final provider turn. Call submit_code_map using only read-confirmed evidence. If the frontier is still materially open, fail explicitly rather than inventing completeness.',
      })
    }

  }

  if (strictFastContext) {
    const error = 'FastContext exhausted its turn budget without a valid evidence map'
    emit({ type: 'error', message: error })
    return { ok: false, turns: turn, elapsedMs: Date.now() - startedAt, evidence: collectedEvidence, truncated: true, error }
  }
  return { ok: true, turns: turn, elapsedMs: Date.now() - startedAt, evidence: collectedEvidence, truncated: turn >= turnLimit }
}

interface ToolExecResult {
  ok: boolean
  output: string
  summary: string
  evidence: SubAgentEvidence[]
  operations?: number
  readOperations?: number
}

function stableToolValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableToolValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableToolValue(entry)]))
}

function toolCallSignature(name: string, args: Record<string, any>): string {
  return `${name}:${JSON.stringify(stableToolValue(args))}`
}

function buildSearchContentBatchRequest(args: Record<string, any>, workspacePath: string) {
  const pattern = String(args.pattern || '').trim()
  if (!pattern) return null
  return {
    pattern,
    basePath: args.path ? resolveWorkspacePath(workspacePath, args.path) : workspacePath,
    filePattern: args.file_pattern,
    caseInsensitive: args.case_sensitive !== true,
    options: {
      offset: Math.max(0, Math.floor(Number(args.offset) || 0)),
      limit: Math.min(200, Math.max(1, Math.floor(Number(args.head_limit) || 40)) * 4),
      contextBefore: Math.max(0, Math.min(12, Math.floor(Number(args.context_before) || 0))),
      contextAfter: Math.max(0, Math.min(12, Math.floor(Number(args.context_after) || 0))),
      multiline: args.multiline === true,
      fileType: typeof args.file_type === 'string' ? args.file_type : undefined,
    },
  }
}

export function __testTraceDefinitionReadLimit(hit: {
  startLine?: number
  endLine?: number
  line?: number
  symbolKind?: string
}): number {
  const startLine = hit.startLine || hit.line || 1
  const endLine = hit.endLine || startLine
  const structuralDefinition = hit.symbolKind === 'class'
    || hit.symbolKind === 'interface'
    || hit.symbolKind === 'type'
    || hit.symbolKind === 'enum'
  return Math.min(220, Math.max(structuralDefinition ? 160 : 40, endLine - startLine + 24))
}

interface SubAgentSearchHit {
  file: string
  line: number
  text: string
  context?: string
}

function searchPathPriority(path: string): number {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  if (/(^|\/)(docs?|examples?|fixtures?|templates?|vendor|generated)(\/|$)/.test(normalized)) return 2
  if (/(^|\/)(__tests__|tests?|spec)(\/|$)|\.(?:test|spec)\.[^/]+$/.test(normalized)) return 1
  return 0
}

function diversifySearchHits(hits: SubAgentSearchHit[], limit: number): SubAgentSearchHit[] {
  const buckets = new Map<string, { priority: number; firstIndex: number; hits: SubAgentSearchHit[] }>()
  hits.forEach((hit, index) => {
    const path = hit.file.replace(/\\/g, '/')
    const bucket = buckets.get(path)
    if (bucket) bucket.hits.push(hit)
    else buckets.set(path, { priority: searchPathPriority(path), firstIndex: index, hits: [hit] })
  })
  const orderedBuckets = [...buckets.values()].sort((left, right) => left.priority - right.priority || left.firstIndex - right.firstIndex)
  const selected: SubAgentSearchHit[] = []
  for (let depth = 0; selected.length < limit && orderedBuckets.some(bucket => depth < bucket.hits.length); depth += 1) {
    for (const bucket of orderedBuckets) {
      const hit = bucket.hits[depth]
      if (hit) selected.push(hit)
      if (selected.length >= limit) break
    }
  }
  return selected
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
      const retrievalLimit = Math.min(200, headLimit * 4)
      let effectivePattern = pattern
      let res = args.__batch_result || (usingPagedSearch
        ? await executor.searchContentPage!(pattern, basePath, filePattern, caseInsensitive, {
            offset,
            limit: retrievalLimit,
            contextBefore,
            contextAfter,
            multiline: args.multiline === true,
            fileType: typeof args.file_type === 'string' ? args.file_type : undefined,
          })
        : await executor.searchContent(pattern, basePath, filePattern, caseInsensitive))
      if (!res.success && /regex parse error|invalid regular expression|unclosed (?:group|class)|unterminated/i.test(res.error || '')) {
        effectivePattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        res = usingPagedSearch
          ? await executor.searchContentPage!(effectivePattern, basePath, filePattern, caseInsensitive, {
              offset,
              limit: retrievalLimit,
              contextBefore,
              contextAfter,
              multiline: false,
              fileType: typeof args.file_type === 'string' ? args.file_type : undefined,
            })
          : await executor.searchContent(effectivePattern, basePath, filePattern, caseInsensitive)
      }
      if (!res.success) {
        const error = res.error || 'unknown search error'
        return { ok: false, output: `Search failed: ${error}`, summary: `grep "${pattern}" failed: ${error}`, evidence }
      }
      const page = usingPagedSearch
        ? res.data as { hits?: SubAgentSearchHit[]; totalMatches?: number; truncated?: boolean }
        : { hits: Array.isArray(res.data) ? res.data : [], totalMatches: Array.isArray(res.data) ? res.data.length : 0, truncated: false }
      const pageHits = page.hits || []
      if (pageHits.length === 0) {
        return { ok: true, output: 'No matches found.', summary: `grep "${pattern}" → 0 hits`, evidence }
      }
      const hits = diversifySearchHits(pageHits, headLimit)
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
          reason: `grep: ${effectivePattern}`,
        })
      }
      if (page.truncated) lines.push(`[More matches available. Continue with offset=${offset + pageHits.length}.]`)
      return { ok: true, output: lines.join('\n'), summary: `grep "${pattern}" → ${hits.length} hits`, evidence }
    }

    case 'read_file': {
      const requestedPath = String(args.path || '').trim()
      if (!requestedPath) {
        return { ok: false, output: 'File path is required.', summary: 'read failed: missing path', evidence }
      }
      const offset = Math.max(0, Math.floor(Number(args.offset) || 1) - 1)
      const limit = Math.max(1, Math.min(400, Math.floor(Number(args.limit) || 80)))
      const readPath = async (path: string) => {
        const filePath = resolveWorkspacePath(workspacePath, path)
        const rangeResult = executor.readFileRange
          ? await executor.readFileRange(filePath, offset, limit)
          : null
        return { path, filePath, rangeResult, res: rangeResult || await executor.readFile(filePath) }
      }
      let read = await readPath(requestedPath)
      let recoveryOperations = 0
      if (!read.res.success || !read.res.data) {
        const normalized = requestedPath.replace(/\\/g, '/').replace(/^\.\//, '')
        const collapsedModule = normalized.replace(/\/(?:__init__|index)(\.[^/.]+)$/i, '$1')
        if (collapsedModule !== normalized) {
          const collapsedRead = await readPath(collapsedModule)
          recoveryOperations += 1
          if (collapsedRead.res.success && collapsedRead.res.data) read = collapsedRead
        }
        if (!read.res.success || !read.res.data) {
          const basename = normalized.split('/').pop() || normalized
          const matches = await executor.searchFiles(`**/${basename}`, workspacePath)
          recoveryOperations += 1
          const candidates = matches.success ? matches.data?.matches || [] : []
          if (candidates.length === 1) read = await readPath(toWorkspaceRelative(workspacePath, candidates[0]))
        }
      }
      const { rangeResult, res } = read
      const relativePath = toWorkspaceRelative(workspacePath, read.filePath)
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
        content: slice.join('\n').slice(0, 20_000),
        reason: 'file read',
      })
      const outputLines = slice.map((line, index) => `${offset + index + 1} | ${line}`)
      if (rangeData?.truncated) outputLines.push(`[More lines available. Continue with offset=${offset + slice.length + 1}.]`)
      const recovered = relativePath.replace(/\\/g, '/').toLowerCase() !== requestedPath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
      return {
        ok: true,
        output: `${recovered ? `[Resolved requested path ${requestedPath} -> ${relativePath}]\n` : ''}${outputLines.join('\n')}`,
        summary: `read ${relativePath}:${offset + 1}-${offset + slice.length}${recovered ? ' (resolved missing path)' : ''}`,
        evidence,
        operations: 1 + recoveryOperations,
        readOperations: 1,
      }
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

    case 'search_symbol':
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
