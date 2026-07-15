import type { FastContextScanEvent, FastContextScanPhase } from '../../../core/fastContextTypes'

export const MAX_FAST_CONTEXT_UI_EVENTS = 120

export interface FastContextUiSummary {
  phase: FastContextScanPhase
  events: number
  files: number
  absorbed: number
  hits: number
  latest: string
}

export function createFastContextUiSummary(): FastContextUiSummary {
  return {
    phase: 'scanning',
    events: 0,
    files: 0,
    absorbed: 0,
    hits: 0,
    latest: '',
  }
}

export function reduceFastContextUiSummary(
  summary: FastContextUiSummary,
  events: readonly FastContextScanEvent[],
): FastContextUiSummary {
  const next = { ...summary }

  for (const event of events) {
    next.events += 1
    if (event.type === 'phase') next.phase = event.phase
    if (event.type === 'file') {
      if (event.status === 'discovered') {
        next.files += 1
        next.latest = event.path
      } else if (event.status === 'absorbed') {
        next.absorbed += 1
      }
    }
    if (event.type === 'hit') next.hits += 1
    if (event.type === 'worker' && event.currentPath) next.latest = event.currentPath
  }

  return next
}

export function appendFastContextUiEvents(
  current: readonly FastContextScanEvent[],
  incoming: readonly FastContextScanEvent[],
  limit = MAX_FAST_CONTEXT_UI_EVENTS,
): FastContextScanEvent[] {
  if (incoming.length === 0) return [...current]
  const boundedLimit = Math.max(1, Math.floor(limit))
  return [...current, ...incoming].slice(-boundedLimit)
}
