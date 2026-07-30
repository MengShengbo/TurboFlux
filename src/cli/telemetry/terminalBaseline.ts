import { basename } from 'node:path'
import type { FlowTelemetryMetric, LocalFlowTelemetrySnapshot, NumericHistogram } from './localFlowTelemetry'

export type TerminalTransport = 'local' | 'conpty' | 'ssh' | 'container' | 'unknown'

export interface DistributionSummary {
  count: number
  min: number
  mean: number
  max: number
  p50UpperBound: number
  p95UpperBound: number
  p99UpperBound: number
}

export interface ExternalPaintEvidence {
  schemaVersion: 1
  method: string
  capturedAt: string
  sampleCount: number
  keyToPaintMs: { p50: number; p95: number; p99: number }
  submitToEchoMs: { p50: number; p95: number; p99: number }
  deltaToTailMs: { p50: number; p95: number; p99: number }
  notes?: string
}

export interface TerminalBaselineOptions {
  label?: string
  transport?: TerminalTransport
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: string
  nodeVersion?: string
  interactive?: boolean
  columns?: number
  rows?: number
  minimumSamples?: number
  terminalAckSamples?: number[]
  physicalPaint?: ExternalPaintEvidence
  now?: () => number
}

const PROXY_METRICS = [
  'ui.key_to_terminal_flush_ms',
  'ui.submit_to_echo_flush_ms',
  'ui.delta_to_tail_flush_ms',
  'ui.frame_render_ms',
] as const satisfies readonly FlowTelemetryMetric[]

const PROXY_P95_TARGETS: Partial<Record<FlowTelemetryMetric, number>> = {
  'ui.key_to_terminal_flush_ms': 50,
  'ui.submit_to_echo_flush_ms': 50,
  'ui.delta_to_tail_flush_ms': 100,
  'ui.frame_render_ms': 33,
}

export function summarizeHistogram(histogram: NumericHistogram | undefined): DistributionSummary | null {
  if (!histogram || histogram.count <= 0) return null
  return {
    count: histogram.count,
    min: round(histogram.min),
    mean: round(histogram.sum / histogram.count),
    max: round(histogram.max),
    p50UpperBound: percentileBucketUpperBound(histogram, 0.5),
    p95UpperBound: percentileBucketUpperBound(histogram, 0.95),
    p99UpperBound: percentileBucketUpperBound(histogram, 0.99),
  }
}

export function summarizeSamples(samples: number[]): DistributionSummary | null {
  const finite = samples.filter(Number.isFinite).map(value => Math.max(0, value)).sort((left, right) => left - right)
  if (finite.length === 0) return null
  const percentile = (ratio: number) => finite[Math.min(finite.length - 1, Math.ceil(finite.length * ratio) - 1)] ?? 0
  return {
    count: finite.length,
    min: round(finite[0] ?? 0),
    mean: round(finite.reduce((sum, value) => sum + value, 0) / finite.length),
    max: round(finite[finite.length - 1] ?? 0),
    p50UpperBound: round(percentile(0.5)),
    p95UpperBound: round(percentile(0.95)),
    p99UpperBound: round(percentile(0.99)),
  }
}

export function inferTerminalTransport(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): TerminalTransport {
  if (environment.SSH_CONNECTION || environment.SSH_TTY || environment.SSH_CLIENT) return 'ssh'
  if (environment.container || environment.CONTAINER || environment.KUBERNETES_SERVICE_HOST) return 'container'
  if (platform === 'win32' && (environment.WT_SESSION || environment.ConEmuANSI || environment.TERM_PROGRAM)) return 'conpty'
  return 'local'
}

