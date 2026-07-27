import { describe, expect, it } from 'vitest'
import { darkTheme } from './dark'
import { TURBOFLUX_ACCENTS } from './palette'

function rgb(hex: string): [number, number, number] {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map(channel => Number.parseInt(channel, 16)) || []
  expect(channels).toHaveLength(3)
  return channels as [number, number, number]
}

function grayLevel(hex: string): number {
  const channels = rgb(hex)
  expect(new Set(channels).size).toBe(1)
  return channels[0]
}

function luminance(hex: string): number {
  const channels = rgb(hex).map(channel => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
}

function contrast(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background))
  const darker = Math.min(luminance(foreground), luminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

describe('dark terminal theme', () => {
  it('keeps the structural palette neutral and layered', () => {
    const neutralColors = [
      darkTheme.text,
      darkTheme.inactive,
      darkTheme.subtle,
      darkTheme.background,
      darkTheme.panelBackground,
      darkTheme.panelRaised,
      darkTheme.surface,
      darkTheme.divider,
      darkTheme.promptBorder,
      darkTheme.promptBackground,
      darkTheme.statusLine,
      darkTheme.codeBackground,
    ]
    for (const color of neutralColors) grayLevel(color)

    expect(grayLevel(darkTheme.background)).toBeLessThan(grayLevel(darkTheme.panelBackground))
    expect(grayLevel(darkTheme.panelBackground)).toBeLessThan(grayLevel(darkTheme.panelRaised))
    expect(grayLevel(darkTheme.panelRaised)).toBeLessThan(grayLevel(darkTheme.surface))
    expect(grayLevel(darkTheme.text)).toBeGreaterThan(grayLevel(darkTheme.inactive))
    expect(grayLevel(darkTheme.inactive)).toBeGreaterThan(grayLevel(darkTheme.subtle))
  })

  it('uses green and cyan only as high-contrast accents', () => {
    const [greenRed, green, greenBlue] = rgb(darkTheme.brandShimmer)
    const [cyanRed, cyanGreen, cyanBlue] = rgb(darkTheme.info)

    expect(darkTheme.brandShimmer).toBe(TURBOFLUX_ACCENTS.neonGreen)
    expect(darkTheme.brand).toBe(TURBOFLUX_ACCENTS.cyanBright)
    expect(darkTheme.promptBorder).toBe('#000000')
    expect(darkTheme.info).toBe(TURBOFLUX_ACCENTS.cyan)
    expect(green).toBeGreaterThan(greenRed)
    expect(green).toBeGreaterThan(greenBlue)
    expect(cyanGreen).toBeGreaterThan(cyanRed)
    expect(cyanBlue).toBeGreaterThan(cyanRed)
    expect(contrast(darkTheme.brandShimmer, darkTheme.background)).toBeGreaterThan(7)
    expect(contrast(darkTheme.info, darkTheme.background)).toBeGreaterThan(7)
  })
})
