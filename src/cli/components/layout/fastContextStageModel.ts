import type {
  FastContextScanEvent,
  FastContextScanPhase,
  FastContextScanWorkerStatus,
} from '../../../core/fastContextTypes'
import type { FastContextUiSummary } from './fastContextUi'
import { createTranslator, type Translator } from '../../i18n/index'

export type FastContextTraceTone = 'info' | 'success' | 'warning' | 'error' | 'muted'

export interface FastContextTraceEntry {
  id: string
  label: string
  detail: string
  tone: FastContextTraceTone
}

export interface FastContextStageWorker {
  id: string
  label: string
  status: FastContextScanWorkerStatus
  currentPath?: string
  scannedCount: number
  hitCount: number
}

export interface FastContextStageModel {
  phase: FastContextScanPhase
  phaseLabel: string
  stageIndex: number
  wave: number
  maxWaves: number
  files: number
  absorbed: number
  hits: number
  currentTarget: string
  insight: string
  activeWorkers: FastContextStageWorker[]
  trace: FastContextTraceEntry[]
}

const TERMINAL_PHASES: readonly FastContextScanPhase[] = ['completed', 'cancelled', 'error']
const DEFAULT_TRANSLATOR = createTranslator('en')

export function projectFastContextStage(
  events: readonly FastContextScanEvent[],
  summary: FastContextUiSummary,
  traceLimit = 10,
  t: Translator = DEFAULT_TRANSLATOR,
): FastContextStageModel {
  let phase = summary.phase
  let wave = 0
  let maxWaves = 0
  let currentTarget = summary.latest
  let insight = summary.insight
  let sawReadActivity = summary.absorbed > 0 || summary.hits > 0
  const workers = new Map<string, FastContextStageWorker>()
  const trace: FastContextTraceEntry[] = []
  const limit = Math.max(1, Math.floor(traceLimit))

  const appendTrace = (entry: Omit<FastContextTraceEntry, 'id'>, eventIndex: number): void => {
    trace.push({ ...entry, id: `${eventIndex}-${entry.label}-${trace.length}` })
    if (trace.length > limit) trace.splice(0, trace.length - limit)
  }

  events.forEach((event, eventIndex) => {
    if (event.type === 'phase') {
      phase = event.phase
      wave = event.wave ?? wave
      maxWaves = event.maxWaves ?? maxWaves
      insight = event.insight || insight
      appendTrace({
        label: t('ui.fastContext.trace.phase'),
        detail: `${formatPhase(event.phase, t)}${event.insight ? ` - ${event.insight}` : ''}`,
        tone: terminalTone(event.phase),
      }, eventIndex)
      return
    }

    if (event.type === 'worker') {
      const previous = workers.get(event.id)
      const worker: FastContextStageWorker = {
        id: event.id,
        label: event.label,
        status: event.status,
        currentPath: event.currentPath ?? previous?.currentPath,
        scannedCount: event.scannedCount ?? previous?.scannedCount ?? 0,
        hitCount: event.hitCount ?? previous?.hitCount ?? 0,
      }
      workers.set(event.id, worker)
      if (worker.currentPath) currentTarget = worker.currentPath
      appendTrace({
        label: t('ui.fastContext.trace.worker'),
        detail: `${worker.label} - ${worker.currentPath || worker.status}`,
        tone: event.status === 'error' ? 'error' : event.status === 'completed' ? 'success' : 'info',
      }, eventIndex)
      return
    }

    if (event.type === 'file') {
      currentTarget = event.path
      if (event.status === 'reading' || event.status === 'absorbed') sawReadActivity = true
      const label = event.status === 'discovered' ? t('ui.fastContext.trace.discovered')
        : event.status === 'reading' ? t('ui.fastContext.trace.read')
        : event.status === 'absorbed' ? t('ui.fastContext.trace.absorbed')
        : event.status === 'error' ? t('ui.fastContext.trace.error')
        : t('ui.fastContext.trace.skipped')
      appendTrace({
        label,
        detail: `${event.path}${event.kind ? ` [${event.kind}]` : ''}${event.reason ? ` - ${event.reason}` : ''}`,
        tone: event.status === 'error' ? 'error' : event.status === 'absorbed' ? 'success' : event.status === 'skipped' ? 'muted' : 'info',
      }, eventIndex)
      return
    }

    if (event.type === 'hit') {
      sawReadActivity = true
      currentTarget = event.hit.path
      appendTrace({
        label: t('ui.fastContext.trace.evidence'),
        detail: `${event.hit.path}:${event.hit.startLine}-${event.hit.endLine}${event.hit.kind ? ` [${event.hit.kind}]` : ''}`,
        tone: 'success',
      }, eventIndex)
      return
    }

    if (event.type === 'progress') {
      if (event.latest) currentTarget = event.latest
      if (event.insight) insight = event.insight
      if (event.absorbed > 0 || event.hits > 0) sawReadActivity = true
      appendTrace({
        label: t('ui.fastContext.trace.progress'),
        detail: t('ui.fastContext.trace.progressDetail', {
          absorbed: event.absorbed,
          files: event.files,
          hits: event.hits,
          latest: event.latest ? ` - ${event.latest}` : '',
        }),
        tone: 'info',
      }, eventIndex)
      return
    }

    if (event.type === 'insight') {
      insight = event.text
      appendTrace({
        label: insightLabel(event.text, t),
        detail: event.text,
        tone: event.tone === 'success' ? 'success' : event.tone === 'warning' ? 'warning' : 'info',
      }, eventIndex)
      return
    }

    appendTrace({
      label: t('ui.fastContext.trace.turn', { turn: event.turn }),
      detail: t('ui.fastContext.trace.turnDetail', {
        calls: event.calls,
        duration: formatDuration(event.totalElapsedMs),
        tokens: formatTokens(event.outputTokens),
      }),
      tone: 'muted',
    }, eventIndex)
  })

  const activeWorkers = [...workers.values()].filter(worker => worker.status === 'running')
  const stageIndex = phase === 'ranking' ? 2
    : phase === 'synthesizing' || phase === 'completed' ? 3
    : phase === 'mapping' && sawReadActivity ? 1
    : 0

  return {
    phase,
    phaseLabel: phase === 'mapping' && sawReadActivity ? t('ui.fastContext.phase.reading') : formatPhase(phase, t),
    stageIndex,
    wave,
    maxWaves,
    files: summary.files,
    absorbed: summary.absorbed,
    hits: summary.hits,
    currentTarget,
    insight,
    activeWorkers,
    trace,
  }
}

