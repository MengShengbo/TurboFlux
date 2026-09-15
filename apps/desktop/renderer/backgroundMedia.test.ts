import { describe, expect, it } from 'vitest'
import { backgroundBrightnessMultiplier, DEFAULT_BACKGROUND_MEDIA_SETTINGS, normalizeBackgroundMediaSettings, normalizeWindowOpacity } from './backgroundMedia'

describe('desktop background media settings', () => {
  it('normalizes the shared image and video layout contract', () => {
    expect(normalizeBackgroundMediaSettings({
      fit: 'contain', scale: 1.35, positionX: 24, positionY: 81,
      darkBrightness: 24, lightBrightness: 76, materialOpacity: 0.64, materialBlur: 18, blur: 6, playbackRate: 0.8,
    })).toEqual({
      fit: 'contain', scale: 1.35, positionX: 24, positionY: 81,
      darkBrightness: 24, lightBrightness: 76, materialOpacity: 0.64, materialBlur: 18, blur: 6, playbackRate: 0.8,
    })
  })

  it('clamps unsafe settings and rejects unknown fit modes', () => {
    expect(normalizeBackgroundMediaSettings({
      fit: 'invalid', scale: 9, positionX: -2, positionY: 120,
      darkBrightness: 80, lightBrightness: 0, materialOpacity: 0, materialBlur: 80, blur: 80, playbackRate: 8,
    })).toEqual({
      ...DEFAULT_BACKGROUND_MEDIA_SETTINGS,
      scale: 2,
      positionX: 0,
      positionY: 100,
      darkBrightness: 50,
      lightBrightness: 50,
      materialOpacity: 0.32,
      materialBlur: 30,
      blur: 24,
      playbackRate: 2,
    })
  })

  it('migrates the former surface opacity without reviving the global veil', () => {
    expect(normalizeBackgroundMediaSettings({ surfaceOpacity: 0.72 }).materialOpacity).toBe(0.72)
  })

  it('keeps 50 neutral and separates light from dark theme brightness', () => {
    expect(backgroundBrightnessMultiplier({ ...DEFAULT_BACKGROUND_MEDIA_SETTINGS, darkBrightness: 0 }, 'dark')).toBe(0.62)
    expect(backgroundBrightnessMultiplier(DEFAULT_BACKGROUND_MEDIA_SETTINGS, 'dark')).toBe(1)
    expect(backgroundBrightnessMultiplier(DEFAULT_BACKGROUND_MEDIA_SETTINGS, 'light')).toBe(1)
    expect(backgroundBrightnessMultiplier({ ...DEFAULT_BACKGROUND_MEDIA_SETTINGS, lightBrightness: 100 }, 'light')).toBe(1.35)
  })

  it('keeps the native window visible enough to recover controls', () => {
    expect(normalizeWindowOpacity(0)).toBe(0.45)
    expect(normalizeWindowOpacity(0.72)).toBe(0.72)
    expect(normalizeWindowOpacity(5)).toBe(1)
  })
})
