import { describe, expect, it } from 'vitest'
import { describeFlowFeatureFlags, isPersistenceRecoveryCommand, resolveFlowFeatureFlags } from './flowFeatureFlags'

describe('resolveFlowFeatureFlags', () => {
  it('enables every migration block by default', () => {
    expect(resolveFlowFeatureFlags({})).toEqual({
      flowUi: true,
      transcriptWindowing: true,
      notifications: true,
      streamScheduler: true,
      journalBatching: true,
    })
  })

  it('supports a global rollback with explicit per-block overrides', () => {
    expect(resolveFlowFeatureFlags({
      TURBOFLUX_FLOW: 'off',
      TURBOFLUX_FLOW_UI: 'on',
      TURBOFLUX_FLOW_JOURNAL_BATCHING: '1',
    })).toEqual({
      flowUi: true,
      transcriptWindowing: false,
      notifications: false,
      streamScheduler: false,
      journalBatching: true,
    })
  })

  it('keeps safe defaults for unknown values', () => {
    expect(resolveFlowFeatureFlags({ TURBOFLUX_FLOW_WINDOWING: 'maybe' }).transcriptWindowing).toBe(true)
  })

  it('formats a stable operator-facing summary', () => {
    expect(describeFlowFeatureFlags(resolveFlowFeatureFlags({ TURBOFLUX_FLOW: '0' }))).toBe(
      'flowUi=off, transcriptWindowing=off, notifications=off, streamScheduler=off, journalBatching=off',
    )
  })

  it('allows only local recovery and exit commands through the degraded gate', () => {
    expect(isPersistenceRecoveryCommand('/flow retry')).toBe(true)
    expect(isPersistenceRecoveryCommand('/help')).toBe(true)
    expect(isPersistenceRecoveryCommand('/exit')).toBe(true)
    expect(isPersistenceRecoveryCommand('/model')).toBe(false)
    expect(isPersistenceRecoveryCommand('continue coding')).toBe(false)
  })
})
