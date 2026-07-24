import { createHash } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import type { NativeReasoningConfig } from '../shared/agentTypes'
import type { SubAgentDefinition, SubAgentEvidence } from '../shared/subAgentTypes'
import type { SearchContentHit, ToolExecutor } from '../tools/executor'
import type { ModelCapabilities } from './config'
import { runSubAgent } from './subAgent'

export type FastContextTaskShape = 'direct-owner' | 'indirect-owner' | 'cross-boundary' | 'multi-frontier' | 'repository-census'
export type FastContextPlannerPerspective = 'causal-owner' | 'frontier'

export interface FastContextFrontierSearch {
  role: string
  query: string
  symbols: string[]
  filenameGlobs: string[]
  subsystemHints: string[]
}

export interface FastContextCensusSearch {
  role: 'anchor' | 'violation' | 'example'
  mode: 'literal' | 'regex'
  query: string
  caseSensitive?: boolean
  multiline?: boolean
  fileGlob?: string
}

export interface FastContextQueryPlan {
  taskShape: FastContextTaskShape
  confidence: number
  needsFeedback: boolean
  symbols: string[]
  semanticQueries: string[]
  filenameGlobs: string[]
  subsystemHints: string[]
  frontierRoles: string[]
  frontierSearches: FastContextFrontierSearch[]
  censusSearches?: FastContextCensusSearch[]
  editableExtensions: string[]
  rationale: string
}

export interface FastContextPlannerResult {
  ok: boolean
  plan: FastContextQueryPlan
  elapsedMs: number
  cacheHit?: boolean
  error?: string
}

export interface FastContextPlannedEvidence {
  calls: number
  readCalls: number
  candidatePaths: string[]
  seedEvidence: SubAgentEvidence[]
  confidence: number
  frontierExpected: number
  frontierCovered: number
  frontierCoverage: number
  census?: {
    candidateFiles: number
    directViolationFiles: number
    readFiles: number
    truncated: boolean
  }
  text?: string
}

interface PlannerParams {
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
  codemap?: string
  abortSignal?: AbortSignal
  requestTimeoutMs?: number
  onEvent?: Parameters<typeof runSubAgent>[0]['onEvent']
}

const PLANNER_CACHE_TTL_MS = 60_000
const PLANNER_CACHE_MAX_ENTRIES = 64
const plannerCache = new Map<string, { result: FastContextPlannerResult; expiresAt: number }>()
interface PlannerInFlightEntry {
  controller: AbortController
  listeners: Set<PlannerEventListener>
  promise: Promise<FastContextPlannerResult>
  subscribers: number
  settled: boolean
}
type PlannerEventListener = NonNullable<PlannerParams['onEvent']>
const plannerInFlight = new Map<string, PlannerInFlightEntry>()

function plannerCacheKey(params: PlannerParams, perspective: FastContextPlannerPerspective, feedbackContext?: string): string {
  return createHash('sha256')
    .update([
      params.workspacePath.replace(/\\/g, '/').toLowerCase(),
      params.baseUrl.replace(/\/+$/, ''),
      params.provider || '',
      params.model || '',
      perspective,
      params.codemap || '',
      feedbackContext || '',
      params.objective.replace(/\s+/g, ' ').trim().slice(0, 8_000),
    ].join('\0'))
    .digest('hex')
}

function rememberPlannerResult(key: string, result: FastContextPlannerResult): void {
  if (!result.ok) return
  plannerCache.delete(key)
  plannerCache.set(key, { result, expiresAt: Date.now() + PLANNER_CACHE_TTL_MS })
  while (plannerCache.size > PLANNER_CACHE_MAX_ENTRIES) {
    const oldest = plannerCache.keys().next().value
    if (!oldest) break
    plannerCache.delete(oldest)
  }
}

export function __testClearFastContextPlannerCache(): void {
  plannerCache.clear()
  for (const entry of plannerInFlight.values()) entry.controller.abort()
  plannerInFlight.clear()
}

interface PlannedHit {
  path: string
  line?: number
  preview: string
  score: number
  source: 'semantic' | 'symbol' | 'filename' | 'symbol-filename' | 'frontier' | 'frontier-filename'
  queryIndex: number
  censusRole?: FastContextCensusSearch['role']
}

interface AggregatedHit extends PlannedHit {
  sources: Set<PlannedHit['source']>
  queryKeys: Set<string>
}

