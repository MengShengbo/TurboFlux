import type { NativeReasoningConfig } from '../shared/agentTypes'
import type { SubAgentDefinition, SubAgentEvent, SubAgentEvidence } from '../shared/subAgentTypes'
import type { ToolExecutor } from '../tools/executor'
import type { ModelCapabilities } from './config'
import type {
  FastContextScanEvent,
  FastContextScanHit,
  FastContextScanResult,
} from './fastContextTypes'
import { FAST_CONTEXT_TUNING } from './fastContextTypes'
import {
  buildFastContextSystemPrompt,
  renderSubmittedCodeMap,
  runSubAgent,
} from './subAgent'

const FAST_CONTEXT_DEFINITION: SubAgentDefinition = {
  id: 'fast_context',
  label: 'FastContext Controller',
  description: 'Low-latency causal code retrieval with parallel tools and grounded ranking',
  driver: 'main-model',
  systemPrompt: buildFastContextSystemPrompt(),
  maxTurns: FAST_CONTEXT_TUNING.maxTurns,
  maxParallel: FAST_CONTEXT_TUNING.maxParallel,
  maxOutputTokens: 4096,
}

export const FAST_CONTEXT_REQUEST_TIMEOUT_MS = 60_000

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
  codemap?: string
  abortSignal?: AbortSignal
  requestTimeoutMs?: number
  onEvent?: (event: FastContextScanEvent) => void
}

function trimText(value: string, max = 220): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat
}

function trimLlmReport(value?: string): string {
  const text = (value || '').trim()
  if (!text) return ''
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  if (!/^RANKED_CODE_MAP\b/m.test(normalized)) return ''
  return normalized.length > 5000 ? `${normalized.slice(0, 4999)}...` : normalized
}

