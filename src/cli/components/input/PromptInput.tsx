import React, { useState, useMemo, useRef, useEffect, useCallback, type MutableRefObject } from 'react'
import { Box, Text, useInput, usePaste, type Key } from 'ink'
import stringWidth from 'string-width'
import cliTruncate from 'cli-truncate'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import { commandRegistry } from '../../commands/registry'
import { getSafeFrameWidth } from '../../terminalLayout'
import { isTerminalMouseInput } from '../../terminalMouse'
import type { Theme } from '../../theme/types'
import { useI18n } from '../../i18n/index'

type PromptAppearance = 'default' | 'landing'

interface PasteTextResult {
  value: string
  cursorOffset?: number
}

interface PromptInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  onAlternateSubmit?: (value: string) => void
  onDoubleEsc?: () => void
  onPasteImage?: () => boolean
  onPasteText?: (pastedText: string, nextValue: string) => PasteTextResult | null
  mode?: string
  width?: number
  placeholder?: string
  appearance?: PromptAppearance
  historyRef?: MutableRefObject<string[]>
}

export function resolvePromptChrome(theme: Theme, appearance: PromptAppearance): { borderColor: string; backgroundColor?: string } {
  if (appearance === 'landing') {
    return { borderColor: theme.promptBorder, backgroundColor: theme.promptBackground }
  }
  return { borderColor: theme.promptBorder, backgroundColor: theme.promptBackground }
}

export function isImagePasteShortcut(input: string, key: Pick<Key, 'ctrl' | 'meta'>): boolean {
  const normalized = input?.toLowerCase()
  return (key.ctrl && normalized === 'v') ||
    input === '\u0016' ||
    (key.meta && normalized === 'v')
}

