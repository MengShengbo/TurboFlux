import { describe, expect, it } from 'vitest'
import { darkTheme } from './dark'

function grayLevel(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map(channel => Number.parseInt(channel, 16)) || []
  expect(channels).toHaveLength(3)
  expect(new Set(channels).size).toBe(1)
  return channels[0]!
}

describe('dark terminal theme', () => {
  it('uses a strictly monochrome palette', () => {
    for (const color of Object.values(darkTheme)) grayLevel(color)
  })

  it('keeps panels and text readable through gray-level hierarchy', () => {
    expect(grayLevel(darkTheme.background)).toBeLessThan(grayLevel(darkTheme.panelBackground))
    expect(grayLevel(darkTheme.panelBackground)).toBeLessThan(grayLevel(darkTheme.panelRaised))
    expect(grayLevel(darkTheme.panelRaised)).toBeLessThan(grayLevel(darkTheme.surface))
    expect(grayLevel(darkTheme.text)).toBeGreaterThan(grayLevel(darkTheme.inactive))
    expect(grayLevel(darkTheme.inactive)).toBeGreaterThan(grayLevel(darkTheme.subtle))
  })
})
