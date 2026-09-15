export interface TimingSummary {
  count: number
  totalMs: number
  minMs: number
  p50Ms: number
  p90Ms: number
  maxMs: number
}

export function streamTimingTraceEnabled(): boolean {
  return process.env.TURBOFLUX_STREAM_TRACE === '1'
}

export function summarizeTimings(samples: readonly number[]): TimingSummary {
  if (samples.length === 0) {
    return { count: 0, totalMs: 0, minMs: 0, p50Ms: 0, p90Ms: 0, maxMs: 0 }
  }
  const sorted = [...samples].sort((left, right) => left - right)
  const percentile = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!
  const rounded = (value: number): number => Number(value.toFixed(3))
  return {
    count: samples.length,
    totalMs: rounded(samples.reduce((total, value) => total + value, 0)),
    minMs: rounded(sorted[0]!),
    p50Ms: rounded(percentile(0.5)),
    p90Ms: rounded(percentile(0.9)),
    maxMs: rounded(sorted.at(-1)!),
  }
}

export function emitStreamTimingTrace(scope: string, detail: Record<string, unknown>): void {
  if (!streamTimingTraceEnabled()) return
  console.error(`[TurboFlux stream trace] ${JSON.stringify({ scope, at: Date.now(), ...detail })}`)
}
