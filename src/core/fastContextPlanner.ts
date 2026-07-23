import { isAbsolute, relative } from 'node:path'
import type { NativeReasoningConfig } from '../shared/agentTypes'
import type { SubAgentDefinition, SubAgentEvidence } from '../shared/subAgentTypes'
import type { SearchContentHit, ToolExecutor } from '../tools/executor'
import type { ModelCapabilities } from './config'
import { runSubAgent } from './subAgent'

export type FastContextTaskShape = 'direct-owner' | 'indirect-owner' | 'cross-boundary' | 'multi-frontier'
export type FastContextPlannerPerspective = 'causal-owner' | 'frontier' | 'feedback'

export interface FastContextQueryPlan {
  taskShape: FastContextTaskShape
  confidence: number
  needsFeedback: boolean
  symbols: string[]
  semanticQueries: string[]
  filenameGlobs: string[]
  subsystemHints: string[]
  frontierRoles: string[]
  editableExtensions: string[]
  rationale: string
}

export interface FastContextPlannerResult {
  ok: boolean
  plan: FastContextQueryPlan
  elapsedMs: number
  error?: string
}

export interface FastContextPlannedEvidence {
  calls: number
  readCalls: number
  candidatePaths: string[]
  seedEvidence: SubAgentEvidence[]
  confidence: number
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

interface PlannedHit {
  path: string
  line?: number
  preview: string
  score: number
  source: 'semantic' | 'symbol' | 'filename' | 'symbol-filename'
  queryIndex: number
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

Reason semantically: infer likely subsystems, architecture roles, morphological variants, indirect owners, configuration surfaces, and cross-boundary propagation. Do not merely repeat issue words. Do not claim that guessed paths exist. semanticQueries are executable source-search fragments, not prose: each must contain 2-5 discriminative code tokens likely to occur near one another in source. Put broader architectural hypotheses in rationale, subsystemHints, and frontierRoles. symbols must be plausible literal repository identifiers ordered from the most owner-specific to the least; do not put generic issue words in symbols unless they are likely exact code identifiers. For cross-boundary or multi-frontier tasks, allocate queries to separate boundaries such as server capability, transport/config propagation, client state, and UI consumer. Prefer 4-8 discriminative queries over broad keywords.

Return one JSON object only, without Markdown, with this exact shape:
{"taskShape":"direct-owner|indirect-owner|cross-boundary|multi-frontier","confidence":0.0,"needsFeedback":true,"symbols":[],"semanticQueries":[],"filenameGlobs":[],"subsystemHints":[],"frontierRoles":[],"editableExtensions":[],"rationale":""}

confidence measures confidence that this plan can expose the real edit owner, not confidence in the issue description. needsFeedback is true when repository results should be shown back once before final ranking.`,
}

const DEFAULT_EDITABLE_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'pyi', 'rs', 'go', 'java', 'kt', 'kts', 'cs', 'c', 'cc',
  'cpp', 'cxx', 'h', 'hpp', 'swift', 'scala', 'rb', 'php', 'vue', 'svelte', 'json', 'yaml', 'yml', 'toml',
  'ini', 'cfg', 'conf', 'xml', 'gradle', 'properties', 'sh', 'bash', 'zsh', 'fish', 'sql', 'proto', 'graphql',
  'gql', 'md', 'mdx',
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
      const taskShape: FastContextTaskShape = ['direct-owner', 'indirect-owner', 'cross-boundary', 'multi-frontier'].includes(shape)
        ? shape
        : 'indirect-owner'
      const list = (item: unknown, limit: number) => unique(Array.isArray(item) ? item.map(String) : [], limit)
      const plan: FastContextQueryPlan = {
        taskShape,
        confidence: clampConfidence(parsed.confidence),
        needsFeedback: parsed.needsFeedback !== false,
        symbols: list(parsed.symbols, 8),
        semanticQueries: list(parsed.semanticQueries, 8),
        filenameGlobs: list(parsed.filenameGlobs, 6),
        subsystemHints: list(parsed.subsystemHints, 6),
        frontierRoles: list(parsed.frontierRoles, 6),
        editableExtensions: list(parsed.editableExtensions, 8),
        rationale: String(parsed.rationale || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      }
      if (plan.symbols.length === 0 && plan.semanticQueries.length === 0 && plan.filenameGlobs.length === 0) continue
      return plan
    } catch {}
  }
  return undefined
}

function plannerPrompt(objective: string, perspective: FastContextPlannerPerspective, feedbackContext?: string): string {
  const perspectiveInstruction = perspective === 'causal-owner'
    ? 'PERSPECTIVE: Find the causal operation and indirect semantic owner. Prioritize exact error behavior, transformations, state transitions, and morphology-aware symbols. Keep semanticQueries short and grep-ready.'
    : perspective === 'frontier'
      ? 'PERSPECTIVE: Find cross-boundary propagation and the coordinated edit frontier. Allocate separate short, grep-ready queries to configuration, transport, server/client state, UI consumers, adapters, and mirrors when relevant.'
      : 'PERSPECTIVE: Diagnose what the first repository results failed to expose. Produce only new high-information queries for missing owners or frontier boundaries.'
  return [
    'Build the semantic repository retrieval plan for this issue.',
    perspectiveInstruction,
    `ISSUE\n${objective.slice(0, 8_000)}`,
    feedbackContext ? `FIRST-PASS REPOSITORY RESULTS\n${feedbackContext.slice(0, 12_000)}\nReturn a delta plan: avoid repeating low-value queries and target missing owners or frontier edges.` : '',
    'Return JSON only.',
  ].filter(Boolean).join('\n\n')
}

export async function planFastContextQueries(
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
      maxTransientAttempts: 3,
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

function interleave(left: string[], right: string[], limit: number): string[] {
  return unique(Array.from({ length: Math.max(left.length, right.length) })
    .flatMap((_, index) => [left[index], right[index]])
    .filter((value): value is string => Boolean(value)), limit)
}

export function mergeFastContextQueryPlans(owner: FastContextQueryPlan, frontier: FastContextQueryPlan): FastContextQueryPlan {
  const shapeRank: FastContextTaskShape[] = ['direct-owner', 'indirect-owner', 'cross-boundary', 'multi-frontier']
  const taskShape = shapeRank[Math.max(shapeRank.indexOf(owner.taskShape), shapeRank.indexOf(frontier.taskShape))]
  return {
    taskShape,
    confidence: (owner.confidence + frontier.confidence) / 2,
    needsFeedback: owner.needsFeedback || frontier.needsFeedback,
    symbols: interleave(owner.symbols, frontier.symbols, 8),
    semanticQueries: interleave(owner.semanticQueries, frontier.semanticQueries, 8),
    filenameGlobs: interleave(owner.filenameGlobs, frontier.filenameGlobs, 6),
    subsystemHints: interleave(owner.subsystemHints, frontier.subsystemHints, 8),
    frontierRoles: interleave(owner.frontierRoles, frontier.frontierRoles, 8),
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
  return value
    .trim()
    .split(/[^A-Za-z0-9_$]+/)
    .filter(Boolean)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s_.:/-]*')
}

function symbolFileGlob(value: string): string | undefined {
  const identifier = value.match(/[A-Za-z_$][A-Za-z0-9_$]*/)?.[0]
  if (!identifier || identifier.length < 4 || /^__.*__$/.test(identifier)) return undefined
  return `**/*${identifier.replace(/[?*\[\]{}]/g, '')}*.*`
}

async function runLimited<T>(tasks: Array<() => Promise<T>>, concurrency = 6): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length)
  let nextIndex = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (nextIndex < tasks.length) {
      const index = nextIndex++
      try {
        results[index] = { status: 'fulfilled', value: await tasks[index]() }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }))
  return results
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

export async function executeFastContextQueryPlan(params: {
  workspacePath: string
  toolExecutor: ToolExecutor
  plan: FastContextQueryPlan
  coveredEvidence?: SubAgentEvidence[]
}): Promise<FastContextPlannedEvidence> {
  const semanticQueries = unique(params.plan.semanticQueries, 4)
  const symbolQueries = unique(params.plan.symbols, 8)
  const filenameGlobs = unique(params.plan.filenameGlobs, 2)
  const extensionList = editableExtensions(params.plan)
  const extensionSet = new Set(extensionList)
  const sourceGlob = editableGlob(extensionList)
  const contentQueries = [
    ...semanticQueries.map((query, queryIndex) => ({ query, queryIndex, source: 'semantic' as const })),
    ...symbolQueries.map((query, queryIndex) => ({ query, queryIndex, source: 'symbol' as const })),
  ]
  const tasks: Array<() => Promise<PlannedHit[]>> = [
    ...contentQueries.map(({ query, queryIndex, source }) => async () => {
      const pattern = literalPattern(query)
      if (!pattern) return []
      const result = params.toolExecutor.searchContentPage
        ? await params.toolExecutor.searchContentPage(pattern, params.workspacePath, sourceGlob, true, { limit: 160 })
        : await params.toolExecutor.searchContent(pattern, params.workspacePath, sourceGlob, true)
      const page = result.data as SearchContentHit[] | { hits?: SearchContentHit[] } | undefined
      const hits = Array.isArray(page) ? page : page?.hits || []
      const seen = new Set<string>()
      return result.success ? hits.flatMap(hit => {
        const path = relativePath(params.workspacePath, hit.file)
        const key = path.toLowerCase()
        if (!isEditableFile(path, extensionSet) || seen.has(key)) return []
        seen.add(key)
        return [{
          path,
          line: hit.line,
          preview: `${path}:${hit.line} ${hit.text.replace(/\s+/g, ' ').trim().slice(0, 180)}`,
          score: (source === 'symbol' ? 44 : 40) - queryIndex * 2 + pathScore(path, params.plan),
          source,
          queryIndex,
        }]
      }).slice(0, 14) : []
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
  ]
  const settled = await runLimited(tasks, 12)
  const coveredEvidence = params.coveredEvidence || []
  const isCovered = (hit: PlannedHit): boolean => coveredEvidence.some(evidence => {
    if (evidence.path.replace(/\\/g, '/').toLowerCase() !== hit.path.toLowerCase()) return false
    const anchor = hit.line || 1
    return anchor >= Math.max(1, evidence.startLine - 20) && anchor <= evidence.endLine + 20
  })
  const bestByPath = new Map<string, AggregatedHit>()
  for (const hit of settled.flatMap(result => result.status === 'fulfilled' ? result.value : [])) {
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
    .slice(0, 1))
  const symbolLane = ranked.filter(hit => hit.sources.has('symbol')).slice(0, 5)
  const symbolFilenameLane = ranked.filter(hit => hit.sources.has('symbol-filename')).slice(0, 3)
  const filenameLane = ranked.filter(hit => hit.sources.has('filename')).slice(0, 2)
  const readLimit = params.plan.taskShape === 'multi-frontier' || params.plan.taskShape === 'cross-boundary' ? 10 : 8
  const readTargets = [...symbolFilenameLane, ...symbolLane, ...semanticLane, ...filenameLane, ...configLane, ...ranked]
    .filter((hit, index, all) => all.findIndex(other => other.path.toLowerCase() === hit.path.toLowerCase()) === index)
    .slice(0, readLimit)
  const readResults = await runLimited(readTargets.map(hit => async () => {
    const offset = Math.max(0, (hit.line || 1) - 61)
    const range = params.toolExecutor.readFileRange
      ? await params.toolExecutor.readFileRange(hit.path, offset, 220, 96_000)
      : undefined
    if (range?.success && range.data?.content) {
      return {
        path: hit.path,
        startLine: range.data.startLine,
        endLine: range.data.endLine,
        preview: range.data.content.split('\n').slice(0, 12).join('\n'),
        content: range.data.content.slice(0, 16_000),
        reason: 'file read',
        score: hit.score,
      } satisfies SubAgentEvidence
    }
    const file = await params.toolExecutor.readFile(hit.path)
    if (!file.success || !file.data) return undefined
    const lines = String(file.data).split('\n').slice(offset, offset + 220)
    return {
      path: hit.path,
      startLine: offset + 1,
      endLine: offset + lines.length,
      preview: lines.slice(0, 12).join('\n'),
      content: lines.join('\n').slice(0, 16_000),
      reason: 'file read',
      score: hit.score,
    } satisfies SubAgentEvidence
  }))
  const seedEvidence = readResults.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : [])
  const consensusPaths = ranked.filter(hit => hit.sources.size >= 2 || hit.queryKeys.size >= 2).length
  const coveredQueries = new Set(ranked.flatMap(hit => [...hit.queryKeys])).size
  const totalQueries = Math.max(1, contentQueries.length + filenameGlobs.length)
  const queryCoverage = Math.min(1, coveredQueries / totalQueries)
  const confidence = Math.min(0.95, params.plan.confidence * 0.3
    + Math.min(0.3, consensusPaths * 0.075)
    + queryCoverage * 0.25
    + Math.min(0.1, seedEvidence.length * 0.0125))
  const text = [
    `Semantic planner: ${params.plan.taskShape}; confidence=${params.plan.confidence.toFixed(2)}; feedback=${params.plan.needsFeedback}`,
    `Planner rationale: ${params.plan.rationale}`,
    `Planner queries: ${[...params.plan.symbols, ...params.plan.semanticQueries].join(' | ')}`,
    `Planner subsystems: ${params.plan.subsystemHints.join(' | ')}`,
    `Planner candidate reads:\n${seedEvidence.map(item => `${item.path}:${item.startLine}-${item.endLine}\n${(item.content || item.preview).slice(0, 1_200)}`).join('\n---\n')}`,
  ].join('\n\n').slice(0, 36_000)
  return {
    calls: tasks.length + readTargets.length,
    readCalls: readTargets.length,
    candidatePaths: ranked.map(hit => hit.path).slice(0, 80),
    seedEvidence,
    confidence,
    text,
  }
}

export function buildFastContextFeedbackContext(params: {
  plan: FastContextQueryPlan
  localPaths: string[]
  planned: FastContextPlannedEvidence
}): string {
  return [
    `FIRST PLAN\n${JSON.stringify(params.plan)}`,
    `LOCAL EXACT CANDIDATES\n${params.localPaths.slice(0, 60).join('\n')}`,
    `SEMANTIC PLAN CANDIDATES\n${params.planned.candidatePaths.slice(0, 60).join('\n')}`,
    `READ EXCERPTS\n${params.planned.seedEvidence.slice(0, 10).map(item => `${item.path}:${item.startLine}-${item.endLine}\n${(item.content || item.preview).slice(0, 700)}`).join('\n---\n')}`,
  ].join('\n\n').slice(0, 12_000)
}
