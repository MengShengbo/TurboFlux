import { performance } from 'node:perf_hooks'
import type { FlowTelemetryMetric } from './localFlowTelemetry'

type TerminalLatencyMetric = Extract<FlowTelemetryMetric,
  | 'ui.key_to_terminal_flush_ms'
  | 'ui.submit_to_echo_flush_ms'
  | 'ui.delta_to_tail_flush_ms'
>

interface PendingLatencySamples {
  key: number[]
  submit: number[]
  delta: number[]
}

export interface TerminalLatencyTrackerOptions {
  now?: () => number
  maxPendingSamples?: number
}

function emptySamples(): PendingLatencySamples {
  return { key: [], submit: [], delta: [] }
}

export class TerminalLatencyTracker {
  private readonly now: () => number
  private readonly maxPendingSamples: number
  private pending = emptySamples()
  private inFlight: PendingLatencySamples | null = null

  constructor(
    private readonly observe: (metric: TerminalLatencyMetric, value: number) => void,
    options: TerminalLatencyTrackerOptions = {},
  ) {
    this.now = options.now ?? performance.now.bind(performance)
    this.maxPendingSamples = Math.max(1, options.maxPendingSamples ?? 256)
  }

  noteKeyReceived(at = this.now()): void {
    this.push(this.pending.key, at)
  }

  noteSubmit(at = this.now()): void {
    this.push(this.pending.submit, at)
  }

  noteDeltaReceived(at = this.now()): void {
    this.push(this.pending.delta, at)
  }

  hasPending(): boolean {
    return this.pending.key.length > 0 || this.pending.submit.length > 0 || this.pending.delta.length > 0
  }

  beginTerminalFlush(): boolean {
    if (this.inFlight || !this.hasPending()) return false
    this.inFlight = this.pending
    this.pending = emptySamples()
    return true
  }

  completeTerminalFlush(at = this.now()): void {
    const samples = this.inFlight
    this.inFlight = null
    if (!samples) return
    this.observeSamples('ui.key_to_terminal_flush_ms', samples.key, at)
    this.observeSamples('ui.submit_to_echo_flush_ms', samples.submit, at)
    this.observeSamples('ui.delta_to_tail_flush_ms', samples.delta, at)
  }

  cancelTerminalFlush(): void {
    this.inFlight = null
  }

  private push(samples: number[], at: number): void {
    if (!Number.isFinite(at)) return
    samples.push(at)
    if (samples.length > this.maxPendingSamples) samples.splice(0, samples.length - this.maxPendingSamples)
  }

  private observeSamples(metric: TerminalLatencyMetric, samples: number[], flushedAt: number): void {
    for (const startedAt of samples) this.observe(metric, Math.max(0, flushedAt - startedAt))
  }
}
