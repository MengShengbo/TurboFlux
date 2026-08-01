import React, { useState, useMemo, useRef, useEffect, useCallback, type MutableRefObject } from 'react'
import { Box, Text, useInput, usePaste, type Key } from 'ink'
import stringWidth from 'string-width'
import cliTruncate from 'cli-truncate'
import stripAnsi from 'strip-ansi'
import { resolveBackground, useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import { commandRegistry } from '../../commands/registry'
import { getSafeFrameWidth } from '../../terminalLayout'
import { isTerminalMouseInput } from '../../terminalMouse'
import type { Theme } from '../../theme/types'
import { useI18n } from '../../i18n/index'
import { stripTerminalFocusSequences } from '../../platform/terminalAttention'
import { TerminalInputStateMachine } from './terminalInputStateMachine'

type PromptAppearance = 'default' | 'landing'

interface PasteTextResult {
  value: string
  cursorOffset?: number
}

interface PromptInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => string | void
  onAlternateSubmit?: (value: string) => void
  onDoubleEsc?: () => void
  onPasteImage?: () => boolean
  onPasteText?: (pastedText: string, nextValue: string, insertionStart: number) => PasteTextResult | null
  onUserActivity?: () => void
  onInputMutation?: () => void
  mode?: string
  width?: number
  placeholder?: string
  appearance?: PromptAppearance
  historyRef?: MutableRefObject<string[]>
}

const MAX_PROMPT_HISTORY_ENTRIES = 200
const MAX_PROMPT_HISTORY_CHARS = 1 * 1024 * 1024

export function resolvePromptChrome(theme: Theme, _appearance: PromptAppearance): { borderColor: string; backgroundColor?: string } {
  return {
    borderColor: theme.transparentBackground ? theme.divider : theme.promptBorder,
    backgroundColor: resolveBackground(theme, 'promptBackground'),
  }
}

export function isImagePasteShortcut(input: string, key: Pick<Key, 'ctrl' | 'meta'>): boolean {
  const normalized = input?.toLowerCase()
  return (key.ctrl && normalized === 'v') ||
    input === '\u0016' ||
    (key.meta && normalized === 'v')
}

export function sanitizePromptInputChunk(input: string): string {
  return stripTerminalFocusSequences(stripAnsi(input)).replace(/\r\n?/g, '\n')
}

function clampCursor(offset: number, value: string): number {
  return Math.max(0, Math.min(offset, value.length))
}

export function previousTextOffset(value: string, offset: number): number {
  const normalized = clampCursor(offset, value)
  if (normalized === 0) return 0
  const previousCodeUnit = value.charCodeAt(normalized - 1)
  const isLowSurrogate = previousCodeUnit >= 0xDC00 && previousCodeUnit <= 0xDFFF
  const precedingCodeUnit = normalized >= 2 ? value.charCodeAt(normalized - 2) : 0
  const hasSurrogatePair = isLowSurrogate && precedingCodeUnit >= 0xD800 && precedingCodeUnit <= 0xDBFF
  return Math.max(0, normalized - (hasSurrogatePair ? 2 : 1))
}

export function nextTextOffset(value: string, offset: number): number {
  const normalized = clampCursor(offset, value)
  if (normalized >= value.length) return value.length
  const nextCodeUnit = value.charCodeAt(normalized)
  const followingCodeUnit = normalized + 1 < value.length ? value.charCodeAt(normalized + 1) : 0
  const hasSurrogatePair = nextCodeUnit >= 0xD800
    && nextCodeUnit <= 0xDBFF
    && followingCodeUnit >= 0xDC00
    && followingCodeUnit <= 0xDFFF
  return Math.min(value.length, normalized + (hasSurrogatePair ? 2 : 1))
}

export interface PromptHistoryNavigation {
  value: string
  index: number
  draft: string
}

export function navigatePromptHistory(
  history: string[],
  index: number,
  draft: string,
  currentValue: string,
  direction: 'older' | 'newer',
): PromptHistoryNavigation {
  if (history.length === 0) return { value: currentValue, index, draft }

  if (direction === 'older') {
    const nextIndex = Math.min(history.length - 1, index + 1)
    return {
      value: history[history.length - 1 - nextIndex] ?? currentValue,
      index: nextIndex,
      draft: index < 0 ? currentValue : draft,
    }
  }

  if (index < 0) return { value: currentValue, index, draft }
  if (index === 0) return { value: draft, index: -1, draft: '' }
  const nextIndex = index - 1
  return {
    value: history[history.length - 1 - nextIndex] ?? draft,
    index: nextIndex,
    draft,
  }
}

