import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import cliTruncate from 'cli-truncate'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import { formatMarkdownForDisplay } from '../markdown/index'
import { SpinnerGlyph } from '../spinner/SpinnerGlyph'
import type { ToolStatus } from './toolTypes'
import type { AgentRunState, ReasoningEffort, ThinkingTrace } from '../../../shared/agentTypes'
import type { ContextCompactionState } from '../../../state/types'
import { ThinkingBlock } from '../messages/ThinkingBlock'
import { deriveActivityModel } from '../agentActivityModel'
import type { StreamingToolDraft } from './toolTypes'
import { ToolActivityList } from './ToolActivityList'
import { useI18n, type Translator } from '../../i18n/index'

export type { StreamingToolDraft } from './toolTypes'

export interface ModelRequestPresentation {
  phase: 'requesting' | 'responding' | 'completed'
  startedAt: number
  elapsedMs?: number
}

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
  requestStatus?: ModelRequestPresentation | null
  compaction?: ContextCompactionState | null
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
  requestStatus,
  compaction = null,
}: ActiveWorkPanelProps) {
  const theme = useTheme()
  const { t } = useI18n()
  const { columns } = useTerminalSize()
  const panelColumns = Math.max(24, availableWidth ?? columns)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const runActive = runState && runState.phase !== 'idle' && runState.phase !== 'completed'
    const compactionActive = compaction && !['completed', 'interrupted', 'failed'].includes(compaction.phase)
    if (!runActive && requestStatus?.phase !== 'requesting' && !compactionActive) return
    const timer = setInterval(
      () => setNow(Date.now()),
      requestStatus?.phase === 'requesting' || compactionActive ? 250 : 1000,
    )
    return () => clearInterval(timer)
  }, [runState?.phase, requestStatus?.phase, compaction?.phase])

  const resolvedIdleLabel = idleLabel === undefined ? t('ui.activity.phase.thinking') : idleLabel
  const activity = deriveActivityModel({ runState, tools, draft, streamText, thinkingText, idleLabel: resolvedIdleLabel }, t)
  if (!activity.visible && !requestStatus && !compaction) return null

  const hasLiveReasoning = Boolean(thinkingText.trim()) || Boolean(reasoningActive && thinkingStartedAt !== undefined)
  const hasLiveOutput = Boolean(streamText.trim()) || hasLiveReasoning
  const hasToolActivity = tools.length > 0 || Boolean(draft)

  return (
    <Box flexDirection="column" marginBottom={1}>
      {requestStatus && !(requestStatus.phase === 'responding' && hasLiveReasoning) && (
        !compaction && <ModelRequestLine status={requestStatus} now={now} t={t} />
      )}
      {compaction && <ContextCompactionLine state={compaction} now={now} t={t} />}
      {!requestStatus && runState && runState.phase !== 'idle' && !hasLiveOutput && (
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
      ) : activity.detail && !requestStatus && !streamText && !hasLiveReasoning ? (
        <Box>
          <Text color={theme.inactive}>{t('ui.work.label')} </Text>
          <SpinnerGlyph lastActivity={lastActivity} label={activity.detail} />
          {outputTokens > 0 && <Text color={theme.success}>{t('ui.activity.outputTokens', { count: formatTokenCount(outputTokens) })}</Text>}
        </Box>
      ) : null}
      {streamText && (
        <Box flexDirection="column" marginTop={hasToolActivity ? 1 : 0}>
          <Text color={theme.info} bold>{t('ui.work.mainAgent')}</Text>
          <Text>{formatMarkdownForDisplay(streamText)}</Text>
        </Box>
      )}
    </Box>
  )
}

