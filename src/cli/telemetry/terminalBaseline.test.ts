import { describe, expect, it } from 'vitest'
import type { LocalFlowTelemetrySnapshot, NumericHistogram } from './localFlowTelemetry'
import { buildTerminalBaselineReport, inferTerminalTransport, summarizeHistogram, summarizeSamples } from './terminalBaseline'

function histogram(values: number[]): NumericHistogram {
  const limits = [1, 4, 8, 16, 33, 50, 100, 250, 500, 1_000, 5_000]
  const buckets: Record<string, number> = {}
  for (const value of values) {
    const limit = limits.find(candidate => value <= candidate)
    const key = limit === undefined ? '+Inf' : String(limit)
    buckets[key] = (buckets[key] ?? 0) + 1
  }
  return {
    count: values.length,
    sum: values.reduce((sum, value) => sum + value, 0),
    min: Math.min(...values),
    max: Math.max(...values),
    buckets,
  }
}

describe('terminal baseline summaries', () => {
  it('reports conservative upper-bound histogram percentiles', () => {
    expect(summarizeHistogram(histogram([1, 2, 3, 20, 40]))).toMatchObject({
      count: 5,
      p50UpperBound: 4,
      p95UpperBound: 50,
    })
    expect(summarizeSamples([1, 2, 3, 4, 100])?.p95UpperBound).toBe(100)
  })

  it('infers transport without recording session identifiers', () => {
    expect(inferTerminalTransport({ SSH_CONNECTION: 'sensitive endpoint' }, 'linux')).toBe('ssh')
    expect(inferTerminalTransport({ WT_SESSION: 'sensitive id' }, 'win32')).toBe('conpty')
  })

  it('keeps physical paint external and marks missing evidence as a blocker', () => {
    const good = histogram(Array.from({ length: 25 }, () => 10))
    const snapshot: LocalFlowTelemetrySnapshot = {
      version: 1,
      generatedAt: 1,
      platform: 'win32',
      counters: {},
      histograms: {
        'ui.key_to_terminal_flush_ms': good,
        'ui.submit_to_echo_flush_ms': good,
        'ui.delta_to_tail_flush_ms': good,
        'ui.frame_render_ms': good,
      },
    }
    const report = buildTerminalBaselineReport(snapshot, {
      environment: { WT_SESSION: 'must-not-leak', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      platform: 'win32',
      interactive: true,
      columns: 120,
      rows: 40,
      now: () => 2,
    })

    expect(report.environment).toMatchObject({ terminalProgram: 'Windows Terminal', transport: 'conpty', shell: 'cmd.exe' })
    expect(JSON.stringify(report)).not.toContain('must-not-leak')
    expect(report.gate).toMatchObject({ proxyStatus: 'passed', physicalPaintStatus: 'external-required', releaseReady: false })
  })

  it('accepts explicit passing physical paint evidence', () => {
    const good = histogram(Array.from({ length: 25 }, () => 8))
    const snapshot: LocalFlowTelemetrySnapshot = {
      version: 1,
      generatedAt: 1,
      platform: 'linux',
      counters: {},
      histograms: Object.fromEntries([
        'ui.key_to_terminal_flush_ms',
        'ui.submit_to_echo_flush_ms',
        'ui.delta_to_tail_flush_ms',
        'ui.frame_render_ms',
      ].map(metric => [metric, good])),
    }
    const report = buildTerminalBaselineReport(snapshot, {
      environment: {},
      platform: 'linux',
      minimumSamples: 20,
      physicalPaint: {
        schemaVersion: 1,
        method: '240fps-camera',
        capturedAt: '2026-07-29T00:00:00Z',
        sampleCount: 25,
        keyToPaintMs: { p50: 20, p95: 40, p99: 80 },
        submitToEchoMs: { p50: 20, p95: 40, p99: 80 },
        deltaToTailMs: { p50: 30, p95: 80, p99: 90 },
      },
    })

    expect(report.gate).toMatchObject({ proxyStatus: 'passed', physicalPaintStatus: 'passed', releaseReady: true })
  })
})
