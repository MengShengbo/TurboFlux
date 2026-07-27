import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import cliTruncate from 'cli-truncate'
import { resolveBackground, useTheme } from '../../theme/index'
import { TURBOFLUX_VERSION } from '../../brand'
import type { FastContextUiSummary } from './fastContextUi'
import type { ActiveTaskContext } from '../../../core/taskManager'
import type { GitSnapshot } from '../../../core/gitService'
import type { AgentRunState, TokenUsage } from '../../../shared/agentTypes'
import type { TerminalSessionInfo } from '../../../shared/terminalTypes'
import type { ToolStatus } from '../tools/ToolCallTree'
import { formatToolLabelForHistory } from '../tools/ToolCallTree'
import type { StreamingToolDraft } from '../tools/ActiveWorkPanel'
import type { SandboxStatus } from '../../../core/sandbox/types'
import type { SecurityResearchProfile } from '../../../shared/securityTypes'
import { deriveDeveloperFlow, type DeveloperSubAgentActivity, type DeveloperFlowTone } from '../developerFlowModel'

interface SessionSidebarProps {
  width: number
  workspacePath: string
  model: string
  mode: 'vibe' | 'plan'
  reasoning?: string
  approvalPolicy: string
  sandboxStatus?: SandboxStatus
  securityProfile?: SecurityResearchProfile
  contextWindow: number
  tokenUsage: TokenUsage
  isRunning: boolean
  runState: AgentRunState
  tools: ToolStatus[]
  draft: StreamingToolDraft | null
  streamText?: string
  thinkingText?: string
  fastContextSummary: FastContextUiSummary
  fastContextActive: boolean
  subagents: readonly DeveloperSubAgentActivity[]
  queuedCount: number
  terminals: TerminalSessionInfo[]
  mcpCount: number
  task: ActiveTaskContext | null
  objective?: string | null
  gitEnabled: boolean
  gitSnapshot: GitSnapshot | null
}