export function isFastContextTerminalPhase(phase: FastContextScanPhase): boolean {
  return TERMINAL_PHASES.includes(phase)
}

function formatPhase(phase: FastContextScanPhase, t: Translator): string {
  if (phase === 'mapping') return t('ui.fastContext.phase.mapping')
  if (phase === 'scanning') return t('ui.fastContext.phase.scanning')
  if (phase === 'ranking') return t('ui.fastContext.phase.ranking')
  if (phase === 'synthesizing') return t('ui.fastContext.phase.synthesizing')
  if (phase === 'completed') return t('ui.fastContext.phase.completed')
  if (phase === 'cancelled') return t('ui.fastContext.phase.cancelled')
  return t('ui.fastContext.phase.error')
}

function terminalTone(phase: FastContextScanPhase): FastContextTraceTone {
  if (phase === 'completed') return 'success'
  if (phase === 'error') return 'error'
  if (phase === 'cancelled') return 'warning'
  return 'info'
}

function insightLabel(text: string, t: Translator): string {
  if (/^read_file\b/i.test(text)) return t('ui.fastContext.trace.read')
  if (/^search_/i.test(text)) return 'SEARCH'
  if (/model/i.test(text)) return 'MODEL'
  if (/retry|degraded|warning/i.test(text)) return 'RECOVER'
  return 'INSIGHT'
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}
