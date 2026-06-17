import type {
  FastContextConfidence,
  FastContextEvidenceKind,
  FastContextScanEvent,
  FastContextScanHit,
  FastContextScanResult,
} from './fastContextTypes'
import type { SubAgentEvent, SubAgentEvidence } from '../shared/subAgentTypes'
import type { ToolExecutor } from '../tools/executor'
import { runSubAgent } from './subAgent'

const FAST_CONTEXT_DEFINITION = {
  id: 'fast_context',
  label: 'FastContext Code Map',
  description: 'Fast issue-localization code map for large repositories',
  maxTurns: 3,
  maxParallel: 6,
  driver: 'deepseek-flash',
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'when', 'where', 'what',
  'why', 'how', 'into', 'your', 'ours', 'their', 'file', 'code', 'task', 'fix',
  'bug', 'issue', 'error', 'failed', 'fails', 'wrong', 'about', 'need', 'needs',
  'current', 'now', 'then', 'there', 'here', 'read', 'write', 'edit',
])

interface RunParams {
  workspacePath: string
  objective: string
  toolExecutor: ToolExecutor
  apiKey: string
  baseUrl: string
  maxTurns?: number
  maxParallel?: number
  model?: string
  /** Optional codemap primer. When provided, runner seeds it as a stable
   * cache prefix unit so subsequent calls in the same workspace hit the
   * prompt cache for the primer. */
  codemap?: string
  abortSignal?: AbortSignal
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

function objectiveTokens(objective: string): string[] {
  return Array.from(new Set(
    objective
      .toLowerCase()
      .split(/[^a-z0-9_.$/-]+/i)
      .map(token => token.trim())
      .filter(token => token.length >= 3 && !STOP_WORDS.has(token)),
  )).slice(0, 16)
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function inferKind(hit: SubAgentEvidence, tokens: string[]): FastContextEvidenceKind {
  const path = hit.path.toLowerCase()
  const base = basename(path)
  const preview = hit.preview.toLowerCase()
  const reason = hit.reason.toLowerCase()
  const objectiveMatches = tokens.filter(token => path.includes(token) || preview.includes(token)).length
  const looksLikeFailureSite = /\b(throw|error|exception|failed|failure|invalid|missing|undefined|null|abort|reject)\b/.test(preview)

  if (looksLikeFailureSite && objectiveMatches >= 2) return 'root_cause'
  if (/\b(test|spec)\b|__tests__|\.test\.|\.spec\./.test(path)) return 'test'
  if (/\b(schema|types?|interface|contract|protocol|ipc|dto)\b/.test(path)) return 'schema'
  if (/(\.config\.|config|settings|package\.json|tsconfig|vite|webpack|rollup|eslint|env)/.test(path)) return 'config'
  if (/^(index|main|app|server|client|router|routes|cli)\./.test(base) || /\b(routes?|entry|bootstrap)\b/.test(path)) return 'entry'
  if (reason.includes('grep') && /\b(import|from|require|use[A-Z]|\w+\()/.test(hit.preview)) return 'caller'
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
  const pathMatches = tokens.filter(token => path.includes(token)).length
  const previewMatches = tokens.filter(token => preview.includes(token)).length
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
  const sourceWeight = reason.includes('file read') ? 8 : reason.includes('grep') ? 3 : 0
  const lineSpan = Math.max(1, hit.endLine - hit.startLine + 1)
  const spanPenalty = lineSpan > 90 ? 6 : 0
  return clamp(kindWeight[kind] + pathMatches * 8 + previewMatches * 4 + sourceWeight - spanPenalty, 20, 98)
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
      const score = clamp(topScore + diversityBonus + densityBonus, 20, 100)
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

function buildEvidencePack(
  objective: string,
  candidates: Map<string, FastContextScanHit[]>,
  elapsedMs: number,
  turns: number,
  truncated: boolean,
): string {
  const ranked = summarizeCandidates(candidates).slice(0, 7)
  const lines: string[] = [
    '<fast_context_pack role="code_map_locator">',
    `objective: ${objective}`,
    `retrieval: ${turns} turn(s), ${elapsedMs}ms`,
    'isolation: subagent tool history is not injected; only this ranked evidence pack enters the main context.',
    '',
    'use_policy:',
    '- Treat this as an issue-localization map, not a complete proof.',
    '- Read only the candidate files/ranges needed for the current task.',
    '- Prefer high-confidence entry/root_cause/implementation candidates first.',
    truncated ? '- Retrieval was truncated; run targeted search if a candidate looks incomplete.' : '',
    '',
    'ranked_candidates:',
  ].filter(Boolean)

  if (ranked.length === 0) {
    lines.push('- no concrete candidates found')
  }

  ranked.forEach((candidate, idx) => {
    lines.push(`${idx + 1}. ${candidate.path} [${candidate.confidence}, score ${Math.round(candidate.score)}] roles=${candidate.kinds.join(',')}`)
    if (candidate.symbols.length > 0) lines.push(`   symbols: ${candidate.symbols.join(', ')}`)
    if (candidate.reasons.length > 0) lines.push(`   why: ${candidate.reasons.join('; ')}`)
    for (const hit of candidate.hits.slice(0, 2)) {
      const label = hit.kind ? `${hit.kind} ` : ''
      lines.push(`   evidence: ${label}L${hit.startLine}-${hit.endLine} ${trimText(hit.preview, 140)}`)
    }
  })

  lines.push('', '</fast_context_pack>')
  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

export async function runFastContextSubagent(params: RunParams): Promise<FastContextScanResult> {
  const onEvent = params.onEvent
  const candidates = new Map<string, FastContextScanHit[]>()
  const allHits: FastContextScanHit[] = []
  const seenHitKeys = new Set<string>()
  const tokens = objectiveTokens(params.objective)
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
      const key = `${event.evidence.path}:${event.evidence.startLine}-${event.evidence.endLine}`
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

  const result = await runSubAgent({
    definition: def as any,
    objective: params.objective,
    workspacePath: params.workspacePath,
    toolExecutor: params.toolExecutor,
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
    model: params.model,
    codemap: params.codemap,
    abortSignal: params.abortSignal,
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
  const evidencePack = buildEvidencePack(params.objective, candidates, result.elapsedMs, result.turns, result.truncated ?? false)

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
    truncated: result.truncated ?? false,
  }
}
