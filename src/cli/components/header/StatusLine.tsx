import React from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import { getSafeFrameWidth } from '../../terminalLayout'
import type { TurboFluxConfig } from '../../../core/config'
import type { AgentMode, ThinkingMode, TokenUsage } from '../../../shared/agentTypes'

interface StatusLineProps {
  config: TurboFluxConfig
  tokenUsage: TokenUsage
  mode?: AgentMode
  thinkingMode?: ThinkingMode
  viewingHistory?: boolean
  gitEnabled?: boolean
  mcpCount?: number
  terminalCount?: number
}

const MODE_LABELS: Record<AgentMode, string> = {
  vibe: 'VIBE',
  plan: 'PLAN',
}

const THINKING_LABELS: Record<ThinkingMode, string> = {
  auto: 'auto',
  off: 'off',
  standard: 'standard',
  max: 'max',
}

export function StatusLine({
  config,
  tokenUsage,
  mode = 'vibe',
  thinkingMode = 'auto',
  viewingHistory = false,
  gitEnabled = false,
  mcpCount = 0,
  terminalCount = 0,
}: StatusLineProps) {
  const theme = useTheme()
  const { columns } = useTerminalSize()
  const hasProviderUsage = tokenUsage.source === 'provider' && typeof tokenUsage.input === 'number'
  const total = hasProviderUsage ? tokenUsage.input! : 0
  const contextWindow = config.contextWindow || 1_000_000
  const ratio = Math.min(1, total / contextWindow)
  const percentage = Math.round(ratio * 100)

  const formatTokens = (n = 0) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`

  const barWidth = 12
  const filled = Math.round(ratio * barWidth)
  const bar = '#'.repeat(filled) + '-'.repeat(barWidth - filled)
  const barColor = ratio < 0.5 ? theme.success : ratio < 0.8 ? theme.warning : theme.error

  const isWide = columns > 80
  const frameWidth = getSafeFrameWidth(columns)

  const parts: string[] = []
  if (config.model) parts.push(config.model)
  parts.push(`think:${THINKING_LABELS[thinkingMode]}`)
  parts.push(`git:${gitEnabled ? 'on' : 'off'}`)
  parts.push(`mcp:${mcpCount > 0 ? mcpCount : 'off'}`)
  if (terminalCount > 0) parts.push(`term:${terminalCount}`)
  if (viewingHistory) parts.push('history')

  return (
    <Box
      width={frameWidth}
      paddingX={1}
      backgroundColor={theme.panelRaised}
      flexDirection="row"
      justifyContent="space-between"
    >
      <Box flexDirection="row">
        <Text color={mode === 'vibe' ? theme.success : theme.info} bold>{MODE_LABELS[mode]}</Text>
        <Text color={theme.divider}> | </Text>
        <Text color={theme.statusLine}>
          {parts.length > 0 ? parts.join(' | ') : 'no model connection'}
          {isWide && ` | ctx ${hasProviderUsage ? `${formatTokens(total)}/${formatTokens(contextWindow)}` : 'unknown'}`}
          {hasProviderUsage && total > 0 && ' '}
        </Text>
        {hasProviderUsage && total > 0 && <Text color={barColor}>{bar}</Text>}
        {hasProviderUsage && total > 0 && <Text color={theme.statusLine}> {percentage}%</Text>}
      </Box>
    </Box>
  )
}