function clampCursor(offset: number, value: string): number {
  return Math.max(0, Math.min(offset, value.length))
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
  const cursorChar = Array.from(value.slice(offset))[0] ?? ' '
  const cursorEnd = offset < value.length ? offset + cursorChar.length : offset
  const cursorWidth = Math.max(1, stringWidth(cursorChar))
  let remainingWidth = Math.max(0, availableWidth - cursorWidth)
  let beforeCursor = ''

  for (const char of Array.from(value.slice(0, offset)).reverse()) {
    const width = stringWidth(char)
    if (width > remainingWidth) break
    beforeCursor = char + beforeCursor
    remainingWidth -= width
  }

  let afterCursor = ''
  for (const char of Array.from(value.slice(cursorEnd))) {
    const width = stringWidth(char)
    if (width > remainingWidth) break
    afterCursor += char
    remainingWidth -= width
  }

  return {
    beforeCursor,
    cursorChar,
    afterCursor,
    width: stringWidth(beforeCursor) + cursorWidth + stringWidth(afterCursor),
  }
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

export function PromptInput({ value, onChange, onSubmit, onAlternateSubmit, onDoubleEsc, onPasteImage, onPasteText, mode, width, placeholder: requestedPlaceholder, appearance = 'default', historyRef: sharedHistoryRef }: PromptInputProps) {
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
    onChange(nextValue)
    setCursorOffset(clampCursor(nextCursor, nextValue))
    setSelectedIdx(0)
    if (resetHistory) {
      historyIdxRef.current = -1
      historyDraftRef.current = ''
    }
  }, [onChange])

  const insertText = useCallback((text: string) => {
    if (!text) return
    const nextValue = value.slice(0, cursorOffset) + text + value.slice(cursorOffset)
    replaceValue(nextValue, cursorOffset + text.length)
  }, [cursorOffset, replaceValue, value])

  const insertPastedText = useCallback((text: string) => {
    if (!text) return
    const nextValue = value.slice(0, cursorOffset) + text + value.slice(cursorOffset)
    const transformed = onPasteText?.(text, nextValue)
    if (transformed) {
      replaceValue(transformed.value, transformed.cursorOffset ?? transformed.value.length)
      return
    }
    replaceValue(nextValue, cursorOffset + text.length)
  }, [cursorOffset, onPasteText, replaceValue, value])

  const handleSubmit = useCallback((val: string) => {
    if (val.trim()) {
      historyRef.current.push(val)
      historyIdxRef.current = -1
      historyDraftRef.current = ''
    }
    onSubmit(val)
  }, [onSubmit])

  usePaste((text) => {
    if (text.length === 0 && onPasteImage?.()) return
    insertPastedText(text)
  }, { isActive: isInteractive })

  useInput((ch, key) => {
    if (isTerminalMouseInput(ch)) return

    if (isImagePasteShortcut(ch, key)) {
      onPasteImage?.()
      return
    }

    if (key.escape) {
      const now = Date.now()
      if (now - lastEscRef.current < 300) {
        onDoubleEsc?.()
        lastEscRef.current = 0
      } else {
        lastEscRef.current = now
      }
      return
    }

    if ((key.ctrl || key.shift) && (key.upArrow || key.downArrow)) return

    if (key.upArrow) {
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
      return
    }

    if (key.tab && showCompletions) {
      const cmd = completions[selectedIdx]
      if (cmd) {
        replaceValue('/' + cmd.name + ' ')
        setSelectedIdx(0)
      }
      return
    }

    if (key.return) {
      if ((key.ctrl || key.meta) && onAlternateSubmit) {
        onAlternateSubmit(value)
      } else {
        handleSubmit(value)
      }
      return
    }

    if (key.leftArrow) {
      setCursorOffset(offset => getImageTokenBefore(value, offset)?.start ?? Math.max(0, offset - 1))
      return
    }

    if (key.rightArrow) {
      setCursorOffset(offset => getImageTokenAfter(value, offset)?.end ?? Math.min(value.length, offset + 1))
      return
    }

    if (key.home) {
      setCursorOffset(0)
      return
    }

    if (key.end) {
      setCursorOffset(value.length)
      return
    }

    if (key.backspace) {
      if (cursorOffset > 0) {
        const token = getImageTokenRangeBeforeDelete(value, cursorOffset)
        if (token) {
          replaceValue(value.slice(0, token.start) + value.slice(token.end), token.start)
        } else {
          replaceValue(value.slice(0, cursorOffset - 1) + value.slice(cursorOffset), cursorOffset - 1)
        }
      }
      return
    }

    if (key.delete) {
      if (cursorOffset < value.length) {
        const token = getImageTokenRangeAfterDelete(value, cursorOffset)
        if (token) {
          replaceValue(value.slice(0, token.start) + value.slice(token.end), token.start)
        } else {
          replaceValue(value.slice(0, cursorOffset) + value.slice(cursorOffset + 1), cursorOffset)
        }
      }
      return
    }

    if (key.ctrl || key.meta) return
    insertText(ch)
  }, { isActive: isInteractive })

  const placeholder = requestedPlaceholder ?? (mode === 'plan' ? t('ui.prompt.plan')
    : t('ui.prompt.default'))
  const frameWidth = Math.max(20, Math.min(width ?? getSafeFrameWidth(columns, 3), getSafeFrameWidth(columns, 3)))
  const promptChrome = resolvePromptChrome(theme, appearance)
  const landingInnerWidth = Math.max(1, frameWidth - 2)
  const landingPanelFill = '█'.repeat(landingInnerWidth)
  const defaultInnerWidth = Math.max(1, frameWidth - 2)
  const defaultPanelFill = '█'.repeat(defaultInnerWidth)
  const editorViewportWidth = Math.max(1, (appearance === 'landing' ? landingInnerWidth : defaultInnerWidth) - 3)
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
  const landingMiddleFill = '█'.repeat(Math.max(0, landingInnerWidth - 3 - editorWidth))
  const defaultMiddleFill = '█'.repeat(Math.max(0, defaultInnerWidth - 3 - editorWidth))
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
    <Box flexDirection="column" marginTop={0}>
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
          flexDirection="column"
          borderStyle="single"
          borderColor={promptChrome.borderColor}
          overflow="hidden"
        >
          <Text color="#000000">{landingPanelFill}</Text>
          <Box width={landingInnerWidth} flexDirection="row" overflow="hidden">
            <Text color="#000000">█</Text>
            <Text bold color={theme.brandShimmer} backgroundColor={promptChrome.backgroundColor}>{'> '}</Text>
            {editorText}
            <Text color="#000000">{landingMiddleFill}</Text>
          </Box>
          <Text color="#000000">{landingPanelFill}</Text>
        </Box>
      ) : (
        <Box
          width={frameWidth}
          flexDirection="column"
          borderStyle="single"
          borderColor={promptChrome.borderColor}
          overflow="hidden"
        >
          <Text color="#000000">{defaultPanelFill}</Text>
          <Box width={defaultInnerWidth} flexDirection="row" overflow="hidden">
            <Text color="#000000">█</Text>
            <Text bold color={theme.brandShimmer} backgroundColor={promptChrome.backgroundColor}>{'> '}</Text>
            {editorText}
            <Text color="#000000">{defaultMiddleFill}</Text>
          </Box>
          <Text color="#000000">{defaultPanelFill}</Text>
        </Box>
      )}
    </Box>
  )
}
