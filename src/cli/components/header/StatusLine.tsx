import React from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import type { TurboFluxConfig } from '../../../core/config'
import type { AgentMode, TokenUsage } from '../../../shared/agentTypes'

interface StatusLineProps {
  config: TurboFluxConfig
  tokenUsage: TokenUsage
  mode?: AgentMode
  viewingHistory?: boolean
  gitEnabled?: boolean
}

const MODE_COLORS: Record<AgentMode, string> = {
  vibe: 'green',
  plan: 'blue',
}

const MODE_LABELS: Record<AgentMode, string> = {
  vibe: 'VIBE',
  plan: 'PLAN',
}

export function StatusLine({ config, tokenUsage, mode = 'vibe', viewingHistory = false, gitEnabled = false }: StatusLineProps) {
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

  const parts: string[] = []
  if (config.model) parts.push(config.model)
  if (config.provider) parts.push(config.provider)
  if (gitEnabled) parts.push('git')
  if (viewingHistory) parts.push('history view')

  return (
    <Box marginTop={0} flexDirection="row" justifyContent="space-between">
      <Box flexDirection="row">
        <Text color={MODE_COLORS[mode]} bold>[{MODE_LABELS[mode]}]</Text>
        <Text color={theme.statusLine}> </Text>
        <Text color={theme.statusLine}>
          {parts.length > 0 ? parts.join(' - ') : 'no model connection'}
          {isWide && ` - ctx ${hasProviderUsage ? `${formatTokens(total)}/${formatTokens(contextWindow)}` : 'unknown'}`}
          {hasProviderUsage && total > 0 && ' '}
        </Text>
        {hasProviderUsage && total > 0 && <Text color={barColor}>{bar}</Text>}
        {hasProviderUsage && total > 0 && <Text color={theme.statusLine}> {percentage}%</Text>}
      </Box>
    </Box>
  )
}
