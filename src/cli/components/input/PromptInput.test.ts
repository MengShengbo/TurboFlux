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
  getPromptEditorViewport,
  isImagePasteShortcut,
  navigatePromptHistory,
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
  it('keeps every prompt opaque under a transparent terminal theme', () => {
    const transparentTheme = { ...darkTheme, transparentBackground: true }

    expect(resolvePromptChrome(transparentTheme, 'default')).toEqual({
      borderColor: darkTheme.promptBorder,
      backgroundColor: '#000000',
    })
    expect(resolvePromptChrome(transparentTheme, 'landing')).toEqual({
      borderColor: darkTheme.promptBorder,
      backgroundColor: '#000000',
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
    expect(lines[1]).toContain('█')
  })

  it('paints every bordered prompt cell instead of relying on box background', () => {
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
          appearance: 'default',
        }),
      ),
      { columns: 40 },
    )
    const lines = stripAnsi(output).split('\n')

    expect(lines).toHaveLength(5)
    expect(lines.every(line => line.length === 30)).toBe(true)
    expect(lines[1]).toContain('█')
    expect(lines[2]).toContain('> ')
  })

  it('keeps typed landing input visible on the editor row', () => {
    const output = renderToString(
      React.createElement(
        ThemeProvider,
        { transparentBackground: true },
        React.createElement(PromptInput, {
          value: 'hello',
          onChange: () => {},
          onSubmit: () => {},
          width: 30,
          placeholder: '',
          appearance: 'landing',
        }),
      ),
      { columns: 40 },
    )

    expect(stripAnsi(output).split('\n')[2]).toContain('> hello')
  })

  it('keeps long input framed while showing the cursor-side tail', () => {
    const output = renderToString(
      React.createElement(
        ThemeProvider,
        { transparentBackground: true },
        React.createElement(PromptInput, {
          value: 'a'.repeat(40) + 'visible-tail',
          onChange: () => {},
          onSubmit: () => {},
          width: 30,
          appearance: 'default',
        }),
      ),
      { columns: 40 },
    )
    const lines = stripAnsi(output).split('\n')

    expect(lines.every(line => line.length === 30)).toBe(true)
    expect(lines[2]).toContain('visible-tail')
  })
})

describe('prompt history navigation', () => {
  it('walks older entries and restores the draft on return', () => {
    const history = ['first', 'second', 'third']
    const latest = navigatePromptHistory(history, -1, '', 'unfinished draft', 'older')
    const older = navigatePromptHistory(history, latest.index, latest.draft, latest.value, 'older')
    const newer = navigatePromptHistory(history, older.index, older.draft, older.value, 'newer')
    const draft = navigatePromptHistory(history, newer.index, newer.draft, newer.value, 'newer')

    expect([latest.value, older.value, newer.value, draft.value]).toEqual(['third', 'second', 'third', 'unfinished draft'])
    expect(draft.index).toBe(-1)
  })
})

describe('prompt editor viewport', () => {
  it('keeps the cursor visible when long input exceeds the frame', () => {
    const atEnd = getPromptEditorViewport('0123456789abcdefghijklmnop', 26, 10)
    const inMiddle = getPromptEditorViewport('0123456789abcdefghijklmnop', 13, 10)

    expect(atEnd.beforeCursor).toBe('hijklmnop')
    expect(atEnd.cursorChar).toBe(' ')
    expect(atEnd.width).toBe(10)
    expect(`${inMiddle.beforeCursor}${inMiddle.cursorChar}${inMiddle.afterCursor}`).toContain('d')
    expect(inMiddle.width).toBeLessThanOrEqual(10)
  })

  it('measures wide characters without overflowing the editor width', () => {
    const viewport = getPromptEditorViewport('中文输入测试', '中文输入'.length, 7)
    expect(viewport.cursorChar).toBe('测')
    expect(viewport.width).toBeLessThanOrEqual(7)
  })
})
