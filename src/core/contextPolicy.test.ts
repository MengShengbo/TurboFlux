import { describe, expect, it } from 'vitest'
import { autoCompactThreshold, blockingContextLimit, effectiveInputWindow, recapThreshold } from './contextPolicy'

describe('contextPolicy', () => {
  it('reserves output tokens before calculating the effective input window', () => {
    expect(effectiveInputWindow(200_000, 32_000)).toBe(180_000)
  })

  it('uses a fixed normal autocompact buffer like Claude Code', () => {
    expect(autoCompactThreshold(200_000, 32_000, 'normal')).toBe(167_000)
  })

  it('uses a more conservative quality-first autocompact threshold', () => {
    expect(autoCompactThreshold(200_000, 32_000, 'qualityFirst')).toBeLessThan(autoCompactThreshold(200_000, 32_000, 'normal'))
    expect(recapThreshold(200_000, 32_000, 'qualityFirst')).toBeLessThan(recapThreshold(200_000, 32_000, 'normal'))
  })

  it('keeps a manual compact buffer before the hard blocking limit', () => {
    expect(blockingContextLimit(200_000, 32_000)).toBe(177_000)
  })
})
