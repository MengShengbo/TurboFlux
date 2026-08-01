import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import cliTruncate from 'cli-truncate'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import type { AgentRunState } from '../../../shared/agentTypes'
import type { ActiveTaskContext } from '../../../core/taskManager'
import { formatElapsed, formatTaskProgressLabel, formatTaskToolName, formatTaskToolSummary } from '../appHelpers'
import type { StreamingToolDraft, ToolStatus } from './toolTypes'
import { useI18n } from '../../i18n/index'

interface TaskFlowHudProps {
  task: ActiveTaskContext | null
  objective?: string | null
  isRunning: boolean
  runState?: AgentRunState
  tools: ToolStatus[]
  draft: StreamingToolDraft | null
  queuedCount?: number
  width?: number
}

export function TaskFlowHud({
  task,
  objective,
  isRunning,
  runState,
  tools,
  draft,
  queuedCount = 0,
  width: requestedWidth,
}: TaskFlowHudProps) {
  const theme = useTheme()
  const { t } = useI18n()
  const { columns } = useTerminalSize()
  const [now, setNow] = useState(Date.now)
  const width = Math.max(24, Math.min(requestedWidth ?? columns - 3, columns - 3))
  const hasLiveRun = isRunning || (runState?.phase !== undefined && runState.phase !== 'idle' && runState.phase !== 'completed')
  const visibleObjective = hasLiveRun ? objective : null

  useEffect(() => {
    if (!isRunning) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [isRunning, task?.taskId])

  if (!task && !hasLiveRun) return null

  const completed = task?.toolCalls.filter(call => call.status === 'completed' || call.status === 'error' || call.status === 'cancelled').length ?? 0
  const total = task?.toolCalls.length ?? 0
  const running = task?.toolCalls.filter(call => call.status === 'running').length ?? 0
  const errored = task?.toolCalls.filter(call => call.status === 'error').length ?? 0
  const latestTaskTool = [...(task?.toolCalls ?? [])].reverse().find(call => call.status === 'running')
    ?? task?.toolCalls.at(-1)
  const latestTool = latestTaskTool?.toolName
    ?? tools.find(tool => tool.status === 'running')?.name
    ?? draft?.name
    ?? runState?.activeTool
  const title = (task?.title || visibleObjective || runState?.detail || t('ui.flow.planningNext')).trim()
  const progress = task ? formatTaskProgressLabel(task.progress, t) : ''
  const summary = task
    ? formatTaskToolSummary(completed, total, running, errored, t)
    : runState?.detail || ''
  const startTime = task?.startedAt ?? runState?.startedAt
  const elapsed = startTime ? formatElapsed(Math.max(0, now - startTime)) : ''
  const meta = [
    summary,
    progress,
    latestTool ? formatTaskToolName(latestTool, t) : '',
    elapsed,
    queuedCount > 0 ? `queue ${queuedCount}` : '',
  ].filter(Boolean)
  const titleWidth = Math.max(12, width - 18)
  const accent = runState?.phase === 'awaiting_approval' || runState?.phase === 'awaiting_input'
    ? theme.warning
    : theme.brandShimmer

  return (
    <Box width={width} flexDirection="column" alignItems="flex-end" flexShrink={0} marginBottom={1}>
      <Box width={width} justifyContent="flex-end">
        <Text color={accent} bold>{`◆ ${task ? 'TASK' : 'FLOW'}`}</Text>
        <Text color={theme.text}>{` ${cliTruncate(title, titleWidth, { position: 'middle' })}`}</Text>
      </Box>
      {meta.length > 0 && (
        <Box width={width} justifyContent="flex-end">
          <Text color={theme.inactive}>{cliTruncate(meta.join(' · '), Math.max(12, width - 2), { position: 'middle' })}</Text>
        </Box>
      )}
    </Box>
  )
}
