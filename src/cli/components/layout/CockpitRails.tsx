import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import cliTruncate from 'cli-truncate'
import { resolveBackground, useTheme } from '../../theme/index'
import type { FastContextScanPhase } from '../../../core/fastContextTypes'
import type { ActiveTaskContext } from '../../../core/taskManager'
import type { TerminalSessionInfo } from '../../../shared/terminalTypes'
import type { AgentRunState } from '../../../shared/agentTypes'
import type { ToolStatus } from '../tools/ToolCallTree'
import { formatToolLabelForHistory } from '../tools/ToolCallTree'
import type { StreamingToolDraft } from '../tools/ActiveWorkPanel'
import type { FastContextUiSummary } from './fastContextUi'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import { TURBOFLUX_VERSION } from '../../brand'
import {
  deriveDeveloperFlow,
  type DeveloperFlowTone,
  type DeveloperSubAgentActivity,
} from '../developerFlowModel'

export interface CockpitLayout {
  showWorkRail: boolean
  showTaskRail: boolean
  workWidth: number
  taskWidth: number
}

export function resolveCockpitLayout(columns: number): CockpitLayout {
  void columns
  return { showWorkRail: false, showTaskRail: false, workWidth: 0, taskWidth: 0 }
}

export interface CockpitHudProps {
  columns?: number
  workspacePath: string
  model: string
  mode: 'vibe' | 'plan'
  reasoning?: string
  approvalPolicy: string
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
  showTask: boolean
}