const PLANNER_DEFINITION: SubAgentDefinition = {
  id: 'fast_context_query_planner',
  label: 'FastContext Semantic Planner',
  description: 'One-shot semantic retrieval planner',
  driver: 'main-model',
  maxTurns: 1,
  maxParallel: 1,
  maxOutputTokens: 1400,
  temperature: 0,
  thinking: 'disabled',
  systemPrompt: `You lead repository retrieval. Convert a software issue into a compact, high-information search plan before any repository tools run.

Reason semantically: infer likely subsystems, architecture roles, morphological variants, indirect owners, configuration surfaces, and cross-boundary propagation. Do not merely repeat issue words. Do not claim that guessed paths exist. semanticQueries are executable source-search fragments, not prose: each must contain 2-5 discriminative code tokens likely to occur near one another in source. Put broader architectural hypotheses in rationale, subsystemHints, and frontierRoles. symbols must be plausible literal repository identifiers ordered from the most owner-specific to the least; do not put generic issue words in symbols unless they are likely exact code identifiers.

  Use repository-census when the requested change applies one rule to many independent occurrences, such as API migration, annotation or literal normalization, deprecated construct replacement, configuration-key migration, or a repeated cross-language convention. For census work, fill censusSearches instead of inventing an owner hierarchy. Use role=anchor for the broad repeated construct, role=violation for a pattern that directly identifies required edits, and role=example only for issue examples that help disambiguate but must not dominate enumeration. mode=literal is preferred; mode=regex must be a valid ripgrep/Rust regex without lookaround and should only be used when it materially improves precision. Set caseSensitive when casing is semantically meaningful, multiline only when one occurrence genuinely spans lines, and fileGlob only when the rule is scoped to a known file family. If the violation cannot be encoded safely, provide broad anchors and let the evidence judge classify the read-confirmed occurrences.

  frontierSearches is the coordinated edit frontier. Each item must represent a distinct causal boundary, not a synonym: examples include behavior owner, configuration/capability source, registration or routing, transport/IPC propagation, runtime execution/code generation, persistence/state, and client/UI consumer. Include only boundaries relevant to the issue. For indirect failures, trace both upstream definition/normalization and downstream runtime execution; a stack-trace frame can be a symptom rather than the edit owner. Each frontier query must be a short grep-ready fragment, with owner-specific symbols and likely subsystem hints. Prefer 2-4 high-information frontiers for cross-boundary work and 1-2 for direct-owner work. Do not emit speculative UI, transport, persistence, or configuration frontiers when the issue gives no evidence that those boundaries participate.

Return one JSON object only, without Markdown, with this exact shape:
  {"taskShape":"direct-owner|indirect-owner|cross-boundary|multi-frontier|repository-census","confidence":0.0,"needsFeedback":true,"symbols":[],"semanticQueries":[],"filenameGlobs":[],"subsystemHints":[],"frontierRoles":[],"frontierSearches":[{"role":"","query":"","symbols":[],"filenameGlobs":[],"subsystemHints":[]}],"censusSearches":[{"role":"anchor|violation|example","mode":"literal|regex","query":"","caseSensitive":false,"multiline":false,"fileGlob":""}],"editableExtensions":[],"rationale":""}

confidence measures confidence that this plan can expose the real edit owner, not confidence in the issue description. needsFeedback is true when repository results should be shown back once before final ranking.`,
}

const DEFAULT_EDITABLE_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'pyi', 'rs', 'go', 'java', 'kt', 'kts', 'cs', 'c', 'cc',
  'cpp', 'cxx', 'h', 'hpp', 'swift', 'scala', 'rb', 'php', 'vue', 'svelte', 'json', 'yaml', 'yml', 'toml',
  'ini', 'cfg', 'conf', 'xml', 'gradle', 'properties', 'sh', 'bash', 'zsh', 'fish', 'sql', 'proto', 'graphql',
  'gql', 'md', 'mdx', 'html', 'htm', 'hbs', 'handlebars', 'ejs', 'njk', 'twig', 'jsonc',
]
const EDITABLE_BASENAMES = new Set(['dockerfile', 'makefile', 'gemfile', 'rakefile', 'procfile'])

function editableExtensions(plan: FastContextQueryPlan): string[] {
  return unique([
    ...DEFAULT_EDITABLE_EXTENSIONS,
    ...plan.editableExtensions.map(value => value.replace(/^\*?\.?/, '').replace(/[^a-z0-9]+/gi, '')),
  ], 64, 16)
}

function isEditableFile(path: string, extensions: ReadonlySet<string>): boolean {
  const filename = path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() || ''
  if (EDITABLE_BASENAMES.has(filename)) return true
  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1) : ''
  return extensions.has(extension)
}

function editableGlob(extensions: string[]): string {
  return `*.{${extensions.join(',')}}`
}

function unique(values: string[], limit: number, maxLength = 160): string[] {
  const seen = new Set<string>()
  const selected: string[] = []
  for (const value of values) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
    const key = normalized.toLowerCase()
    if (!normalized || seen.has(key)) continue
    seen.add(key)
    selected.push(normalized)
    if (selected.length >= limit) break
  }
  return selected
}

function clampConfidence(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0
}

function emptyPlan(): FastContextQueryPlan {
  return {
    taskShape: 'indirect-owner',
    confidence: 0,
    needsFeedback: true,
    symbols: [],
    semanticQueries: [],
    filenameGlobs: [],
    subsystemHints: [],
    frontierRoles: [],
    frontierSearches: [],
    censusSearches: [],
    editableExtensions: [],
    rationale: '',
  }
}

function jsonObjectCandidates(value: string): string[] {
  const candidates = [...value.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1].trim())
  let start = -1
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') {
      quoted = true
      continue
    }
    if (character === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (character === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) candidates.push(value.slice(start, index + 1))
    }
  }
  return unique(candidates, 6, 20_000)
}

