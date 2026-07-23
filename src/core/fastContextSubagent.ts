import type {
  FastContextScanEvent,
  FastContextScanHit,
  FastContextScanResult,
} from './fastContextTypes'
import type { SubAgentDefinition, SubAgentEvent, SubAgentEvidence } from '../shared/subAgentTypes'
import type { NativeReasoningConfig } from '../shared/agentTypes'
import type { ToolExecutor } from '../tools/executor'
import type { ModelCapabilities } from './config'
import {
  renderSubmittedCodeMap,
  runSubAgent,
  type SubmittedCodeMap,
} from './subAgent'
import { FAST_CONTEXT_TUNING } from './fastContextTypes'
import {
  buildFastContextPrimerQueries,
  buildFastContextRetrievalPrimer,
} from './fastContextRetrieval'
import { buildContextMapsPrimer } from './contextMaps'

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

const FAST_CONTEXT_RERANK_DEFINITION: SubAgentDefinition = {
  id: 'fast_context',
  label: 'FastContext Evidence Reranker',
  description: 'Bounded listwise reranker over read-confirmed candidates and structural frontier hints',
  driver: 'main-model',
  maxTurns: 3,
  maxParallel: FAST_CONTEXT_TUNING.maxParallel,
  systemPrompt: `You are the final evidence reranker for FastContext. Two independent locators have already explored the repository. Compare their candidates jointly instead of starting another broad repository tour.

Rank by direct edit necessity, not textual similarity. Separate the behavior owner from callers, wrappers, tests, documentation, and generic configuration surfaces. Apply a counterfactual edit test: ask which candidate must change for the faulty semantics to become correct. A caller that merely forwards complete state or configuration ranks below the shared predicate, transformation, or state transition that interprets it. For bugs, identify the concrete operation that causes the observed failure. For features, recover the complete coordinated implementation frontier, including sibling pipeline stages and behavior-bearing mirrors. Use the structural and behavioral query views independently, then reconcile them.

The caller provides branch rankings, read-confirmed source excerpts, and an implementation-family census. Treat filenames and search hits only as hypotheses. If a high-signal sibling or graph neighbor could be a required edit but lacks source evidence, read it with a narrow range before deciding. Search only to resolve a specific missing owner or frontier edge. Do not perform a generic repository tour.

Use listwise comparison: evaluate candidates relative to one another, place the most probable direct owner first, retain every read-confirmed implementation that is necessary for the same change, and explicitly reject attractive false positives. Every submitted candidate and relationship must be grounded by read_file evidence available in this run. Finish only with submit_code_map.` ,
}

