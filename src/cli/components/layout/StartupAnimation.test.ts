import { describe, expect, it } from 'vitest'
import { getStartupAnimationFrame, shouldAnimateStartup, STARTUP_ANIMATION_MS } from './StartupAnimation'

describe('startup animation frames', () => {
  it('starts with a stable hidden layout', () => {
    expect(getStartupAnimationFrame(0)).toMatchObject({
      logoReveal: 0,
      showVersion: false,
      showRails: false,
      showPrompt: false,
      complete: false,
    })
  })

  it('reveals the real interface in stages', () => {
    const frame = getStartupAnimationFrame(STARTUP_ANIMATION_MS * 0.8)
    expect(frame.logoReveal).toBe(1)
    expect(frame.showWorkspace).toBe(true)
    expect(frame.showRails).toBe(true)
    expect(frame.showPrompt).toBe(true)
    expect(frame.showStatus).toBe(false)
    expect(frame.shimmerActive).toBe(true)
  })

  it('settles on the complete static interface', () => {
    expect(getStartupAnimationFrame(STARTUP_ANIMATION_MS)).toMatchObject({
      logoReveal: 1,
      showVersion: true,
      showWorkspace: true,
      showSession: true,
      showRails: true,
      showPrompt: true,
      showStatus: true,
      shimmerActive: false,
      complete: true,
    })
  })
})

describe('startup animation selection', () => {
  it('animates normal interactive sessions', () => {
    expect(shouldAnimateStartup(true, undefined, true, {})).toBe(true)
  })

  it('skips motion where animation is inappropriate', () => {
    expect(shouldAnimateStartup(false, undefined, true, {})).toBe(false)
    expect(shouldAnimateStartup(true, 'single shot', true, {})).toBe(false)
    expect(shouldAnimateStartup(true, undefined, false, {})).toBe(false)
    expect(shouldAnimateStartup(true, undefined, true, { CI: 'true' })).toBe(false)
    expect(shouldAnimateStartup(true, undefined, true, { TERM: 'dumb' })).toBe(false)
    expect(shouldAnimateStartup(true, undefined, true, { TURBOFLUX_NO_ANIMATION: '1' })).toBe(false)
  })
})
