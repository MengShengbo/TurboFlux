import { describe, expect, it } from 'vitest'
import { buildThinkingModeRailText } from './ThinkingModeRail'

describe('ThinkingModeRail', () => {
  it('marks the active thinking mode without explanatory copy', () => {
    expect(buildThinkingModeRailText('max')).toBe('Think Auto  Off  Standard  [Max]')
  })
})