export function SessionSidebar({
  width,
  workspacePath,
  model,
  mode,
  reasoning,
  approvalPolicy,
  sandboxStatus,
  securityProfile,
  contextWindow,
  tokenUsage,
  isRunning,
  runState,
  tools,
  draft,
  streamText,
  thinkingText,
  fastContextSummary,
  fastContextActive,
  subagents,
  queuedCount,
  terminals,
  mcpCount,
  task,
  objective,
  gitEnabled,
  gitSnapshot,
}: SessionSidebarProps) {
  const theme = useTheme()
  const [, setTick] = useState(0)
  const activeTerminals = terminals.filter(session => session.status === 'running' || session.status === 'starting').length
  const flow = deriveDeveloperFlow({
    runState,
    isRunning,
    tools,
    draft,
    streamText,
    thinkingText,
    fastContextSummary,
    fastContextActive,
    subagents,
    terminals: activeTerminals,
    queuedCount,
    task,
    objective,
  })
  const contextTotal = tokenUsage.source === 'provider' && typeof tokenUsage.input === 'number'
    ? tokenUsage.input
    : 0
  const safeContextWindow = Math.max(1, contextWindow || 200_000)
  const contextRatio = Math.min(1, contextTotal / safeContextWindow)
  const latestTool = [...tools].reverse().find(tool => tool.status === 'running') ?? tools.at(-1)
  const workspaceName = workspacePath.split(/[\\/]/).filter(Boolean).at(-1) || workspacePath
  const elapsed = isRunning && runState.startedAt ? formatElapsed(Date.now() - runState.startedAt) : ''

  useEffect(() => {
    if (!isRunning || !runState.startedAt) return
    const timer = setInterval(() => setTick(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [isRunning, runState.startedAt])

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
      <Box justifyContent="space-between" flexShrink={0}>
        <Text color={theme.brand} bold>TurboFlux</Text>
        <Text color={theme.subtle}>{`v${TURBOFLUX_VERSION}`}</Text>
      </Box>
      <Text color={theme.inactive}>{cliTruncate(workspacePath, Math.max(12, width - 4), { position: 'middle' })}</Text>

      <Section title="STATUS">
        <Text color={flowColor(flow.tone, theme)} bold>{flow.label}</Text>
        <Text color={theme.inactive}>{cliTruncate(flow.detail, Math.max(16, (width - 4) * 2), { position: 'end' })}</Text>
        {elapsed && <SidebarRow label="Elapsed" value={elapsed} width={width} color={theme.info} />}
      </Section>

      <Section title="SESSION">
        <SidebarRow label="Model" value={model || 'not mounted'} width={width} color={theme.text} />
        <SidebarRow label="Mode" value={mode.toUpperCase()} width={width} color={mode === 'vibe' ? theme.success : theme.info} />
        <SidebarRow label="Reason" value={reasoning || 'provider'} width={width} color={theme.text} />
        <SidebarRow label="Approval" value={approvalPolicy} width={width} color={theme.text} />
        {securityProfile?.active && <SidebarRow
          label="Security"
          value={`${securityProfile.mode.toUpperCase()} · ${securityProfile.targets.length} target${securityProfile.targets.length === 1 ? '' : 's'}`}
          width={width}
          color={securityProfile.mode === 'red' ? theme.error : theme.info}
        />}
        {sandboxStatus && <SidebarRow
          label="Sandbox"
          value={`${sandboxStatus.policy}/${sandboxStatus.resolvedBackend}${sandboxStatus.available ? '' : ' unavailable'}`}
          width={width}
          color={!sandboxStatus.available ? theme.error : sandboxStatus.osIsolation ? theme.success : theme.warning}
        />}
      </Section>

      <Section title="CONTEXT">
        <Text color={contextColor(contextRatio, theme)}>{progressBar(contextRatio, Math.max(8, width - 5))}</Text>
        <SidebarRow
          label="Used"
          value={contextTotal > 0 ? `${formatTokens(contextTotal)} / ${formatTokens(safeContextWindow)}` : 'waiting'}
          width={width}
          color={contextTotal > 0 ? theme.text : theme.inactive}
        />
        {(tokenUsage.cached ?? 0) > 0 && <SidebarRow label="Cached" value={formatTokens(tokenUsage.cached)} width={width} color={theme.success} />}
        {(tokenUsage.output ?? 0) > 0 && <SidebarRow label="Output" value={formatTokens(tokenUsage.output)} width={width} color={theme.info} />}
      </Section>

      {(objective || task || latestTool || fastContextActive || flow.background.length > 0) && (
        <Section title="WORK">
          {(objective || task?.title) && (
            <Text color={theme.text}>{cliTruncate((objective || task?.title || '').replace(/\s+/g, ' '), Math.max(16, (width - 4) * 2), { position: 'end' })}</Text>
          )}
          {latestTool && (
            <Text color={latestTool.status === 'error' ? theme.error : latestTool.status === 'running' ? theme.brandShimmer : theme.inactive}>
              {cliTruncate(formatToolLabelForHistory(latestTool.name, latestTool.args), Math.max(12, width - 4), { position: 'middle' })}
            </Text>
          )}
          {fastContextActive && <SidebarRow label="Context" value={fastContextSummary.phase} width={width} color={theme.brandShimmer} />}
          {flow.background.slice(0, 2).map(item => <Text key={item} color={theme.inactive}>{cliTruncate(item, Math.max(12, width - 4))}</Text>)}
        </Section>
      )}

      <Section title="RUNTIME">
        <SidebarRow label="Git" value={formatGit(gitEnabled, gitSnapshot)} width={width} color={gitSnapshot?.conflictedCount ? theme.error : gitEnabled ? theme.success : theme.inactive} />
        <SidebarRow label="MCP" value={mcpCount > 0 ? `${mcpCount} online` : 'off'} width={width} color={mcpCount > 0 ? theme.success : theme.inactive} />
        <SidebarRow label="Terminal" value={activeTerminals > 0 ? `${activeTerminals} active` : 'idle'} width={width} color={activeTerminals > 0 ? theme.info : theme.inactive} />
        {queuedCount > 0 && <SidebarRow label="Queued" value={String(queuedCount)} width={width} color={theme.warning} />}
      </Section>

      <Box flexGrow={1} />
      <Text color={theme.subtle}>{`/${cliTruncate(workspaceName, Math.max(8, width - 5), { position: 'middle' })}`}</Text>
      <Text color={isRunning ? theme.brandShimmer : theme.success}>{`● ${isRunning ? 'working' : 'ready'} · TurboFlux ${TURBOFLUX_VERSION}`}</Text>
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

function flowColor(tone: DeveloperFlowTone, theme: ReturnType<typeof useTheme>): string {
  if (tone === 'warning') return theme.warning
  if (tone === 'error') return theme.error
  if (tone === 'success') return theme.success
  if (tone === 'idle') return theme.inactive
  return theme.brandShimmer
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

function formatGit(enabled: boolean, snapshot: GitSnapshot | null): string {
  if (!enabled) return 'off'
  if (!snapshot) return 'loading'
  const changed = snapshot.files.length > 0 ? ` · ${snapshot.files.length}` : ''
  return `${snapshot.branch}${changed}`
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}
