import type {
  FastContextScanEvent,
  FastContextScanHit,
  FastContextScanResult,
} from './fastContextTypes'
import type { SubAgentDefinition, SubAgentEvent, SubAgentEvidence } from '../shared/subAgentTypes'
import type { NativeReasoningConfig } from '../shared/agentTypes'
import type { ToolExecutor } from '../tools/executor'
import type { ModelCapabilities } from './config'
import type { CodeSearchHit } from '../shared/codeIndexTypes'
import {
  renderSubmittedCodeMap,
  runSubAgent,
  type SubmittedCodeMap,
} from './subAgent'
import { FAST_CONTEXT_TUNING } from './fastContextTypes'

const FAST_CONTEXT_DEFINITION: SubAgentDefinition = {
  id: 'fast_context',
  label: 'FastContext Causal Owner',
  description: 'Independent root-cause and direct-edit owner locator',
  systemPrompt: `You are the causal-owner branch of FastContext. Find the smallest set of implementation files that directly define the reported defect or requested behavior.

Treat explicit causal statements in the issue as high-value evidence. For bugs, rank the defect-defining implementation before wrappers, feature-specific callers, templates, tests, or documentation. For features, rank the runtime owner and dispatch point before secondary consumers. Search exact identifiers and causal phrases first, read every submitted range, trace only the direct caller/callee or state edge needed to prove ownership, and avoid broad repository tours.

Available tools are search_content, search_files, search_symbols, trace_symbol, get_codemap, read_file, and submit_code_map. Run independent searches and reads in parallel. Every candidate and relationship must cite a read_file range from this run. Finish only with submit_code_map, searches_tried, and uncertainty; fail explicitly rather than guessing.`,
  maxTurns: 4,
  maxParallel: FAST_CONTEXT_TUNING.maxParallel,
  driver: 'main-model',
}

const FAST_CONTEXT_COVERAGE_DEFINITION: SubAgentDefinition = {
  id: 'fast_context',
  label: 'FastContext Change Frontier',
  description: 'Independent high-recall audit of implementation families and coordinated edit boundaries',
  driver: 'main-model',
  maxTurns: 4,
  maxParallel: FAST_CONTEXT_TUNING.maxParallel,
  systemPrompt: `You are the independent change-frontier branch of FastContext. Optimize evidence-grounded recall within a ten-file result while preserving implementation-first ranking.

Search and read the repository yourself. Focus on what a primary locator commonly misses: split pipeline stages, sibling runtime modules, platform/package adapters, serializers, validators, authorization and permission handlers, configuration/schema owners, and behavior-bearing mirrors. Inspect the dispatcher or index that wires a family together, then read every named sibling compiler or handler that could share the change before submitting. Do not pad the result with documentation, generated files, barrels, or tests unless they are themselves part of the requested implementation contract.

Available tools are search_content, search_files, search_symbols, trace_symbol, get_codemap, read_file, and submit_code_map. Run independent searches and reads in parallel. Every submitted candidate and relationship must cite a range returned by read_file in this run. Finish only with submit_code_map. Include searches_tried and uncertainty; fail explicitly rather than guessing.`,
}

export const FAST_CONTEXT_REQUEST_TIMEOUT_MS = 90_000

interface RunParams {
  workspacePath: string
  objective: string
  toolExecutor: ToolExecutor
  apiKey: string
  baseUrl: string
  provider?: string
  customHeaders?: Record<string, string>
  reasoning?: NativeReasoningConfig
  modelCapabilities?: ModelCapabilities
  model?: string
  /** Optional codemap primer. When provided, runner seeds it as a stable
   * cache prefix unit so subsequent calls in the same workspace hit the
   * prompt cache for the primer. */
  codemap?: string
  abortSignal?: AbortSignal
  requestTimeoutMs?: number
  onEvent?: (event: FastContextScanEvent) => void
}

export function __testRetrievalPrimerQueries(objective: string): { symbols: string[]; filePatterns: string[] } {
  const title = objective.split(/\r?\n/, 1)[0]
  const symbols = [...new Set(objective.match(/\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g) || [])]
    .filter(token => /[a-z][A-Z]|_|[A-Z].*[A-Z]/.test(token))
    .slice(0, 5)
  const stopWords = new Set(['with', 'from', 'into', 'when', 'after', 'before', 'always', 'support', 'function', 'option', 'current'])
  const words = (title.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [])
    .map(word => word === 'multiple' ? 'multi' : word.endsWith('s') && word.length > 4 ? word.slice(0, -1) : word)
    .filter(word => !stopWords.has(word))
    .slice(0, 6)
  const filePatterns = [...new Set(words.slice(0, -1).flatMap((word, index) => {
    const next = words[index + 1]
    return [`**/*${word}*${next}*.*`, `**/*${word}${next}*.*`]
  }))].slice(0, 6)
  return { symbols, filePatterns }
}

