import type {
  FastContextConfidence,
  FastContextEvidenceKind,
  FastContextLevel,
  FastContextScanEvent,
  FastContextScanHit,
  FastContextScanResult,
} from './fastContextTypes'
import type { SubAgentDefinition, SubAgentEvent, SubAgentEvidence } from '../shared/subAgentTypes'
import type { NativeReasoningConfig } from '../shared/agentTypes'
import type { ToolExecutor } from '../tools/executor'
import type { ModelCapabilities } from './config'
import { buildFastContextSystemPrompt, runSubAgent } from './subAgent'
import { getFastContextTuning } from './fastContextTypes'

const FAST_CONTEXT_DEFINITION: SubAgentDefinition = {
  id: 'fast_context',
  label: 'FastContext Code Map',
  description: 'Fast issue-localization code map for large repositories',
  systemPrompt: buildFastContextSystemPrompt('medium'),
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
  level?: FastContextLevel
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
          : reason.includes('grep') || reason.includes('glob')
            ? 3
            : 0
  const lineSpan = Math.max(1, hit.endLine - hit.startLine + 1)
  const spanPenalty = lineSpan > 90 ? 6 : 0
  const documentationPenalty = /(?:^|\/)(?:docs?|readme)(?:\/|\.|$)/.test(path) && pathMatches === 0 ? 14 : 0
  const entryIntent = tokens.some(token => ENTRY_QUERY_TERMS.has(token))
  const entryIntentAdjustment = entryIntent ? (kind === 'entry' ? 18 : -8) : 0
  return clamp(
    kindWeight[kind] + pathMatches * 8 + previewMatches * 4 + sourceWeight
      + entryIntentAdjustment - spanPenalty - documentationPenalty,
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
      const readConfirmedBonus = reasons.some(reason => /(?:file read|read confirmation)/i.test(reason)) ? 6 : 0
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
    .filter(hit => /(?:file read|read confirmation)/i.test(hit.reason || ''))
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
      '- This report is the semantic retrieval result from model-directed search and file reads.',
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
      '- The semantic retrieval report did not complete. These are unranked tool evidence, not a code map or conclusion.',
      '- The main agent must run targeted search and read_file before making claims or edits.',
      '- Do not infer execution flow from ordering below.',
      '',
      'unranked_tool_evidence:',
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

  const tuning = getFastContextTuning(params.level)
  const def: SubAgentDefinition = {
    ...FAST_CONTEXT_DEFINITION,
    systemPrompt: buildFastContextSystemPrompt(tuning.level),
    maxTurns: params.maxTurns ?? tuning.maxTurns,
    maxParallel: params.maxParallel ?? tuning.maxParallel,
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

  emit({ type: 'insight', text: 'starting model-directed retrieval', tone: 'info' })
  const result = await runSubAgent({
    definition: def,
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
    minimumSearchCalls: tuning.minimumSearchCalls,
    minimumReadCalls: tuning.minimumReadCalls,
    onEvent: onSubEvent,
  })

  if (!result.ok) {
    throw new Error(result.error || 'FastContext locator failed')
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