export function buildTerminalBaselineReport(
  snapshot: LocalFlowTelemetrySnapshot,
  options: TerminalBaselineOptions = {},
) {
  const environment = options.environment ?? process.env
  const platform = options.platform ?? process.platform
  const minimumSamples = Math.max(1, options.minimumSamples ?? 20)
  const proxyMetrics = Object.fromEntries(PROXY_METRICS.map(metric => [
    metric,
    summarizeHistogram(snapshot.histograms[metric]),
  ])) as Record<typeof PROXY_METRICS[number], DistributionSummary | null>
  const proxyFailures: string[] = []
  const proxyInsufficient: string[] = []
  for (const metric of PROXY_METRICS) {
    const summary = proxyMetrics[metric]
    if (!summary || summary.count < minimumSamples) {
      proxyInsufficient.push(`${metric} requires at least ${minimumSamples} samples`)
      continue
    }
    const target = PROXY_P95_TARGETS[metric]
    if (target !== undefined && summary.p95UpperBound > target) {
      proxyFailures.push(`${metric} p95 upper bound ${summary.p95UpperBound}ms exceeds ${target}ms`)
    }
  }

  const paintFailures = validatePhysicalPaint(options.physicalPaint, minimumSamples)
  const reducerViolations = snapshot.counters['flow.reducer_violation'] ?? 0
  const safetyFailures = [
    ...(reducerViolations > 0 ? [`flow.reducer_violation is ${reducerViolations}, expected 0`] : []),
  ]
  const blockers = [
    ...proxyFailures,
    ...proxyInsufficient,
    ...safetyFailures,
    ...(options.physicalPaint ? paintFailures : ['physical paint evidence is required for release acceptance']),
  ]

  return {
    schemaVersion: 1 as const,
    generatedAt: options.now?.() ?? Date.now(),
    label: options.label?.trim() || 'unnamed-terminal-baseline',
    environment: {
      platform,
      arch: options.arch ?? process.arch,
      node: options.nodeVersion ?? process.version,
      terminalProgram: terminalProgram(environment),
      terminalVersion: safeEnvironmentLabel(environment.TERM_PROGRAM_VERSION),
      transport: options.transport ?? inferTerminalTransport(environment, platform),
      shell: shellName(environment),
      interactive: options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
      columns: Math.max(0, options.columns ?? process.stdout.columns ?? 0),
      rows: Math.max(0, options.rows ?? process.stdout.rows ?? 0),
      ci: truthy(environment.CI),
    },
    evidenceBoundary: {
      stdoutFlush: 'measured: application event to stdout write callback; not physical paint',
      terminalAck: options.terminalAckSamples?.length
        ? 'measured: ANSI DSR round trip; terminal processing acknowledgement, not physical paint'
        : 'not measured; run with --probe-ack',
      physicalPaint: options.physicalPaint
        ? `external evidence supplied via ${options.physicalPaint.method}`
        : 'external evidence required; use camera/high-frame-rate or platform compositor instrumentation',
    },
    proxyMetrics,
    terminalAckMs: summarizeSamples(options.terminalAckSamples ?? []),
    physicalPaint: options.physicalPaint ?? null,
    safetySignals: {
      reducerViolations,
    },
    privacy: {
      automaticallyIncludesContent: false,
      automaticallyIncludesAbsolutePaths: false,
      operatorSuppliedFields: ['label', 'physicalPaint.method', 'physicalPaint.notes'],
      environmentAllowlist: ['platform', 'arch', 'node', 'terminal program/version', 'transport', 'shell basename', 'TTY geometry', 'CI boolean'],
    },
    gate: {
      proxyStatus: proxyFailures.length > 0 ? 'failed' : proxyInsufficient.length > 0 ? 'insufficient-samples' : 'passed',
      safetyStatus: safetyFailures.length > 0 ? 'failed' : 'passed',
      physicalPaintStatus: options.physicalPaint
        ? paintFailures.length > 0 ? 'failed' : 'passed'
        : 'external-required',
      releaseReady: blockers.length === 0,
      blockers,
    },
  }
}

function percentileBucketUpperBound(histogram: NumericHistogram, ratio: number): number {
  const buckets = Object.entries(histogram.buckets)
    .map(([label, count]) => ({ upper: label === '+Inf' ? Number.POSITIVE_INFINITY : Number(label), count }))
    .filter(bucket => Number.isFinite(bucket.count) && bucket.count > 0 && !Number.isNaN(bucket.upper))
    .sort((left, right) => left.upper - right.upper)
  const targetRank = Math.max(1, Math.ceil(histogram.count * ratio))
  let seen = 0
  for (const bucket of buckets) {
    seen += bucket.count
    if (seen >= targetRank) return round(Number.isFinite(bucket.upper) ? bucket.upper : histogram.max)
  }
  return round(histogram.max)
}

function validatePhysicalPaint(evidence: ExternalPaintEvidence | undefined, minimumSamples: number): string[] {
  if (!evidence) return []
  const failures: string[] = []
  if (evidence.schemaVersion !== 1) failures.push('physical paint evidence schemaVersion must be 1')
  if (!evidence.method.trim()) failures.push('physical paint evidence method is required')
  if (evidence.sampleCount < minimumSamples) failures.push(`physical paint evidence requires at least ${minimumSamples} samples`)
  for (const [name, distribution] of Object.entries({
    keyToPaintMs: evidence.keyToPaintMs,
    submitToEchoMs: evidence.submitToEchoMs,
    deltaToTailMs: evidence.deltaToTailMs,
  })) {
    const values = [distribution.p50, distribution.p95, distribution.p99]
    if (values.some(value => !Number.isFinite(value) || value < 0)) {
      failures.push(`${name} must contain finite non-negative values`)
    } else if (distribution.p50 > distribution.p95 || distribution.p95 > distribution.p99) {
      failures.push(`${name} percentiles must be monotonic`)
    }
  }
  if (evidence.keyToPaintMs.p95 > 50 || evidence.keyToPaintMs.p99 > 100) {
    failures.push('physical key-to-paint exceeds p95 50ms or p99 100ms')
  }
  if (evidence.submitToEchoMs.p95 > 50) failures.push('physical submit-to-echo exceeds p95 50ms')
  if (evidence.deltaToTailMs.p95 > 100) failures.push('physical delta-to-tail exceeds p95 100ms')
  return failures
}

function terminalProgram(environment: NodeJS.ProcessEnv): string {
  if (environment.WT_SESSION) return 'Windows Terminal'
  if (environment.ConEmuANSI) return 'ConEmu'
  return safeEnvironmentLabel(environment.TERM_PROGRAM) || safeEnvironmentLabel(environment.TERM) || 'unknown'
}

function shellName(environment: NodeJS.ProcessEnv): string {
  const shell = environment.ComSpec || environment.COMSPEC || environment.SHELL
  return shell ? basename(shell) : 'unknown'
}

function safeEnvironmentLabel(value: string | undefined): string {
  return value?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || ''
}

function truthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function round(value: number): number {
  return Number(value.toFixed(3))
}