export function parseFastContextQueryPlan(value: string): FastContextQueryPlan | undefined {
  for (const candidate of jsonObjectCandidates(value)) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      const shape = String(parsed.taskShape || '') as FastContextTaskShape
      const taskShape: FastContextTaskShape = ['direct-owner', 'indirect-owner', 'cross-boundary', 'multi-frontier', 'repository-census'].includes(shape)
        ? shape
        : 'indirect-owner'
      const list = (item: unknown, limit: number) => unique(Array.isArray(item) ? item.map(String) : [], limit)
      const frontierSearches = (Array.isArray(parsed.frontierSearches) ? parsed.frontierSearches : [])
        .flatMap(item => {
          if (!item || typeof item !== 'object') return []
          const value = item as Record<string, unknown>
          const role = String(value.role || '').replace(/\s+/g, ' ').trim().slice(0, 80)
          const query = String(value.query || '').replace(/\s+/g, ' ').trim().slice(0, 160)
          const symbols = list(value.symbols, 4)
          const filenameGlobs = list(value.filenameGlobs, 3)
          const subsystemHints = list(value.subsystemHints, 3)
          if (!role || (!query && symbols.length === 0 && filenameGlobs.length === 0)) return []
          return [{ role, query, symbols, filenameGlobs, subsystemHints } satisfies FastContextFrontierSearch]
        })
        .filter((item, index, all) => all.findIndex(other => `${other.role}:${other.query}`.toLowerCase() === `${item.role}:${item.query}`.toLowerCase()) === index)
        .slice(0, 6)
      const censusSearches = (Array.isArray(parsed.censusSearches) ? parsed.censusSearches : [])
        .flatMap(item => {
          if (!item || typeof item !== 'object') return []
          const value = item as Record<string, unknown>
          const role = String(value.role || '').trim().toLowerCase()
          const mode = String(value.mode || '').trim().toLowerCase()
          const query = String(value.query || '').trim().slice(0, 240)
          if (!['anchor', 'violation', 'example'].includes(role) || !['literal', 'regex'].includes(mode) || !query) return []
          const fileGlob = String(value.fileGlob || '').trim().slice(0, 160)
          return [{
            role,
            mode,
            query,
            caseSensitive: value.caseSensitive === true,
            multiline: value.multiline === true,
            ...(fileGlob ? { fileGlob } : {}),
          } as FastContextCensusSearch]
        })
        .filter((item, index, all) => all.findIndex(other => `${other.role}:${other.mode}:${other.query}:${other.fileGlob || ''}:${other.caseSensitive}:${other.multiline}`.toLowerCase() === `${item.role}:${item.mode}:${item.query}:${item.fileGlob || ''}:${item.caseSensitive}:${item.multiline}`.toLowerCase()) === index)
        .slice(0, 8)
      const plan: FastContextQueryPlan = {
        taskShape,
        confidence: clampConfidence(parsed.confidence),
        needsFeedback: parsed.needsFeedback !== false,
        symbols: list(parsed.symbols, 8),
        semanticQueries: list(parsed.semanticQueries, 8),
        filenameGlobs: list(parsed.filenameGlobs, 6),
        subsystemHints: list(parsed.subsystemHints, 6),
        frontierRoles: list(parsed.frontierRoles, 6),
        frontierSearches,
        censusSearches,
        editableExtensions: list(parsed.editableExtensions, 8),
        rationale: String(parsed.rationale || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      }
      if (plan.symbols.length === 0 && plan.semanticQueries.length === 0 && plan.filenameGlobs.length === 0 && (plan.censusSearches?.length || 0) === 0) continue
      return plan
    } catch {}
  }
  return undefined
}

function plannerPrompt(objective: string, perspective: FastContextPlannerPerspective, feedbackContext?: string): string {
  const perspectiveInstruction = perspective === 'causal-owner'
    ? 'PERSPECTIVE: Find the causal operation and indirect semantic owner. Prioritize exact error behavior, transformations, state transitions, and morphology-aware symbols. Keep semanticQueries short and grep-ready.'
    : 'PERSPECTIVE: Find cross-boundary propagation and the coordinated edit frontier. Allocate separate short, grep-ready queries to configuration, transport, server/client state, UI consumers, adapters, and mirrors only when evidence in the issue makes them plausible.'
  return [
    'Build the semantic repository retrieval plan for this issue.',
    perspectiveInstruction,
    `ISSUE\n${objective.slice(0, 8_000)}`,
    feedbackContext ? `FIRST-PASS REPOSITORY RESULTS\n${feedbackContext.slice(0, 12_000)}\nReturn a delta plan: avoid repeating low-value queries and target missing owners or frontier edges.` : '',
    'Return JSON only.',
  ].filter(Boolean).join('\n\n')
}

async function runFastContextQueryPlanner(
  params: PlannerParams,
  feedbackContext?: string,
  perspective: FastContextPlannerPerspective = 'causal-owner',
): Promise<FastContextPlannerResult> {
  const startedAt = Date.now()
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort()
  if (params.abortSignal?.aborted) controller.abort()
  else params.abortSignal?.addEventListener('abort', abort, { once: true })
  const softTimeoutMs = Math.min(params.requestTimeoutMs ?? 35_000, 35_000)
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, softTimeoutMs)
  try {
    const result = await runSubAgent({
      definition: PLANNER_DEFINITION,
      objective: params.objective,
      workspacePath: params.workspacePath,
      toolExecutor: params.toolExecutor,
      apiKey: params.apiKey,
      baseUrl: params.baseUrl,
      provider: params.provider,
      customHeaders: params.customHeaders,
      reasoning: params.reasoning,
      modelCapabilities: params.modelCapabilities,
      model: params.model,
      codemap: params.codemap?.slice(0, 12_000),
      abortSignal: controller.signal,
      requestTimeoutMs: softTimeoutMs,
      maxTransientAttempts: 2,
      allowedTools: [],
      userPrompt: plannerPrompt(params.objective, perspective, feedbackContext),
      onEvent: params.onEvent,
    })
    const plan = parseFastContextQueryPlan(result.finalText || '')
    if (!result.ok || !plan) {
      return {
        ok: false,
        plan: emptyPlan(),
        elapsedMs: Date.now() - startedAt,
        error: timedOut ? `Planner exceeded ${softTimeoutMs}ms soft deadline` : result.error || 'Planner returned invalid JSON',
      }
    }
    return { ok: true, plan, elapsedMs: Date.now() - startedAt }
  } finally {
    clearTimeout(timer)
    params.abortSignal?.removeEventListener('abort', abort)
  }
}

