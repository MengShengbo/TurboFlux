import { isAbsolute, join, relative } from 'path'
import type {
  FastContextConfidence,
  FastContextEvidenceKind,
  FastContextScanEvent,
  FastContextScanHit,
  FastContextScanResult,
} from './fastContextTypes'
import type { SubAgentEvent, SubAgentEvidence } from '../shared/subAgentTypes'
import type { NativeReasoningConfig } from '../shared/agentTypes'
import type { ToolExecutor } from '../tools/executor'
import type { ModelCapabilities } from './config'
import { runSubAgent } from './subAgent'

const FAST_CONTEXT_DEFINITION = {
  id: 'fast_context',
  label: 'FastContext Code Map',
  description: 'Fast issue-localization code map for large repositories',
  maxTurns: 8,
  maxParallel: 6,
  driver: 'main-model',
}

export const FAST_CONTEXT_REQUEST_TIMEOUT_MS = 90_000

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'when', 'where', 'what',
  'why', 'how', 'into', 'your', 'ours', 'their', 'file', 'code', 'task', 'fix',
  'bug', 'issue', 'error', 'failed', 'fails', 'wrong', 'about', 'need', 'needs',
  'current', 'now', 'then', 'there', 'here', 'read', 'write', 'edit',
  'locate', 'find', 'identify', 'show', 'implementation', 'implement', 'handling',
  'support', 'codebase', 'source', 'logic', 'feature', 'behavior', 'trace', 'tracing',
  'start', 'started', 'persist', 'persisted', 'poll', 'polled', 'restore', 'restored',
  'terminate', 'terminated',
])

const PREFETCH_FILE_GLOBS = [
  '**/{package.json,pyproject.toml,Cargo.toml,go.mod,composer.json,pom.xml,build.gradle,Makefile}',
  '**/{index,main,app,server,client,router,routes,cli}.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,java,kt}',
]
const FAILURE_QUERY_TERMS = new Set([
  'abort', 'aborted', 'crash', 'crashes', 'deadlock', 'freeze', 'freezes', 'hang', 'hangs',
  'stuck', 'timeout', 'timedout', 'exception', 'panic', 'failure',
])
const ENTRY_QUERY_TERMS = new Set(['bootstrap', 'entry', 'entrypoint', 'launch', 'startup'])

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
  maxTurns?: number
  maxParallel?: number
  model?: string
  /** Optional codemap primer. When provided, runner seeds it as a stable
   * cache prefix unit so subsequent calls in the same workspace hit the
   * prompt cache for the primer. */
  codemap?: string
  abortSignal?: AbortSignal
  requestTimeoutMs?: number
  onEvent?: (event: FastContextScanEvent) => void
}

interface CandidateSummary {
  path: string
  hits: FastContextScanHit[]
  score: number
  confidence: FastContextConfidence
  kinds: FastContextEvidenceKind[]
  reasons: string[]
  symbols: string[]
}

interface DeterministicPrefetchResult {
  evidence: SubAgentEvidence[]
  context: string
  errors: string[]
}

async function settleWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = new Array(tasks.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length || 1)) }, async () => {
    while (nextIndex < tasks.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = { status: 'fulfilled', value: await tasks[index]() }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  })
  await Promise.all(workers)
  return results
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function trimText(value: string, max = 220): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat
}

