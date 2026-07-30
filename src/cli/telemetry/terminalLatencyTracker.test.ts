import { describe, expect, it } from 'vitest'
import type { FlowTelemetryMetric } from './localFlowTelemetry'
import { TerminalLatencyTracker } from './terminalLatencyTracker'

describe('TerminalLatencyTracker', () => {
  it('measures input, submit, and delta samples at the next terminal flush', () => {
    const samples: Array<{ metric: FlowTelemetryMetric; value: number }> = []
    const tracker = new TerminalLatencyTracker((metric, value) => samples.push({ metric, value }))
    tracker.noteKeyReceived(1)
    tracker.noteSubmit(2)
    tracker.noteDeltaReceived(3)

    expect(tracker.beginTerminalFlush()).toBe(true)
    tracker.completeTerminalFlush(11)

    expect(samples).toEqual([
      { metric: 'ui.key_to_terminal_flush_ms', value: 10 },
      { metric: 'ui.submit_to_echo_flush_ms', value: 9 },
      { metric: 'ui.delta_to_tail_flush_ms', value: 8 },
    ])
  })

  it('keeps events arriving during a flush for the following frame', () => {
    const values: number[] = []
    const tracker = new TerminalLatencyTracker((_metric, value) => values.push(value))
    tracker.noteKeyReceived(1)
    expect(tracker.beginTerminalFlush()).toBe(true)
    tracker.noteKeyReceived(5)
    expect(tracker.beginTerminalFlush()).toBe(false)
    tracker.completeTerminalFlush(10)

    expect(tracker.hasPending()).toBe(true)
    expect(tracker.beginTerminalFlush()).toBe(true)
    tracker.completeTerminalFlush(20)
    expect(values).toEqual([9, 15])
  })

  it('bounds pending samples during a burst', () => {
    const values: number[] = []
    const tracker = new TerminalLatencyTracker((_metric, value) => values.push(value), { maxPendingSamples: 2 })
    tracker.noteDeltaReceived(1)
    tracker.noteDeltaReceived(2)
    tracker.noteDeltaReceived(3)
    tracker.beginTerminalFlush()
    tracker.completeTerminalFlush(10)

    expect(values).toEqual([8, 7])
  })
})
