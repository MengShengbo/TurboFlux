import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import cliTruncate from 'cli-truncate'
import { resolveBackground, useTheme } from '../../theme/index'
import type { GitIntegrationState } from '../../../core/gitService'
import type { TokenUsage } from '../../../shared/agentTypes'
import type { TerminalSessionInfo } from '../../../shared/terminalTypes'
import { useI18n } from '../../i18n/index'

interface SessionSidebarProps {
  width: number
  workspacePath: string
  model: string
  mode: 'vibe' | 'plan'
  reasoning?: string
  contextWindow: number
  tokenUsage: TokenUsage
  queuedCount: number
  terminals: TerminalSessionInfo[]
  mcpCount: number
  gitState: GitIntegrationState
}

export function SessionSidebar({
  width,
  workspacePath,
  model,
  mode,
  reasoning,
  contextWindow,
  tokenUsage,
  queuedCount,
  terminals,
  mcpCount,
  gitState,
}: SessionSidebarProps) {
  const theme = useTheme()
  const { t } = useI18n()
  const [, setTick] = useState(0)
  const runningTerminals = terminals.filter(session => session.status === 'running' || session.status === 'starting')
  const activeTerminals = runningTerminals.length
  const latestTerminal = runningTerminals.at(-1)
  const contextTotal = tokenUsage.source === 'provider' && typeof tokenUsage.input === 'number'
    ? tokenUsage.input
    : 0
  const safeContextWindow = Math.max(1, contextWindow || 200_000)
  const contextRatio = Math.min(1, contextTotal / safeContextWindow)
  const gitSnapshot = gitState.snapshot
  const showRepo = Boolean(gitSnapshot || gitState.error || gitState.operation || ['detecting', 'syncing', 'error'].includes(gitState.phase))
  const showRuntime = mcpCount > 0 || activeTerminals > 0 || queuedCount > 0

  useEffect(() => {
    if (activeTerminals === 0) return
    const timer = setInterval(() => setTick(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [activeTerminals])

  return (
    <Box
      width={width}
      flexShrink={0}
      flexDirection="column"
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderRight={false}
      borderColor={theme.divider}
      backgroundColor={resolveBackground(theme, 'panelBackground')}
      paddingX={1}
      overflow="hidden"
    >
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
        <Text color={theme.brand} bold>TurboFlux</Text>
        <Text color={theme.inactive}>{cliTruncate(workspacePath, Math.max(12, width - 4), { position: 'middle' })}</Text>

        <Section title={t('ui.sidebar.session')}>
          <SidebarRow label={t('ui.sidebar.model')} value={model || t('ui.sidebar.notMounted')} width={width} color={theme.text} />
          <SidebarRow label={t('ui.sidebar.profile')} value={`${mode.toUpperCase()} / ${reasoning || t('ui.sidebar.provider')}`} width={width} color={mode === 'vibe' ? theme.success : theme.info} />
        </Section>

        <Section title={t('ui.sidebar.context')}>
          <Text color={contextColor(contextRatio, theme)}>{progressBar(contextRatio, Math.max(8, width - 5))}</Text>
          <SidebarRow
            label={t('ui.sidebar.used')}
            value={contextTotal > 0 ? `${formatTokens(contextTotal)} / ${formatTokens(safeContextWindow)}` : t('ui.sidebar.waiting')}
            width={width}
            color={contextTotal > 0 ? theme.text : theme.inactive}
          />
          {((tokenUsage.cached ?? 0) > 0 || (tokenUsage.output ?? 0) > 0) && (
            <SidebarRow
              label={t('ui.sidebar.io')}
              value={t('ui.sidebar.cacheOut', { cache: formatTokens(tokenUsage.cached), output: formatTokens(tokenUsage.output) })}
              width={width}
              color={theme.info}
            />
          )}
        </Section>

        {showRepo && (
          <Section title={t('ui.sidebar.repo')}>
            {gitState.phase !== 'ready' && <SidebarRow label={t('ui.sidebar.state')} value={gitState.phase} width={width} color={gitState.phase === 'error' ? theme.error : theme.warning} />}
            {gitSnapshot && <SidebarRow label={t('ui.sidebar.branch')} value={`${gitSnapshot.branch}${gitSnapshot.head ? ` @ ${gitSnapshot.head.slice(0, 8)}` : ''}`} width={width} color={gitSnapshot.conflictedCount > 0 ? theme.error : theme.text} />}
            {gitSnapshot && <SidebarRow label={t('ui.sidebar.changes')} value={`${gitSnapshot.stagedCount}S ${gitSnapshot.unstagedCount}M ${gitSnapshot.untrackedCount}U ${gitSnapshot.conflictedCount}C`} width={width} color={gitSnapshot.conflictedCount > 0 ? theme.error : gitSnapshot.clean ? theme.success : theme.warning} />}
            {gitSnapshot && (gitSnapshot.ahead > 0 || gitSnapshot.behind > 0) && <SidebarRow label={t('ui.sidebar.tracking')} value={`+${gitSnapshot.ahead} / -${gitSnapshot.behind}`} width={width} color={theme.info} />}
            {gitState.operation && <SidebarRow label={t('ui.sidebar.operation')} value={`${gitState.operation.name}: ${gitState.operation.status}`} width={width} color={gitState.operation.status === 'error' ? theme.error : gitState.operation.status === 'running' ? theme.warning : theme.success} />}
            {gitState.error && <Text color={theme.error}>{cliTruncate(gitState.error, Math.max(12, width - 4), { position: 'end' })}</Text>}
          </Section>
        )}

        {showRuntime && (
          <Section title={t('ui.sidebar.runtime')}>
            {mcpCount > 0 && <SidebarRow label="MCP" value={t('common.online', { count: mcpCount })} width={width} color={theme.success} />}
            {activeTerminals > 0 && <SidebarRow label={t('ui.sidebar.terminal')} value={t('common.active', { count: activeTerminals })} width={width} color={theme.info} />}
            {latestTerminal && <SidebarRow label={t('ui.sidebar.running')} value={formatElapsed(Date.now() - latestTerminal.createdAt)} width={width} color={theme.info} />}
            {latestTerminal && <Text color={theme.text}>{cliTruncate(latestTerminal.command || latestTerminal.title, Math.max(12, width - 4), { position: 'middle' })}</Text>}
            {latestTerminal && <Text color={theme.inactive}>{`${formatBytes(latestTerminal.outputBytes || 0)} · /ps · /stop`}</Text>}
            {queuedCount > 0 && <SidebarRow label={t('ui.sidebar.queued')} value={String(queuedCount)} width={width} color={theme.warning} />}
          </Section>
        )}
      </Box>

    </Box>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme()
  return (
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
      <Text color={theme.info} bold>{title}</Text>
      {children}
    </Box>
  )
}

function SidebarRow({ label, value, width, color }: { label: string; value: string; width: number; color: string }) {
  const theme = useTheme()
  const valueWidth = Math.max(8, width - label.length - 6)
  return (
    <Box justifyContent="space-between" overflow="hidden">
      <Text color={theme.inactive}>{label}</Text>
      <Text color={color}>{cliTruncate(value, valueWidth, { position: 'middle' })}</Text>
    </Box>
  )
}

function contextColor(ratio: number, theme: ReturnType<typeof useTheme>): string {
  if (ratio >= 0.8) return theme.error
  if (ratio >= 0.5) return theme.warning
  return theme.info
}

function progressBar(ratio: number, width: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width)
  return `${'━'.repeat(filled)}${'─'.repeat(Math.max(0, width - filled))}`
}

function formatTokens(value = 0): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}
