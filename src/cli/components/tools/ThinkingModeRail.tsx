import React, { useEffect } from 'react'
import { Box, Text } from 'ink'
import cliTruncate from 'cli-truncate'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import type { ThinkingMode } from '../../../shared/agentTypes'

interface ThinkingModeRailProps {
  notice: { mode: ThinkingMode; changedAt: number } | null
  onDone: () => void
}

const NOTICE_DURATION_MS = 1400
const MODES: ThinkingMode[] = ['auto', 'off', 'standard', 'max']
const LABELS: Record<ThinkingMode, string> = {
  auto: 'Auto',
  off: 'Off',
  standard: 'Standard',
  max: 'Max',
}

export function ThinkingModeRail({ notice, onDone }: ThinkingModeRailProps) {
  const theme = useTheme()
  const { columns } = useTerminalSize()

  useEffect(() => {
    if (!notice) return
    const elapsed = Date.now() - notice.changedAt
    const timer = setTimeout(onDone, Math.max(250, NOTICE_DURATION_MS - elapsed))
    return () => clearTimeout(timer)
  }, [notice, onDone])

  if (!notice) return null

  const width = Math.max(24, columns - 2)
  if (width < 48) {
    return (
      <Box flexShrink={0} height={1}>
        <Text color={theme.statusLine}>Think </Text>
        <Text color={theme.brandShimmer} bold>[{LABELS[notice.mode]}]</Text>
      </Box>
    )
  }

  return (
    <Box flexShrink={0} height={1}>
      <Text color={theme.statusLine}>{cliTruncate('Think ', width, { position: 'end' })}</Text>
      {MODES.map((mode, index) => {
        const selected = mode === notice.mode
        return (
          <Text key={mode} color={selected ? theme.brandShimmer : theme.inactive} bold={selected}>
            {index > 0 ? '  ' : ''}
            {selected ? `[${LABELS[mode]}]` : LABELS[mode]}
          </Text>
        )
      })}
    </Box>
  )
}

export function buildThinkingModeRailText(mode: ThinkingMode): string {
  return `Think ${MODES.map(item => item === mode ? `[${LABELS[item]}]` : LABELS[item]).join('  ')}`
}