export async function planFastContextQueries(
  params: PlannerParams,
  feedbackContext?: string,
  perspective: FastContextPlannerPerspective = 'causal-owner',
): Promise<FastContextPlannerResult> {
  const key = plannerCacheKey(params, perspective, feedbackContext)
  const cached = plannerCache.get(key)
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      plannerCache.delete(key)
      plannerCache.set(key, cached)
      return { ...cached.result, elapsedMs: 0, cacheHit: true }
    }
    plannerCache.delete(key)
  }
  let entry = plannerInFlight.get(key)
  const shared = Boolean(entry)
  const listener: PlannerEventListener | undefined = params.onEvent
    ? event => params.onEvent?.(event)
    : undefined
  if (!entry) {
    const controller = new AbortController()
    const listeners = new Set<PlannerEventListener>()
    if (listener) listeners.add(listener)
    entry = {
      controller,
      listeners,
      subscribers: 1,
      settled: false,
      promise: Promise.resolve({ ok: false, plan: emptyPlan(), elapsedMs: 0 }),
    }
    const current = entry
    current.promise = runFastContextQueryPlanner({
      ...params,
      abortSignal: controller.signal,
      onEvent: event => {
        for (const listener of current.listeners) listener(event)
      },
    }, feedbackContext, perspective)
      .then(result => {
        rememberPlannerResult(key, result)
        return result
      })
      .finally(() => {
        current.settled = true
        if (plannerInFlight.get(key) === current) plannerInFlight.delete(key)
      })
    plannerInFlight.set(key, current)
  } else {
    entry.subscribers += 1
    if (listener) entry.listeners.add(listener)
  }
  try {
    const result = await waitForPlannerResult(entry.promise, params.abortSignal)
    return shared ? { ...result, elapsedMs: 0, cacheHit: true } : result
  } finally {
    entry.subscribers = Math.max(0, entry.subscribers - 1)
    if (listener) entry.listeners.delete(listener)
    if (entry.subscribers === 0 && !entry.settled) entry.controller.abort()
  }
}

function interleave(left: string[], right: string[], limit: number): string[] {
  return unique(Array.from({ length: Math.max(left.length, right.length) })
    .flatMap((_, index) => [left[index], right[index]])
    .filter((value): value is string => Boolean(value)), limit)
}

export function mergeFastContextQueryPlans(owner: FastContextQueryPlan, frontier: FastContextQueryPlan): FastContextQueryPlan {
  const mergeTaskShape = (): FastContextTaskShape => {
    if (owner.taskShape === frontier.taskShape) return owner.taskShape
    if (owner.taskShape === 'repository-census' || frontier.taskShape === 'repository-census') {
      const censusPlan = owner.taskShape === 'repository-census' ? owner : frontier
      return censusPlan.confidence >= 0.72 && (censusPlan.censusSearches?.length || 0) > 0
        ? 'repository-census'
        : 'cross-boundary'
    }
    const shapeRank: FastContextTaskShape[] = ['direct-owner', 'indirect-owner', 'cross-boundary', 'multi-frontier']
    const ownerRank = shapeRank.indexOf(owner.taskShape)
    const frontierRank = shapeRank.indexOf(frontier.taskShape)
    if (Math.abs(ownerRank - frontierRank) >= 2) return 'cross-boundary'
    return shapeRank[Math.max(ownerRank, frontierRank)]
  }
  const taskShape = mergeTaskShape()
  return {
    taskShape,
    confidence: (owner.confidence + frontier.confidence) / 2,
    needsFeedback: owner.needsFeedback || frontier.needsFeedback,
    symbols: interleave(owner.symbols, frontier.symbols, 8),
    semanticQueries: interleave(owner.semanticQueries, frontier.semanticQueries, 8),
    filenameGlobs: interleave(owner.filenameGlobs, frontier.filenameGlobs, 6),
    subsystemHints: interleave(owner.subsystemHints, frontier.subsystemHints, 8),
    frontierRoles: interleave(owner.frontierRoles, frontier.frontierRoles, 8),
    frontierSearches: taskShape === 'repository-census' ? [] : Array.from({ length: Math.max(owner.frontierSearches.length, frontier.frontierSearches.length) })
      .flatMap((_, index) => [owner.frontierSearches[index], frontier.frontierSearches[index]])
      .filter((item): item is FastContextFrontierSearch => Boolean(item))
      .filter((item, index, all) => all.findIndex(other => `${other.role}:${other.query}`.toLowerCase() === `${item.role}:${item.query}`.toLowerCase()) === index)
      .slice(0, 4),
    censusSearches: taskShape === 'repository-census'
      ? [...(owner.censusSearches || []), ...(frontier.censusSearches || [])]
        .filter((item, index, all) => all.findIndex(other => `${other.role}:${other.mode}:${other.query}:${other.fileGlob || ''}:${other.caseSensitive}:${other.multiline}`.toLowerCase() === `${item.role}:${item.mode}:${item.query}:${item.fileGlob || ''}:${item.caseSensitive}:${item.multiline}`.toLowerCase()) === index)
        .slice(0, 8)
      : [],
    editableExtensions: unique([...owner.editableExtensions, ...frontier.editableExtensions], 10),
    rationale: `Owner view: ${owner.rationale} Frontier view: ${frontier.rationale}`.slice(0, 900),
  }
}

