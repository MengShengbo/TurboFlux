import { isAbsolute, join, relative } from 'path'
import type { CodeMapNode, CodeSearchHit } from '../shared/codeIndexTypes'
import type { SubAgentEvent, SubAgentEvidence, SubAgentDefinition } from '../shared/subAgentTypes'
import type { ToolExecutor } from '../tools/executor'
import { loadAgentsFromDir, type LoadedAgent } from './agents/loader'
import type { SkillRuntime } from './skills/runtime'
import type { LoadedSkill } from './skills/loader'
import { normalizeBaseUrl } from './normalizeBaseUrl'

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
    systemPrompt: FAST_CONTEXT_SYSTEM_PROMPT(),
    maxTurns: 3,
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

function FAST_CONTEXT_SYSTEM_PROMPT(): string {
  return `You are FastContext, a read-only code exploration subagent for large repositories. Local code does not decide meaning; you do. Your job is to plan searches, run tools in parallel, read high-signal slices, and return a compact ranked code map grounded in files and line ranges.

Tools:
- search_content(pattern, path?, file_pattern?, case_sensitive?)
- search_files(pattern)
- search_symbols(query, path?, symbol_kind?)
- get_codemap(query, path?)
- read_file(path, offset?, limit?)

Strategy:
1. Plan semantically from the objective. Infer likely visible text, symbols, routes, components, style classes, file globs, and aliases. Do not rely on fixed trigger words.
2. Run independent searches in parallel. Use search_symbols for code names, search_content for visible text/literals, search_files for likely filenames, and get_codemap for unfamiliar areas.
3. Read the top candidate slices after search. A filename, codemap node, or search hit is not proof; confirm role and exact line ranges with read_file.
4. Rank candidates yourself from the evidence you read. Prefer true entry points, implementations, style/source files, schemas/config, tests, and suspected root causes over incidental references.
5. Return a concise final report that starts with exactly "RANKED_CODE_MAP". Include 3-7 ranked candidates with path, line range, role, confidence, and why. Then list "SEARCHES_TRIED" and "UNCERTAINTY".

Rules:
- Never describe files you have not read.
- Prioritize source, entry, schema/config, and failing-path files over README-style context.
- Prefer narrow, targeted reads (offset+limit) over full-file reads.
- Avoid dumping many related files. Five strong candidates beat twenty weak ones.
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
  model?: string
  codemap?: string | null
  abortSignal?: AbortSignal
  requestTimeoutMs?: number
  retrievalContext?: string
  initialEvidence?: SubAgentEvidence[]
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

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const remainingMs = timeoutMs - (Date.now() - startedAt)
    if (remainingMs < 1) {
      throw lastError || new Error(`Model request timed out after ${timeoutMs}ms`)
    }

    try {
      const response = await fetchWithTimeout(url, init, parentSignal, remainingMs)
      if (attempt === 1 && TRANSIENT_HTTP_STATUSES.has(response.status)) {
        const delayMs = Math.min(retryAfterMs(response), Math.max(0, remainingMs - 1))
        onRetry(2, delayMs, `API ${response.status}`)
        await response.body?.cancel().catch(() => undefined)
        await abortableDelay(delayMs, parentSignal)
        continue
      }
      return response
    } catch (error) {
      lastError = error
      const isAbort = parentSignal?.aborted || (error instanceof Error && error.name === 'AbortError')
      const isTimeout = error instanceof Error && /timed out after \d+ms/i.test(error.message)
      if (attempt === 2 || isAbort || isTimeout || !isTransientNetworkError(error)) throw error

      const elapsedMs = Date.now() - startedAt
      const delayMs = Math.min(200, Math.max(0, timeoutMs - elapsedMs - 1))
      if (delayMs <= 0) throw error
      onRetry(2, delayMs, formatSubAgentError(error))
      await abortableDelay(delayMs, parentSignal)
    }
  }

  throw lastError || new Error('Model request failed')
}

function toAnthropicMessages(messages: SubAgentMessage[]): Array<Record<string, unknown>> {
  return messages.filter(message => message.role !== 'system').map(message => {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      return {
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
      }
    }
    if (message.role === 'tool') {
      return {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }],
      }
    }
    return { role: message.role, content: message.content }
  })
}

export async function runSubAgent(options: RunSubAgentOptions): Promise<SubAgentResult> {
  const { definition, objective, workspacePath, toolExecutor, apiKey, baseUrl, provider, customHeaders, model, codemap, abortSignal, onEvent } = options
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
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file or a slice of it',
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
  let readRecoveryUsed = false

  const addEvidence = (evidence: SubAgentEvidence): void => {
    const key = `${evidence.path}:${evidence.startLine}-${evidence.endLine}:${evidence.reason}`
    if (evidenceKeys.has(key)) return
    evidenceKeys.add(key)
    collectedEvidence.push(evidence)
  }

  const hasReadEvidence = (): boolean => collectedEvidence.some(evidence => /(?:file read|read confirmation|prefetch read)/i.test(evidence.reason))

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
      const isAnthropic = provider === 'anthropic'
      const requestBody = isAnthropic
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
        : {
            model: modelId,
            messages,
            tools,
            temperature: definition.temperature ?? 0,
            max_tokens: definition.maxOutputTokens || 4096,
            stream: false,
          }
      const url = isAnthropic
        ? `${baseUrl.replace(/\/+$/, '')}/messages`
        : `${normalizeBaseUrl(baseUrl)}/chat/completions`
      const headers = isAnthropic
        ? { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', ...customHeaders }
        : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, ...customHeaders }
      const res = await fetchWithTransientRetry(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      }, abortSignal, requestTimeoutMs, (attempt, delayMs, reason) => {
        emit({ type: 'model_retry', turn, attempt, delayMs, reason })
      })

      if (!res.ok) {
        const errText = await res.text()
        emit({ type: 'error', message: `API ${res.status}: ${errText.slice(0, 200)}` })
        return { ok: false, turns: turn, elapsedMs: Date.now() - startedAt, error: `API error: ${res.status}` }
      }

      const response: any = await res.json()
      if (isAnthropic) {
        const blocks = Array.isArray(response.content) ? response.content : []
        messageText = blocks.filter((block: any) => block.type === 'text').map((block: any) => block.text || '').join('')
        responseToolCalls = blocks.filter((block: any) => block.type === 'tool_use').map((block: any) => ({
          id: block.id,
          function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
        }))
      } else {
        const choice = response.choices?.[0]
        if (!choice) {
          return { ok: false, turns: turn, elapsedMs: Date.now() - startedAt, error: 'No response choice' }
        }
        messageText = choice.message?.content || ''
        responseToolCalls = choice.message?.tool_calls || []
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
      const isFastContext = definition.id === 'fast_context'
      if (isFastContext && !hasReadEvidence() && collectedEvidence.length > 0 && !readRecoveryUsed && turn < definition.maxTurns) {
        messages.push({ role: 'assistant', content: messageText })
        messages.push({
          role: 'user',
          content: 'Quality gate: candidate paths are not enough. Use read_file on the strongest candidates, inspect the relevant line ranges, then return the required RANKED_CODE_MAP with grounded evidence.',
        })
        readRecoveryUsed = true
        continue
      }
      if (isFastContext && collectedEvidence.length === 0 && !searchRecoveryUsed && turn < definition.maxTurns) {
        messages.push({ role: 'assistant', content: messageText })
        messages.push({
          role: 'user',
          content: 'Recovery search: the first pass produced no concrete evidence. Rewrite the objective into exact identifiers, visible text, and likely file globs; run a different search strategy before concluding.',
        })
        searchRecoveryUsed = true
        continue
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

    emit({ type: 'turn_complete', turn, calls: results.length })

    if (
      definition.id === 'fast_context'
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
      const res = await executor.searchContent(pattern, basePath, filePattern, caseInsensitive)
      if (!res.success) {
        const error = res.error || 'unknown search error'
        return { ok: false, output: `Search failed: ${error}`, summary: `grep "${pattern}" failed: ${error}`, evidence }
      }
      if (!res.data || res.data.length === 0) {
        return { ok: true, output: 'No matches found.', summary: `grep "${pattern}" → 0 hits`, evidence }
      }
      const hits = res.data.slice(0, 15)
      const lines: string[] = []
      for (const hit of hits) {
        const relPath = toWorkspaceRelative(workspacePath, hit.file)
        lines.push(`${relPath}:${hit.line}: ${hit.text}`)
        evidence.push({
          path: relPath,
          startLine: Math.max(1, hit.line - 2),
          endLine: hit.line + 2,
          preview: hit.text,
          reason: `grep: ${pattern}`,
        })
      }
      return { ok: true, output: lines.join('\n'), summary: `grep "${pattern}" → ${hits.length} hits`, evidence }
    }

    case 'read_file': {
      const requestedPath = String(args.path || '').trim()
      if (!requestedPath) {
        return { ok: false, output: 'File path is required.', summary: 'read failed: missing path', evidence }
      }
      const filePath = resolveWorkspacePath(workspacePath, requestedPath)
      const relativePath = toWorkspaceRelative(workspacePath, filePath)
      const res = await executor.readFile(filePath)
      if (!res.success || !res.data) {
        const error = res.error || 'file not found'
        return { ok: false, output: `Read failed: ${error}`, summary: `read ${relativePath} failed: ${error}`, evidence }
      }
      const allLines = res.data.split('\n')
      const offset = Math.max(0, Math.floor(Number(args.offset) || 1) - 1)
      const limit = Math.max(1, Math.min(200, Math.floor(Number(args.limit) || 60)))
      const slice = allLines.slice(offset, offset + limit)
      const preview = slice.slice(0, 10).join('\n')
      evidence.push({
        path: relativePath,
        startLine: offset + 1,
        endLine: offset + slice.length,
        preview,
        reason: 'file read',
      })
      return { ok: true, output: slice.map((line, index) => `${offset + index + 1} | ${line}`).join('\n'), summary: `read ${relativePath}:${offset + 1}-${offset + slice.length}`, evidence }
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