export function CockpitHud({
  columns: requestedColumns,
  workspacePath,
  model,
  mode,
  reasoning,
  approvalPolicy,
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
  showTask,
}: CockpitHudProps) {
  const theme = useTheme()
  const { columns: terminalColumns } = useTerminalSize()
  const columns = requestedColumns || terminalColumns
  const availableWidth = Math.max(40, columns - 6)
  const leftWidth = Math.max(20, Math.floor(availableWidth * 0.56))
  const rightWidth = Math.max(16, availableWidth - leftWidth)
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
  const flowColor = resolveFlowColor(flow.tone, theme)
  const taskGoal = getTaskRailGoal(isRunning ? task : null, isRunning ? objective : null)
  const sessionDetails = [
    model || 'no model',
    mode.toUpperCase(),
    reasoning ? `reason:${reasoning}` : '',
    `approval:${approvalPolicy}`,
    mcpCount > 0 ? `${mcpCount} MCP` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const backgroundDetails = showTask && taskGoal
    ? `Task · ${taskGoal}`
    : flow.background.length > 0
      ? flow.background.join(' · ')
      : isRunning && taskGoal ? `Focus · ${taskGoal}` : ''

  return (
    <Box flexDirection="column" flexShrink={0} backgroundColor={resolveBackground(theme, 'panelBackground')} paddingX={1}>
      <Box flexDirection="row" height={1} overflow="hidden">
        <Box width={leftWidth} overflow="hidden">
          <Text color={theme.brand} bold>TurboFlux</Text>
          <Text color={theme.subtle}>{` v${TURBOFLUX_VERSION} · `}</Text>
          <Text color={theme.text} wrap="truncate-middle">{workspacePath}</Text>
        </Box>
        <Box width={rightWidth} justifyContent="flex-end" overflow="hidden">
          <Box flexShrink={0}>
            <Text color={flowColor} bold>{`● ${flow.label}`}</Text>
          </Box>
          <Box flexShrink={1} minWidth={0} overflow="hidden">
            <Text color={theme.text} wrap="truncate-middle">{` · ${flow.detail}`}</Text>
          </Box>
        </Box>
      </Box>
      <Box flexDirection="row" height={1} overflow="hidden">
        <Box width={leftWidth} overflow="hidden">
          <Text color={theme.inactive} wrap="truncate-end">{sessionDetails}</Text>
        </Box>
        <Box width={rightWidth} justifyContent="flex-end" overflow="hidden">
          {backgroundDetails && (
            <Text color={theme.inactive} wrap="truncate-middle">{`BG · ${backgroundDetails}`}</Text>
          )}
        </Box>
      </Box>
    </Box>
  )
}

interface WorkRailProps {
  width: number
  isRunning: boolean
  tools: ToolStatus[]
  draft: StreamingToolDraft | null
  fastContextSummary: FastContextUiSummary
  fastContextActive: boolean
  terminals: TerminalSessionInfo[]
  mcpCount: number
  visible?: boolean
  compact?: boolean
}

export function WorkRail({
  width,
  isRunning,
  tools,
  draft,
  fastContextSummary,
  fastContextActive,
  terminals,
  mcpCount,
  visible = true,
  compact = false,
}: WorkRailProps) {
  const theme = useTheme()
  const fastContext = fastContextSummary
  const activeTerminals = terminals.filter(session => session.status === 'running' || session.status === 'starting').length
  const visibleTools = tools.slice(-3).reverse()
  const fastStatus = fastContextActive
    ? phaseLabel(fastContext.phase)
    : fastContext.events > 0
      ? fastContext.phase === 'error' ? 'ERROR' : 'COMPLETE'
      : 'READY'

  if (!visible) return <HiddenRail width={width} side="left" />

  return (
    <Box
      width={width}
      flexShrink={0}
      flexDirection="column"
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderLeft={compact}
      borderColor={theme.divider}
      paddingX={compact ? 1 : 0}
      backgroundColor={resolveBackground(theme, 'panelBackground')}
      overflow="hidden"
    >
      <RailHeader
        title="WORK"
        state={isRunning ? 'ACTIVE' : 'READY'}
        stateColor={isRunning ? theme.brandShimmer : theme.success}
      />

      <Box flexDirection="column" paddingX={1}>
        <SectionLabel>EXECUTION</SectionLabel>
        {draft ? (
          <RailEntry label="PREPARING" value={formatDraft(draft, width)} color={theme.brandShimmer} />
        ) : null}

        {visibleTools.map((tool, index) => (
          <Box key={tool.id ?? `${tool.name}-${index}`}>
            <Text color={tool.status === 'error' ? theme.error : tool.status === 'running' ? theme.brandShimmer : theme.success}>
              {tool.status === 'running' ? '● ' : tool.status === 'error' ? '! ' : '✓ '}
            </Text>
            <Text color={tool.status === 'running' ? theme.text : theme.inactive}>
              {cliTruncate(formatToolLabelForHistory(tool.name, tool.args), Math.max(8, width - 6), { position: 'middle' })}
            </Text>
          </Box>
        ))}
        {!draft && visibleTools.length === 0 && <Text color={theme.inactive}>No active tool</Text>}

        <Box flexDirection="column" marginTop={1}>
          <SectionLabel>RESOURCES</SectionLabel>
          <InfoRow
            label="Fast context"
            value={fastStatus}
            color={fastContextActive ? theme.brandShimmer : fastContext.phase === 'error' ? theme.error : theme.success}
          />
          {(fastContextActive || fastContext.events > 0) && (
            <InfoRow label="Evidence" value={`${fastContext.files} files / ${fastContext.hits} hits`} color={theme.info} />
          )}
          <InfoRow label="Terminals" value={activeTerminals > 0 ? `${activeTerminals} active` : 'NONE'} color={activeTerminals > 0 ? theme.info : theme.inactive} />
          <InfoRow label="MCP servers" value={mcpCount > 0 ? `${mcpCount} ONLINE` : 'OFF'} color={mcpCount > 0 ? theme.success : theme.inactive} />
          {(fastContext.insight || fastContext.latest) && fastContextActive && (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.subtle}>BACKGROUND</Text>
              <Text color={theme.inactive}>
                {cliTruncate(fastContext.insight || fastContext.latest, Math.max(8, width - 4), { position: 'middle' })}
              </Text>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  )
}

function RailHeader({ title, state, stateColor }: { title: string; state: string; stateColor: string }) {
  const theme = useTheme()
  return (
    <Box backgroundColor={resolveBackground(theme, 'panelRaised')} paddingX={1} marginBottom={1} justifyContent="space-between">
      <Text color={theme.brand} bold>{title}</Text>
      <Text color={stateColor} bold>{`● ${state}`}</Text>
    </Box>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  const theme = useTheme()
  return <Text color={theme.subtle} bold>{children}</Text>
}

function RailEntry({ label, value, color }: { label: string; value: string; color: string }) {
  const theme = useTheme()
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.subtle}>{label}</Text>
      <Text color={color}>{value}</Text>
    </Box>
  )
}

function InfoRow({ label, value, color }: { label: string; value: string; color: string }) {
  const theme = useTheme()
  return (
    <Box justifyContent="space-between">
      <Text color={theme.inactive}>{label}</Text>
      <Text color={color}>{value}</Text>
    </Box>
  )
}

interface TaskRailProps {
  width: number
  task: ActiveTaskContext | null
  objective?: string | null
  objectiveStartedAt?: number
  isRunning: boolean
  visible?: boolean
  compact?: boolean
}

export function TaskRail({ width, task, objective, objectiveStartedAt, isRunning, visible = true, compact = false }: TaskRailProps) {
  const theme = useTheme()
  const [, setTick] = useState(0)
  const activeTask = isRunning ? task : null
  const goal = getTaskRailGoal(activeTask, isRunning ? objective : null)

  useEffect(() => {
    if ((!activeTask && !objectiveStartedAt) || !isRunning) return
    const timer = setInterval(() => setTick(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [activeTask?.taskId, objectiveStartedAt, isRunning])

  const completedCalls = activeTask?.toolCalls.filter(call => call.status !== 'running').length ?? 0
  const errors = activeTask?.toolCalls.filter(call => call.status === 'error').length ?? 0
  const latest = activeTask
    ? [...activeTask.toolCalls].reverse().find(call => call.status === 'running') ?? activeTask.toolCalls[activeTask.toolCalls.length - 1]
    : undefined
  const elapsedStartedAt = activeTask?.startedAt ?? objectiveStartedAt
  const elapsed = elapsedStartedAt ? formatElapsed(Date.now() - elapsedStartedAt) : ''
  const progress = activeTask ? Math.max(0, Math.min(100, Math.round(activeTask.progress))) : 0

  if (!visible) return <HiddenRail width={width} side="right" />

  return (
    <Box
      width={width}
      flexShrink={0}
      flexDirection="column"
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderRight={false}
      borderLeft={compact}
      borderColor={theme.divider}
      paddingX={compact ? 1 : 0}
      backgroundColor={resolveBackground(theme, 'panelBackground')}
      overflow="hidden"
    >
      <RailHeader
        title="CURRENT TASK"
        state={isRunning ? activeTask ? 'EXECUTING' : 'PLANNING' : 'IDLE'}
        stateColor={isRunning ? theme.brandShimmer : theme.inactive}
      />

      <Box flexDirection="column" paddingX={1}>
        {goal ? (
          <>
            <SectionLabel>GOAL</SectionLabel>
            <Text color={theme.text} bold>{formatObjective(goal, width)}</Text>
          </>
        ) : (
          <Text color={theme.inactive}>No active task</Text>
        )}

        {activeTask ? (
          <Box flexDirection="column" marginTop={1}>
            {activeTask.title !== goal && (
              <>
                <SectionLabel>PLAN</SectionLabel>
                <Text color={theme.text}>{cliTruncate(activeTask.title, Math.max(10, width - 4), { position: 'end' })}</Text>
              </>
            )}
            <Box marginTop={1}>
              <Text color={theme.info}>{progressBar(progress, Math.max(8, width - 13))}</Text>
              <Text color={theme.inactive}>{` ${progress >= 95 && progress < 100 ? 'FINAL' : `${progress}%`}`}</Text>
            </Box>
            <InfoRow label="Steps" value={`${completedCalls}/${activeTask.toolCalls.length}`} color={completedCalls > 0 ? theme.success : theme.inactive} />
            <InfoRow label="Elapsed" value={elapsed} color={theme.info} />
            {errors > 0 && <InfoRow label="Failures" value={String(errors)} color={theme.error} />}
            {latest && (
              <Box flexDirection="column" marginTop={1}>
                <SectionLabel>NOW</SectionLabel>
                <Text color={latest.status === 'error' ? theme.error : theme.brandShimmer}>
                  {formatTaskTool(latest.toolName)}
                </Text>
                {latest.path && <Text color={theme.inactive}>{cliTruncate(latest.path, Math.max(10, width - 4), { position: 'middle' })}</Text>}
              </Box>
            )}
          </Box>
        ) : isRunning && goal ? (
          <Box flexDirection="column" marginTop={1}>
            <InfoRow label="Phase" value="PLANNING" color={theme.warning} />
            {elapsed && <InfoRow label="Elapsed" value={elapsed} color={theme.info} />}
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}

function HiddenRail({ width, side }: { width: number; side: 'left' | 'right' }) {
  const theme = useTheme()
  return (
    <Box
      width={width}
      flexShrink={0}
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderLeft={side === 'right'}
      borderRight={side === 'left'}
      borderColor={theme.divider}
      backgroundColor={resolveBackground(theme, 'panelBackground')}
    />
  )
}

export function getTaskRailGoal(task: ActiveTaskContext | null, objective?: string | null): string {
  return objective?.trim() || task?.title.trim() || ''
}

function formatObjective(objective: string, width: number): string {
  const compact = objective.replace(/\s+/g, ' ').trim()
  return cliTruncate(compact, Math.max(12, (width - 4) * 2), { position: 'end' })
}

function formatDraft(draft: StreamingToolDraft, width: number): string {
  const path = draft.partialJson.match(/"path"\s*:\s*"([^"]+)/)?.[1]
  return cliTruncate(path ? `${draft.name} ${path}` : draft.name, Math.max(8, width - 4), { position: 'middle' })
}

function phaseLabel(phase: FastContextScanPhase): string {
  if (phase === 'synthesizing') return 'SYNTHESIZING'
  if (phase === 'completed') return 'COMPLETE'
  return phase.toUpperCase()
}

function resolveFlowColor(tone: DeveloperFlowTone, theme: ReturnType<typeof useTheme>): string {
  if (tone === 'warning') return theme.warning
  if (tone === 'error') return theme.error
  if (tone === 'success') return theme.success
  if (tone === 'idle') return theme.inactive
  return theme.brandShimmer
}

function progressBar(progress: number, width: number): string {
  const filled = Math.round((progress / 100) * width)
  return '━'.repeat(filled) + '─'.repeat(Math.max(0, width - filled))
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

function formatTaskTool(name: string): string {
  return name.replaceAll('_', ' ')
}