async function buildRetrievalPrimer(params: RunParams): Promise<{ text?: string; calls: number }> {
  const queries = __testRetrievalPrimerQueries(params.objective)
  const tasks = [
    ...queries.symbols.map(async query => {
      const result = await params.toolExecutor.searchCodeSymbols({ workspacePath: params.workspacePath, query, limit: 8 })
      return result.success ? (result.data || []).slice(0, 8).map((hit: CodeSearchHit) => `${hit.path}:${hit.line || hit.startLine || 1} ${hit.title}`) : []
    }),
    ...queries.filePatterns.map(async pattern => {
      const result = await params.toolExecutor.searchFiles(pattern, params.workspacePath)
      return result.success ? (result.data?.matches || []).slice(0, 8) : []
    }),
  ]
  if (tasks.length === 0) return { calls: 0 }
  const settled = await Promise.allSettled(tasks)
  const lines = settled.flatMap(result => result.status === 'fulfilled' ? result.value : [])
  const unique = [...new Set(lines.map(line => String(line).replace(/\\/g, '/')))].slice(0, 30)
  return {
    calls: tasks.length,
    text: unique.length > 0 ? `Exact local primer (starting points, not proof):\n${unique.join('\n')}` : undefined,
  }
}

function trimText(value: string, max = 220): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat
}

function toScanHit(hit: SubAgentEvidence, workerId?: string): FastContextScanHit {
  return {
    path: hit.path,
    line: hit.startLine,
    startLine: hit.startLine,
    endLine: hit.endLine,
    preview: hit.preview,
    reason: hit.reason,
    workerId,
    symbol: hit.symbol,
  }
}

