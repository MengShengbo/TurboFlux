import { basename, isAbsolute, join, relative } from 'path'
import type { CodeMapNode, CodeSearchHit } from '../shared/codeIndexTypes'
import type { SubAgentEvent, SubAgentEvidence, SubAgentDefinition } from '../shared/subAgentTypes'
import type { NativeReasoningConfig } from '../shared/agentTypes'
import type { ToolExecutor } from '../tools/executor'
import type { ModelCapabilities } from './config'
import { FAST_CONTEXT_TUNING } from './fastContextTypes'
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
    description: 'Architecture-level code map for large repositories with grounded ownership, execution relationships, and change-impact candidates.',
    driver: 'main-model',
    systemPrompt: buildFastContextSystemPrompt(),
    maxTurns: FAST_CONTEXT_TUNING.maxTurns,
    maxParallel: FAST_CONTEXT_TUNING.maxParallel,
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

export function buildFastContextSystemPrompt(): string {
  return `You are FastContext, a read-only architecture intelligence subagent for large repositories. You own all semantic query planning, evidence selection, relationship tracing, and role assignment; local tools only execute the exact searches and reads you request. Your job is to produce an architecture-level code map grounded in files and line ranges, not merely locate one likely implementation.

Completion contract: trace the caller-to-core-to-state/config/persistence flow, map the change-impact frontier across modules and implementation families, inspect behavior-bearing mirrors and contracts, verify failure paths, and actively search for evidence that disproves the leading interpretation. Finding the first core file is the start of exploration, never the stopping condition.

Tools:
- search_content(pattern, path?, file_pattern?, case_sensitive?)
- search_files(pattern)
- search_symbols(query, path?, symbol_kind?)
- trace_symbol(query, path?)
- get_codemap(query, path?)
- read_file(path, offset?, limit?)
- submit_code_map(candidates, relationships, rejected_hypotheses, searches_tried, uncertainty)

Strategy:
1. Before the first tool wave, rewrite the objective into independent query groups: exact lexical anchors, likely ownership modules, runtime/state relationships, and change-impact propagation paths.
2. Run independent searches in parallel. Use search_symbols for declarations, trace_symbol for a definition plus references in one call, search_content for literals, search_files for naming hypotheses, and get_codemap only as orientation.
3. Start with your own search wave, refine it from returned evidence, and read the strongest source slices yourself before ranking candidates.
4. Trace relationships, not just mentions: entry/caller -> implementation -> state/config/persistence -> output/error path. Identify ownership boundaries and explain how data and control cross them.
5. As soon as a search reveals the probable execution core, read that implementation before spending more turns on peripheral files. A search-confirmed core is not enough when it can still be read.
6. After confirming a likely implementation, check exact-filename and symbol twins across package, platform, generated, vendored, or compatibility source trees. Read and rank each behavior-bearing mirror that would require the same change; reject stubs or generated copies explicitly.
7. Census the implementation family. When behavior is split across a pipeline or one directory contains phase modules, inspect sibling filenames plus the dispatcher/index that wires them. Do not stop after one stage when validation, authorization, integration, response, permission, serialization, or platform adapters may require coordinated edits.
8. Estimate the change-impact frontier before submission. For each confirmed owner or implementation, inspect its direct callers, contracts/interfaces, schema/config sources, platform/package variants, and state or persistence collaborators. Explicitly reject edges that do not require edits.
9. Disprove attractive false positives. Documentation, index barrels, tests, and generic entry files rank below concrete runtime implementations unless the objective specifically asks for them.
10. Audit residual uncertainty. If a search result or relationship points to a named likely owner, mirror, contract, implementation, or direct collaborator that you have not read, read it now. Residual uncertainty is for ambiguity that cannot be removed with an available targeted read, not for known high-signal paths you skipped.
11. Finish only by calling submit_code_map. Submit up to ten read-confirmed architecture nodes, a grounded relationship map, rejected hypotheses, searches tried, and residual uncertainty. Do not return a prose report instead.

Map contract:
- Rank candidates strictly by direct edit necessity: the most likely behavior owner or implementation that must change is first. Put architectural context in relationships instead of ranking a consumer or supporting file above the probable edit target.
- Before submission, audit every read file that contains behavior directly relevant to the objective. Include it as a candidate or name it in rejected_hypotheses with the concrete reason it does not require an edit.
- Include the owner, behavior-bearing mirrors, implementations, direct consumers, contracts, state/config/persistence collaborators, and tests only when they define the execution path or change-impact frontier.
- Set edit_kind for every candidate: owner, mirror, implementation, consumer, test, or supporting. This describes the node's role; it is not a substitute for grounded edges.
- Every edge must explain a concrete control, data, ownership, state, configuration, persistence, compatibility, or failure relationship.

Rules:
- Never describe files you have not read.
- Every candidate and relationship must cite a path and line range covered by a read_file result from this run.
- Prioritize source, entry, schema/config, and failing-path files over README-style context.
- Include files that implement, configure, propagate, persist, or verify the behavior only when they add a necessary node or edge to the map.
- Prefer narrow, targeted reads (offset+limit) over full-file reads.
- Keep the result within ten candidates, but never omit a read-confirmed behavior-bearing mirror or pipeline stage merely to make the map shorter.
- Use search_content pagination and context windows when a broad query is truncated or crowded.
- If the objective contains Chinese or mixed UI text, search both exact text and nearby component/style naming guesses.
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
  retrievalContext?: string
  initialEvidence?: SubAgentEvidence[]
  requiredAuditPaths?: string[]
  requiredCandidatePaths?: string[]
  requireGroundedReport?: boolean
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
  role: string
  editKind: 'owner' | 'mirror' | 'implementation' | 'consumer' | 'test' | 'supporting'
  confidence: 'high' | 'medium' | 'low'
  why: string
}

export interface SubmittedRelationship {
  from: string
  to: string
  relationship: string
  evidencePath: string
  startLine: number
  endLine: number
}

export interface SubmittedCodeMap {
  candidates: SubmittedCandidate[]
  relationships: SubmittedRelationship[]
  rejectedHypotheses: string[]
  searchesTried: string[]
  uncertainty: string[]
}

type SubAgentMessage = { role: string; content: string; tool_calls?: ToolCallRequest[]; tool_call_id?: string }

function compactToolHistory(
  messages: SubAgentMessage[],
  evidence: SubAgentEvidence[],
  finalizationOnly: boolean,
): SubAgentMessage[] {
  let latestToolWave = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant' && messages[index].tool_calls?.length) {
      latestToolWave = index
      break
    }
  }
  const compacted = messages.map((message, index) => {
    if (message.role !== 'tool' || (!finalizationOnly && index > latestToolWave) || message.content.length <= 1_600) return message
    return {
      ...message,
      content: `${message.content.slice(0, 1_100)}\n...[older tool output compacted]...\n${message.content.slice(-300)}`,
    }
  })
  if (!finalizationOnly) return compacted
  const ledger = evidence
    .filter(item => item.reason === 'file read')
    .map(item => `${item.path}:${item.startLine}-${item.endLine} | ${item.preview.replace(/\s+/g, ' ').slice(0, 180)}`)
    .filter((line, index, all) => all.indexOf(line) === index)
    .slice(0, 40)
  if (ledger.length === 0) return compacted
  return [...compacted, {
    role: 'user',
    content: `FINAL READ-EVIDENCE LEDGER\n${ledger.join('\n')}\nUse only these read-confirmed ranges in submit_code_map.`,
  }]
}

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

function stringList(value: unknown, maxItems: number, maxLength = 240): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map(item => String(item || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map(item => item.slice(0, maxLength))
}

function positiveLine(value: unknown, fallback = 1): number {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
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

function parseSubmittedCodeMap(value: Record<string, any>, workspacePath: string): SubmittedCodeMap {
  const candidates = Array.isArray(value.candidates)
    ? value.candidates.slice(0, 10).map((candidate: Record<string, any>) => {
        const startLine = positiveLine(candidate.start_line ?? candidate.startLine)
        const role = String(candidate.role || '').replace(/\s+/g, ' ').trim().slice(0, 80)
        return {
          path: toWorkspaceRelative(workspacePath, String(candidate.path || '').trim()),
          startLine,
          endLine: Math.max(startLine, positiveLine(candidate.end_line ?? candidate.endLine, startLine)),
          role,
          editKind: normalizeEditKind(candidate.edit_kind ?? candidate.editKind, role.toLowerCase()),
          confidence: ['high', 'medium', 'low'].includes(candidate.confidence) ? candidate.confidence : 'medium',
          why: String(candidate.why || '').replace(/\s+/g, ' ').trim().slice(0, 320),
        } satisfies SubmittedCandidate
      })
    : []
  const relationships = Array.isArray(value.relationships)
    ? value.relationships.slice(0, 12).map((relationship: Record<string, any>) => {
        const startLine = positiveLine(relationship.start_line ?? relationship.startLine)
        return {
          from: String(relationship.from || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          to: String(relationship.to || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          relationship: String(relationship.relationship || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          evidencePath: toWorkspaceRelative(workspacePath, String(relationship.evidence_path ?? relationship.evidencePath ?? '').trim()),
          startLine,
          endLine: Math.max(startLine, positiveLine(relationship.end_line ?? relationship.endLine, startLine)),
        } satisfies SubmittedRelationship
      })
    : []
  return {
    candidates,
    relationships,
    rejectedHypotheses: stringList(value.rejected_hypotheses ?? value.rejectedHypotheses, 8),
    searchesTried: stringList(value.searches_tried ?? value.searchesTried, 12),
    uncertainty: stringList(value.uncertainty, 8),
  }
}

interface LineRange {
  startLine: number
  endLine: number
}

function mergedReadRanges(path: string, evidence: SubAgentEvidence[]): LineRange[] {
  const normalizedPath = path.replace(/\\/g, '/')
  const ranges = evidence
    .filter(item => item.reason === 'file read' && item.path.replace(/\\/g, '/') === normalizedPath)
    .map(item => ({ startLine: item.startLine, endLine: item.endLine }))
    .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine)
  const merged: LineRange[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (!previous || range.startLine > previous.endLine + 1) {
      merged.push({ ...range })
      continue
    }
    previous.endLine = Math.max(previous.endLine, range.endLine)
  }
  return merged
}

function rangeIsRead(path: string, startLine: number, endLine: number, evidence: SubAgentEvidence[]): boolean {
  return mergedReadRanges(path, evidence).some(range => startLine >= range.startLine && endLine <= range.endLine)
}

function readRangesForPath(path: string, evidence: SubAgentEvidence[]): string {
  const ranges = mergedReadRanges(path, evidence).map(item => `${item.startLine}-${item.endLine}`)
  return ranges.length > 0 ? ranges.join(', ') : 'none'
}

function clampNearReadBoundary(path: string, startLine: number, endLine: number, evidence: SubAgentEvidence[]): LineRange | null {
  const overlaps = mergedReadRanges(path, evidence)
    .map(range => ({
      startLine: Math.max(startLine, range.startLine),
      endLine: Math.min(endLine, range.endLine),
    }))
    .filter(range => range.startLine <= range.endLine)
    .sort((left, right) => (right.endLine - right.startLine) - (left.endLine - left.startLine))
  const best = overlaps[0]
  if (!best) return null
  const requestedLength = endLine - startLine + 1
  const coveredLength = best.endLine - best.startLine + 1
  const outsideLines = requestedLength - coveredLength
  if (outsideLines > 2 || coveredLength / requestedLength < 0.8) return null
  return best
}

function normalizeSubmittedCodeMap(report: SubmittedCodeMap, evidence: SubAgentEvidence[]): void {
  const normalizeRange = (item: { path?: string; evidencePath?: string; startLine: number; endLine: number }): void => {
    const path = item.path || item.evidencePath || ''
    if (!path || rangeIsRead(path, item.startLine, item.endLine, evidence)) return
    const grounded = clampNearReadBoundary(path, item.startLine, item.endLine, evidence)
    if (!grounded) return
    item.startLine = grounded.startLine
    item.endLine = grounded.endLine
  }
  report.candidates.forEach(normalizeRange)
  report.relationships.forEach(normalizeRange)
}

function pruneUngroundedCodeMap(report: SubmittedCodeMap, evidence: SubAgentEvidence[]): void {
  const candidateCount = report.candidates.length
  const relationshipCount = report.relationships.length
  report.candidates = report.candidates.filter(candidate => Boolean(candidate.path && candidate.role && candidate.why)
    && rangeIsRead(candidate.path, candidate.startLine, candidate.endLine, evidence))
  report.relationships = report.relationships.filter(relationship => Boolean(
    relationship.from && relationship.to && relationship.relationship && relationship.evidencePath,
  ) && rangeIsRead(relationship.evidencePath, relationship.startLine, relationship.endLine, evidence))
  const removedCandidates = candidateCount - report.candidates.length
  const removedRelationships = relationshipCount - report.relationships.length
  if (removedCandidates > 0 || removedRelationships > 0) {
    report.uncertainty.push(`evidence gate excluded ${removedCandidates} ungrounded candidate(s) and ${removedRelationships} ungrounded relationship(s)`)
  }
}

function sortSubmittedCandidates(report: SubmittedCodeMap): void {
  const priority: Record<SubmittedCandidate['editKind'], number> = {
    owner: 0,
    mirror: 1,
    implementation: 2,
    consumer: 3,
    test: 4,
    supporting: 5,
  }
  const confidencePriority: Record<SubmittedCandidate['confidence'], number> = { high: 0, medium: 1, low: 2 }
  report.candidates = report.candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => priority[left.candidate.editKind] - priority[right.candidate.editKind]
      || confidencePriority[left.candidate.confidence] - confidencePriority[right.candidate.confidence]
      || left.index - right.index)
    .map(item => item.candidate)
}

function validateSubmittedCodeMap(report: SubmittedCodeMap, evidence: SubAgentEvidence[]): string | null {
  if (report.candidates.length === 0) return 'at least one grounded architecture node is required'
  for (const candidate of report.candidates) {
    if (!candidate.path || !candidate.role || !candidate.why) return 'every candidate requires path, role, and why'
    if (!rangeIsRead(candidate.path, candidate.startLine, candidate.endLine, evidence)) {
      return `candidate ${candidate.path}:${candidate.startLine}-${candidate.endLine} is not covered by a read_file result; covered ranges for this path: ${readRangesForPath(candidate.path, evidence)}`
    }
  }
  for (const relationship of report.relationships) {
    if (!relationship.from || !relationship.to || !relationship.relationship || !relationship.evidencePath) {
      return 'every relationship requires from, to, relationship, and evidence_path'
    }
    if (!rangeIsRead(relationship.evidencePath, relationship.startLine, relationship.endLine, evidence)) {
      return `relationship evidence ${relationship.evidencePath}:${relationship.startLine}-${relationship.endLine} is not covered by a read_file result; covered ranges for this path: ${readRangesForPath(relationship.evidencePath, evidence)}`
    }
  }
  if (report.relationships.length === 0) return 'FastContext requires at least one grounded architecture relationship'
  if (report.searchesTried.length === 0) return 'searches_tried must describe at least one query strategy'
  if (report.uncertainty.length === 0) return 'uncertainty must contain residual uncertainty or "none"'
  return null
}

function validateRequiredAuditPaths(report: SubmittedCodeMap, requiredPaths: string[] | undefined): string | null {
  if (!requiredPaths?.length) return null
  const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase()
  const submitted = new Set(report.candidates.map(candidate => normalize(candidate.path)))
  const rejected = report.rejectedHypotheses.map(item => normalize(item))
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
  const lines = ['RANKED_CODE_MAP']
  report.candidates.forEach((candidate, index) => {
    lines.push(`${index + 1}. ${candidate.path} L${candidate.startLine}-L${candidate.endLine} kind=${candidate.editKind} role=${candidate.role} confidence=${candidate.confidence}`)
    lines.push(`   why: ${candidate.why}`)
  })
  lines.push('', 'EXECUTION_FLOW')
  report.relationships.forEach(item => lines.push(`- ${item.from} -> ${item.to} [${item.relationship}] (${item.evidencePath}:L${item.startLine}-L${item.endLine})`))
  lines.push('', 'REJECTED_HYPOTHESES')
  lines.push(...(report.rejectedHypotheses.length > 0 ? report.rejectedHypotheses.map(item => `- ${item}`) : ['- none']))
  lines.push('', 'SEARCHES_TRIED', ...report.searchesTried.map(item => `- ${item}`))
  lines.push('', 'UNCERTAINTY', ...report.uncertainty.map(item => `- ${item}`))
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
    content: [
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
        name: 'trace_symbol',
        description: 'Inspect graph-indexed declarations and exact references together with bounded source evidence for the strongest definitions and callers. Prefer this after a likely core symbol appears.',
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
        description: 'Search fused exact declarations and persistent graph symbols such as functions, classes, interfaces, types, constants, and components',
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
        description: 'Submit the final grounded FastContext architecture map. Call this alone after reading the evidence required by the architecture contract.',
        parameters: {
          type: 'object',
          properties: {
            candidates: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  start_line: { type: 'number' },
                  end_line: { type: 'number' },
                  role: { type: 'string' },
                  edit_kind: { type: 'string', enum: ['owner', 'mirror', 'implementation', 'consumer', 'test', 'supporting'] },
                  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                  why: { type: 'string' },
                },
                required: ['path', 'start_line', 'end_line', 'role', 'edit_kind', 'confidence', 'why'],
              },
            },
            relationships: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  from: { type: 'string' },
                  to: { type: 'string' },
                  relationship: { type: 'string' },
                  evidence_path: { type: 'string' },
                  start_line: { type: 'number' },
                  end_line: { type: 'number' },
                },
                required: ['from', 'to', 'relationship', 'evidence_path', 'start_line', 'end_line'],
              },
            },
            rejected_hypotheses: { type: 'array', items: { type: 'string' } },
            searches_tried: { type: 'array', items: { type: 'string' } },
            uncertainty: { type: 'array', items: { type: 'string' } },
          },
          required: ['candidates', 'relationships', 'rejected_hypotheses', 'searches_tried', 'uncertainty'],
        },
      },
    })
  }

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
  let submissionRecoveryUsed = false
  let evidenceSaturationPrompted = false
  let resolvedProtocol: ModelProtocol | null = null
  const strictFastContext = isFastContextDefinition && options.requireGroundedReport === true
  let turnLimit = definition.maxTurns

  const addEvidence = (evidence: SubAgentEvidence): void => {
    const key = `${evidence.path}:${evidence.startLine}-${evidence.endLine}:${evidence.reason}`
    if (evidenceKeys.has(key)) return
    evidenceKeys.add(key)
    collectedEvidence.push(evidence)
  }

  const hasModelReadEvidence = (): boolean => collectedEvidence.some(evidence => evidence.reason === 'file read')

  while (turn < turnLimit) {
    if (abortSignal?.aborted) break
    turn++
    emit({ type: 'turn_start', turn, maxTurns: turnLimit })

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
        const finalizationOnly = strictFastContext && turn === turnLimit && hasModelReadEvidence()
        const activeSystemPrompt = definition.systemPrompt
        const activeMessages = compactToolHistory(messages, collectedEvidence, finalizationOnly)
        const requestMessages = activeMessages.map(message => ({ ...message })) as Array<Record<string, unknown>>
        const requestTools = finalizationOnly ? tools.filter(tool => tool.function.name === 'submit_code_map') : tools
        const requestBody: Record<string, unknown> = protocol === 'anthropic_messages'
          ? {
              model: modelId,
              system: activeSystemPrompt,
              messages: toAnthropicMessages(activeMessages),
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
      const report = parseSubmittedCodeMap(submissionArgs, workspacePath)
      normalizeSubmittedCodeMap(report, collectedEvidence)
      pruneUngroundedCodeMap(report, collectedEvidence)
      sortSubmittedCandidates(report)
      submissionError ||= validateSubmittedCodeMap(report, collectedEvidence) || ''
      submissionError ||= validateRequiredAuditPaths(report, options.requiredAuditPaths) || ''
      submissionError ||= validateRequiredCandidatePaths(report, options.requiredCandidatePaths) || ''
      if (!submissionError) {
        const finalText = renderSubmittedCodeMap(report)
        emit({ type: 'final', text: finalText })
        emit({ type: 'turn_complete', turn, calls: 1 })
        return { ok: true, turns: turn, elapsedMs: Date.now() - startedAt, finalText, evidence: collectedEvidence, codeMap: report }
      }
      if (submissionRecoveryUsed) {
        const error = `FastContext submission rejected: ${submissionError}`
        emit({ type: 'error', message: error })
        return { ok: false, turns: turn, elapsedMs: Date.now() - startedAt, evidence: collectedEvidence, truncated: true, error }
      }
      if (turn >= turnLimit) turnLimit += 1
      messages.push({ role: 'assistant', content: messageText, tool_calls: [submission] })
      messages.push({ role: 'tool', tool_call_id: submission.id, content: `Rejected: ${submissionError}` })
      messages.push({
        role: 'user',
        content: 'Correct the grounded evidence map and call submit_code_map again. Retrieve or read only if the rejection identifies missing evidence.',
      })
      submissionRecoveryUsed = true
      emit({ type: 'tool_result', tool: 'submit_code_map', ok: false, summary: submissionError, turn })
      emit({ type: 'turn_complete', turn, calls: 1 })
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
          content: 'Search snippets and paths are not proof. Read the strongest implementation ranges now, then trace the relationships required by the architecture contract.',
        })
        continue
      }
      if (strictFastContext && !reportRecoveryUsed && turn < turnLimit) {
        messages.push({ role: 'assistant', content: messageText })
        messages.push({
          role: 'user',
          content: 'Do not return a prose report. Finish by calling submit_code_map with only read-confirmed candidates and relationships.',
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
      emit({ type: 'turn_complete', turn, calls: 0 })
      return { ok: true, turns: turn, elapsedMs: Date.now() - startedAt, finalText: messageText, evidence: collectedEvidence }
    }

    const toolCalls = responseToolCalls.slice(0, definition.maxParallel)
    messages.push({ role: 'assistant', content: messageText, tool_calls: toolCalls })
    const entries = toolCalls.map(tc => {
      let args: Record<string, any> = {}
      try { args = JSON.parse(tc.function.arguments) } catch {}
      emit({ type: 'tool_call', tool: tc.function.name, args, turn })
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

    const readEvidencePaths = new Set(collectedEvidence
      .filter(evidence => evidence.reason === 'file read')
      .map(evidence => evidence.path.toLowerCase()))
    if (strictFastContext && !evidenceSaturationPrompted && turn >= 4 && readEvidencePaths.size >= 6 && turn < turnLimit - 1) {
      messages.push({
        role: 'user',
        content: `You now have read-confirmed evidence from ${readEvidencePaths.size} files. On the next turn, submit the ranked code map unless one specific unresolved owner, mirror, or failure edge still requires a targeted read. Do not broaden the search generically.`,
      })
      evidenceSaturationPrompted = true
    }

    emit({ type: 'turn_complete', turn, calls: results.length })

    if (strictFastContext && turn === turnLimit - 1) {
      messages.push({
        role: 'user',
        content: 'One turn remains. Call submit_code_map now using only read-confirmed evidence. Do not call more retrieval tools.',
      })
    }

    if (
      isFastContextDefinition
      && results.length > 0
      && results.every(({ result }) => result.ok)
      && results.every(({ result }) => result.evidence.length === 0)
      && !searchRecoveryUsed
      && turn < turnLimit
    ) {
      messages.push({
        role: 'user',
        content: 'The last search wave returned no matches. Rewrite the query once using narrower and broader variants, related filenames, symbols, and visible text; do not conclude until one alternate search has run.',
      })
      searchRecoveryUsed = true
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
}

const GENERIC_TWIN_FILENAMES = new Set([
  'index.js', 'index.jsx', 'index.ts', 'index.tsx', 'main.js', 'main.ts',
  'mod.rs', 'lib.rs', '__init__.py', 'package.json', 'readme.md',
])

async function findPathTwinHints(path: string, workspacePath: string, executor: ToolExecutor): Promise<string[]> {
  const filename = basename(path).toLowerCase()
  if (!filename || GENERIC_TWIN_FILENAMES.has(filename)) return []
  try {
    const result = await executor.searchFiles(`**/${basename(path)}`, workspacePath)
    if (!result.success || !result.data || result.data.truncated) return []
    const matches = [...new Set(result.data.matches.map(match => toWorkspaceRelative(workspacePath, match)))]
      .filter(match => match.replace(/\\/g, '/') !== path.replace(/\\/g, '/'))
    return matches.length <= 8 ? matches : []
  } catch {
    return []
  }
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
      const res = usingPagedSearch
        ? await executor.searchContentPage!(pattern, basePath, filePattern, caseInsensitive, {
            offset,
            limit: retrievalLimit,
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
          reason: `grep: ${pattern}`,
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
        content: slice.join('\n').slice(0, 20_000),
        reason: 'file read',
      })
      const outputLines = slice.map((line, index) => `${offset + index + 1} | ${line}`)
      if (rangeData?.truncated) outputLines.push(`[More lines available. Continue with offset=${offset + slice.length + 1}.]`)
      const pathTwins = await findPathTwinHints(relativePath, workspacePath, executor)
      if (pathTwins.length > 0) {
        outputLines.push(`[Same-name source candidates: ${pathTwins.join(', ')}. Read behavior-bearing platform/package mirrors before final ranking; ignore stubs and generated copies that do not require edits.]`)
      }
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

    case 'trace_symbol': {
      const query = String(args.query || '').trim()
      if (!query) return { ok: false, output: 'Symbol query is required.', summary: 'trace skipped: missing symbol', evidence }
      const basePath = args.path ? resolveWorkspacePath(workspacePath, args.path) : workspacePath
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pattern = /^[A-Za-z_$][\w$]*$/.test(query) ? `\\b${escaped}\\b` : escaped
      const [symbolResult, referenceResult] = await Promise.all([
        executor.searchCodeSymbols({ workspacePath, query, path: typeof args.path === 'string' ? args.path : undefined, limit: 12 }),
        executor.searchContentPage
          ? executor.searchContentPage(pattern, basePath, undefined, false, { limit: 30, contextBefore: 1, contextAfter: 1 })
          : executor.searchContent(pattern, basePath, undefined, false),
      ])
      const symbolHits = normalizeCodeSearchHits(symbolResult.data).slice(0, 10)
      const referencePage = referenceResult.data as { hits?: Array<{ file: string; line: number; text: string; context?: string }> } | Array<{ file: string; line: number; text: string; context?: string }> | undefined
      const referenceHits = diversifySearchHits(Array.isArray(referencePage) ? referencePage : referencePage?.hits || [], 30)
      if (!symbolResult.success && !referenceResult.success) {
        const error = symbolResult.error || referenceResult.error || 'symbol trace failed'
        return { ok: false, output: `Symbol trace failed: ${error}`, summary: `trace "${query}" failed`, evidence }
      }
      const lines: string[] = ['DEFINITIONS']
      for (const hit of symbolHits) {
        const relPath = toWorkspaceRelative(workspacePath, hit.path)
        const line = hit.startLine || hit.line || 1
        lines.push(`${relPath}:${line}: ${hit.title} (${hit.symbolKind || hit.source}) ${hit.preview || hit.subtitle || ''}`.trim())
        evidence.push({
          path: relPath,
          startLine: line,
          endLine: hit.endLine || line,
          preview: hit.preview || hit.subtitle || hit.title,
          reason: `symbol: ${query}`,
          symbol: hit.symbolName || hit.title,
        })
      }
      lines.push('REFERENCES')
      for (const hit of referenceHits) {
        const relPath = toWorkspaceRelative(workspacePath, hit.file)
        lines.push(`${relPath}:${hit.line}: ${hit.text}`)
        evidence.push({
          path: relPath,
          startLine: Math.max(1, hit.line - 1),
          endLine: hit.line + 1,
          preview: hit.text,
          reason: `reference: ${query}`,
          symbol: query,
        })
      }
      const definitionPaths = new Set<string>()
      const readTargets: Array<{ path: string; offset: number; limit: number; label: string }> = []
      for (const hit of symbolHits) {
        const relPath = toWorkspaceRelative(workspacePath, hit.path)
        const key = relPath.toLowerCase()
        if (definitionPaths.has(key) || readTargets.length >= 4) continue
        definitionPaths.add(key)
        const startLine = hit.startLine || hit.line || 1
        const endLine = hit.endLine || startLine
        const offset = Math.max(1, startLine - 6)
        readTargets.push({
          path: relPath,
          offset,
          limit: Math.min(100, Math.max(40, endLine - offset + 24)),
          label: `definition ${hit.title}`,
        })
      }
      const referencePaths = new Set<string>()
      for (const hit of referenceHits) {
        const relPath = toWorkspaceRelative(workspacePath, hit.file)
        const key = relPath.toLowerCase()
        if (definitionPaths.has(key) || referencePaths.has(key) || referencePaths.size >= 2) continue
        referencePaths.add(key)
        readTargets.push({
          path: relPath,
          offset: Math.max(1, hit.line - 12),
          limit: 36,
          label: `reference ${query}`,
        })
      }
      const readResults = await Promise.all(readTargets.map(async target => ({
        target,
        result: await executeSubAgentTool('read_file', {
          path: target.path,
          offset: target.offset,
          limit: target.limit,
        }, workspacePath, executor),
      })))
      const successfulReads = readResults.filter(item => item.result.ok && item.result.evidence.some(item => item.reason === 'file read'))
      if (successfulReads.length > 0) {
        lines.push('SOURCE_EVIDENCE')
        for (const item of successfulReads) {
          lines.push(`[${item.target.label}]`)
          lines.push(item.result.output)
          for (const readEvidence of item.result.evidence) evidence.push(readEvidence)
        }
      }
      if (symbolHits.length === 0) lines.splice(1, 0, '- none')
      if (referenceHits.length === 0) lines.push('- none')
      return {
        ok: true,
        output: lines.join('\n'),
        summary: `trace "${query}" -> ${symbolHits.length} definition(s), ${referenceHits.length} reference(s), ${successfulReads.length} source slice(s)`,
        evidence,
      }
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
