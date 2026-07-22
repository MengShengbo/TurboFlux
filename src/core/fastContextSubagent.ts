import type {
  FastContextScanEvent,
  FastContextScanHit,
  FastContextScanResult,
} from './fastContextTypes'
import type { SubAgentDefinition, SubAgentEvent, SubAgentEvidence } from '../shared/subAgentTypes'
import type { NativeReasoningConfig } from '../shared/agentTypes'
import type { ToolExecutor } from '../tools/executor'
import type { ModelCapabilities } from './config'
import { buildFastContextSystemPrompt, runSubAgent } from './subAgent'
import { FAST_CONTEXT_TUNING } from './fastContextTypes'

const FAST_CONTEXT_DEFINITION: SubAgentDefinition = {
  id: 'fast_context',
  label: 'FastContext Code Map',
  description: 'Grounded architecture and change-impact code map for large repositories',
  systemPrompt: buildFastContextSystemPrompt(),
  maxTurns: FAST_CONTEXT_TUNING.maxTurns,
  maxParallel: FAST_CONTEXT_TUNING.maxParallel,
  driver: 'main-model',
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

export async function runFastContextSubagent(params: RunParams): Promise<FastContextScanResult> {
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
      const workerId = currentTurn > 0 ? `map-pass-${currentTurn}` : undefined
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
    insight: 'compiling architecture code map',
  })

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
    insight: `completed - ${candidates.size} candidate files - ${allHits.length} evidence ranges`,
  })
  emit({
    type: 'insight',
    text: candidates.size > 0
      ? `Model-submitted code map grounded in ${candidates.size} file(s)`
      : (result.finalText ? `Code map finished without concrete evidence - ${trimText(result.finalText, 160)}` : 'Code map found no specific evidence'),
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
