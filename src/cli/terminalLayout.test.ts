import { describe, expect, it } from 'vitest'
import { getSafeFrameWidth, getSafeViewportWidth } from './terminalLayout'

describe('terminal layout sizing', () => {
  it('keeps framed UI away from the terminal auto-wrap column', () => {
    expect(getSafeFrameWidth(120)).toBe(116)
  })

  it('keeps a usable minimum for narrow terminals', () => {
    expect(getSafeFrameWidth(22)).toBe(18)
    expect(getSafeFrameWidth(10)).toBe(6)
  })

  it('reserves one column for fixed viewport rendering', () => {
    expect(getSafeViewportWidth(120)).toBe(119)
  })
})
