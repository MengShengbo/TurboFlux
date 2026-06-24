import { describe, expect, it } from 'vitest'
import { isImagePasteShortcut } from './PromptInput'

describe('isImagePasteShortcut', () => {
  it('accepts common terminal encodings for image paste shortcuts', () => {
    expect(isImagePasteShortcut('v', { ctrl: true, meta: false })).toBe(true)
    expect(isImagePasteShortcut('\u0016', { ctrl: true, meta: false })).toBe(true)
    expect(isImagePasteShortcut('v', { ctrl: false, meta: true })).toBe(true)
    expect(isImagePasteShortcut('v', { ctrl: true, meta: true })).toBe(true)
  })

  it('does not treat normal text as an image paste shortcut', () => {
    expect(isImagePasteShortcut('v', { ctrl: false, meta: false })).toBe(false)
    expect(isImagePasteShortcut('x', { ctrl: true, meta: false })).toBe(false)
    expect(isImagePasteShortcut('', { ctrl: false, meta: false })).toBe(false)
  })
})
