import { describe, expect, it, vi } from 'vitest'
import {
  detectTerminalTransparency,
  resolveTransparentBackground,
  windowsTerminalProfileUsesTransparency,
} from './terminalTransparency'

const ACTIVE_PROFILE = '{61c54bbd-c2c6-5271-96e7-009a87ff44bf}'

function windowsTerminalOptions(settings: string) {
  return {
    platform: 'win32' as const,
    environment: {
      WT_SESSION: 'session-id',
      WT_PROFILE_ID: ACTIVE_PROFILE,
    },
    windowsTerminalSettingsPaths: ['settings.json'],
    readTextFile: () => settings,
  }
}

describe('terminal transparency detection', () => {
  it('defaults to an opaque background when terminal transparency is unknown', () => {
    expect(resolveTransparentBackground({ environment: {}, platform: 'linux' })).toBe(false)
    expect(detectTerminalTransparency({
      environment: { WT_SESSION: 'session-id' },
      platform: 'win32',
    })).toBe(false)
  })

  it('recognizes a visible profile background image as a transparent canvas', () => {
    const settings = JSON.stringify({
      profiles: {
        defaults: {},
        list: [{
          guid: ACTIVE_PROFILE,
          backgroundImage: 'wallpaper.png',
          backgroundImageOpacity: 0.18,
        }],
      },
    })

    expect(detectTerminalTransparency(windowsTerminalOptions(settings))).toBe(true)
  })

  it('ignores a disabled profile background image', () => {
    const settings = JSON.stringify({
      profiles: {
        defaults: {},
        list: [{
          guid: ACTIVE_PROFILE,
          backgroundImage: 'wallpaper.png',
          backgroundImageOpacity: 0,
        }],
      },
    })

    expect(detectTerminalTransparency(windowsTerminalOptions(settings))).toBe(false)
  })

  it('inherits a transparent opacity from profile defaults and accepts JSONC', () => {
    const settings = `{
      // Windows Terminal permits comments and trailing commas.
      "profiles": {
        "defaults": { "opacity": 82, },
        "list": [
          { "guid": "${ACTIVE_PROFILE}", },
        ],
      },
    }`

    expect(windowsTerminalProfileUsesTransparency(settings, ACTIVE_PROFILE)).toBe(true)
    expect(detectTerminalTransparency(windowsTerminalOptions(settings))).toBe(true)
  })

  it('lets the active profile override transparent defaults with full opacity', () => {
    const settings = JSON.stringify({
      profiles: {
        defaults: { opacity: 70 },
        list: [{ guid: ACTIVE_PROFILE.toUpperCase(), opacity: 100 }],
      },
    })

    expect(detectTerminalTransparency(windowsTerminalOptions(settings))).toBe(false)
  })

  it('recognizes legacy acrylic transparency', () => {
    const settings = JSON.stringify({
      profiles: {
        defaults: { useAcrylic: true, acrylicOpacity: 0.75 },
        list: [{ guid: ACTIVE_PROFILE }],
      },
    })

    expect(detectTerminalTransparency(windowsTerminalOptions(settings))).toBe(true)
  })
})

describe('terminal transparency preference', () => {
  it('applies explicit flags and environment values before detection', () => {
    const readTextFile = vi.fn(() => JSON.stringify({
      profiles: { list: [{ guid: ACTIVE_PROFILE, opacity: 50 }] },
    }))
    const detection = {
      platform: 'win32' as const,
      windowsTerminalSettingsPaths: ['settings.json'],
      readTextFile,
    }

    expect(resolveTransparentBackground({
      ...detection,
      opaque: true,
      transparent: true,
      environment: { WT_SESSION: 'session-id', WT_PROFILE_ID: ACTIVE_PROFILE },
    })).toBe(false)
    expect(resolveTransparentBackground({
      ...detection,
      transparent: true,
      environment: {},
    })).toBe(true)
    expect(resolveTransparentBackground({
      ...detection,
      environment: {
        TURBOFLUX_TRANSPARENT: 'off',
        WT_SESSION: 'session-id',
        WT_PROFILE_ID: ACTIVE_PROFILE,
      },
    })).toBe(false)
    expect(resolveTransparentBackground({
      ...detection,
      environment: { TURBOFLUX_TRANSPARENT: 'yes' },
    })).toBe(true)
    expect(readTextFile).not.toHaveBeenCalled()
  })
})