function toScanHit(evidence: SubAgentEvidence, workerId?: string): FastContextScanHit {
  return {
    path: evidence.path,
    line: evidence.startLine,
    startLine: evidence.startLine,
    endLine: evidence.endLine,
    preview: evidence.preview,
    reason: evidence.reason,
    workerId,
    symbol: evidence.symbol,
    kind: evidence.kind,
    score: evidence.score,
    confidence: evidence.confidence,
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
    .filter(hit => hit.reason === 'file read')
    .length
  return [
    '<fast_context_pack role="code_map_locator">',
    `objective: ${objective}`,
    `retrieval: ${turns} turn(s), ${elapsedMs}ms`,
    `quality: ${readConfirmedCount} read-confirmed evidence range(s)`,
    'isolation: raw tool history stays inside FastContext; only this compact result enters the main context.',
    'status: complete',
    'authority: llm_verified_code_map',
    '',
    'use_policy:',
    '- Treat this as a retrieval result, then verify the ranges needed for the edit.',
    truncated ? '- The controller ended near its budget; preserve the stated uncertainty.' : '',
    '',
    'llm_ranked_code_map:',
    finalReport,
    '',
    '</fast_context_pack>',
  ].filter((line, index, lines) => line || lines[index - 1] !== '').join('\n')
}

export function __testFastContextDefinition(): SubAgentDefinition {
  return { ...FAST_CONTEXT_DEFINITION }
}

export async function runFastContextSubagent(params: RunParams): Promise<FastContextScanResult> {
  if (!params.model?.trim()) throw new Error('Subagent FastContext Controller requires an active model from the main agent.')

  const startedAt = Date.now()
  const emit = (event: FastContextScanEvent): void => { params.onEvent?.(event) }
  const candidates = new Map<string, FastContextScanHit[]>()
  const hits: FastContextScanHit[] = []
  const seenEvidence = new Set<string>()
  const telemetry = {
    toolCalls: 0,
    searchCalls: 0,
    readCalls: 0,
    stageDurationsMs: {
      planner: 0,
      primer: 0,
      plannedRetrieval: 0,
      dependencyExpansion: 0,
      contextMaps: 0,
      judge: 0,
      total: 0,
    },
  }
  let currentTurn = 0

  const recordEvidence = (evidence: SubAgentEvidence): void => {
    const key = `${evidence.path.toLowerCase()}:${evidence.startLine}-${evidence.endLine}:${evidence.reason}`
    if (seenEvidence.has(key)) return
    seenEvidence.add(key)
    const workerId = currentTurn > 0 ? `controller-turn-${currentTurn}` : undefined
    const hit = toScanHit(evidence, workerId)
    const fileHits = candidates.get(hit.path) || []
    fileHits.push(hit)
    candidates.set(hit.path, fileHits)
    hits.push(hit)
    emit({ type: 'hit', hit })
    emit({ type: 'file', path: hit.path, status: 'absorbed', workerId, reason: hit.reason, kind: hit.kind })
  }

  const onSubAgentEvent = (event: SubAgentEvent): void => {
    if (event.type === 'turn_start') {
      currentTurn = event.turn
      emit({ type: 'worker', id: `controller-turn-${event.turn}`, label: `adaptive search ${event.turn}`, status: 'running' })
      emit({
        type: 'phase',
        phase: event.turn === event.maxTurns ? 'ranking' : 'mapping',
        wave: event.turn,
        maxWaves: event.maxTurns,
        insight: event.turn === 1 ? 'forming causal hypotheses' : 'following the highest-information next hop',
      })
      return
    }
    if (event.type === 'turn_complete') {
      emit({ type: 'worker', id: `controller-turn-${event.turn}`, label: `adaptive search ${event.turn}`, status: 'completed' })
      return
    }
    if (event.type === 'model_wait') {
      const seconds = Math.floor(event.elapsedMs / 1000)
      emit({ type: 'insight', text: seconds > 0 ? `FastContext model response pending (${seconds}s)` : 'FastContext model request started', tone: 'info' })
      return
    }
    if (event.type === 'model_retry') {
      emit({ type: 'insight', text: `retrying model request: ${trimText(event.reason, 120)}`, tone: 'warning' })
      return
    }
    if (event.type === 'tool_call') {
      telemetry.toolCalls += 1
      if (event.tool === 'read_file') telemetry.readCalls += 1
      else if (event.tool !== 'submit_code_map') telemetry.searchCalls += 1
      const args = event.args && typeof event.args === 'object' ? event.args as Record<string, unknown> : {}
      const detail = args.query ?? args.pattern ?? args.path ?? ''
      emit({ type: 'insight', text: `${event.tool}: ${typeof detail === 'string' ? trimText(detail, 84) : ''}`, tone: 'info' })
      return
    }
    if (event.type === 'tool_result') {
      emit({ type: 'insight', text: event.summary, tone: event.ok ? 'info' : 'warning' })
      return
    }
    if (event.type === 'evidence') {
      recordEvidence(event.evidence)
      return
    }
    if (event.type === 'error') emit({ type: 'insight', text: event.message, tone: 'warning' })
  }

  emit({
    type: 'phase',
    phase: 'mapping',
    wave: 1,
    maxWaves: FAST_CONTEXT_DEFINITION.maxTurns,
    insight: 'starting one adaptive FastContext controller',
  })

  const result = await runSubAgent({
    definition: FAST_CONTEXT_DEFINITION,
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
    maxCandidates: 10,
    userPrompt: [
      `Objective: ${params.objective}`,
      '',
      'Run FastContext now. Use one adaptive search loop, execute independent tools in parallel, follow causal next hops from wrappers to behavior owners, and submit the smallest complete read-grounded edit frontier.',
    ].join('\n'),
    onEvent: onSubAgentEvent,
  })

  for (const evidence of result.evidence || []) recordEvidence(evidence)
  if (!result.codeMap?.candidates.length) throw new Error(result.error || 'FastContext controller did not produce grounded candidates')

  const elapsedMs = Date.now() - startedAt
  const truncated = result.truncated === true || !result.ok
  telemetry.stageDurationsMs.judge = result.elapsedMs
  telemetry.stageDurationsMs.total = elapsedMs
  if (!result.ok) emit({ type: 'insight', text: `using grounded candidates from a degraded submission: ${trimText(result.error || 'validation warning', 140)}`, tone: 'warning' })

  emit({ type: 'phase', phase: 'synthesizing', wave: result.turns, maxWaves: FAST_CONTEXT_DEFINITION.maxTurns, insight: 'compacting grounded code map' })
  const finalReport = renderSubmittedCodeMap(result.codeMap)
  const evidencePack = __testBuildEvidencePack(params.objective, candidates, elapsedMs, result.turns, truncated, finalReport)
  emit({
    type: 'phase',
    phase: 'completed',
    wave: result.turns,
    maxWaves: FAST_CONTEXT_DEFINITION.maxTurns,
    insight: `completed - ${result.codeMap.candidates.length} ranked candidate(s), ${hits.length} evidence range(s)`,
  })
  emit({ type: 'insight', text: `FastContext grounded ${result.codeMap.candidates.length} candidate(s) in ${result.turns} turn(s)`, tone: 'success' })

  return {
    objective: params.objective,
    evidencePack,
    filesScanned: candidates.size,
    hits,
    elapsedMs,
    truncated,
    telemetry,
  }
}
