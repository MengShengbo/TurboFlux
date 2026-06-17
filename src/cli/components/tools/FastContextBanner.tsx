import React, { useState, useEffect, useRef } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../theme/index'
import type { FastContextScanEvent, FastContextScanPhase } from '../../../core/fastContextTypes'
import { SPINNER_CHARS, SPINNER_INTERVAL_MS } from '../spinner/constants'

const SPIN = SPINNER_CHARS
const TICK_MS = SPINNER_INTERVAL_MS

interface WorkerState {
  id: string
  label: string
  status: 'queued' | 'running' | 'completed' | 'error'
  currentPath?: string
  hitCount: number
}

interface ScanState {
  phase: FastContextScanPhase
  wave: number
  maxWaves: number
  insight: string
  filesDiscovered: number
  filesAbsorbed: number
  hitCount: number
  workers: Map<string, WorkerState>
  recentFiles: string[]
}

interface FastContextBannerProps {
  events: FastContextScanEvent[]
  isActive: boolean
}

export function FastContextBanner({ events, isActive }: FastContextBannerProps) {
  const theme = useTheme()
  const [tick, setTick] = useState(0)
  const [state, setState] = useState<ScanState>({
    phase: 'scanning',
    wave: 1,
    maxWaves: 4,
    insight: '',
    filesDiscovered: 0,
    filesAbsorbed: 0,
    hitCount: 0,
    workers: new Map(),
    recentFiles: [],
  })

  useEffect(() => {
    if (!isActive) return
    const id = setInterval(() => setTick(t => t + 1), TICK_MS)
    return () => clearInterval(id)
  }, [isActive])

  useEffect(() => {
    setState(prev => {
      let next = prev
      for (const event of events) next = processEvent(next, event)
      return next
    })
  }, [events.length])

  if (!isActive && state.phase !== 'completed') return null

  const phaseColor = state.phase === 'completed' ? theme.success
    : state.phase === 'error' ? theme.error
    : theme.brand

  const phaseLabel = state.phase === 'mapping' ? 'MAPPING'
    : state.phase === 'ranking' ? 'RANKING'
    : state.phase === 'scanning' ? 'SCANNING'
    : state.phase === 'synthesizing' ? 'SYNTHESIZING'
    : state.phase === 'completed' ? 'DONE'
    : 'ERROR'

  const activeWorkers = [...state.workers.values()].filter(w => w.status === 'running')
  const showWorkers = isActive && activeWorkers.length > 0
  const showFallback = isActive && activeWorkers.length === 0 && (state.phase === 'scanning' || state.phase === 'mapping' || state.phase === 'ranking')

  return (
    <Box flexDirection="column" marginBottom={0}>
      {/* Header row */}
      <Box>
        <Text color={phaseColor} bold>Fast Context </Text>
        <Text color={theme.inactive}>[{phaseLabel}]</Text>
        <Text color={theme.inactive}> wave {state.wave}/{state.maxWaves}</Text>
        <Text color={theme.inactive}> - {state.filesDiscovered} files - {state.hitCount} hits</Text>
      </Box>

      {/* Parallel workers */}
      {showWorkers && (
        <Box flexDirection="column" marginLeft={2}>
          {activeWorkers.slice(0, 6).map((worker, i) => {
            const frame = SPIN[(tick + i * 3) % SPIN.length]
            const path = worker.currentPath
              ? shortenPath(worker.currentPath)
              : worker.label
            return (
              <Box key={worker.id}>
                <Text color={theme.brand}>{frame} </Text>
                <Text color={theme.inactive}>{path}</Text>
                {worker.hitCount > 0 && (
                  <Text color={theme.success}> +{worker.hitCount}</Text>
                )}
              </Box>
            )
          })}
        </Box>
      )}

      {/* Single spinner while the subagent has no active worker rows */}
      {showFallback && (
        <Box marginLeft={2}>
          <Text color={theme.brand}>{SPIN[tick % SPIN.length]} </Text>
          <Text color={theme.inactive}>{state.insight || 'mapping code...'}</Text>
        </Box>
      )}

      {/* Recent files (when no active workers) */}
      {!showWorkers && state.recentFiles.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {state.recentFiles.slice(-4).map((file, i, arr) => (
            <Box key={i}>
              <Text color={theme.inactive}>
                {i === arr.length - 1 ? '`-' : '|-'} {file}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Completion summary */}
      {state.phase === 'completed' && state.hitCount > 0 && (
        <Box marginLeft={2}>
          <Text color={theme.success}>Captured {state.filesAbsorbed} evidence files across {state.hitCount} line ranges</Text>
        </Box>
      )}
    </Box>
  )
}

function shortenPath(p: string): string {
  const normalized = p.replace(/\\/g, '/')
  const parts = normalized.split('/')
  if (parts.length <= 3) return normalized
  return '.../' + parts.slice(-2).join('/')
}

function processEvent(state: ScanState, event: FastContextScanEvent): ScanState {
  switch (event.type) {
    case 'phase':
      return {
        ...state,
        phase: event.phase,
        wave: event.wave ?? state.wave,
        maxWaves: event.maxWaves ?? state.maxWaves,
        insight: event.insight || state.insight,
      }
    case 'worker': {
      const workers = new Map(state.workers)
      const existing = workers.get(event.id)
      workers.set(event.id, {
        id: event.id,
        label: event.label,
        status: event.status,
        currentPath: event.currentPath ?? existing?.currentPath,
        hitCount: event.hitCount ?? existing?.hitCount ?? 0,
      })
      return { ...state, workers }
    }
    case 'file':
      if (event.status === 'discovered') {
        const workers = new Map(state.workers)
        if (event.workerId) {
          const w = workers.get(event.workerId)
          if (w) workers.set(event.workerId, { ...w, currentPath: event.path })
        }
        return {
          ...state,
          workers,
          filesDiscovered: state.filesDiscovered + 1,
          recentFiles: [...state.recentFiles.slice(-6), event.path],
        }
      }
      if (event.status === 'absorbed') {
        return { ...state, filesAbsorbed: state.filesAbsorbed + 1 }
      }
      return state
    case 'hit': {
      const workers = new Map(state.workers)
      if (event.hit.workerId) {
        const w = workers.get(event.hit.workerId)
        if (w) workers.set(event.hit.workerId, { ...w, hitCount: (w.hitCount ?? 0) + 1 })
      }
      return {
        ...state,
        workers,
        hitCount: state.hitCount + 1,
      }
    }
    case 'insight':
      return { ...state, insight: event.text }
    default:
      return state
  }
}
