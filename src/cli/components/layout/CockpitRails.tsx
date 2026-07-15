import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text } from 'ink'
import cliTruncate from 'cli-truncate'
import { useTheme } from '../../theme/index'
import type { FastContextScanEvent, FastContextScanPhase } from '../../../core/fastContextTypes'
import type { ActiveTaskContext } from '../../../core/taskManager'
import type { TerminalSessionInfo } from '../../../shared/terminalTypes'
import type { ToolStatus } from '../tools/ToolCallTree'
import { formatToolLabelForHistory } from '../tools/ToolCallTree'
import type { StreamingToolDraft } from '../tools/ActiveWorkPanel'

export interface CockpitLayout {
  showWorkRail: boolean
  showTaskRail: boolean
  workWidth: number
  taskWidth: number
}

export function resolveCockpitLayout(columns: number): CockpitLayout {
  if (columns >= 126) return { showWorkRail: true, showTaskRail: true, workWidth: 28, taskWidth: 34 }
  if (columns >= 100) return { showWorkRail: false, showTaskRail: true, workWidth: 0, taskWidth: 32 }
  return { showWorkRail: false, showTaskRail: false, workWidth: 0, taskWidth: 0 }
}

interface WorkRailProps {
  width: number
  isRunning: boolean
  tools: ToolStatus[]
  draft: StreamingToolDraft | null
  fastContextEvents: FastContextScanEvent[]
  fastContextActive: boolean
  terminals: TerminalSessionInfo[]
  mcpCount: number
}

export function WorkRail({
  width,
  isRunning,
  tools,
  draft,
  fastContextEvents,
  fastContextActive,
  terminals,
  mcpCount,
}: WorkRailProps) {
  const theme = useTheme()
  const fastContext = useMemo(() => summarizeFastContext(fastContextEvents), [fastContextEvents])
  const activeTerminals = terminals.filter(session => session.status === 'running' || session.status === 'starting').length
  const visibleTools = tools.slice(-3).reverse()
  const fastStatus = fastContextActive
    ? phaseLabel(fastContext.phase)
    : fastContext.events > 0
      ? fastContext.phase === 'error' ? 'ERROR' : 'COMPLETE'
      : 'READY'

  return (
    <Box
      width={width}
      flexShrink={0}
      flexDirection="column"
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
      borderColor={theme.divider}
      backgroundColor={theme.panelBackground}
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
          {fastContext.latest && fastContextActive && (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.subtle}>SCANNING</Text>
              <Text color={theme.inactive}>{cliTruncate(fastContext.latest, Math.max(8, width - 4), { position: 'middle' })}</Text>
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
    <Box backgroundColor={theme.panelRaised} paddingX={1} marginBottom={1} justifyContent="space-between">
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
  isRunning: boolean
}

export function TaskRail({ width, task, objective, isRunning }: TaskRailProps) {
  const theme = useTheme()
  const [, setTick] = useState(0)
  const activeTask = isRunning ? task : null
  const goal = getTaskRailGoal(activeTask, isRunning ? objective : null)

  useEffect(() => {
    if (!activeTask || !isRunning) return
    const timer = setInterval(() => setTick(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [activeTask?.taskId, isRunning])

  const completedCalls = activeTask?.toolCalls.filter(call => call.status !== 'running').length ?? 0
  const errors = activeTask?.toolCalls.filter(call => call.status === 'error').length ?? 0
  const latest = activeTask
    ? [...activeTask.toolCalls].reverse().find(call => call.status === 'running') ?? activeTask.toolCalls[activeTask.toolCalls.length - 1]
    : undefined
  const elapsed = activeTask ? formatElapsed(Date.now() - activeTask.startedAt) : ''
  const progress = activeTask ? Math.max(0, Math.min(100, Math.round(activeTask.progress))) : 0

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
      backgroundColor={theme.panelBackground}
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
          <Box marginTop={1}>
            <Text color={theme.subtle}>PHASE </Text>
            <Text color={theme.warning}>Building execution plan</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
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

function summarizeFastContext(events: FastContextScanEvent[]): {
  events: number
  phase: FastContextScanPhase
  files: number
  hits: number
  latest: string
} {
  let phase: FastContextScanPhase = 'scanning'
  let files = 0
  let hits = 0
  let latest = ''
  for (const event of events) {
    if (event.type === 'phase') phase = event.phase
    if (event.type === 'file' && event.status === 'discovered') {
      files++
      latest = event.path
    }
    if (event.type === 'hit') hits++
    if (event.type === 'worker' && event.currentPath) latest = event.currentPath
  }
  return { events: events.length, phase, files, hits, latest }
}

function phaseLabel(phase: FastContextScanPhase): string {
  if (phase === 'synthesizing') return 'SYNTHESIZING'
  if (phase === 'completed') return 'COMPLETE'
  return phase.toUpperCase()
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