export interface PromptEditorViewport {
  beforeCursor: string
  cursorChar: string
  afterCursor: string
  width: number
}

export function getPromptEditorViewport(value: string, cursorOffset: number, maxWidth: number): PromptEditorViewport {
  const offset = clampCursor(cursorOffset, value)
  const availableWidth = Math.max(1, Math.floor(maxWidth))
  const cursorEnd = nextTextOffset(value, offset)
  const cursorChar = formatPromptEditorCharacter(offset < value.length ? value.slice(offset, cursorEnd) : ' ')
  const cursorWidth = Math.max(1, stringWidth(cursorChar))
  let remainingWidth = Math.max(0, availableWidth - cursorWidth)
  let beforeCursor = ''

  let beforeOffset = offset
  while (beforeOffset > 0) {
    const characterStart = previousTextOffset(value, beforeOffset)
    const char = formatPromptEditorCharacter(value.slice(characterStart, beforeOffset))
    const width = stringWidth(char)
    if (width > remainingWidth) break
    beforeCursor = char + beforeCursor
    remainingWidth -= width
    beforeOffset = characterStart
  }

  let afterCursor = ''
  let afterOffset = cursorEnd
  while (afterOffset < value.length) {
    const characterEnd = nextTextOffset(value, afterOffset)
    const char = formatPromptEditorCharacter(value.slice(afterOffset, characterEnd))
    const width = stringWidth(char)
    if (width > remainingWidth) break
    afterCursor += char
    remainingWidth -= width
    afterOffset = characterEnd
  }

  return {
    beforeCursor,
    cursorChar,
    afterCursor,
    width: stringWidth(beforeCursor) + cursorWidth + stringWidth(afterCursor),
  }
}

function formatPromptEditorCharacter(character: string): string {
  if (character === '\n' || character === '\r') return '↵'
  if (character === '\t') return '→'
  if (character.length === 1 && character.codePointAt(0)! < 0x20) return '·'
  return character || ' '
}

function fitText(value: string, maxWidth: number): string {
  let result = ''
  let width = 0
  for (const char of Array.from(value)) {
    const nextWidth = width + stringWidth(char)
    if (nextWidth > maxWidth) break
    result += char
    width = nextWidth
  }
  return result
}

