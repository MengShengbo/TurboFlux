import React from 'react'
import { Box, Text } from 'ink'
import cliTruncate from 'cli-truncate'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import { getSafeFrameWidth } from '../../terminalLayout'
import type { TurboFluxConfig } from '../../../core/config'
import { formatNativeReasoningSetting } from '../../../core/modelRegistry'
import type { AgentMode, TokenUsage } from '../../../shared/agentTypes'

interface StatusLineProps {
  config: TurboFluxConfig
  tokenUsage: TokenUsage
  mode?: AgentMode
  viewingHistory?: boolean
  gitEnabled?: boolean
  mcpCount?: number
  terminalCount?: number
}

const MODE_LABELS: Record<AgentMode, string> = {
  vibe: 'VIBE',
  plan: 'PLAN',
}

export function StatusLine({
  config,
  tokenUsage,
  mode = 'vibe',
  viewingHistory = false,
  gitEnabled = false,
  mcpCount = 0,
  terminalCount = 0,
}: StatusLineProps) {
  const theme = useTheme()
  const { columns } = useTerminalSize()
  const hasProviderUsage = tokenUsage.source === 'provider' && typeof tokenUsage.input === 'number'
  const total = hasProviderUsage ? tokenUsage.input! : 0
  const contextWindow = config.contextWindow || 200_000
  const ratio = Math.min(1, total / contextWindow)
  const percentage = Math.round(ratio * 100)

  const formatTokens = (n = 0) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`

  const barWidth = 12
  const filled = Math.round(ratio * barWidth)
  const bar = '#'.repeat(filled) + '-'.repeat(barWidth - filled)
  const barColor = ratio < 0.5 ? theme.success : ratio < 0.8 ? theme.warning : theme.error

  const frameWidth = getSafeFrameWidth(columns, 3)
  const modelPart = config.model || 'no model connection'
  const reasoningSetting = formatNativeReasoningSetting(config.model, config.reasoning, config.provider, config.modelCapabilities)
  const primaryParts = [
    modelPart,
    reasoningSetting ? `reason:${reasoningSetting}` : '',
    `approval:${config.approvalPolicy}`,
  ].filter(Boolean)
  const secondaryParts = [
    `git:${gitEnabled ? 'on' : 'off'}`,
    `mcp:${mcpCount > 0 ? mcpCount : 'off'}`,
    terminalCount > 0 ? `term:${terminalCount}` : '',
    viewingHistory ? 'history' : '',
  ].filter(Boolean)
  const contextLabel = `ctx ${hasProviderUsage ? `${formatTokens(total)}/${formatTokens(contextWindow)}` : 'unknown'}`
  const cacheLabel = hasProviderUsage && (tokenUsage.cached ?? 0) > 0
    ? `cache ${formatTokens(tokenUsage.cached)}`
    : ''
  const outputLabel = hasProviderUsage && (tokenUsage.output ?? 0) > 0
    ? `out ${formatTokens(tokenUsage.output)}`
    : ''
  const parts = [
    ...primaryParts,
    ...(columns >= 82 ? [contextLabel] : []),
    ...(columns >= 100 && outputLabel ? [outputLabel] : []),
    ...(columns >= 100 && cacheLabel ? [cacheLabel] : []),
    ...(columns >= 112 ? secondaryParts : []),
  ]
  const usageWidth = hasProviderUsage && total > 0 ? barWidth + 7 : 0
  const textWidth = Math.max(12, frameWidth - 9 - usageWidth)
  const statusText = cliTruncate(parts.join(' | '), textWidth, { position: 'middle' })

  return (
    <Box
      width={frameWidth}
      paddingX={1}
      backgroundColor={theme.panelRaised}
      flexDirection="row"
      justifyContent="space-between"
    >
      <Box flexDirection="row" flexGrow={1} minWidth={0}>
        <Text color={mode === 'vibe' ? theme.success : theme.info} bold>{MODE_LABELS[mode]}</Text>
        <Text color={theme.divider}> | </Text>
        <Text color={theme.statusLine} wrap="truncate-end">{statusText}</Text>
        {hasProviderUsage && total > 0 && <Text> </Text>}
        {hasProviderUsage && total > 0 && <Text color={barColor}>{bar}</Text>}
        {hasProviderUsage && total > 0 && <Text color={theme.statusLine}> {percentage}%</Text>}
      </Box>
    </Box>
  )
}