export function __testObjectiveTokens(objective: string): string[] {
  const tokens: string[] = []
  const add = (token: string): void => {
    const value = token.trim().replace(/^[./-]+|[./-]+$/g, '').toLowerCase()
    if (!value || STOP_WORDS.has(value)) return
    if (/^[a-z0-9_.$/-]+$/i.test(value) && value.length < 2) return
    if (/^[\u4e00-\u9fff]+$/u.test(value) && value.length < 2) return
    tokens.push(value)
  }

  for (const quoted of objective.matchAll(/["'`“”‘’]([^"'`“”‘’]{2,})["'`“”‘’]/g)) {
    add(quoted[1])
  }

  for (const raw of objective.match(/[A-Za-z0-9_.$/-]+/g) || []) {
    add(raw)
    for (const part of raw
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[_.$/-]+|\s+/)
      .filter(Boolean)) {
      add(part)
    }
  }

  for (const raw of objective.match(/[\u4e00-\u9fff]+/gu) || []) {
    add(raw)
    for (let size = Math.min(4, raw.length); size >= 2; size--) {
      for (let i = 0; i <= raw.length - size; i++) add(raw.slice(i, i + size))
    }
  }

  return Array.from(new Set(tokens)).slice(0, 32)
}

export function __testSelectPrefetchTokens(objective: string): string[] {
  return selectPrefetchTokens(__testObjectiveTokens(objective))
}

function selectPrefetchTokens(tokens: string[]): string[] {
  const compoundParts = new Set(
    tokens
      .filter(token => /[._/$-]/.test(token))
      .flatMap(token => token.split(/[._/$-]+/).filter(part => part.length >= 2)),
  )
  const preferred = tokens.filter(token => (
    token.length >= 2
    && !STOP_WORDS.has(token)
    && (!compoundParts.has(token) || /[._/$-]/.test(token))
    && !(
      /^[a-z0-9_$]+$/i.test(token)
      && tokens.some(other => (
        other !== token
        && /^[a-z0-9_$]+$/i.test(other)
        && other.length >= token.length + 3
        && other.includes(token)
      ))
    )
  ))
  const codeLike = preferred.filter(token => /[a-z0-9_$]/i.test(token) && (/[._/$-]/.test(token) || /[a-z]/i.test(token)))
  const chinese = preferred.filter(token => /[\u4e00-\u9fff]/u.test(token))
  return Array.from(new Set([
    ...codeLike.slice(0, 6),
    ...chinese.slice(0, 3),
    ...preferred.slice(0, 6),
  ])).slice(0, 6)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function toWorkspaceRelative(workspacePath: string, value: unknown): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const absolutePath = isAbsolute(raw) ? raw : join(workspacePath, raw)
  const relativePath = relative(workspacePath, absolutePath).replace(/\\/g, '/')
  if (!relativePath || relativePath === '.' || relativePath.startsWith('../')) return ''
  return relativePath.replace(/^\.\//, '')
}

function formatPrefetchError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function dedupeEvidence(evidence: SubAgentEvidence[]): SubAgentEvidence[] {
  const seen = new Set<string>()
  return evidence.filter(item => {
    const key = `${item.path}:${item.startLine}-${item.endLine}:${item.reason}:${item.preview}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function takeDiverseContentHits(hits: any[], limit: number, perFileLimit = 3): any[] {
  const selected: any[] = []
  const counts = new Map<string, number>()
  for (const hit of hits) {
    const file = String(hit?.file || '')
    const count = counts.get(file) || 0
    if (!file || count >= perFileLimit) continue
    selected.push(hit)
    counts.set(file, count + 1)
    if (selected.length >= limit) break
  }
  return selected
}

function buildPrefetchContext(evidence: SubAgentEvidence[]): string {
  const confirmed = evidence.filter(item => /prefetch read confirmation/i.test(item.reason)).slice(0, 6)
  const candidates = evidence
    .filter(item => !/prefetch read confirmation/i.test(item.reason))
    .slice(0, 10)
  const lines: string[] = []

  if (confirmed.length > 0) {
    lines.push('read-confirmed candidates:')
    for (const item of confirmed) {
      lines.push(`- ${item.path}:${item.startLine}-${item.endLine} ${trimText(item.preview.replace(/\s+/g, ' '), 260)}`)
    }
  }
  if (candidates.length > 0) {
    lines.push('search candidates:')
    for (const item of candidates) {
      lines.push(`- ${item.path}:${item.startLine} ${trimText(item.preview.replace(/\s+/g, ' '), 180)}`)
    }
  }
  return lines.join('\n') || 'No deterministic candidates were found; use independent search strategies.'
}

async function runDeterministicPrefetch(params: RunParams, tokens: string[]): Promise<DeterministicPrefetchResult> {
  const selectedTokens = selectPrefetchTokens(tokens)
  const tasks: Array<{
    label: string
    kind: 'files' | 'content' | 'symbols'
    token?: string
    pattern?: string
    run: () => Promise<any>
  }> = []

  for (const pattern of PREFETCH_FILE_GLOBS) {
    tasks.push({
      label: `glob ${pattern}`,
      kind: 'files',
      pattern,
      run: () => params.toolExecutor.searchFiles(pattern, params.workspacePath),
    })
  }
  const filenameTokens = Array.from(new Set(
    selectedTokens
      .flatMap(token => token.split(/[._/$-]+/))
      .map(token => token.replace(/[^a-z0-9_\u4e00-\u9fff-]/gi, ''))
      .filter(token => token.length >= 3),
  )).slice(0, 8)
  if (filenameTokens.length > 0) {
    const pattern = filenameTokens.length === 1
      ? `**/*${filenameTokens[0]}*`
      : `**/*{${filenameTokens.join(',')}}*`
    tasks.push({
      label: `filenames ${filenameTokens.join(',')}`,
      kind: 'files',
      token: filenameTokens.join(','),
      pattern,
      run: () => params.toolExecutor.searchFiles(pattern, params.workspacePath),
    })
  }
  for (const token of selectedTokens) {
    tasks.push({
      label: `content ${token}`,
      kind: 'content',
      token,
      run: () => params.toolExecutor.searchContent(escapeRegExp(token), params.workspacePath, undefined, true),
    })
  }
  const pairTokens = selectedTokens.filter(token => /^[a-z0-9_$-]+$/i.test(token)).slice(0, 5)
  for (let index = 0; index < pairTokens.length - 1 && index < 3; index += 1) {
    const left = pairTokens[index]
    const right = pairTokens[index + 1]
    const pattern = `(?:${escapeRegExp(left)}.{0,80}${escapeRegExp(right)}|${escapeRegExp(right)}.{0,80}${escapeRegExp(left)})`
    tasks.push({
      label: `content pair ${left}+${right}`,
      kind: 'content',
      token: `${left}+${right}`,
      run: () => params.toolExecutor.searchContent(pattern, params.workspacePath, undefined, true),
    })
  }
  for (const token of selectedTokens.filter(value => /^[a-z_$][a-z0-9_$]{2,}$/i.test(value)).slice(0, 4)) {
    tasks.push({
      label: `symbols ${token}`,
      kind: 'symbols',
      token,
      run: () => params.toolExecutor.searchCodeSymbols({ workspacePath: params.workspacePath, query: token, limit: 8 }),
    })
  }

  const settled = await settleWithConcurrency(tasks.map(task => task.run), params.maxParallel ?? FAST_CONTEXT_DEFINITION.maxParallel)
  const evidence: SubAgentEvidence[] = []
  const errors: string[] = []

  settled.forEach((item, index) => {
    const task = tasks[index]
    if (item.status === 'rejected') {
      errors.push(`${task.label}: ${formatPrefetchError(item.reason)}`)
      return
    }
    const result = item.value
    if (!result?.success) {
      errors.push(`${task.label}: ${result?.error || 'search failed'}`)
      return
    }

    if (task.kind === 'files') {
      const matches = Array.isArray(result.data?.matches) ? result.data.matches : []
      for (const match of matches.slice(0, 12)) {
        const path = toWorkspaceRelative(params.workspacePath, match)
        if (!path) continue
        evidence.push({
          path,
          startLine: 1,
          endLine: 1,
          preview: path,
          reason: task.token
            ? `prefetch filename: ${task.token}`
            : `prefetch glob: ${task.pattern}`,
        })
      }
      return
    }

    if (task.kind === 'content') {
      const hits = Array.isArray(result.data) ? result.data : []
      for (const hit of takeDiverseContentHits(hits, 12)) {
        const path = toWorkspaceRelative(params.workspacePath, hit?.file)
        const line = Math.max(1, Number(hit?.line) || 1)
        if (!path) continue
        evidence.push({
          path,
          startLine: Math.max(1, line - 2),
          endLine: line + 2,
          preview: String(hit?.text || ''),
          reason: `prefetch search: ${task.token}`,
        })
      }
      return
    }

    const hits = Array.isArray(result.data) ? result.data : []
    for (const hit of hits.slice(0, 8)) {
      const path = toWorkspaceRelative(params.workspacePath, hit?.path)
      const line = Math.max(1, Number(hit?.line || hit?.startLine) || 1)
      if (!path) continue
      evidence.push({
        path,
        startLine: line,
        endLine: Math.max(line, Number(hit?.endLine) || line + 5),
        preview: String(hit?.preview || hit?.subtitle || hit?.title || ''),
        reason: `prefetch symbol: ${task.token}`,
        symbol: hit?.symbolName || hit?.title,
      })
    }
  })

  const uniqueEvidence = dedupeEvidence(evidence)
  const grouped = new Map<string, FastContextScanHit[]>()
  const candidateEvidence = uniqueEvidence.filter(item => !/prefetch glob/i.test(item.reason))
  const evidenceForRanking = candidateEvidence.length > 0
    ? candidateEvidence
    : uniqueEvidence
  for (const item of evidenceForRanking) {
    const hit = decorateHit(item, tokens, 'prefetch')
    const list = grouped.get(hit.path) || []
    list.push(hit)
    grouped.set(hit.path, list)
  }

  const rankedCandidates = summarizeCandidates(grouped)
  const anchorGrouped = new Map<string, FastContextScanHit[]>()
  for (const item of uniqueEvidence.filter(item => /prefetch glob/i.test(item.reason))) {
    const hit = decorateHit(item, tokens, 'prefetch')
    const list = anchorGrouped.get(hit.path) || []
    list.push(hit)
    anchorGrouped.set(hit.path, list)
  }
  const rankedAnchors = summarizeCandidates(anchorGrouped)
  const entryOrStartupQuery = tokens.some(token => ENTRY_QUERY_TERMS.has(token))
  const preferredTargets = entryOrStartupQuery
    ? [...rankedCandidates.slice(0, 3), ...rankedAnchors.slice(0, 2), ...rankedCandidates.slice(3)]
    : rankedCandidates
  const seenReadTargets = new Set<string>()
  const readTargets = preferredTargets.filter(candidate => {
    if (seenReadTargets.has(candidate.path)) return false
    seenReadTargets.add(candidate.path)
    return true
  }).slice(0, entryOrStartupQuery ? 7 : 6)
  const readResults = await Promise.all(readTargets.map(async candidate => {
    if (params.abortSignal?.aborted) return null
    const filePath = join(params.workspacePath, candidate.path)
    const targetLine = Math.max(1, candidate.hits[0]?.startLine || 1)
    const offset = Math.max(0, targetLine - 8)
    const result = params.toolExecutor.readFileRange
      ? await params.toolExecutor.readFileRange(filePath, offset, 26)
      : await params.toolExecutor.readFile(filePath)
    if (!result.success || result.data === undefined) {
      errors.push(`read ${candidate.path}: ${result.error || 'read failed'}`)
      return null
    }
    const rangeData = params.toolExecutor.readFileRange ? result.data as { content: string; startLine: number; endLine: number } : null
    const lines = rangeData ? rangeData.content.split(/\r?\n/) : String(result.data).split(/\r?\n/)
    const start = rangeData ? rangeData.startLine - 1 : Math.max(0, Math.min(lines.length, targetLine - 8))
    const end = rangeData ? rangeData.endLine : Math.min(lines.length, Math.max(start + 1, targetLine + 17))
    return {
      path: candidate.path,
      startLine: start + 1,
      endLine: end,
      preview: rangeData ? rangeData.content : lines.slice(start, end).join('\n'),
      reason: 'prefetch read confirmation',
    } satisfies SubAgentEvidence
  }))

  const allEvidence = dedupeEvidence([
    ...uniqueEvidence,
    ...readResults.filter((item): item is SubAgentEvidence => Boolean(item)),
  ])
  return {
    evidence: allEvidence,
    context: buildPrefetchContext(allEvidence),
    errors,
  }
}

function countTokenMatches(value: string, tokens: string[]): number {
  const lower = value.toLowerCase()
  let count = 0
  for (const token of tokens) {
    if (lower.includes(token)) count++
  }
  return count
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function inferKind(hit: SubAgentEvidence, tokens: string[]): FastContextEvidenceKind {
  const path = hit.path.toLowerCase()
  const base = basename(path)
  const preview = hit.preview.toLowerCase()
  const reason = hit.reason.toLowerCase()
  const objectiveMatches = countTokenMatches(`${path}\n${preview}`, tokens)
  const looksLikeFailureSite = /\b(throw|error|exception|failed|failure|invalid|missing|undefined|null|abort|reject)\b/.test(preview)
  const objectiveLooksLikeFailure = tokens.some(token => FAILURE_QUERY_TERMS.has(token))

  if (/\b(test|spec|benchmark|fixture)\b|__tests__|\.test\.|\.spec\./.test(path)) return 'test'
  if (/\b(schema|types?|interface|contract|protocol|ipc|dto|registry)\b/.test(path)) return 'schema'
  if (/(\.config\.|config|settings|package\.json|tsconfig|vite|webpack|rollup|eslint|env)/.test(path)) return 'config'
  if (/^bin\/.*\.(?:mjs|cjs|js|ts|py|sh|ps1|cmd|bat)$/.test(path) || /^(index|main|app|server|client|router|routes|cli)\./.test(base) || /\b(routes?|entry|bootstrap)\b/.test(path)) return 'entry'
  if (objectiveLooksLikeFailure && looksLikeFailureSite && objectiveMatches >= 2) return 'root_cause'
  if ((reason.includes('grep') || reason.includes('symbol')) && /\b(import|from|require|use[A-Z]|\w+\()/.test(hit.preview)) return 'caller'
  if (reason.includes('file read') || /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cs|cpp|c|swift|kt)$/.test(path)) return 'implementation'
  return 'supporting'
}

function extractSymbol(hit: SubAgentEvidence): string | undefined {
  const preview = hit.preview.replace(/\s+/g, ' ')
  const symbolMatch = preview.match(/\b(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/)
    || preview.match(/\b([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:\(|function\b)/)
    || preview.match(/\bexport\s+(?:default\s+)?([A-Za-z_$][\w$]*)/)
  return symbolMatch?.[1]
}

function scoreHit(hit: SubAgentEvidence, kind: FastContextEvidenceKind, tokens: string[]): number {
  const path = hit.path.toLowerCase()
  const preview = hit.preview.toLowerCase()
  const reason = hit.reason.toLowerCase()
  const pathMatches = countTokenMatches(path, tokens)
  const previewMatches = countTokenMatches(preview, tokens)
  const kindWeight: Record<FastContextEvidenceKind, number> = {
    root_cause: 78,
    entry: 72,
    implementation: 68,
    caller: 63,
    schema: 60,
    config: 56,
    test: 54,
    supporting: 44,
  }
  const sourceWeight = reason.includes('file read')
    ? 10
    : reason.includes('read confirmation')
      ? 8
      : reason.includes('symbol')
        ? 8
        : reason.includes('codemap')
          ? 5
          : reason.includes('prefetch search')
            ? reason.includes('+') ? 10 : 5
            : reason.includes('grep') || reason.includes('glob')
              ? 3
              : 0
  const lineSpan = Math.max(1, hit.endLine - hit.startLine + 1)
  const spanPenalty = lineSpan > 90 ? 6 : 0
  const genericAnchorPenalty = reason.includes('prefetch glob') && pathMatches === 0 ? 24 : 0
  const documentationPenalty = /(?:^|\/)(?:docs?|readme)(?:\/|\.|$)/.test(path) && pathMatches === 0 ? 14 : 0
  const barrelPenalty = /(?:^|\/)(?:index|main)\.[a-z0-9]+$/.test(path) && pathMatches === 0 && reason.includes('prefetch glob') ? 10 : 0
  const entryIntent = tokens.some(token => ENTRY_QUERY_TERMS.has(token))
  const entryIntentAdjustment = entryIntent ? (kind === 'entry' ? 18 : -8) : 0
  return clamp(
    kindWeight[kind] + pathMatches * 8 + previewMatches * 4 + sourceWeight
      + entryIntentAdjustment - spanPenalty - genericAnchorPenalty - documentationPenalty - barrelPenalty,
    20,
    140,
  )
}

function confidenceForScore(score: number): FastContextConfidence {
  if (score >= 78) return 'high'
  if (score >= 58) return 'medium'
  return 'low'
}

function decorateHit(hit: SubAgentEvidence, tokens: string[], workerId?: string): FastContextScanHit {
  const kind = inferKind(hit, tokens)
  const score = scoreHit(hit, kind, tokens)
  return {
    path: hit.path,
    line: hit.startLine,
    startLine: hit.startLine,
    endLine: hit.endLine,
    preview: hit.preview,
    reason: hit.reason,
    workerId,
    kind,
    score,
    confidence: confidenceForScore(score),
    symbol: extractSymbol(hit),
  }
}

function summarizeCandidates(candidates: Map<string, FastContextScanHit[]>): CandidateSummary[] {
  return Array.from(candidates.entries())
    .map(([path, hits]) => {
      const sortedHits = [...hits].sort((a, b) => (b.score || 0) - (a.score || 0))
      const topScore = sortedHits[0]?.score || 0
      const kinds = Array.from(new Set(sortedHits.map(hit => hit.kind || 'supporting')))
      const reasons = Array.from(new Set(sortedHits.map(hit => hit.reason || '').filter(Boolean))).slice(0, 3)
      const symbols = Array.from(new Set(sortedHits.map(hit => hit.symbol || '').filter(Boolean))).slice(0, 4)
      const diversityBonus = Math.min(7, Math.max(0, kinds.length - 1) * 3)
      const densityBonus = Math.min(12, Math.max(0, sortedHits.length - 1) * 3)
      const readConfirmedBonus = reasons.some(reason => /(?:file read|read confirmation|prefetch read)/i.test(reason)) ? 6 : 0
      const testPenalty = kinds.length === 1 && kinds[0] === 'test' ? 12 : 0
      const score = Math.max(20, topScore + diversityBonus + densityBonus + readConfirmedBonus - testPenalty)
      return {
        path,
        hits: sortedHits,
        score,
        confidence: confidenceForScore(score),
        kinds,
        reasons,
        symbols,
      }
    })
    .sort((a, b) => b.score - a.score)
}

export function __testBuildEvidencePack(
  objective: string,
  candidates: Map<string, FastContextScanHit[]>,
  elapsedMs: number,
  turns: number,
  truncated: boolean,
  llmReport?: string,
): string {
  const fallbackRanked = summarizeCandidates(candidates).slice(0, 12)
  const finalReport = trimLlmReport(llmReport)
  const readConfirmedCount = Array.from(candidates.values())
    .flat()
    .filter(hit => /(?:file read|read confirmation|prefetch read)/i.test(hit.reason || ''))
    .length
  const lines: string[] = [
    '<fast_context_pack role="code_map_locator">',
    `objective: ${objective}`,
    `retrieval: ${turns} turn(s), ${elapsedMs}ms`,
    `quality: ${readConfirmedCount} read-confirmed evidence range(s)`,
    'isolation: subagent raw tool history is not injected; only this compact result enters the main context.',
  ]

  if (finalReport) {
    lines.push(
      'status: complete',
      'authority: llm_verified_code_map',
      '',
      'use_policy:',
      '- This report is the semantic retrieval result. Local heuristics were used only to execute fast recall.',
      '- Read only the files/ranges needed for the current task and verify again before editing.',
      truncated ? '- Retrieval ended near its budget; investigate any stated uncertainty before editing.' : '',
      '',
      'llm_ranked_code_map:',
      finalReport,
    )
  } else {
    lines.push(
      'status: degraded',
      'authority: none',
      '',
      'use_policy:',
      '- The semantic LLM retrieval stage did not complete. These are local recall leads, not a code map or conclusion.',
      '- The main agent must run targeted search and read_file before making claims or edits.',
      '- Do not infer execution flow from ordering below.',
      '',
      'local_recall_candidates:',
    )
    if (fallbackRanked.length === 0) {
      lines.push('- no concrete local candidates found')
    }
    fallbackRanked.forEach((candidate, idx) => {
      lines.push(`${idx + 1}. ${candidate.path} [${candidate.confidence}] roles=${candidate.kinds.join(',')}`)
      if (candidate.symbols.length > 0) lines.push(`   symbols: ${candidate.symbols.join(', ')}`)
      if (candidate.reasons.length > 0) lines.push(`   why: ${candidate.reasons.join('; ')}`)
      for (const hit of candidate.hits.slice(0, 2)) {
        const label = hit.kind ? `${hit.kind} ` : ''
        lines.push(`   evidence: ${label}L${hit.startLine}-${hit.endLine} ${trimText(hit.preview, 140)}`)
      }
    })
  }

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

export async function runFastContextSubagent(params: RunParams): Promise<FastContextScanResult> {
  const onEvent = params.onEvent
  const candidates = new Map<string, FastContextScanHit[]>()
  const allHits: FastContextScanHit[] = []
  const seenHitKeys = new Set<string>()
  const tokens = __testObjectiveTokens(params.objective)
  const startedAt = Date.now()

  const def = {
    ...FAST_CONTEXT_DEFINITION,
    maxTurns: params.maxTurns ?? FAST_CONTEXT_DEFINITION.maxTurns,
    maxParallel: params.maxParallel ?? FAST_CONTEXT_DEFINITION.maxParallel,
    driver: (params.model as typeof FAST_CONTEXT_DEFINITION.driver) ?? FAST_CONTEXT_DEFINITION.driver,
  }

  const emit = (event: FastContextScanEvent): void => { onEvent?.(event) }

  emit({
    type: 'phase',
    phase: 'mapping',
    wave: 1,
    maxWaves: def.maxTurns,
    insight: `building issue map (${def.driver})`,
  })

  let currentTurn = 0

  const onSubEvent = (event: SubAgentEvent): void => {
    if (event.type === 'turn_start') {
      currentTurn = event.turn
      const workerId = `map-pass-${event.turn}`
      const phase = event.turn === 1 ? 'mapping' : 'ranking'
      emit({ type: 'worker', id: workerId, label: `map pass ${event.turn}`, status: 'running' })
      emit({
        type: 'phase',
        phase,
        wave: event.turn,
        maxWaves: event.maxTurns,
        insight: event.turn === 1 ? 'mapping likely entry points' : 'ranking candidate evidence',
      })
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
      const workerId = currentTurn > 0 ? `map-pass-${currentTurn}` : undefined
      const scanHit = decorateHit(event.evidence, tokens, workerId)
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
        kind: scanHit.kind,
        score: scanHit.score,
        confidence: scanHit.confidence,
      })
    } else if (event.type === 'turn_complete') {
      const workerId = `map-pass-${event.turn}`
      emit({ type: 'worker', id: workerId, label: `map pass ${event.turn}`, status: 'completed' })
    } else if (event.type === 'final') {
      emit({ type: 'insight', text: `locator summary: ${trimText(event.text, 220)}`, tone: 'info' })
    } else if (event.type === 'error') {
      emit({ type: 'insight', text: `locator error: ${event.message}`, tone: 'warning' })
    }
  }

  emit({ type: 'insight', text: 'running deterministic workspace prefetch', tone: 'info' })
  const prefetch = await runDeterministicPrefetch(params, tokens)
  for (const evidence of prefetch.evidence) {
    onSubEvent({ type: 'evidence', evidence })
  }
  if (prefetch.errors.length > 0) {
    emit({
      type: 'insight',
      text: `prefetch completed with ${prefetch.errors.length} recoverable error(s): ${trimText(prefetch.errors[0], 140)}`,
      tone: 'warning',
    })
  } else {
    emit({
      type: 'insight',
      text: `prefetch found ${prefetch.evidence.length} evidence range(s) across ${candidates.size} file(s)`,
      tone: prefetch.evidence.length > 0 ? 'success' : 'warning',
    })
  }

  const result = await runSubAgent({
    definition: def as any,
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
    retrievalContext: prefetch.context,
    initialEvidence: prefetch.evidence,
    requireGroundedReport: true,
    onEvent: onSubEvent,
  })

  if (!result.ok && prefetch.evidence.length === 0) {
    throw new Error(result.error || 'FastContext locator failed')
  }
  if (!result.ok) {
    emit({
      type: 'insight',
      text: `model ranking unavailable; using deterministic evidence (${trimText(result.error || 'request failed', 120)})`,
      tone: 'warning',
    })
  }

  emit({
    type: 'phase',
    phase: 'synthesizing',
    wave: result.turns,
    maxWaves: def.maxTurns,
    insight: 'compiling ranked code map',
  })

  const ranked = summarizeCandidates(candidates)
  const truncated = (result.truncated ?? false) || !result.ok
  const evidencePack = __testBuildEvidencePack(
    params.objective,
    candidates,
    result.elapsedMs,
    result.turns,
    truncated,
    result.ok ? result.finalText : undefined,
  )

  emit({
    type: 'phase',
    phase: 'completed',
    wave: result.turns,
    maxWaves: def.maxTurns,
    insight: `completed - ${ranked.length} candidate files - ${allHits.length} evidence ranges`,
  })
  emit({
    type: 'insight',
    text: ranked.length > 0
      ? `Code map ranked ${ranked.length} files; top candidate ${ranked[0].path} (${ranked[0].confidence})`
      : (result.finalText ? `Code map finished without concrete evidence - ${trimText(result.finalText, 160)}` : 'Code map found no specific evidence'),
    tone: ranked.length > 0 ? 'success' : 'warning',
  })

  return {
    objective: params.objective,
    evidencePack,
    filesScanned: candidates.size,
    hits: allHits,
    elapsedMs: Date.now() - startedAt,
    truncated,
  }
}
