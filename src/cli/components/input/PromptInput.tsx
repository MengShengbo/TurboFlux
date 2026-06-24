import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { Box, Text, useInput, usePaste, type Key } from 'ink'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import { commandRegistry } from '../../commands/registry'
import { getSafeFrameWidth } from '../../terminalLayout'

interface PasteTextResult {
  value: string
  cursorOffset?: number
}

interface PromptInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  onDoubleEsc?: () => void
  onPasteImage?: () => boolean
  onPasteText?: (pastedText: string, nextValue: string) => PasteTextResult | null
  mode?: string
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

export function PromptInput({ value, onChange, onSubmit, onDoubleEsc, onPasteImage, onPasteText, mode }: PromptInputProps) {
  const theme = useTheme()
  const { columns } = useTerminalSize()
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [cursorOffset, setCursorOffset] = useState(value.length)
  const lastEscRef = useRef<number>(0)
  const lastValueRef = useRef(value)
  const historyRef = useRef<string[]>([])
  const historyIdxRef = useRef<number>(-1)

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

  const replaceValue = useCallback((nextValue: string, nextCursor = nextValue.length) => {
    onChange(nextValue)
    setCursorOffset(clampCursor(nextCursor, nextValue))
    setSelectedIdx(0)
    historyIdxRef.current = -1
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
    }
    onSubmit(val)
  }, [onSubmit])

  usePaste((text) => {
    if (text.length === 0 && onPasteImage?.()) return
    insertPastedText(text)
  }, { isActive: isInteractive })

  useInput((ch, key) => {
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

    if (key.upArrow) {
      if (showCompletions) {
        setSelectedIdx(i => Math.max(i - 1, 0))
      } else {
        const history = historyRef.current
        if (history.length === 0) return
        const nextIdx = historyIdxRef.current < history.length - 1
          ? historyIdxRef.current + 1
          : historyIdxRef.current
        historyIdxRef.current = nextIdx
        replaceValue(history[history.length - 1 - nextIdx] ?? '')
      }
      return
    }

    if (key.downArrow) {
      if (showCompletions) {
        setSelectedIdx(i => Math.min(i + 1, completions.length - 1))
      } else {
        const history = historyRef.current
        if (historyIdxRef.current <= 0) {
          historyIdxRef.current = -1
          replaceValue('')
        } else {
          historyIdxRef.current -= 1
          replaceValue(history[history.length - 1 - historyIdxRef.current] ?? '')
        }
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
      handleSubmit(value)
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

  const placeholder = mode === 'plan' ? 'Describe what to plan...'
    : 'What are we building today?'
  const frameWidth = getSafeFrameWidth(columns)
  const cursorChar = value[cursorOffset] ?? ' '
  const beforeCursor = value.slice(0, cursorOffset)
  const afterCursor = cursorOffset < value.length ? value.slice(cursorOffset + 1) : ''

  return (
    <Box flexDirection="column" marginTop={0}>
      {showCompletions && (
        <Box flexDirection="column" marginBottom={0} paddingLeft={2}>
          {completions.slice(0, 6).map((cmd, i) => (
            <Box key={cmd.name}>
              <Text color={i === selectedIdx ? theme.brandShimmer : theme.text}>
                {i === selectedIdx ? '> ' : '  '}/{cmd.name} <Text color={theme.inactive}>- {cmd.description}</Text>
              </Text>
            </Box>
          ))}
        </Box>
      )}
      <Box
        borderStyle="round"
        borderColor={theme.promptBorder}
        borderLeft={false}
        borderRight={false}
        width={frameWidth}
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
      >
        <Text bold color={theme.brand}>{'> '}</Text>
        {value ? (
          <Text>
            {beforeCursor}
            <Text inverse>{cursorChar}</Text>
            {afterCursor}
          </Text>
        ) : (
          <Text>
            <Text inverse>{placeholder[0] ?? ' '}</Text>
            <Text color={theme.inactive}>{placeholder.slice(1)}</Text>
          </Text>
        )}
      </Box>
    </Box>
  )
}