export function getImageTokenBefore(value: string, offset: number): { start: number; end: number } | null {
  const prefix = value.slice(0, offset)
  const match = prefix.match(/\[Image\s*#\s*\d+]$/i)
  return match?.index === undefined ? null : { start: match.index, end: offset }
}

export function getImageTokenAfter(value: string, offset: number): { start: number; end: number } | null {
  const suffix = value.slice(offset)
  const match = suffix.match(/^\[Image\s*#\s*\d+]/i)
  return match ? { start: offset, end: offset + match[0].length } : null
}

const PASTED_CONTENT_TOKEN_PATTERN = /\[Pasted Content \d+ chars(?: #\d+)?\]/g

function getPastedContentToken(value: string, offset: number, direction: 'before' | 'after'): { start: number; end: number } | null {
  const normalized = clampCursor(offset, value)
  const pattern = new RegExp(PASTED_CONTENT_TOKEN_PATTERN.source, 'g')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value))) {
    const start = match.index
    const end = start + match[0].length
    if (direction === 'before' && normalized > start && normalized <= end) return { start, end }
    if (direction === 'after' && normalized >= start && normalized < end) return { start, end }
  }
  return null
}

export function getPastedContentTokenBefore(value: string, offset: number): { start: number; end: number } | null {
  return getPastedContentToken(value, offset, 'before')
}

export function getPastedContentTokenAfter(value: string, offset: number): { start: number; end: number } | null {
  return getPastedContentToken(value, offset, 'after')
}

export function getPastedContentTokenRangeBeforeDelete(value: string, offset: number): { start: number; end: number } | null {
  const token = getPastedContentTokenBefore(value, offset)
  if (token) return token
  const prefix = value.slice(0, offset)
  const match = prefix.match(new RegExp(`(\\s*)(${PASTED_CONTENT_TOKEN_PATTERN.source})(\\s*)$`))
  if (match?.index === undefined) return null
  const rawStart = match.index
  const leading = match[1] ?? ''
  const trailing = match[3] ?? ''
  const tokenStart = rawStart + leading.length
  const hasTextAfterCursor = /\S/.test(value.slice(offset))
  const start = trailing.length > 0 && hasTextAfterCursor
    ? tokenStart
    : tokenStart > 0 && value[tokenStart - 1] === ' '
      ? tokenStart - 1
      : rawStart
  return { start, end: offset }
}

export function getPastedContentTokenRangeAfterDelete(value: string, offset: number): { start: number; end: number } | null {
  const token = getPastedContentTokenAfter(value, offset)
  if (token) return token
  const suffix = value.slice(offset)
  const match = suffix.match(new RegExp(`^(\\s*)(${PASTED_CONTENT_TOKEN_PATTERN.source})(\\s*)`, 'i'))
  if (!match) return null
  const leading = match[1] ?? ''
  const trailing = match[3] ?? ''
  const tokenEnd = offset + match[0].length - trailing.length
  const fullEnd = offset + match[0].length
  if (leading.length > 0) return { start: offset, end: tokenEnd }
  return { start: offset, end: fullEnd }
}

export function getImageTokenRangeBeforeDelete(value: string, offset: number): { start: number; end: number } | null {
  const prefix = value.slice(0, offset)
  const match = prefix.match(/(\s*)\[Image\s*#\s*\d+](\s*)$/i)
  if (match?.index === undefined) return null
  const rawStart = match.index
  const leading = match[1] ?? ''
  const trailing = match[2] ?? ''
  const tokenStart = rawStart + leading.length
  const hasTextAfterCursor = /\S/.test(value.slice(offset))
  const start = trailing.length > 0 && hasTextAfterCursor
    ? tokenStart
    : tokenStart > 0 && value[tokenStart - 1] === ' '
      ? tokenStart - 1
      : rawStart
  return { start, end: offset }
}

export function getImageTokenRangeAfterDelete(value: string, offset: number): { start: number; end: number } | null {
  const suffix = value.slice(offset)
  const match = suffix.match(/^(\s*)\[Image\s*#\s*\d+](\s*)/i)
  if (!match) return null
  const leading = match[1] ?? ''
  const trailing = match[2] ?? ''
  const tokenEnd = offset + match[0].length - trailing.length
  const fullEnd = offset + match[0].length
  if (leading.length > 0) return { start: offset, end: tokenEnd }
  return { start: offset, end: fullEnd }
}

export function PromptInput({ value, onChange, onSubmit, onAlternateSubmit, onDoubleEsc, onPasteImage, onPasteText, onUserActivity, onInputMutation, mode, width, placeholder: requestedPlaceholder, appearance = 'default', historyRef: sharedHistoryRef }: PromptInputProps) {
  const theme = useTheme()
  const { t } = useI18n()
  const { columns } = useTerminalSize()
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [cursorOffset, setCursorOffset] = useState(value.length)
  const lastEscRef = useRef<number>(0)
  const lastValueRef = useRef(value)
  const internalHistoryRef = useRef<string[]>([])
  const historyRef = sharedHistoryRef ?? internalHistoryRef
  const historyIdxRef = useRef<number>(-1)
  const historyDraftRef = useRef('')
  const terminalInputStateRef = useRef(new TerminalInputStateMachine())

  const completions = useMemo(() => {
    if (!value.startsWith('/') || value.includes(' ')) return []
    return commandRegistry.getCompletions(value)
  }, [value])

  const showCompletions = completions.length > 0

  useEffect(() => {
    const previous = lastValueRef.current
    setCursorOffset(offset => value.startsWith(previous) && value.length > previous.length
      ? value.length
      : clampCursor(offset, value)
    )
    lastValueRef.current = value
  }, [value])

  const replaceValue = useCallback((nextValue: string, nextCursor = nextValue.length, resetHistory = true) => {
    if (nextValue !== value) onInputMutation?.()
    onChange(nextValue)
    setCursorOffset(clampCursor(nextCursor, nextValue))
    setSelectedIdx(0)
    if (resetHistory) {
      historyIdxRef.current = -1
      historyDraftRef.current = ''
    }
  }, [onChange, onInputMutation, value])

  const insertText = useCallback((text: string) => {
    if (!text) return
    const nextValue = value.slice(0, cursorOffset) + text + value.slice(cursorOffset)
    replaceValue(nextValue, cursorOffset + text.length)
  }, [cursorOffset, replaceValue, value])

  const insertPastedText = useCallback((text: string) => {
    const normalizedText = sanitizePromptInputChunk(text)
    if (!normalizedText) return
    const nextValue = value.slice(0, cursorOffset) + normalizedText + value.slice(cursorOffset)
    const transformed = onPasteText?.(normalizedText, nextValue, cursorOffset)
    if (transformed) {
      replaceValue(transformed.value, transformed.cursorOffset ?? transformed.value.length)
      return
    }
    replaceValue(nextValue, cursorOffset + normalizedText.length)
  }, [cursorOffset, onPasteText, replaceValue, value])

  const handleSubmit = useCallback((val: string) => {
    terminalInputStateRef.current.reset()
    const submittedValue = onSubmit(val)
    const historyValue = typeof submittedValue === 'string' ? submittedValue : val
    if (historyValue.trim()) {
      historyRef.current.push(historyValue)
      while (historyRef.current.length > MAX_PROMPT_HISTORY_ENTRIES) historyRef.current.shift()
      let historyChars = historyRef.current.reduce((total, item) => total + item.length, 0)
      while (historyChars > MAX_PROMPT_HISTORY_CHARS && historyRef.current.length > 1) {
        const removed = historyRef.current.shift() || ''
        historyChars -= removed.length
      }
      historyIdxRef.current = -1
      historyDraftRef.current = ''
    }
  }, [onSubmit])

  usePaste((text) => {
    onUserActivity?.()
    if (text.length === 0) {
      terminalInputStateRef.current.noteModifiedOrNavigationInput()
      if (onPasteImage?.()) return
    } else {
      terminalInputStateRef.current.noteExplicitPaste(text)
    }
    insertPastedText(text)
  }, { isActive: isInteractive })

  useInput((ch, key) => {
    onUserActivity?.()
    const inputChunk = sanitizePromptInputChunk(ch)
    if (!inputChunk && ch.length > 0) return
    if (isTerminalMouseInput(inputChunk)) return

    if (isImagePasteShortcut(inputChunk, key)) {
      terminalInputStateRef.current.noteModifiedOrNavigationInput()
      onPasteImage?.()
      return
    }

    if (key.escape) {
      terminalInputStateRef.current.noteModifiedOrNavigationInput()
      const now = Date.now()
      if (now - lastEscRef.current < 300) {
        onDoubleEsc?.()
        lastEscRef.current = 0
      } else {
        lastEscRef.current = now
      }
      return
    }

    if ((key.ctrl || key.shift) && (key.upArrow || key.downArrow)) {
      terminalInputStateRef.current.noteModifiedOrNavigationInput()
      return
    }

    if (key.upArrow) {
      terminalInputStateRef.current.noteModifiedOrNavigationInput()
      if (showCompletions) {
        setSelectedIdx(i => Math.max(i - 1, 0))
      } else {
        const next = navigatePromptHistory(historyRef.current, historyIdxRef.current, historyDraftRef.current, value, 'older')
        historyIdxRef.current = next.index
        historyDraftRef.current = next.draft
        replaceValue(next.value, next.value.length, false)
      }
      return
    }

    if (key.downArrow) {
      terminalInputStateRef.current.noteModifiedOrNavigationInput()
      if (showCompletions) {
        setSelectedIdx(i => Math.min(i + 1, completions.length - 1))
      } else {
        const next = navigatePromptHistory(historyRef.current, historyIdxRef.current, historyDraftRef.current, value, 'newer')
        historyIdxRef.current = next.index
        historyDraftRef.current = next.draft
        replaceValue(next.value, next.value.length, false)
      }
      return
    }

    if (key.shift && key.tab) {
      terminalInputStateRef.current.noteModifiedOrNavigationInput()
      return
    }

    if (key.tab && showCompletions) {
      terminalInputStateRef.current.noteModifiedOrNavigationInput()
      const cmd = completions[selectedIdx]
      if (cmd) {
        replaceValue('/' + cmd.name + ' ')
        setSelectedIdx(0)
      }
      return
    }

    if (key.return) {
      if (!key.ctrl && !key.meta && terminalInputStateRef.current.shouldInsertNewline()) {
        terminalInputStateRef.current.noteInsertedNewline()
        insertText('\n')
        return
      }
      if ((key.ctrl || key.meta) && onAlternateSubmit) {
        terminalInputStateRef.current.reset()
        onAlternateSubmit(value)
      } else {
        handleSubmit(value)
      }
      return
    }

    if (key.leftArrow) {
      terminalInputStateRef.current.noteModifiedOrNavigationInput()
      setCursorOffset(offset => getImageTokenBefore(value, offset)?.start
        ?? getPastedContentTokenBefore(value, offset)?.start
        ?? previousTextOffset(value, offset))
      return
    }

    if (key.rightArrow) {
      terminalInputStateRef.current.noteModifiedOrNavigationInput()
      setCursorOffset(offset => getImageTokenAfter(value, offset)?.end
        ?? getPastedContentTokenAfter(value, offset)?.end
        ?? nextTextOffset(value, offset))
      return
    }

    if (key.home) {
      terminalInputStateRef.current.noteModifiedOrNavigationInput()
      setCursorOffset(0)
      return
    }

    if (key.end) {
      terminalInputStateRef.current.noteModifiedOrNavigationInput()
      setCursorOffset(value.length)
      return
    }

    if (key.backspace) {
      terminalInputStateRef.current.noteModifiedOrNavigationInput()
      if (cursorOffset > 0) {
        const token = getImageTokenRangeBeforeDelete(value, cursorOffset)
        const pastedToken = getPastedContentTokenRangeBeforeDelete(value, cursorOffset)
        if (token || pastedToken) {
          const range = token ?? pastedToken!
          replaceValue(value.slice(0, range.start) + value.slice(range.end), range.start)
        } else {
          const previousOffset = previousTextOffset(value, cursorOffset)
          replaceValue(value.slice(0, previousOffset) + value.slice(cursorOffset), previousOffset)
        }
      }
      return
    }

    if (key.delete) {
      terminalInputStateRef.current.noteModifiedOrNavigationInput()
      if (cursorOffset < value.length) {
        const token = getImageTokenRangeAfterDelete(value, cursorOffset)
        const pastedToken = getPastedContentTokenRangeAfterDelete(value, cursorOffset)
        if (token || pastedToken) {
          const range = token ?? pastedToken!
          replaceValue(value.slice(0, range.start) + value.slice(range.end), range.start)
        } else {
          replaceValue(value.slice(0, cursorOffset) + value.slice(nextTextOffset(value, cursorOffset)), cursorOffset)
        }
      }
      return
    }

    if (key.ctrl || key.meta) {
      terminalInputStateRef.current.noteModifiedOrNavigationInput()
      return
    }
    terminalInputStateRef.current.notePlainText(inputChunk)
    if (inputChunk.length > 1 || inputChunk.includes('\n')) insertPastedText(inputChunk)
    else insertText(inputChunk)
  }, { isActive: isInteractive })

  const placeholder = requestedPlaceholder ?? (mode === 'plan' ? t('ui.prompt.plan')
    : t('ui.prompt.default'))
  const frameWidth = Math.max(20, Math.min(width ?? getSafeFrameWidth(columns, 3), getSafeFrameWidth(columns, 3)))
  const promptChrome = resolvePromptChrome(theme, appearance)
  const panelFillCharacter = promptChrome.backgroundColor ? '█' : ' '
  const landingInnerWidth = Math.max(1, frameWidth - 2)
  const landingPanelFill = panelFillCharacter.repeat(landingInnerWidth)
  const defaultInnerWidth = Math.max(1, frameWidth - 2)
  const defaultPanelFill = panelFillCharacter.repeat(defaultInnerWidth)
  const editorViewportWidth = Math.max(1, (appearance === 'landing' ? landingInnerWidth : defaultInnerWidth) - 4)
  const editorViewport = getPromptEditorViewport(value, cursorOffset, editorViewportWidth)
  const visiblePlaceholder = fitText(placeholder, editorViewportWidth)
  const completionLimit = appearance === 'landing' ? 3 : 6
  const completionStart = Math.max(0, Math.min(
    selectedIdx - Math.floor(completionLimit / 2),
    completions.length - completionLimit,
  ))
  const visibleCompletions = completions.slice(completionStart, completionStart + completionLimit)
  const editorWidth = value
    ? editorViewport.width
    : Math.max(1, stringWidth(visiblePlaceholder))
  const landingMiddleFill = panelFillCharacter.repeat(Math.max(0, landingInnerWidth - 3 - editorWidth))
  const defaultMiddleFill = panelFillCharacter.repeat(Math.max(0, defaultInnerWidth - 3 - editorWidth))
  const editorText = value ? (
    <Text backgroundColor={promptChrome.backgroundColor}>
      {editorViewport.beforeCursor}
      <Text inverse>{editorViewport.cursorChar}</Text>
      {editorViewport.afterCursor}
    </Text>
  ) : (
    <Text backgroundColor={promptChrome.backgroundColor}>
      <Text inverse>{Array.from(visiblePlaceholder)[0] ?? ' '}</Text>
      <Text color={theme.inactive}>{Array.from(visiblePlaceholder).slice(1).join('')}</Text>
    </Text>
  )

  return (
    <Box
      width={frameWidth}
      minWidth={frameWidth}
      maxWidth={frameWidth}
      flexDirection="column"
      flexShrink={0}
      marginTop={0}
      overflow="hidden"
    >
      {showCompletions && (
        <Box flexDirection="column" marginBottom={0} paddingLeft={2}>
          {visibleCompletions.map((cmd, visibleIndex) => {
            const index = completionStart + visibleIndex
            const selected = index === selectedIdx
            const description = cmd.descriptionKey ? t(cmd.descriptionKey) : cmd.description ?? ''
            const line = `${selected ? '> ' : '  '}/${cmd.name} - ${description}`
            return (
            <Box key={cmd.name}>
              <Text color={selected ? theme.brandShimmer : theme.inactive}>
                {cliTruncate(line, Math.max(8, frameWidth - 4), { position: 'end' })}
              </Text>
            </Box>
            )
          })}
        </Box>
      )}
      {appearance === 'landing' ? (
        <Box
          width={frameWidth}
          minWidth={frameWidth}
          maxWidth={frameWidth}
          flexDirection="column"
          flexShrink={0}
          borderStyle="single"
          borderColor={promptChrome.borderColor}
          overflow="hidden"
        >
          <Text color={promptChrome.backgroundColor}>{landingPanelFill}</Text>
          <Box
            width={landingInnerWidth}
            minWidth={landingInnerWidth}
            maxWidth={landingInnerWidth}
            flexDirection="row"
            flexShrink={0}
            overflow="hidden"
          >
            <Text color={promptChrome.backgroundColor}>{panelFillCharacter}</Text>
            <Text bold color={theme.brandShimmer} backgroundColor={promptChrome.backgroundColor}>{'> '}</Text>
            {editorText}
            <Text color={promptChrome.backgroundColor}>{landingMiddleFill}</Text>
          </Box>
          <Text color={promptChrome.backgroundColor}>{landingPanelFill}</Text>
        </Box>
      ) : (
        <Box
          width={frameWidth}
          minWidth={frameWidth}
          maxWidth={frameWidth}
          flexDirection="column"
          flexShrink={0}
          borderStyle="single"
          borderColor={promptChrome.borderColor}
          overflow="hidden"
        >
          <Text color={promptChrome.backgroundColor}>{defaultPanelFill}</Text>
          <Box
            width={defaultInnerWidth}
            minWidth={defaultInnerWidth}
            maxWidth={defaultInnerWidth}
            flexDirection="row"
            flexShrink={0}
            overflow="hidden"
          >
            <Text color={promptChrome.backgroundColor}>{panelFillCharacter}</Text>
            <Text bold color={theme.brandShimmer} backgroundColor={promptChrome.backgroundColor}>{'> '}</Text>
            {editorText}
            <Text color={promptChrome.backgroundColor}>{defaultMiddleFill}</Text>
          </Box>
          <Text color={promptChrome.backgroundColor}>{defaultPanelFill}</Text>
        </Box>
      )}
    </Box>
  )
}