export function __testBuildEvidencePack(
  objective: string,
  candidates: Map<string, FastContextScanHit[]>,
  elapsedMs: number,
  turns: number,
  truncated: boolean,
  llmReport?: string,
): string {
  const finalReport = trimLlmReport(llmReport)
  if (!finalReport) throw new Error('FastContext completed without a valid model-submitted code map')
  const readConfirmedCount = Array.from(candidates.values())
    .flat()
    .filter(hit => /(?:file read|read confirmation)/i.test(hit.reason || ''))
    .length
  const lines: string[] = [
    '<fast_context_pack role="code_map_locator">',
    `objective: ${objective}`,
    `retrieval: ${turns} turn(s), ${elapsedMs}ms`,
    `quality: ${readConfirmedCount} read-confirmed evidence range(s)`,
    'isolation: subagent raw tool history is not injected; only this compact result enters the main context.',
  ]

  lines.push(
    'status: complete',
    'authority: llm_verified_code_map',
    '',
    'use_policy:',
    '- This report is the semantic retrieval result from model-directed search and file reads.',
    '- Read only the files/ranges needed for the current task and verify again before editing.',
    truncated ? '- Retrieval ended near its budget; investigate any stated uncertainty before editing.' : '',
    '',
    'llm_ranked_code_map:',
    finalReport,
  )

  lines.push('', '</fast_context_pack>')
  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

function trimLlmReport(value?: string): string {
  const text = (value || '').trim()
  if (!text) return ''
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  if (!/^RANKED_CODE_MAP\b/m.test(normalized)) return ''
  return normalized.length > 5000 ? `${normalized.slice(0, 4999)}...` : normalized
}

export function __testMergeCodeMaps(primary?: SubmittedCodeMap, coverage?: SubmittedCodeMap, causal?: SubmittedCodeMap): SubmittedCodeMap | undefined {
  const base = primary || causal || coverage
  if (!base) return undefined
  const nonRuntime = (candidate: SubmittedCodeMap['candidates'][number]) => candidate.editKind === 'test'
    || /(^|\/)(?:docs?|documentation|test|tests|testing|__tests__)(\/|$)|(?:^|\.)test\.[^/]+$|(?:^|\.)spec\.[^/]+$|readme(?:\.[^/]+)?$/i.test(candidate.path.replace(/\\/g, '/'))
  const reports = [primary, coverage, causal].filter((report): report is SubmittedCodeMap => Boolean(report))
  const explicitCandidates = new Map<string, Array<{ candidate: SubmittedCodeMap['candidates'][number]; branch: number; rank: number }>>()
  reports.forEach((report, branch) => report.candidates.forEach((candidate, rank) => {
    const key = candidate.path.replace(/\\/g, '/').toLowerCase()
    const entries = explicitCandidates.get(key) || []
    entries.push({ candidate, branch, rank })
    explicitCandidates.set(key, entries)
  }))
  const consensusCandidates = [...explicitCandidates.values()]
    .filter(entries => entries.length > 1)
    .map(entries => ({
      candidate: entries.find(entry => entry.branch === 0)?.candidate || entries[0].candidate,
      score: entries.reduce((sum, entry) => sum + [3, 2, 2.5][entry.branch] / (entry.rank + 1), 0) + (entries.length - 1) * 2,
    }))
    .filter(item => !nonRuntime(item.candidate))
    .sort((left, right) => right.score - left.score)
    .map(item => item.candidate)
  const relationshipCandidates = reports.flatMap(report => report.relationships)
    .map(relationship => ({
      path: relationship.evidencePath,
      startLine: relationship.startLine,
      endLine: relationship.endLine,
      role: 'change-impact relationship evidence',
      editKind: 'supporting' as const,
      confidence: 'medium' as const,
      why: `${relationship.from} -> ${relationship.to}: ${relationship.relationship}`.slice(0, 320),
    }))
    .filter(candidate => !nonRuntime(candidate))
  const groups = [
    ...(primary ? [primary.candidates.filter(candidate => !nonRuntime(candidate))] : []),
    consensusCandidates,
    ...(causal ? [causal.candidates.filter(candidate => !nonRuntime(candidate))] : []),
    ...(coverage ? [coverage.candidates.filter(candidate => !nonRuntime(candidate))] : []),
    relationshipCandidates,
    ...reports.map(report => report.candidates.filter(nonRuntime)),
  ]
  const candidates: SubmittedCodeMap['candidates'] = []
  const seenCandidates = new Set<string>()
  for (const group of groups) {
    for (const candidate of group) {
      const key = candidate.path.replace(/\\/g, '/').toLowerCase()
      if (seenCandidates.has(key) || candidates.length >= 10) continue
      seenCandidates.add(key)
      candidates.push(candidate)
    }
  }
  const relationships = [...base.relationships]
  const seenRelationships = new Set(relationships.map(item => `${item.from}|${item.to}|${item.evidencePath}`.toLowerCase()))
  for (const report of reports) {
    if (report === base) continue
    for (const relationship of report.relationships) {
      const key = `${relationship.from}|${relationship.to}|${relationship.evidencePath}`.toLowerCase()
      if (seenRelationships.has(key) || relationships.length >= 16) continue
      seenRelationships.add(key)
      relationships.push(relationship)
    }
  }
  const mergeText = (pick: (report: SubmittedCodeMap) => string[], limit: number) => [...new Set(reports.flatMap(pick))].slice(0, limit)
  return {
    candidates,
    relationships,
    rejectedHypotheses: mergeText(report => report.rejectedHypotheses, 12),
    searchesTried: mergeText(report => report.searchesTried, 16),
    uncertainty: mergeText(report => report.uncertainty, 12),
  }
}

export function __testApplyCausalAnchorRanking(report: SubmittedCodeMap, objective: string): SubmittedCodeMap {
  const causalText = objective.match(/(?:caused by|because|due to|root cause|原因是|由于|导致)([\s\S]{0,1000})/i)?.[1] || ''
  const stopWords = new Set(['this', 'that', 'with', 'from', 'into', 'after', 'before', 'when', 'then', 'only', 'value', 'values', 'passed', 'widget', 'function', 'method', 'class'])
  const anchors = [...new Set(causalText.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [])]
    .filter(anchor => !stopWords.has(anchor.toLowerCase()))
    .map(anchor => ({ value: anchor.toLowerCase(), weight: /[A-Z_]/.test(anchor) ? 3 : 1 }))
  const linkedPaths = causalText.match(/(?:[A-Za-z0-9_.-]+\/){2,}[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g)
    ?.map(path => path.toLowerCase()) || []
  const filenameAnchors = [...new Set(__testRetrievalPrimerQueries(objective).filePatterns
    .map(pattern => pattern.replace(/[^A-Za-z0-9]/g, '').toLowerCase())
    .filter(anchor => anchor.length >= 6))]
  if (anchors.length === 0 && linkedPaths.length === 0 && filenameAnchors.length === 0) return report
  const ranked = report.candidates.map((candidate, index) => {
    const path = candidate.path.replace(/\\/g, '/').toLowerCase()
    const evidence = `${path} ${candidate.role} ${candidate.why}`.toLowerCase()
    const pathScore = (linkedPaths.some(linkedPath => linkedPath.endsWith(path)) ? 20 : 0)
      + (filenameAnchors.some(anchor => path.replace(/[^a-z0-9]/g, '').includes(anchor)) ? 8 : 0)
    const anchorScore = anchors.reduce((score, anchor) => score + (evidence.includes(anchor.value) ? anchor.weight : 0), 0)
    return { candidate, index, score: pathScore + anchorScore }
  })
  if (Math.max(...ranked.map(item => item.score)) <= 0) return report
  ranked.sort((left, right) => right.score - left.score || left.index - right.index)
  return { ...report, candidates: ranked.map(item => item.candidate) }
}

export async function runFastContextSubagent(params: RunParams): Promise<FastContextScanResult> {
  if (!params.model?.trim()) throw new Error('Subagent FastContext Causal Owner requires an active model from the main agent.')
  const onEvent = params.onEvent
  const candidates = new Map<string, FastContextScanHit[]>()
  const allHits: FastContextScanHit[] = []
  const seenHitKeys = new Set<string>()
  const startedAt = Date.now()
  const telemetry = { toolCalls: 0, searchCalls: 0, readCalls: 0 }

  const def: SubAgentDefinition = {
    ...FAST_CONTEXT_DEFINITION,
  }

  const emit = (event: FastContextScanEvent): void => { onEvent?.(event) }

  emit({
    type: 'phase',
    phase: 'mapping',
    wave: 1,
    maxWaves: def.maxTurns,
    insight: `building issue map (${def.driver})`,
  })

  const createSubEventHandler = (branch: 'primary' | 'coverage') => {
    let currentTurn = 0
    return (event: SubAgentEvent): void => {
      if (event.type === 'turn_start') {
        currentTurn = event.turn
        const workerId = `${branch}-pass-${event.turn}`
        const phase = event.turn === 1 ? 'mapping' : 'ranking'
        emit({ type: 'worker', id: workerId, label: `${branch} pass ${event.turn}`, status: 'running' })
        if (branch === 'primary') {
          emit({
            type: 'phase',
            phase,
            wave: event.turn,
            maxWaves: event.maxTurns,
            insight: event.turn === 1 ? 'mapping likely entry points' : 'ranking candidate evidence',
          })
        }
      } else if (event.type === 'model_wait') {
        const elapsedSeconds = Math.floor(event.elapsedMs / 1000)
        emit({
          type: 'insight',
          text: elapsedSeconds > 0
            ? `FastContext model response pending (${elapsedSeconds}s)`
            : 'FastContext model request started',
          tone: 'info',
        })
      } else if (event.type === 'model_retry') {
        emit({
          type: 'insight',
          text: `retrying model request: ${trimText(event.reason, 120)}`,
          tone: 'warning',
        })
      } else if (event.type === 'tool_call') {
        telemetry.toolCalls += 1
        if (event.tool === 'read_file') telemetry.readCalls += 1
        else if (event.tool !== 'submit_code_map') telemetry.searchCalls += 1
        const argSummary = (() => {
          const obj = (event.args && typeof event.args === 'object') ? (event.args as Record<string, unknown>) : {}
          const pattern = obj.pattern ?? obj.path ?? ''
          return typeof pattern === 'string' ? trimText(pattern, 84) : ''
        })()
        emit({ type: 'insight', text: `${event.tool}: ${argSummary}`, tone: 'info' })
      } else if (event.type === 'tool_result') {
        emit({ type: 'insight', text: event.summary, tone: event.ok ? 'info' : 'warning' })
      } else if (event.type === 'evidence') {
        const key = `${event.evidence.path}:${event.evidence.startLine}-${event.evidence.endLine}:${event.evidence.reason}`
        if (seenHitKeys.has(key)) return
        seenHitKeys.add(key)
        const workerId = currentTurn > 0 ? `${branch}-pass-${currentTurn}` : undefined
        const scanHit = toScanHit(event.evidence, workerId)
        const list = candidates.get(scanHit.path) || []
        list.push(scanHit)
        candidates.set(scanHit.path, list)
        allHits.push(scanHit)
        emit({ type: 'hit', hit: scanHit })
        emit({
          type: 'file',
          path: scanHit.path,
          status: 'absorbed',
          workerId,
          reason: scanHit.reason,
        })
      } else if (event.type === 'turn_complete') {
        const workerId = `${branch}-pass-${event.turn}`
        emit({ type: 'worker', id: workerId, label: `${branch} pass ${event.turn}`, status: 'completed' })
      } else if (event.type === 'final') {
        emit({ type: 'insight', text: `${branch} summary: ${trimText(event.text, 220)}`, tone: 'info' })
      } else if (event.type === 'error') {
        emit({ type: 'insight', text: `${branch} error: ${event.message}`, tone: 'warning' })
      }
    }
  }

  emit({ type: 'insight', text: 'starting parallel model-directed retrieval', tone: 'info' })
  const primer = await buildRetrievalPrimer(params)
  telemetry.toolCalls += primer.calls
  telemetry.searchCalls += primer.calls
  if (primer.text) emit({ type: 'insight', text: `exact primer found ${primer.text.split('\n').length - 1} starting point(s)`, tone: 'info' })
  const commonOptions = {
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
    codemap: params.codemap,
    abortSignal: params.abortSignal,
    requestTimeoutMs: params.requestTimeoutMs ?? FAST_CONTEXT_REQUEST_TIMEOUT_MS,
    requireGroundedReport: true,
    retrievalContext: primer.text,
  } as const
  const coverageDefinition = {
    ...FAST_CONTEXT_COVERAGE_DEFINITION,
    maxTurns: /\b(?:add|feature|implement|proposal|support)\b/i.test(params.objective.slice(0, 600)) ? 5 : 4,
  }
  let [primaryResult, coverageResult] = await Promise.all([
    runSubAgent({ ...commonOptions, definition: def, onEvent: createSubEventHandler('primary') }),
    runSubAgent({ ...commonOptions, definition: coverageDefinition, onEvent: createSubEventHandler('coverage') }),
  ])

  const combinedError = `${primaryResult.error || ''} ${coverageResult.error || ''}`
  if (!primaryResult.ok && !coverageResult.ok && /\b(?:429|500|502|503|504)\b|fetch failed|timed?\s*out|econnreset/i.test(combinedError)) {
    emit({ type: 'insight', text: 'both retrieval branches hit a transient provider failure; retrying one branch after backoff', tone: 'warning' })
    await new Promise<void>(resolveDelay => {
      const timer = setTimeout(resolveDelay, 2_000)
      params.abortSignal?.addEventListener('abort', () => {
        clearTimeout(timer)
        resolveDelay()
      }, { once: true })
    })
    if (!params.abortSignal?.aborted) {
      primaryResult = await runSubAgent({
        ...commonOptions,
        codemap: undefined,
        retrievalContext: undefined,
        definition: def,
        onEvent: createSubEventHandler('primary'),
      })
    }
  }

  if (!primaryResult.ok && !coverageResult.ok) {
    throw new Error(primaryResult.error || coverageResult.error || 'FastContext locator failed')
  }
  const mergedCodeMap = __testMergeCodeMaps(
    primaryResult.ok ? primaryResult.codeMap : undefined,
    coverageResult.ok ? coverageResult.codeMap : undefined,
  )
  if (!mergedCodeMap) throw new Error('FastContext completed without a structured evidence map')
  const rankedCodeMap = __testApplyCausalAnchorRanking(mergedCodeMap, params.objective)
  const finalReport = renderSubmittedCodeMap(rankedCodeMap)
  const maxTurns = Math.max(primaryResult.turns, coverageResult.turns)

  emit({
    type: 'phase',
    phase: 'synthesizing',
    wave: maxTurns,
    maxWaves: def.maxTurns,
    insight: 'compiling architecture code map',
  })

  const truncated = (primaryResult.ok && primaryResult.truncated === true)
    || (coverageResult.ok && coverageResult.truncated === true)
  const evidencePack = __testBuildEvidencePack(
    params.objective,
    candidates,
    Date.now() - startedAt,
    maxTurns,
    truncated,
    finalReport,
  )

  emit({
    type: 'phase',
    phase: 'completed',
    wave: maxTurns,
    maxWaves: def.maxTurns,
    insight: `completed - ${candidates.size} candidate files - ${allHits.length} evidence ranges`,
  })
  emit({
    type: 'insight',
    text: candidates.size > 0
      ? `Model-submitted code map grounded in ${candidates.size} file(s)`
      : `Code map finished without concrete evidence - ${trimText(finalReport, 160)}`,
    tone: candidates.size > 0 ? 'success' : 'warning',
  })

  return {
    objective: params.objective,
    evidencePack,
    filesScanned: candidates.size,
    hits: allHits,
    elapsedMs: Date.now() - startedAt,
    truncated,
    telemetry,
  }
}
