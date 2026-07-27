import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import cliTruncate from 'cli-truncate'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import { formatMarkdown } from '../markdown/index'
import { SpinnerGlyph } from '../spinner/SpinnerGlyph'
import type { ToolStatus } from './toolTypes'
import type { AgentRunState, ReasoningEffort, ThinkingTrace } from '../../../shared/agentTypes'
import { ThinkingBlock } from '../messages/ThinkingBlock'
import { deriveActivityModel } from '../agentActivityModel'
import type { StreamingToolDraft } from './toolTypes'
import { ToolActivityList } from './ToolActivityList'
import { useI18n, type Translator } from '../../i18n/index'

export type { StreamingToolDraft } from './toolTypes'

interface ActiveWorkPanelProps {
  tools: ToolStatus[]
  draft: StreamingToolDraft | null
  streamText: string
  outputTokens?: number
  lastActivity: number
  runState?: AgentRunState
  queuedCount?: number
  thinkingText?: string
  thinkingStartedAt?: number
  reasoningEffort?: ReasoningEffort
  reasoningActive?: boolean
  showThinking?: boolean
  verbose: boolean
  idleLabel?: string | null
  availableWidth?: number
}

export function ActiveWorkPanel({
  tools,
  draft,
  streamText,
  outputTokens = 0,
  lastActivity,
  runState,
  queuedCount = 0,
  thinkingText = '',
  thinkingStartedAt,
  reasoningEffort,
  reasoningActive = false,
  showThinking = false,
  verbose,
  idleLabel,
  availableWidth,
}: ActiveWorkPanelProps) {
  const theme = useTheme()
  const { t } = useI18n()
  const { columns } = useTerminalSize()
  const panelColumns = Math.max(24, availableWidth ?? columns)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!runState || runState.phase === 'idle' || runState.phase === 'completed') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [runState?.phase])

  const resolvedIdleLabel = idleLabel === undefined ? t('ui.activity.phase.thinking') : idleLabel
  const activity = deriveActivityModel({ runState, tools, draft, streamText, thinkingText, idleLabel: resolvedIdleLabel }, t)
  if (!activity.visible) return null

  const hasLiveReasoning = reasoningActive || Boolean(thinkingText.trim())
  const hasLiveOutput = Boolean(streamText.trim()) || hasLiveReasoning
  const hasToolActivity = tools.length > 0 || Boolean(draft)

  return (
    <Box flexDirection="column" marginBottom={1}>
      {runState && runState.phase !== 'idle' && !hasLiveOutput && (
        <RunStateLine state={runState} now={now} queuedCount={queuedCount} columns={panelColumns} t={t} />
      )}
      {hasLiveReasoning && (
        <ThinkingBlock
          trace={{
            content: thinkingText,
            isStreaming: true,
            status: 'streaming',
            startedAt: thinkingStartedAt,
            tokenCount: thinkingText.trim() ? Math.max(1, Math.ceil(thinkingText.length / 4)) : 0,
            ...(reasoningEffort ? { effort: reasoningEffort } : {}),
          } as ThinkingTrace}
          expanded={showThinking}
          streaming
          lastActivity={lastActivity}
        />
      )}
      {hasToolActivity ? (
        <ToolActivityList
          tools={tools}
          draft={draft}
          availableWidth={panelColumns}
          showOutputs={verbose}
          summarySuffix={outputTokens > 0 ? t('ui.activity.outputTokens', { count: formatTokenCount(outputTokens) }) : undefined}
        />
      ) : activity.detail && !streamText && !hasLiveReasoning ? (
        <Box>
          <Text color={theme.inactive}>{t('ui.work.label')} </Text>
          <SpinnerGlyph lastActivity={lastActivity} label={activity.detail} />
          {outputTokens > 0 && <Text color={theme.success}>{t('ui.activity.outputTokens', { count: formatTokenCount(outputTokens) })}</Text>}
        </Box>
      ) : null}
      {streamText && (
        <Box flexDirection="column" marginTop={hasToolActivity ? 1 : 0}>
          <Text color={theme.info} bold>{t('ui.work.mainAgent')}</Text>
          <Text>{formatMarkdown(streamText)}</Text>
        </Box>
      )}
    </Box>
  )
}

function RunStateLine({ state, now, queuedCount, columns, t }: { state: AgentRunState; now: number; queuedCount: number; columns: number; t: Translator }) {
  const theme = useTheme()
  const labels: Record<AgentRunState['phase'], { label: string; color: string }> = {
    idle: { label: t('ui.runState.ready'), color: theme.inactive },
    thinking: { label: t('ui.runState.planning'), color: theme.brandShimmer },
    tool_running: { label: t('ui.runState.executing'), color: theme.brand },
    awaiting_approval: { label: t('ui.runState.reviewRequired'), color: theme.warning },
    awaiting_input: { label: t('ui.runState.inputRequired'), color: theme.warning },
    paused: { label: t('ui.runState.paused'), color: theme.warning },
    aborting: { label: t('ui.runState.stopping'), color: theme.error },
    recoverable_error: { label: t('ui.runState.recovering'), color: theme.error },
    completed: { label: t('ui.runState.done'), color: theme.success },
  }
  const current = labels[state.phase]
  const elapsed = state.startedAt ? formatElapsed(Math.max(0, now - state.startedAt)) : ''
  const detail = state.detail || ''
  const fixedWidth = current.label.length + elapsed.length + (queuedCount > 0 ? 15 : 7)
  const detailWidth = Math.max(12, columns - fixedWidth)
  return (
    <Box>
      <Text color={current.color} bold>{`> ${current.label}`}</Text>
      {elapsed && <Text color={theme.inactive}>{`  ${elapsed}`}</Text>}
      {detail && <Text color={theme.text}>{`  ${cliTruncate(detail, detailWidth, { position: 'middle' })}`}</Text>}
      {queuedCount > 0 && <Text color={theme.inactive}>{`  / ${t('ui.runState.queued', { count: queuedCount })}`}</Text>}
    </Box>
  )
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function formatTokenCount(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString()
}