function ContextCompactionLine({ state, now, t }: { state: ContextCompactionState; now: number; t: Translator }) {
  const theme = useTheme()
  const terminal = state.phase === 'completed'
    ? { label: t('ui.compaction.completed'), color: theme.success }
    : state.phase === 'interrupted'
      ? { label: t('ui.compaction.interrupted'), color: theme.warning }
      : state.phase === 'failed'
        ? { label: t('ui.compaction.failed'), color: theme.error }
        : state.phase === 'fallback'
          ? { label: t('ui.compaction.fallback'), color: theme.warning }
          : state.phase === 'committing'
            ? { label: t('ui.compaction.committing'), color: theme.brand }
            : state.phase === 'summarizing'
              ? { label: t('ui.compaction.summarizing'), color: theme.brandShimmer }
              : { label: t('ui.compaction.started'), color: theme.brandShimmer }
  const elapsed = state.phase === 'completed' || state.phase === 'interrupted' || state.phase === 'failed'
    ? state.elapsedMs
    : Math.max(state.elapsedMs, now - state.startedAt)
  const progress = typeof state.progress === 'number' ? ` ${Math.round(state.progress * 100)}%` : ''
  const detail = state.error || state.detail || t('ui.compaction.detail')
  return (
    <Box>
      {state.phase !== 'completed' && state.phase !== 'interrupted' && state.phase !== 'failed'
        ? <SpinnerGlyph lastActivity={state.updatedAt} />
        : <Text color={terminal.color} bold>{state.phase === 'completed' ? '✓' : state.phase === 'failed' ? '!' : '!'}</Text>}
      <Text color={terminal.color} bold>{` ${terminal.label}`}</Text>
      <Text color={theme.inactive}>{`  ${formatElapsed(elapsed)}${progress}`}</Text>
      <Text color={theme.text}>{`  ${cliTruncate(detail, 72, { position: 'middle' })}`}</Text>
    </Box>
  )
}

function ModelRequestLine({ status, now, t }: { status: ModelRequestPresentation; now: number; t: Translator }) {
  const theme = useTheme()
  const label = status.phase === 'requesting'
    ? t('ui.request.requesting')
    : status.phase === 'responding'
      ? t('ui.request.responding')
      : t('ui.request.completed')
  const elapsedMs = status.elapsedMs ?? Math.max(0, now - status.startedAt)
  if (status.phase === 'completed') {
    return (
      <Box>
        <Text color={theme.success} bold>{`✓ ${label}`}</Text>
        <Text color={theme.inactive}>{`  · ${t('ui.request.total', { elapsed: formatRequestDuration(elapsedMs) })}`}</Text>
      </Box>
    )
  }

  const detail = status.phase === 'requesting'
    ? requestWaitHint(elapsedMs, t)
    : t('ui.request.firstResponse', { elapsed: formatRequestDuration(elapsedMs) })
  const color = status.phase === 'responding' ? theme.info : theme.brandShimmer
  return (
    <Box>
      <SpinnerGlyph />
      <Text color={color} bold>{` ${label}`}</Text>
      <Text color={theme.inactive}>{`  ${status.phase === 'requesting' ? formatLiveRequestDuration(elapsedMs) : ''}  · ${detail}`}</Text>
    </Box>
  )
}

function RunStateLine({ state, now, queuedCount, columns, t }: { state: AgentRunState; now: number; queuedCount: number; columns: number; t: Translator }) {
  const theme = useTheme()
  const labels: Record<AgentRunState['phase'], { label: string; color: string }> = {
    idle: { label: t('ui.runState.ready'), color: theme.inactive },
    thinking: { label: t('ui.runState.planning'), color: theme.brandShimmer },
    compacting: { label: t('ui.runState.compacting'), color: theme.brandShimmer },
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

function formatRequestDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`
}

function formatLiveRequestDuration(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  return formatElapsed(ms)
}

function requestWaitHint(ms: number, t: Translator): string {
  if (ms >= 30_000) return t('ui.request.slow')
  if (ms >= 10_000) return t('ui.request.stillWaiting')
  return t('ui.request.awaitingFirstResponse')
}

function formatTokenCount(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString()
}