function relativePath(workspacePath: string, filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  if (!isAbsolute(filePath)) return normalized.replace(/^\.\//, '')
  const workspaceRelative = relative(workspacePath, filePath).replace(/\\/g, '/')
  return workspaceRelative.startsWith('../') ? normalized : workspaceRelative
}

function literalPattern(value: string): string {
  const trimmed = value.trim()
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed) || (/^[\u4e00-\u9fff]+$/u.test(trimmed) && trimmed.length <= 32)) {
    return escape(trimmed)
  }
  return trimmed
    .split(/\s+/u)
    .filter(Boolean)
    .map(escape)
    .join('[\\s_.:/-]*')
}

function symbolFileGlob(value: string): string | undefined {
  const identifier = value.match(/[A-Za-z_$][A-Za-z0-9_$]*/)?.[0]
  if (!identifier || identifier.length < 4 || /^__.*__$/.test(identifier)) return undefined
  return `**/*${identifier.replace(/[?*\[\]{}]/g, '')}*.*`
}

export const __testLiteralPattern = literalPattern

function fastContextAbortError(): Error {
  const error = new Error('FastContext operation aborted')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw fastContextAbortError()
}

async function runLimited<T>(
  tasks: Array<() => Promise<T>>,
  concurrency = 6,
  signal?: AbortSignal,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length)
  let nextIndex = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (nextIndex < tasks.length) {
      if (signal?.aborted) break
      const index = nextIndex++
      try {
        throwIfAborted(signal)
        results[index] = { status: 'fulfilled', value: await tasks[index]() }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }))
  if (signal?.aborted) {
    for (let index = 0; index < results.length; index += 1) {
      if (!results[index]) results[index] = { status: 'rejected', reason: fastContextAbortError() }
    }
  }
  return results
}

function waitForPlannerResult<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(fastContextAbortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(fastContextAbortError())
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(value => {
      cleanup()
      resolve(value)
    }, error => {
      cleanup()
      reject(error)
    })
  })
}

function pathScore(path: string, plan: FastContextQueryPlan): number {
  const normalized = path.toLowerCase()
  const compactPath = normalized.replace(/[^a-z0-9]+/g, '')
  const subsystem = plan.subsystemHints.filter(hint => normalized.includes(hint.toLowerCase().replace(/\\/g, '/'))).length
  const roles = plan.frontierRoles.filter(role => compactPath.includes(role.toLowerCase().replace(/[^a-z0-9]+/g, ''))).length
  const config = /\.(?:json|ya?ml|toml|ini|cfg|conf|xml|gradle|properties)$/i.test(path) ? 2 : 0
  const nonRuntime = /(?:^|\/)(?:docs?|examples?|fixtures?|tests?|__tests__)(?:\/|$)/i.test(path) ? -4 : 0
  return subsystem * 3 + roles * 4 + config + nonRuntime
}

function frontierPathScore(path: string, frontier: FastContextFrontierSearch): number {
  const normalized = path.toLowerCase().replace(/\\/g, '/')
  const compactPath = normalized.replace(/[^a-z0-9]+/g, '')
  const subsystem = frontier.subsystemHints.filter(hint => normalized.includes(hint.toLowerCase().replace(/\\/g, '/'))).length
  const role = frontier.role.toLowerCase().replace(/[^a-z0-9]+/g, '')
  return subsystem * 8 + (role && compactPath.includes(role) ? 6 : 0)
}

function directoryBucket(path: string): string {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  const index = normalized.lastIndexOf('/')
  return index > 0 ? normalized.slice(0, index) : normalized
}

function diversifyByDirectory<T extends { path: string; score: number }>(hits: T[], limit: number): T[] {
  const buckets = new Map<string, T[]>()
  for (const hit of hits) {
    const bucket = directoryBucket(hit.path)
    const entries = buckets.get(bucket) || []
    entries.push(hit)
    buckets.set(bucket, entries)
  }
  for (const entries of buckets.values()) entries.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
  const ordered = [...buckets.values()].sort((left, right) => right[0].score - left[0].score || left[0].path.localeCompare(right[0].path))
  const selected: T[] = []
  for (let depth = 0; selected.length < limit && ordered.some(bucket => depth < bucket.length); depth += 1) {
    for (const bucket of ordered) {
      const hit = bucket[depth]
      if (hit) selected.push(hit)
      if (selected.length >= limit) break
    }
  }
  return selected
}