const FAST_CONTEXT_BOUNDED_JUDGE_DEFINITION: SubAgentDefinition = {
  id: 'fast_context',
  label: 'FastContext Evidence Judge',
  description: 'Bounded listwise judgment over locally retrieved, read-confirmed evidence',
  driver: 'main-model',
  maxTurns: 1,
  maxParallel: 6,
  maxOutputTokens: 4096,
  systemPrompt: `You are the final evidence judge for FastContext. A deterministic retrieval stage has already searched the repository, expanded likely implementation families, and read the strongest source candidates. You receive its complete bounded candidate field and read-confirmed excerpts.

Perform one closed-list listwise decision and call submit_code_map immediately. Retrieval tools are intentionally unavailable in this stage. Rank by direct edit necessity rather than lexical similarity. Use a counterfactual edit test: the behavior owner is the file whose implementation must change for the requested semantics to become correct. Rank wrappers, tests, documentation, schemas, generic configuration, and downstream output consumers below the operation that interprets or mutates behavior.

Preserve a compact coordinated frontier. When a bug crosses a public API or orchestration stage into a compiler, parser, serializer, validator, adapter, or renderer, retain every read-confirmed behavior-bearing stage that can require a coordinated edit; do not collapse the map to only the deepest owner. Evidence labeled semantic responsibility probe is deliberately targeted: compare it directly with the primary owner and keep it when it implements the named transformation or output stage. Conversely, never pad the top ten with unrelated writers, builders, callers, or sibling domains merely because they consume the resulting data.

Apply causal proximity before ranking. A file that defines an API, state transition, transformation, or emitted output explicitly named by the issue outranks environment-specific adapters, framework wiring, examples, and analogous sibling implementations. Operating system, backend, version, and provider details are reproduction context unless the issue explicitly identifies them as causal. A sibling that merely demonstrates a similar pattern belongs in rejected hypotheses and must never outrank the read-confirmed failing path.

Every candidate and relationship must use a read-confirmed path and line range supplied in the evidence or obtained through the single targeted tool round. Explicitly reject attractive false positives and state residual uncertainty. Do not perform a generic repository tour, do not return prose, and do not invent unread files. Finish with exactly one submit_code_map call.` ,
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

export const __testRetrievalPrimerQueries = buildFastContextPrimerQueries

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

export function __testBuildRerankContext(params: {
  primer?: string
  primary?: SubmittedCodeMap
  coverage?: SubmittedCodeMap
  evidence: SubAgentEvidence[]
}): string {
  const reports = [params.primary, params.coverage].filter((report): report is SubmittedCodeMap => Boolean(report))
  const rankedPaths = new Set(reports
    .flatMap(report => report.candidates)
    .map(candidate => candidate.path.replace(/\\/g, '/').toLowerCase()))
  const readEvidence = params.evidence.filter(item => item.reason === 'file read')
  const groupedEvidence = new Map<string, SubAgentEvidence[]>()
  for (const item of readEvidence) {
    const key = item.path.replace(/\\/g, '/').toLowerCase()
    const entries = groupedEvidence.get(key) || []
    entries.push(item)
    groupedEvidence.set(key, entries)
  }
  const orderedEvidence = [...groupedEvidence.entries()]
    .sort((left, right) => Number(rankedPaths.has(right[0])) - Number(rankedPaths.has(left[0])))
    .slice(0, 24)
    .map(([, entries]) => {
      const path = entries[0].path.replace(/\\/g, '/')
      const excerpts = entries.slice(0, 3).map(entry => {
        const source = (entry.content || entry.preview || '').trim().slice(0, 1_600)
        return `${path}:${entry.startLine}-${entry.endLine}\n${source}`
      })
      return excerpts.join('\n---\n')
    })
  const sections = [
    params.primer ? `DUAL-PERSPECTIVE CANDIDATE POOL\n${params.primer}` : '',
    params.primary ? `CAUSAL-OWNER BRANCH\n${renderSubmittedCodeMap(params.primary)}` : '',
    params.coverage ? `CHANGE-FRONTIER BRANCH\n${renderSubmittedCodeMap(params.coverage)}` : '',
    orderedEvidence.length > 0 ? `READ-CONFIRMED SOURCE EXCERPTS\n${orderedEvidence.join('\n\n=====\n\n')}` : '',
    'RERANKING CONTRACT\nCompare the candidates jointly. Return the direct behavior owner first, preserve every required implementation in a coordinated multi-file frontier, and reject wrappers or nearby files that do not require edits. Resolve any high-signal unread sibling with one targeted read before submission.',
  ].filter(Boolean)
  return sections.join('\n\n').slice(0, 48_000)
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

export function __testApplyResponsibilityRanking(report: SubmittedCodeMap, objective: string): SubmittedCodeMap {
  const objectiveTerms = [...new Set((objective.slice(0, 1_200).toLowerCase().match(/[a-z_][a-z0-9_-]{3,}/g) || [])
    .filter(term => !['this', 'that', 'with', 'from', 'when', 'then', 'into', 'after', 'before', 'should'].includes(term)))]
  const scored = report.candidates.slice(0, 5).map((candidate, index) => {
    const role = candidate.role.toLowerCase()
    const text = `${role} ${candidate.why}`.toLowerCase()
    const declarativeSurface = /configuration schema|option (?:schema|definition)|documentation|type declaration/i.test(role)
    const semanticOwner = !declarativeSurface
      && (candidate.editKind === 'owner' || candidate.editKind === 'implementation')
      && /\b(?:defines?|implements?|owns?|performs?|applies?)\b[^.!;]{0,100}(?:predicate|match|matching|normaliz|transform|mutat|state|decision|validation|serializ|parse)/i.test(text)
    const primitiveLanguage = /predicate|matcher|matching semantics|normaliz|transform|state transition|mutat|serializ|parse decision/i
    const semanticPrimitive = semanticOwner
      || primitiveLanguage.test(role)
        && candidate.editKind !== 'consumer'
    const delegation = !semanticPrimitive
      && /\bcaller\b|\bwrapper\b|\bforwards?\b|\bdelegates?\b|\borchestrat|\bentry point\b|\bcalls?\b[^.!;]{0,80}\b(?:helper|predicate|implementation)/i.test(text)
    const lexical = Math.min(3, objectiveTerms.filter(term => text.includes(term)).length)
    const score = (semanticOwner ? 5 : 0)
      + (semanticPrimitive ? 3 : 0)
      + (candidate.editKind === 'owner' ? 2 : candidate.editKind === 'implementation' ? 1 : 0)
      + lexical
      - (declarativeSurface ? 5 : 0)
      - (delegation ? 4 : 0)
    return { candidate, index, score }
  })
  if (scored.length < 2) return report
  const current = scored[0]
  const best = [...scored].sort((left, right) => right.score - left.score || left.index - right.index)[0]
  if (best.index === 0 || best.score < current.score + 2) return report
  return {
    ...report,
    candidates: [best.candidate, ...report.candidates.filter(candidate => candidate !== best.candidate)],
  }
}

export function __testSelectFrontierAuditPaths(
  primerPaths: string[],
  report: SubmittedCodeMap,
  readPaths: string[],
): string[] {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
  const directory = (value: string) => {
    const normalized = normalize(value)
    const index = normalized.lastIndexOf('/')
    return index > 0 ? normalized.slice(0, index) : ''
  }
  const parent = (value: string) => {
    const index = value.lastIndexOf('/')
    return index > 0 ? value.slice(0, index) : ''
  }
  const knownDirectories = report.candidates.map(candidate => directory(candidate.path)).filter(Boolean)
  const alreadyRead = new Set(readPaths.map(normalize))
  const responsibilityName = /authori[sz]|permission|validat|integrat|response|serializ|deserializ|adapter|handler|registry|dispatch|resolver|transform|normaliz|parser|schema|policy/i
  return [...new Set(primerPaths.map(path => path.replace(/\\/g, '/').replace(/^\.\//, '')))]
    .filter(path => /\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|kts|swift|cs|cpp|cc|cxx|c|h|hpp|php|scala|vue|svelte)$/i.test(path))
    .filter(path => !alreadyRead.has(normalize(path)))
    .filter(path => !/(?:^|\/)(?:docs?|documentation|test|tests|__tests__)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$/i.test(path))
    .map(path => {
      const pathDirectory = directory(path)
      const related = knownDirectories.some(known => pathDirectory === known || parent(pathDirectory) === known || parent(known) === pathDirectory)
      const namedRole = responsibilityName.test(path.slice(path.lastIndexOf('/') + 1))
      return { path, score: (related ? 4 : 0) + (namedRole ? 5 : 0) }
    })
    .filter(item => item.score >= 9)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 8)
    .map(item => item.path)
}

export function __testEnsureFeatureFrontierCandidates(
  report: SubmittedCodeMap,
  preliminary: SubmittedCodeMap,
  objective: string,
): SubmittedCodeMap {
  if (!/\b(?:add|feature|implement|proposal|support)\b/i.test(objective.slice(0, 800))) return report
  const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase()
  const responsibilityName = /authori[sz]|permission|validat|integrat|response|serializ|deserializ|adapter|handler|registry|dispatch|resolver|transform|normaliz|parser|schema|policy/i
  const isResponsibilityCandidate = (candidate: SubmittedCodeMap['candidates'][number]) => {
    const filename = candidate.path.slice(candidate.path.lastIndexOf('/') + 1)
    return responsibilityName.test(filename)
      && candidate.editKind !== 'test'
      && !/(?:^|\/)(?:docs?|documentation|test|tests|__tests__)(?:\/|$)/i.test(candidate.path)
  }
  const candidates = [...report.candidates]
  const seen = new Set(candidates.map(candidate => normalize(candidate.path)))
  for (const candidate of preliminary.candidates.filter(isResponsibilityCandidate)) {
    const key = normalize(candidate.path)
    if (seen.has(key)) continue
    if (candidates.length >= 10) {
      let replacementIndex = -1
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const existing = candidates[index]
        if (!isResponsibilityCandidate(existing) && (existing.editKind === 'supporting' || existing.editKind === 'consumer')) {
          replacementIndex = index
          break
        }
      }
      if (replacementIndex < 0) continue
      seen.delete(normalize(candidates[replacementIndex].path))
      candidates.splice(replacementIndex, 1)
    }
    candidates.push(candidate)
    seen.add(key)
  }
  const ranked = candidates.map((candidate, index) => ({
    candidate,
    index,
    score: (isResponsibilityCandidate(candidate) ? 5 : 0)
      + (candidate.editKind === 'owner' ? 2 : candidate.editKind === 'implementation' ? 1 : 0)
      - (candidate.editKind === 'supporting' ? 1 : 0),
  }))
  ranked.sort((left, right) => right.score - left.score || left.index - right.index)
  return { ...report, candidates: ranked.map(item => item.candidate) }
}

async function readFrontierAuditEvidence(paths: string[], params: RunParams): Promise<SubAgentEvidence[]> {
  const results = await Promise.allSettled(paths.map(async path => {
    const rangeResult = params.toolExecutor.readFileRange
      ? await params.toolExecutor.readFileRange(path, 0, 320, 96_000)
      : undefined
    if (rangeResult?.success && rangeResult.data?.content) {
      return {
        path,
        startLine: rangeResult.data.startLine,
        endLine: rangeResult.data.endLine,
        preview: rangeResult.data.content.split('\n').slice(0, 12).join('\n'),
        content: rangeResult.data.content.slice(0, 24_000),
        reason: 'file read',
      } satisfies SubAgentEvidence
    }
    const fileResult = await params.toolExecutor.readFile(path)
    if (!fileResult.success || !fileResult.data) return undefined
    const lines = String(fileResult.data).split('\n').slice(0, 320)
    return {
      path,
      startLine: 1,
      endLine: lines.length,
      preview: lines.slice(0, 12).join('\n'),
      content: lines.join('\n').slice(0, 24_000),
      reason: 'file read',
    } satisfies SubAgentEvidence
  }))
  return results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : [])
}

async function readContextMapEvidence(
  contextMaps: Awaited<ReturnType<typeof buildContextMapsPrimer>>,
  primerEvidence: SubAgentEvidence[],
  params: RunParams,
): Promise<SubAgentEvidence[]> {
  const knownPaths = new Set(primerEvidence.map(item => item.path.replace(/\\/g, '/').toLowerCase()))
  const candidates = (contextMaps.primer?.candidates || [])
    .filter(item => !knownPaths.has(item.path.toLowerCase()))
    .slice(0, 4)
  const results = await Promise.allSettled(candidates.map(async candidate => {
    const offset = Math.max(0, candidate.startLine - 41)
    const limit = Math.min(240, Math.max(120, candidate.endLine - offset))
    const rangeResult = params.toolExecutor.readFileRange
      ? await params.toolExecutor.readFileRange(candidate.path, offset, limit, 96_000)
      : undefined
    if (rangeResult?.success && rangeResult.data?.content) {
      return {
        path: candidate.path,
        startLine: rangeResult.data.startLine,
        endLine: rangeResult.data.endLine,
        preview: rangeResult.data.content.split('\n').slice(0, 12).join('\n'),
        content: rangeResult.data.content.slice(0, 16_000),
        reason: 'context map read',
      } satisfies SubAgentEvidence
    }
    return undefined
  }))
  return results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : [])
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

  const createSubEventHandler = (branch: 'primary' | 'coverage' | 'rerank' | 'judge' | 'recovery') => {
    let currentTurn = 0
    return (event: SubAgentEvent): void => {
      if (event.type === 'turn_start') {
        currentTurn = event.turn
        const workerId = `${branch}-pass-${event.turn}`
        const phase = event.turn === 1 ? 'mapping' : 'ranking'
        emit({ type: 'worker', id: workerId, label: `${branch} pass ${event.turn}`, status: 'running' })
        if (branch === 'primary' || branch === 'rerank') {
          emit({
            type: 'phase',
            phase: branch === 'rerank' ? 'synthesizing' : phase,
            wave: event.turn,
            maxWaves: event.maxTurns,
            insight: branch === 'rerank'
              ? 'comparing read-confirmed candidates'
              : event.turn === 1 ? 'mapping likely entry points' : 'ranking candidate evidence',
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
  emit({ type: 'context_maps', state: 'warming' })
  const primer = await buildFastContextRetrievalPrimer(params)
  const contextMaps = primer.confidence < 0.7
    ? await buildContextMapsPrimer({
      workspacePath: params.workspacePath,
      objective: params.objective,
      toolExecutor: params.toolExecutor,
    })
    : { status: 'unavailable' as const, elapsedMs: 0 }
  if (contextMaps.status === 'on' && contextMaps.primer) {
    emit({
      type: 'context_maps',
      state: 'on',
      confidence: contextMaps.primer.confidence,
      nodes: contextMaps.primer.nodes,
      elapsedMs: contextMaps.elapsedMs,
    })
    emit({
      type: 'insight',
      text: `ContextMaps enabled with ${contextMaps.primer.nodes} graph node(s) at ${contextMaps.primer.confidence.toFixed(2)} confidence`,
      tone: 'success',
    })
  } else {
    emit({ type: 'context_maps', state: 'off', elapsedMs: contextMaps.elapsedMs })
  }
  const contextMapEvidence = await readContextMapEvidence(contextMaps, primer.seedEvidence, params)
  telemetry.toolCalls += contextMapEvidence.length
  telemetry.readCalls += contextMapEvidence.length
  telemetry.toolCalls += primer.calls
  telemetry.readCalls += primer.readCalls
  telemetry.searchCalls += primer.calls - primer.readCalls
  for (const evidence of primer.seedEvidence) {
    const key = `${evidence.path}:${evidence.startLine}-${evidence.endLine}:${evidence.reason}`
    if (seenHitKeys.has(key)) continue
    seenHitKeys.add(key)
    const scanHit = toScanHit(evidence, 'primer')
    const list = candidates.get(scanHit.path) || []
    list.push(scanHit)
    candidates.set(scanHit.path, list)
    allHits.push(scanHit)
    emit({ type: 'hit', hit: scanHit })
    emit({ type: 'file', path: scanHit.path, status: 'absorbed', workerId: 'primer', reason: 'multi-route source seed' })
  }
  for (const evidence of contextMapEvidence) {
    const key = `${evidence.path}:${evidence.startLine}-${evidence.endLine}:${evidence.reason}`
    if (seenHitKeys.has(key)) continue
    seenHitKeys.add(key)
    const scanHit = toScanHit(evidence, 'context-maps')
    const list = candidates.get(scanHit.path) || []
    list.push(scanHit)
    candidates.set(scanHit.path, list)
    allHits.push(scanHit)
    emit({ type: 'hit', hit: scanHit })
    emit({ type: 'file', path: scanHit.path, status: 'absorbed', workerId: 'context-maps', reason: 'graph hypothesis read and confirmed' })
  }
  if (primer.text) emit({ type: 'insight', text: `exact primer found ${primer.text.split('\n').length - 1} starting point(s)`, tone: 'info' })
  const initialEvidence = [...primer.seedEvidence, ...contextMapEvidence]
    .filter((item, index, all) => all.findIndex(other => other.path.toLowerCase() === item.path.toLowerCase()) === index)
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
    maxTransientAttempts: 3,
    requireGroundedReport: true,
    retrievalContext: [contextMaps.primer?.text, primer.text].filter(Boolean).join('\n\n') || undefined,
    initialEvidence,
    submissionOnly: true,
  } as const
  emit({ type: 'insight', text: 'running single-pass evidence judgment', tone: 'info' })
  let result = initialEvidence.length > 0
    ? await runSubAgent({
        ...commonOptions,
        definition: FAST_CONTEXT_BOUNDED_JUDGE_DEFINITION,
        onEvent: createSubEventHandler('judge'),
      })
    : await runSubAgent({
        ...commonOptions,
        definition: def,
        onEvent: createSubEventHandler('recovery'),
      })
  const providerFailure = /all compatible model protocols failed|upstream (?:service )?temporarily unavailable|\b(?:408|409|429|500|502|503|504)\b|fetch failed|timed?\s*out|econnreset|enotfound|socket/i.test(result.error || '')
  if (!result.ok && initialEvidence.length > 0 && !providerFailure && !params.abortSignal?.aborted) {
    emit({ type: 'insight', text: `evidence judgment did not converge; starting one model-directed recovery: ${trimText(result.error || 'unknown error', 120)}`, tone: 'warning' })
    result = await runSubAgent({
      ...commonOptions,
      definition: def,
      onEvent: createSubEventHandler('recovery'),
    })
  }
  if (!result.ok || !result.codeMap) throw new Error(result.error || 'FastContext locator failed')
  const responsibilityRankedCodeMap = __testApplyResponsibilityRanking(result.codeMap, params.objective)
  const rankedCodeMap = __testApplyCausalAnchorRanking(responsibilityRankedCodeMap, params.objective)
  const finalReport = renderSubmittedCodeMap(rankedCodeMap)
  const maxTurns = result.turns

  emit({
    type: 'phase',
    phase: 'synthesizing',
    wave: maxTurns,
    maxWaves: def.maxTurns,
    insight: 'compiling architecture code map',
  })

  const truncated = result.truncated === true
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
