import React from 'react'
import chalk from 'chalk'
import { renderToString } from 'ink'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'
import {
  PromptInput,
  getImageTokenAfter,
  getImageTokenBefore,
  getImageTokenRangeAfterDelete,
  getImageTokenRangeBeforeDelete,
  getPastedContentTokenAfter,
  getPastedContentTokenBefore,
  getPastedContentTokenRangeAfterDelete,
  getPastedContentTokenRangeBeforeDelete,
  getPromptEditorViewport,
  isImagePasteShortcut,
  navigatePromptHistory,
  nextTextOffset,
  previousTextOffset,
  resolvePromptChrome,
  sanitizePromptInputChunk,
} from './PromptInput'
import { darkTheme } from '../../theme/index'
import { ThemeProvider } from '../../theme/index'
import '../../commands/index'

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

describe('terminal focus reports', () => {
  it('never inserts full or Ink-normalized focus sequences into the draft', () => {
    expect(sanitizePromptInputChunk('\u001b[O')).toBe('')
    expect(sanitizePromptInputChunk('[I')).toBe('')
    expect(sanitizePromptInputChunk('[O[Ihello')).toBe('hello')
  })

  it('normalizes pasted terminal output without changing its line structure', () => {
    expect(sanitizePromptInputChunk('\u001b[31mfirst\r\nsecond\u001b[0m')).toBe('first\nsecond')
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

describe('large paste token navigation', () => {
  const value = 'before [Pasted Content 1200 chars] after'
  const tokenStart = 'before '.length
  const tokenEnd = tokenStart + '[Pasted Content 1200 chars]'.length

  it('moves across a pasted content placeholder as one token', () => {
    expect(getPastedContentTokenBefore(value, tokenEnd)).toEqual({ start: tokenStart, end: tokenEnd })
    expect(getPastedContentTokenAfter(value, tokenStart)).toEqual({ start: tokenStart, end: tokenEnd })
  })

  it('deletes the complete pasted content placeholder', () => {
    expect(getPastedContentTokenRangeBeforeDelete(value, tokenEnd)).toEqual({ start: tokenStart, end: tokenEnd })
    expect(getPastedContentTokenRangeAfterDelete(value, tokenStart)).toEqual({ start: tokenStart, end: tokenEnd })
    expect(getPastedContentTokenRangeBeforeDelete(`${value} tail`, tokenEnd + 1)).toEqual({ start: tokenStart, end: tokenEnd + 1 })
    const afterDeleteValue = `head [Pasted Content 1200 chars] tail`
    expect(getPastedContentTokenRangeAfterDelete(afterDeleteValue, 'head '.length)).toEqual({ start: 'head '.length, end: 'head '.length + tokenEnd - tokenStart })
  })
})

describe('prompt appearance', () => {
  it('leaves prompt surfaces transparent while keeping a visible border', () => {
    const transparentTheme = { ...darkTheme, transparentBackground: true }

    expect(resolvePromptChrome(transparentTheme, 'default')).toEqual({
      borderColor: transparentTheme.divider,
      backgroundColor: undefined,
    })
    expect(resolvePromptChrome(transparentTheme, 'landing')).toEqual({
      borderColor: transparentTheme.divider,
      backgroundColor: undefined,
    })
  })

  it('keeps landing prompt geometry without painting fill glyphs', () => {
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
    expect(lines[1]).not.toContain('█')
  })

  it('keeps bordered prompt geometry without painting fill glyphs', () => {
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
    expect(lines[1]).not.toContain('█')
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

  it('keeps the right border in the same display column as input grows', () => {
    const values = ['', 'a', 'abcdef', '中文输入', '🚀'.repeat(8), 'a'.repeat(40)]

    for (const appearance of ['default', 'landing'] as const) {
      for (const value of values) {
        const output = renderToString(
          React.createElement(
            ThemeProvider,
            { transparentBackground: true },
            React.createElement(PromptInput, {
              value,
              onChange: () => {},
              onSubmit: () => {},
              width: 30,
              placeholder: '',
              appearance,
            }),
          ),
          { columns: 40 },
        )
        const editorLine = stripAnsi(output).split('\n')[2] ?? ''

        expect(stringWidth(editorLine)).toBe(30)
        expect(editorLine.endsWith('│')).toBe(true)
      }
    }
  })

  it('keeps long input framed while showing the cursor-side tail', () => {
    for (const appearance of ['default', 'landing'] as const) {
      const output = renderToString(
        React.createElement(
          ThemeProvider,
          { transparentBackground: true },
          React.createElement(PromptInput, {
            value: 'a'.repeat(40) + 'visible-tail',
            onChange: () => {},
            onSubmit: () => {},
            width: 30,
            appearance,
          }),
        ),
        { columns: 40 },
      )
      const lines = stripAnsi(output).split('\n')

      expect(lines.every(line => line.length === 30)).toBe(true)
      expect(lines[2]).toContain('visible-tail')
      expect(lines[2]).toMatch(/│$/)
    }
  })

  it('keeps multiline pasted input inside the single-row editor frame', () => {
    const output = renderToString(
      React.createElement(
        ThemeProvider,
        { transparentBackground: true },
        React.createElement(PromptInput, {
          value: 'first line\nsecond line\nthird line',
          onChange: () => {},
          onSubmit: () => {},
          width: 30,
        }),
      ),
      { columns: 40 },
    )
    const plainOutput = stripAnsi(output)
    const lines = plainOutput.split('\n')

    expect(lines).toHaveLength(5)
    expect(lines.every(line => line.length === 30)).toBe(true)
    expect(plainOutput).toContain('\u21b5')
  })

  it('keeps the prompt fill in opaque mode', () => {
    const output = renderToString(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(PromptInput, {
          value: '',
          onChange: () => {},
          onSubmit: () => {},
          width: 30,
          placeholder: '',
        }),
      ),
      { columns: 40 },
    )

    expect(stripAnsi(output).split('\n')[1]).toContain('█')
  })

  it('emits background ANSI only in opaque mode', () => {
    const previousLevel = chalk.level
    chalk.level = 3
    try {
      const renderPrompt = (transparentBackground: boolean) => renderToString(
        React.createElement(
          ThemeProvider,
          { transparentBackground },
          React.createElement(PromptInput, {
            value: 'hello',
            onChange: () => {},
            onSubmit: () => {},
            width: 30,
          }),
        ),
        { columns: 40 },
      )

      expect(renderPrompt(true)).not.toContain('\u001b[48;')
      expect(renderPrompt(false)).toContain('\u001b[48;')
    } finally {
      chalk.level = previousLevel
    }
  })

  it('bounds landing completions without hiding the prompt frame', () => {
    const output = renderToString(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(PromptInput, {
          value: '/',
          onChange: () => {},
          onSubmit: () => {},
          width: 30,
          appearance: 'landing',
        }),
      ),
      { columns: 30 },
    )
    const lines = stripAnsi(output).split('\n')

    expect(lines).toHaveLength(8)
    expect(lines.every(line => line.length <= 30)).toBe(true)
    expect(lines.some(line => line.includes('> /'))).toBe(true)
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

describe('Unicode cursor boundaries', () => {
  it('moves across emoji without splitting surrogate pairs', () => {
    const value = 'a😀b'
    expect(nextTextOffset(value, 1)).toBe(3)
    expect(previousTextOffset(value, 3)).toBe(1)
  })

  it('moves one CJK code point at a time', () => {
    const value = '测试'
    expect(nextTextOffset(value, 0)).toBe(1)
    expect(previousTextOffset(value, 2)).toBe(1)
  })
})
