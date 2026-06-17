import React, { useState, useMemo, useRef } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import { commandRegistry } from '../../commands/registry'
import { getSafeFrameWidth } from '../../terminalLayout'

interface PromptInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  onDoubleEsc?: () => void
  mode?: string
}

export function PromptInput({ value, onChange, onSubmit, onDoubleEsc, mode }: PromptInputProps) {
  const theme = useTheme()
  const { columns } = useTerminalSize()
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const lastEscRef = useRef<number>(0)
  const historyRef = useRef<string[]>([])
  const historyIdxRef = useRef<number>(-1)

  const completions = useMemo(() => {
    if (!value.startsWith('/') || value.includes(' ')) return []
    return commandRegistry.getCompletions(value)
  }, [value])

  const showCompletions = completions.length > 0

  useInput((ch, key) => {
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
        onChange(history[history.length - 1 - nextIdx] ?? '')
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
          onChange('')
        } else {
          historyIdxRef.current -= 1
          onChange(history[history.length - 1 - historyIdxRef.current] ?? '')
        }
      }
      return
    }

    if (key.tab && showCompletions) {
      const cmd = completions[selectedIdx]
      if (cmd) {
        onChange('/' + cmd.name + ' ')
        setSelectedIdx(0)
      }
    }
  }, { isActive: isInteractive })

  const handleSubmit = (val: string) => {
    if (val.trim()) {
      historyRef.current.push(val)
      historyIdxRef.current = -1
    }
    onSubmit(val)
  }

  const placeholder = mode === 'plan' ? 'Describe what to plan...'
    : 'What are we building today?'
  const frameWidth = getSafeFrameWidth(columns)

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
        <TextInput value={value} onChange={(v) => { onChange(v); setSelectedIdx(0) }} onSubmit={handleSubmit} placeholder={placeholder} />
      </Box>
    </Box>
  )
}
