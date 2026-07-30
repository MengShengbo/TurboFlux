import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type FlowTelemetryMetric =
  | 'ui.key_received'
  | 'ui.key_to_terminal_flush_ms'
  | 'ui.submit_to_echo_flush_ms'
  | 'ui.delta_to_tail_flush_ms'
  | 'ui.frame_render_ms'
  | 'ui.approval_requested'
  | 'ui.approval_presented_ms'
  | 'ui.stream_flush'
  | 'ui.stream_batch_depth'
  | 'ui.stream_oldest_age_ms'
  | 'ui.transcript_mounted_cells'
  | 'ui.transcript_total_cells'
  | 'ui.markdown_cache_hit_rate'
  | 'journal.physical_writes'
  | 'journal.streaming_batches'
  | 'flow.reducer_violation'

export interface NumericHistogram {
  count: number
  sum: number
  min: number
  max: number
  buckets: Record<string, number>
}

export interface LocalFlowTelemetrySnapshot {
  version: 1
  generatedAt: number
  platform: NodeJS.Platform
  counters: Partial<Record<FlowTelemetryMetric, number>>
  histograms: Partial<Record<FlowTelemetryMetric, NumericHistogram>>
}

export interface LocalFlowTelemetryOptions {
  enabled?: boolean
  flushIntervalMs?: number
  outputFile?: string
  autoFlush?: boolean
  now?: () => number
}

const HISTOGRAM_BUCKETS = [1, 4, 8, 16, 33, 50, 100, 250, 500, 1_000, 5_000]

function emptySnapshot(now: number): LocalFlowTelemetrySnapshot {
  return {
    version: 1,
    generatedAt: now,
    platform: process.platform,
    counters: {},
    histograms: {},
  }
}

function isFiniteRecord(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).every(item => Number.isFinite(item))
}

export class LocalFlowTelemetry {
  private readonly enabled: boolean
  private readonly flushIntervalMs: number
  private readonly outputFile: string
  private readonly autoFlush: boolean
  private readonly now: () => number
  private snapshot: LocalFlowTelemetrySnapshot
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  private closed = false

  constructor(workspacePath: string, options: LocalFlowTelemetryOptions = {}) {
    this.enabled = options.enabled ?? process.env.TURBOFLUX_TELEMETRY !== '0'
    this.flushIntervalMs = Math.max(100, options.flushIntervalMs ?? 5_000)
    this.outputFile = options.outputFile ?? join(workspacePath, '.turboflux', 'telemetry', 'flow-metrics-v1.json')
    this.autoFlush = options.autoFlush ?? true
    this.now = options.now ?? Date.now
    this.snapshot = this.loadSnapshot() ?? emptySnapshot(this.now())
  }

  count(metric: FlowTelemetryMetric, amount = 1): void {
    if (!this.enabled || this.closed || !Number.isFinite(amount)) return
    this.snapshot.counters[metric] = (this.snapshot.counters[metric] ?? 0) + amount
    this.changed()
  }

  observe(metric: FlowTelemetryMetric, rawValue: number): void {
    if (!this.enabled || this.closed || !Number.isFinite(rawValue)) return
    const value = Math.max(0, rawValue)
    const histogram = this.snapshot.histograms[metric] ?? {
      count: 0,
      sum: 0,
      min: value,
      max: value,
      buckets: {},
    }
    histogram.count += 1
    histogram.sum += value
    histogram.min = Math.min(histogram.min, value)
    histogram.max = Math.max(histogram.max, value)
    const bucket = HISTOGRAM_BUCKETS.find(limit => value <= limit)
    const bucketName = bucket === undefined ? '+Inf' : String(bucket)
    histogram.buckets[bucketName] = (histogram.buckets[bucketName] ?? 0) + 1
    this.snapshot.histograms[metric] = histogram
    this.changed()
  }

  getSnapshot(): LocalFlowTelemetrySnapshot {
    return JSON.parse(JSON.stringify({ ...this.snapshot, generatedAt: this.now() })) as LocalFlowTelemetrySnapshot
  }

  flush(): boolean {
    this.clearTimer()
    if (!this.enabled || !this.dirty) return true
    try {
      mkdirSync(dirname(this.outputFile), { recursive: true })
      const nextSnapshot = { ...this.snapshot, generatedAt: this.now() }
      const temporaryFile = `${this.outputFile}.tmp-${process.pid}`
      writeFileSync(temporaryFile, `${JSON.stringify(nextSnapshot, null, 2)}\n`, 'utf8')
      renameSync(temporaryFile, this.outputFile)
      this.snapshot = nextSnapshot
      this.dirty = false
      return true
    } catch {
      return false
    }
  }

  destroy(): void {
    this.flush()
    this.clearTimer()
    this.closed = true
  }

  private changed(): void {
    this.dirty = true
    if (!this.autoFlush || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.flushIntervalMs)
    this.timer.unref?.()
  }

  private loadSnapshot(): LocalFlowTelemetrySnapshot | null {
    if (!this.enabled || !existsSync(this.outputFile)) return null
    try {
      const parsed = JSON.parse(readFileSync(this.outputFile, 'utf8')) as Partial<LocalFlowTelemetrySnapshot>
      if (parsed.version !== 1 || !isFiniteRecord(parsed.counters ?? {})) return null
      const histograms = parsed.histograms ?? {}
      for (const histogram of Object.values(histograms)) {
        if (!histogram || !Number.isFinite(histogram.count) || !Number.isFinite(histogram.sum) ||
          !Number.isFinite(histogram.min) || !Number.isFinite(histogram.max) || !isFiniteRecord(histogram.buckets)) {
          return null
        }
      }
      return {
        version: 1,
        generatedAt: Number.isFinite(parsed.generatedAt) ? parsed.generatedAt! : this.now(),
        platform: parsed.platform === process.platform ? parsed.platform : process.platform,
        counters: { ...parsed.counters },
        histograms: JSON.parse(JSON.stringify(histograms)),
      }
    } catch {
      return null
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