export async function executeFastContextQueryPlan(params: {
  workspacePath: string
  toolExecutor: ToolExecutor
  plan: FastContextQueryPlan
  coveredEvidence?: SubAgentEvidence[]
  abortSignal?: AbortSignal
}): Promise<FastContextPlannedEvidence> {
  throwIfAborted(params.abortSignal)
  const crossBoundary = params.plan.taskShape === 'multi-frontier' || params.plan.taskShape === 'cross-boundary'
  const repositoryCensus = params.plan.taskShape === 'repository-census'
  const semanticQueries = unique(params.plan.semanticQueries, repositoryCensus ? 3 : crossBoundary ? 4 : 3)
  const symbolQueries = unique(params.plan.symbols, repositoryCensus ? 4 : 6)
  const censusSearches = (params.plan.censusSearches || []).slice(0, 8)
  const filenameGlobs = unique(params.plan.filenameGlobs, 2)
  const frontierSearches = repositoryCensus ? [] : params.plan.frontierSearches.slice(0, crossBoundary ? 4 : 2)
  const extensionList = editableExtensions(params.plan)
  const extensionSet = new Set(extensionList)
  const sourceGlob = editableGlob(extensionList)
  const censusContractQueries = censusSearches.map((search, queryIndex) => ({
    query: search.query,
    queryIndex,
    source: 'semantic' as const,
    censusRole: search.role,
    mode: search.mode,
    caseSensitive: search.caseSensitive === true,
    multiline: search.multiline === true,
    fileGlob: search.fileGlob,
  }))
  const censusFallbackQueries = repositoryCensus && censusSearches.length > 0
    ? [
      ...semanticQueries.slice(0, 2).map((query, index) => ({
        query,
        queryIndex: censusSearches.length + index,
        source: 'semantic' as const,
        censusRole: undefined,
        mode: 'literal' as const,
        caseSensitive: false,
        multiline: false,
        fileGlob: undefined,
      })),
      ...symbolQueries.slice(0, 2).map((query, index) => ({
        query,
        queryIndex: censusSearches.length + semanticQueries.slice(0, 2).length + index,
        source: 'symbol' as const,
        censusRole: undefined,
        mode: 'literal' as const,
        caseSensitive: false,
        multiline: false,
        fileGlob: undefined,
      })),
    ]
    : []
  const rawContentQueries = repositoryCensus && censusSearches.length > 0
    ? [...censusContractQueries, ...censusFallbackQueries]
    : [
      ...semanticQueries.map((query, queryIndex) => ({ query, queryIndex, source: 'semantic' as const, censusRole: undefined, mode: 'literal' as const, caseSensitive: false, multiline: false, fileGlob: undefined })),
      ...symbolQueries.map((query, queryIndex) => ({ query, queryIndex, source: 'symbol' as const, censusRole: undefined, mode: 'literal' as const, caseSensitive: false, multiline: false, fileGlob: undefined })),
      ...frontierSearches.flatMap((frontier, queryIndex) => unique([frontier.query, ...frontier.symbols], 1)
        .map(query => ({ query, queryIndex, source: 'frontier' as const, censusRole: undefined, mode: 'literal' as const, caseSensitive: false, multiline: false, fileGlob: undefined }))),
    ]
  const contentQueries = rawContentQueries.filter((query, index, all) => all.findIndex(other => [
    other.mode,
    other.query,
    other.fileGlob || '',
    String(other.caseSensitive),
    String(other.multiline),
  ].join('\0').toLowerCase() === [
    query.mode,
    query.query,
    query.fileGlob || '',
    String(query.caseSensitive),
    String(query.multiline),
  ].join('\0').toLowerCase()) === index)
  const tasks: Array<() => Promise<PlannedHit[]>> = [
    ...contentQueries.map(({ query, queryIndex, source, censusRole, mode, caseSensitive, multiline, fileGlob }) => async () => {
      const pattern = repositoryCensus && mode === 'regex' ? query : literalPattern(query)
      if (!pattern) return []
      const result = params.toolExecutor.searchContentPage
        ? await params.toolExecutor.searchContentPage(pattern, params.workspacePath, fileGlob || sourceGlob, repositoryCensus ? !caseSensitive : true, {
          limit: repositoryCensus ? 500 : 160,
          multiline: repositoryCensus && multiline,
        })
        : await params.toolExecutor.searchContent(pattern, params.workspacePath, fileGlob || sourceGlob, repositoryCensus ? !caseSensitive : true)
      const page = result.data as SearchContentHit[] | { hits?: SearchContentHit[] } | undefined
      const hits = Array.isArray(page) ? page : page?.hits || []
      const seen = new Set<string>()
      const queryHits = result.success ? hits.flatMap(hit => {
        const path = relativePath(params.workspacePath, hit.file)
        const key = path.toLowerCase()
        if (!isEditableFile(path, extensionSet) || seen.has(key)) return []
        seen.add(key)
        return [{
          path,
          line: hit.line,
          preview: `${path}:${hit.line} ${hit.text.replace(/\s+/g, ' ').trim().slice(0, 180)}`,
          score: (repositoryCensus
            ? censusRole === 'violation' ? 86 : censusRole === 'anchor' ? 64 : censusRole === 'example' ? 42 : source === 'semantic' ? 34 : 30
            : source === 'symbol' ? 44 : source === 'frontier' ? 46 : 40)
            - queryIndex * 2
            + pathScore(path, params.plan)
            + (source === 'frontier' ? frontierPathScore(path, frontierSearches[queryIndex]) : 0),
          source,
          queryIndex,
          censusRole,
        }]
      }) : []
      return diversifyByDirectory(queryHits, repositoryCensus ? 120 : 18)
    }),
    ...filenameGlobs.map((glob, globIndex) => async () => {
      const result = await params.toolExecutor.searchFiles(glob, params.workspacePath)
      return result.success ? (result.data?.matches || []).flatMap(match => {
        const path = relativePath(params.workspacePath, match)
        return isEditableFile(path, extensionSet) ? [{
          path,
          preview: path,
          score: 24 - globIndex * 2 + pathScore(path, params.plan),
          source: 'filename' as const,
          queryIndex: globIndex,
        }] : []
      }).slice(0, 20) : []
    }),
    ...symbolQueries.flatMap((symbol, symbolIndex) => {
      const glob = symbolFileGlob(symbol)
      if (!glob) return []
      return [async () => {
        const result = await params.toolExecutor.searchFiles(glob, params.workspacePath)
        return result.success ? (result.data?.matches || []).flatMap(match => {
          const path = relativePath(params.workspacePath, match)
          return isEditableFile(path, extensionSet) ? [{
            path,
            preview: path,
            score: 48 - symbolIndex + pathScore(path, params.plan),
            source: 'symbol-filename' as const,
            queryIndex: symbolIndex,
          }] : []
        }).slice(0, 12) : []
      }]
    }),
    ...frontierSearches.flatMap((frontier, frontierIndex) => {
      const globs = unique([
        ...frontier.filenameGlobs,
        ...frontier.symbols.map(symbolFileGlob).filter((glob): glob is string => Boolean(glob)),
      ], 1)
      return globs.map(glob => async () => {
        const result = await params.toolExecutor.searchFiles(glob, params.workspacePath)
        return result.success ? (result.data?.matches || []).flatMap(match => {
          const path = relativePath(params.workspacePath, match)
          return isEditableFile(path, extensionSet) ? [{
            path,
            preview: path,
            score: 50 - frontierIndex + pathScore(path, params.plan) + frontierPathScore(path, frontier),
            source: 'frontier-filename' as const,
            queryIndex: frontierIndex,
          }] : []
        }).slice(0, 12) : []
      })
    }),
  ]
  const settled = await runLimited(tasks, 12, params.abortSignal)
  throwIfAborted(params.abortSignal)
  const coveredEvidence = params.coveredEvidence || []
  const isCovered = (hit: PlannedHit): boolean => coveredEvidence.some(evidence => {
    if (evidence.path.replace(/\\/g, '/').toLowerCase() !== hit.path.toLowerCase()) return false
    const anchor = hit.line || 1
    return anchor >= Math.max(1, evidence.startLine - 20) && anchor <= evidence.endLine + 20
  })
  const settledHits = settled.flatMap(result => result.status === 'fulfilled' ? result.value : [])
  const censusViolationDirectories = new Set(repositoryCensus
    ? settledHits
      .filter(hit => hit.censusRole === 'violation')
      .map(hit => directoryBucket(hit.path))
    : [])
  const bestByPath = new Map<string, AggregatedHit>()
  for (const originalHit of settledHits) {
    const hit = repositoryCensus && censusViolationDirectories.has(directoryBucket(originalHit.path))
      ? { ...originalHit, score: originalHit.score + (originalHit.censusRole === 'violation' ? 12 : 4) }
      : originalHit
    const key = hit.path.toLowerCase()
    if (isCovered(hit)) continue
    const current = bestByPath.get(key)
    const queryKey = `${hit.source}:${hit.queryIndex}`
    if (!current) {
      bestByPath.set(key, {
        ...hit,
        sources: new Set([hit.source]),
        queryKeys: new Set([queryKey]),
      })
      continue
    }
    current.sources.add(hit.source)
    current.queryKeys.add(queryKey)
    if (hit.score > current.score) {
      current.score = hit.score
      current.preview = hit.preview
      current.source = hit.source
      current.queryIndex = hit.queryIndex
      if (hit.line !== undefined) current.line = hit.line
    }
    if (current.line === undefined && hit.line !== undefined) current.line = hit.line
  }
  const ranked = [...bestByPath.values()]
    .map(hit => ({
      ...hit,
      score: hit.score + Math.min(12, (hit.sources.size - 1) * 3 + (hit.queryKeys.size - 1) * 1.5),
    }))
    .sort((left, right) => right.score - left.score || Number(right.source !== 'filename') - Number(left.source !== 'filename') || left.path.localeCompare(right.path))
  const configLane = ranked.filter(hit => /\.(?:json|ya?ml|toml|ini|cfg|conf|xml|gradle|properties)$/i.test(hit.path)).slice(0, 1)
  const semanticLane = semanticQueries.flatMap((_, queryIndex) => ranked
    .filter(hit => hit.queryKeys.has(`semantic:${queryIndex}`))
    .slice(0, repositoryCensus ? 8 : 1))
  const censusViolationLane = repositoryCensus ? diversifyByDirectory(ranked.filter(hit => hit.censusRole === 'violation'), 40) : []
  const censusAnchorLane = repositoryCensus ? diversifyByDirectory(ranked.filter(hit => hit.censusRole === 'anchor'), 40) : []
  const censusExampleLane = repositoryCensus ? ranked.filter(hit => hit.censusRole === 'example').slice(0, 8) : []
  const symbolLane = ranked.filter(hit => hit.sources.has('symbol')).slice(0, 5)
  const symbolFilenameLane = ranked.filter(hit => hit.sources.has('symbol-filename')).slice(0, 3)
  const filenameLane = ranked.filter(hit => hit.sources.has('filename')).slice(0, 2)
  const assignedFrontierPaths = new Set<string>()
  const frontierAssignments = frontierSearches.flatMap((_, frontierIndex) => {
    const hit = ranked.find(candidate => !assignedFrontierPaths.has(candidate.path.toLowerCase())
      && (candidate.queryKeys.has(`frontier:${frontierIndex}`) || candidate.queryKeys.has(`frontier-filename:${frontierIndex}`)))
    if (!hit) return []
    assignedFrontierPaths.add(hit.path.toLowerCase())
    return [{ frontierIndex, hit }]
  })
  const frontierLane = frontierAssignments.map(assignment => assignment.hit)
  const diverseLane = diversifyByDirectory(ranked, repositoryCensus ? 32 : crossBoundary ? 6 : 3)
  const censusDirectCount = censusViolationLane.length
  const readLimit = repositoryCensus
    ? Math.min(40, Math.max(censusDirectCount > 0 ? censusDirectCount : 24, Math.min(32, ranked.length)))
    : crossBoundary ? Math.min(12, Math.max(9, frontierSearches.length + 7)) : 8
  const readTargets = (repositoryCensus
    ? [...censusViolationLane, ...diverseLane, ...censusAnchorLane, ...censusExampleLane, ...semanticLane, ...ranked]
    : [...frontierLane, ...diverseLane, ...symbolFilenameLane, ...symbolLane, ...semanticLane, ...filenameLane, ...configLane, ...ranked])
    .filter((hit, index, all) => all.findIndex(other => other.path.toLowerCase() === hit.path.toLowerCase()) === index)
    .slice(0, readLimit)
  const readResults = await runLimited(readTargets.map(hit => async () => {
    throwIfAborted(params.abortSignal)
    const offset = Math.max(0, (hit.line || 1) - (repositoryCensus ? 21 : 61))
    const readLineLimit = repositoryCensus ? 90 : 220
    const range = params.toolExecutor.readFileRange
      ? await params.toolExecutor.readFileRange(hit.path, offset, readLineLimit, repositoryCensus ? 32_000 : 96_000)
      : undefined
    if (range?.success && range.data?.content) {
      return {
        hit,
        evidence: {
          path: hit.path,
          startLine: range.data.startLine,
          endLine: range.data.endLine,
          preview: range.data.content.split('\n').slice(0, 12).join('\n'),
          content: range.data.content.slice(0, repositoryCensus ? 6_000 : 16_000),
          reason: 'file read',
          score: hit.score,
        } satisfies SubAgentEvidence,
      }
    }
    const file = await params.toolExecutor.readFile(hit.path)
    if (!file.success || !file.data) return undefined
    const lines = String(file.data).split('\n').slice(offset, offset + readLineLimit)
    return {
      hit,
      evidence: {
        path: hit.path,
        startLine: offset + 1,
        endLine: offset + lines.length,
        preview: lines.slice(0, 12).join('\n'),
        content: lines.join('\n').slice(0, repositoryCensus ? 6_000 : 16_000),
        reason: 'file read',
        score: hit.score,
      } satisfies SubAgentEvidence,
    }
  }), 6, params.abortSignal)
  throwIfAborted(params.abortSignal)
  const successfulReads = readResults.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : [])
  const seedEvidence = successfulReads.map(result => result.evidence)
  const successfullyReadPaths = new Set(successfulReads.map(result => result.evidence.path.toLowerCase()))
  const coveredFrontierIndexes = new Set(frontierAssignments.flatMap(({ frontierIndex, hit }) => {
    if (!successfullyReadPaths.has(hit.path.toLowerCase())) return []
    const frontier = frontierSearches[frontierIndex]
    const contentMatched = hit.queryKeys.has(`frontier:${frontierIndex}`)
    const aligned = contentMatched || frontier.subsystemHints.length === 0 || frontierPathScore(hit.path, frontier) > 0
    return aligned ? [frontierIndex] : []
  }))
  const frontierExpected = frontierSearches.length
  const frontierCovered = coveredFrontierIndexes.size
  const frontierCoverage = frontierExpected > 0 ? frontierCovered / frontierExpected : 1
  const consensusPaths = ranked.filter(hit => hit.sources.size >= 2 || hit.queryKeys.size >= 2).length
  const coveredQueries = new Set(ranked.flatMap(hit => [...hit.queryKeys])).size
  const totalQueries = Math.max(1, new Set(contentQueries.map(query => `${query.source}:${query.queryIndex}`)).size + filenameGlobs.length)
  const queryCoverage = Math.min(1, coveredQueries / totalQueries)
  const confidence = Math.min(0.95, params.plan.confidence * 0.3
    + Math.min(0.2, consensusPaths * 0.05)
    + queryCoverage * 0.2
    + (frontierExpected > 0 ? frontierCoverage * 0.15 : 0)
    + Math.min(0.1, seedEvidence.length * 0.0125))
  const text = [
    `Semantic planner: ${params.plan.taskShape}; confidence=${params.plan.confidence.toFixed(2)}; feedback=${params.plan.needsFeedback}`,
    `Planner rationale: ${params.plan.rationale}`,
    `Planner queries: ${[...params.plan.symbols, ...params.plan.semanticQueries].join(' | ')}`,
    repositoryCensus ? `Census contract: ${censusSearches.map(search => `${search.role}/${search.mode}${search.caseSensitive ? '/case-sensitive' : ''}${search.multiline ? '/multiline' : ''}${search.fileGlob ? `/${search.fileGlob}` : ''}: ${search.query}`).join(' | ')}` : '',
    repositoryCensus ? `Census inventory (${ranked.length} candidate file(s)):\n${ranked.slice(0, 120).map(hit => `${hit.path}:${hit.line || 1} [${hit.censusRole || 'fallback'}] ${hit.preview.slice(0, 220)}`).join('\n')}` : '',
    `Planner subsystems: ${params.plan.subsystemHints.join(' | ')}`,
    `Planner frontier coverage: ${frontierCovered}/${frontierExpected}`,
    `Planner frontiers: ${frontierSearches.map(frontier => `${frontier.role}: ${frontier.query}`).join(' | ')}`,
    `Planner candidate reads:\n${seedEvidence.map(item => `${item.path}:${item.startLine}-${item.endLine}\n${(item.content || item.preview).slice(0, repositoryCensus ? 700 : 1_200)}`).join('\n---\n')}`,
  ].filter(Boolean).join('\n\n').slice(0, repositoryCensus ? 60_000 : 36_000)
  return {
    calls: tasks.length + readTargets.length,
    readCalls: readTargets.length,
    candidatePaths: ranked.map(hit => hit.path).slice(0, repositoryCensus ? 160 : 80),
    seedEvidence,
    confidence,
    frontierExpected,
    frontierCovered,
    frontierCoverage,
    census: repositoryCensus ? {
      candidateFiles: ranked.length,
      directViolationFiles: ranked.filter(hit => hit.censusRole === 'violation').length,
      readFiles: seedEvidence.length,
      truncated: ranked.length > seedEvidence.length,
    } : undefined,
    text,
  }
}
