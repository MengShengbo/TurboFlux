import React from 'react'
import { Box, Text } from 'ink'
import cliTruncate from 'cli-truncate'
import { resolveBackground, useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import { getSafeFrameWidth } from '../../terminalLayout'
import type { TurboFluxConfig } from '../../../core/config'
import { formatNativeReasoningSetting } from '../../../core/modelRegistry'
import type { GitIntegrationState } from '../../../core/gitService'
import type { AgentMode, TokenUsage } from '../../../shared/agentTypes'
import { useI18n } from '../../i18n/index'
import type { PrimaryFlowActivity } from '../../state/flowSelectors'

interface StatusLineProps {
  config: TurboFluxConfig
  tokenUsage: TokenUsage
  mode?: AgentMode
  viewingHistory?: boolean
  gitState?: GitIntegrationState
  mcpCount?: number
  terminalCount?: number
  attentionLabel?: string
  activity?: PrimaryFlowActivity
  backgroundCount?: number
  queueCount?: number
  resultCount?: number
  width?: number
}

export function StatusLine({
  config,
  tokenUsage,
  viewingHistory = false,
  gitState,
  mcpCount = 0,
  terminalCount = 0,
  attentionLabel,
  activity,
  backgroundCount = 0,
  queueCount = 0,
  resultCount = 0,
  width: requestedWidth,
}: StatusLineProps) {
  const theme = useTheme()
  const { t } = useI18n()
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

  const frameWidth = Math.max(20, Math.min(requestedWidth ?? getSafeFrameWidth(columns, 3), getSafeFrameWidth(columns, 3)))
  const modelPart = config.model || t('ui.status.noModel')
  const reasoningSetting = formatNativeReasoningSetting(config.model, config.reasoning, config.provider, config.modelCapabilities)
  const gitSnapshot = gitState?.snapshot ?? null
  const gitChangedCount = gitSnapshot?.files.length || 0
  const gitTracking = gitSnapshot
    ? [gitSnapshot.ahead > 0 ? `+${gitSnapshot.ahead}` : '', gitSnapshot.behind > 0 ? `-${gitSnapshot.behind}` : ''].filter(Boolean).join('/')
    : ''
  const gitPart = !gitState || gitState.phase === 'disabled'
    ? t('ui.status.gitOff')
    : gitState.phase === 'detecting'
      ? t('ui.status.gitDetecting')
      : gitState.phase === 'unavailable'
        ? t('ui.status.gitUnavailable')
        : gitState.phase === 'error'
          ? t('ui.status.gitError')
          : !gitSnapshot
            ? `git:${gitState.phase}`
      : `git:${gitSnapshot.branch}${gitTracking ? ` ${gitTracking}` : ''}${gitSnapshot.conflictedCount > 0 ? ` !${gitSnapshot.conflictedCount}` : gitChangedCount > 0 ? ` · ${t('ui.status.gitChanged', { count: gitChangedCount })}` : ` ${t('ui.status.gitClean')}`}`
  const compactModelPart = columns < 82 ? cliTruncate(modelPart, 12, { position: 'end' }) : modelPart
  const activityLabel = attentionLabel || (activity?.kind === 'action-required' ? (() => {
    switch (activity.code) {
      case 'review-required': return t('ui.status.activity.reviewRequired')
      case 'input-required': return t('ui.status.activity.inputRequired')
      default: return t('ui.status.activity.needsAttention')
    }
  })() : activity?.kind === 'error'
    ? t('ui.status.activity.needsAttention')
      : activity?.kind === 'stopping'
        ? t('ui.status.activity.stopping')
        : activity?.code === 'compacting'
          ? t('ui.status.activity.compacting')
        : undefined)
  const activityPart = activityLabel && activity?.detail
    ? t('ui.status.activity.detail', { activity: activityLabel, detail: cliTruncate(activity.detail, 24, { position: 'end' }) })
    : activityLabel
  const primaryParts = [
    activityPart || '',
    resultCount > 0 ? t('ui.status.inbox', { count: resultCount }) : '',
    queueCount > 0 ? t('ui.status.queue', { count: queueCount }) : '',
    backgroundCount > 0 ? t('ui.status.background', { count: backgroundCount }) : '',
    compactModelPart,
    columns >= 82 && reasoningSetting ? `reason:${reasoningSetting}` : '',
    `approval:${config.approvalPolicy}`,
    `cap:${config.capabilityProfile || 'workspace-write'}${config.capabilityProfile === 'danger-full-access' ? '!' : ''}`,
  ].filter(Boolean)
  const secondaryParts = [
    gitPart,
    `mcp:${mcpCount > 0 ? mcpCount : 'off'}`,
    terminalCount > 0 ? `term:${terminalCount}` : '',
    viewingHistory ? t('ui.status.history') : '',
  ].filter(Boolean)
  const contextLabel = `ctx ${hasProviderUsage ? `${formatTokens(total)}/${formatTokens(contextWindow)}` : t('ui.status.unknown')}`
  const cacheLabel = hasProviderUsage && (tokenUsage.cached ?? 0) > 0
    ? `cache ${formatTokens(tokenUsage.cached)}`
    : ''
  const outputLabel = hasProviderUsage && (tokenUsage.output ?? 0) > 0
    ? `out ${formatTokens(tokenUsage.output)}`
    : ''
  const parts = [
    ...primaryParts,
    ...(columns >= 82 ? [contextLabel] : []),
    ...(columns >= 100 ? [gitPart] : []),
    ...(columns >= 145 && outputLabel ? [outputLabel] : []),
    ...(columns >= 155 && cacheLabel ? [cacheLabel] : []),
    ...(columns >= 170 ? secondaryParts.filter(part => part !== gitPart) : []),
  ]
  const usageWidth = hasProviderUsage && total > 0 ? barWidth + 7 : 0
  const phaseLabel = attentionLabel || activity?.kind === 'action-required'
    ? t('ui.status.action')
    : activity?.kind === 'error'
      ? t('ui.status.alert')
      : activity?.kind === 'stopping'
        ? t('ui.status.stop')
        : activity?.kind === 'streaming'
          ? t('ui.status.reply')
          : ''
  const phaseColor = attentionLabel || activity?.kind === 'action-required' || activity?.kind === 'stopping'
    ? theme.warning
    : activity?.kind === 'error'
      ? theme.error
      : activity?.kind === 'streaming'
        ? theme.info
        : theme.inactive
  const phaseWidth = phaseLabel ? 9 : 0
  const textWidth = Math.max(12, frameWidth - 2 - phaseWidth - usageWidth)
  const statusText = cliTruncate(parts.join(' | '), textWidth, { position: phaseLabel ? 'end' : 'middle' })

  return (
    <Box
      width={frameWidth}
      paddingX={1}
      backgroundColor={resolveBackground(theme, 'panelRaised')}
      flexDirection="row"
      justifyContent="space-between"
    >
      <Box flexDirection="row" flexGrow={1} minWidth={0}>
        {phaseLabel && (
          <Box flexDirection="row" flexShrink={0}>
            <Text color={phaseColor} bold>{phaseLabel}</Text>
            <Text color={theme.divider}> | </Text>
          </Box>
        )}
        <Text color={theme.statusLine} wrap="truncate-end">{statusText}</Text>
        {hasProviderUsage && total > 0 && <Text> </Text>}
        {hasProviderUsage && total > 0 && <Text color={barColor}>{bar}</Text>}
        {hasProviderUsage && total > 0 && <Text color={theme.statusLine}> {percentage}%</Text>}
      </Box>
    </Box>
  )
}
