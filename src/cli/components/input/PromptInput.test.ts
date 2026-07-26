import React from 'react'
import { renderToString } from 'ink'
import stripAnsi from 'strip-ansi'
import { describe, expect, it } from 'vitest'
import {
  PromptInput,
  getImageTokenAfter,
  getImageTokenBefore,
  getImageTokenRangeAfterDelete,
  getImageTokenRangeBeforeDelete,
  isImagePasteShortcut,
  resolvePromptChrome,
} from './PromptInput'
import { darkTheme } from '../../theme/index'
import { ThemeProvider } from '../../theme/index'

describe('isImagePasteShortcut', () => {
  it('accepts common terminal encodings for image paste shortcuts', () => {
    expect(isImagePasteShortcut('v', { ctrl: true, meta: false })).toBe(true)
    expect(isImagePasteShortcut('\u0016', { ctrl: true, meta: false })).toBe(true)
    expect(isImagePasteShortcut('\u0016', { ctrl: false, meta: false })).toBe(true)
    expect(isImagePasteShortcut('v', { ctrl: false, meta: true })).toBe(true)
    expect(isImagePasteShortcut('v', { ctrl: true, meta: true })).toBe(true)
  })

  it('does not treat normal text as an image paste shortcut', () => {
    expect(isImagePasteShortcut('v', { ctrl: false, meta: false })).toBe(false)
    expect(isImagePasteShortcut('x', { ctrl: true, meta: false })).toBe(false)
    expect(isImagePasteShortcut('', { ctrl: false, meta: false })).toBe(false)
  })
})

describe('image token navigation', () => {
  it('detects image placeholders as whole editor tokens', () => {
    expect(getImageTokenBefore('see [Image #12]', 'see [Image #12]'.length)).toEqual({ start: 4, end: 15 })
    expect(getImageTokenAfter('[Image #3] compare', 0)).toEqual({ start: 0, end: 10 })
  })

  it('ignores partial image placeholder text', () => {
    expect(getImageTokenBefore('see [Image #', 'see [Image #'.length)).toBeNull()
    expect(getImageTokenAfter('[Image #] compare', 0)).toBeNull()
  })

  it('expands delete ranges around image placeholders', () => {
    expect(getImageTokenRangeBeforeDelete('see [Image #1] now', 'see [Image #1] '.length)).toEqual({ start: 4, end: 15 })
    expect(getImageTokenRangeAfterDelete('see [Image #1] now', 3)).toEqual({ start: 3, end: 14 })
    expect(getImageTokenRangeBeforeDelete('see [Image #1] ', 'see [Image #1] '.length)).toEqual({ start: 3, end: 15 })
    expect(getImageTokenRangeAfterDelete('see [Image #1] ', 4)).toEqual({ start: 4, end: 15 })
  })
})

describe('prompt appearance', () => {
  it('keeps the landing prompt opaque under a transparent terminal theme', () => {
    const transparentTheme = { ...darkTheme, transparentBackground: true }

    expect(resolvePromptChrome(transparentTheme, 'default').backgroundColor).toBeUndefined()
    expect(resolvePromptChrome(transparentTheme, 'landing')).toEqual({
      borderColor: darkTheme.brandShimmer,
      backgroundColor: '#0b0b0b',
    })
  })

  it('paints every landing prompt cell instead of leaving layout gaps', () => {
    const output = renderToString(
      React.createElement(
        ThemeProvider,
        { transparentBackground: true },
        React.createElement(PromptInput, {
          value: '',
          onChange: () => {},
          onSubmit: () => {},
          width: 30,
          placeholder: '',
          appearance: 'landing',
        }),
      ),
      { columns: 40 },
    )
    const lines = stripAnsi(output).split('\n')

    expect(lines).toHaveLength(5)
    expect(lines.every(line => line.length === 30)).toBe(true)
  })
})
