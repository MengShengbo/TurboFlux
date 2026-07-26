import { describe, expect, it } from 'vitest'
import { darkTheme } from './dark'
import { resolveBackground } from './resolveColor'

describe('resolveBackground', () => {
  it('omits large panel backgrounds in transparent mode', () => {
    const transparentTheme = { ...darkTheme, transparentBackground: true }

    expect(resolveBackground(transparentTheme, 'background')).toBeUndefined()
    expect(resolveBackground(transparentTheme, 'panelBackground')).toBeUndefined()
    expect(resolveBackground(transparentTheme, 'promptBackground')).toBeUndefined()
    expect(resolveBackground(transparentTheme, 'codeBackground')).toBeUndefined()
  })

  it('preserves normal dark theme backgrounds', () => {
    expect(resolveBackground(darkTheme, 'background')).toBe('#050505')
    expect(resolveBackground(darkTheme, 'panelRaised')).toBe('#141414')
  })

  it('keeps semantic diff colors available in transparent mode', () => {
    const transparentTheme = { ...darkTheme, transparentBackground: true }

    expect(resolveBackground(transparentTheme, 'diffAdded')).toBe('#0d2b18')
    expect(resolveBackground(transparentTheme, 'diffRemoved')).toBe('#2b1118')
  })
})
