import React from 'react'
import { Box, Text } from 'ink'
import cliTruncate from 'cli-truncate'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import { useTheme } from '../../theme/index'
import { StatusIcon } from '../design-system/StatusIcon'
import { SpinnerGlyph } from '../spinner/SpinnerGlyph'
import type { StreamingToolDraft, ToolStatus } from './toolTypes'
import {
  formatDraftToolLabel,
  formatRunningToolLabel,
  formatToolDuration,
  formatToolLabel,
  getToolActivityKind,
  type ToolActivityKind,
} from './toolPresentation'
import { useI18n, type Translator } from '../../i18n/index'
import { RECOVERED_TOOL_RESULT_MESSAGE } from '../../conversations/recoveryMessages'

interface ToolActivityListProps {
  tools: ToolStatus[]
  draft?: StreamingToolDraft | null
  availableWidth?: number
  showOutputs?: boolean
  title?: string
  summarySuffix?: string
}

type ToolActivityEntry =
  | { key: string; kind: ToolActivityKind; status: 'preparing'; label: string; activityAt: number }
  | { key: string; kind: ToolActivityKind; status: ToolStatus['status']; label: string; tool: ToolStatus }

export function ToolActivityList({
  tools,
  draft,
  availableWidth,
  showOutputs = false,
  title,
  summarySuffix,
}: ToolActivityListProps) {
  const theme = useTheme()
  const { t } = useI18n()
  const { columns } = useTerminalSize()
  const width = Math.max(24, availableWidth ?? columns)
  const entries = buildEntries(tools, draft, t)
  if (entries.length === 0) return null

  const running = entries.filter(entry => entry.status === 'running' || entry.status === 'preparing').length
  const failed = entries.filter(entry => entry.status === 'error').length
  const complete = entries.length - running - failed
  const summary = [
    running > 0 ? t('ui.activity.summaryWorking', { count: running }) : '',
    complete > 0 ? t('ui.activity.summaryComplete', { count: complete }) : '',
    failed > 0 ? t('ui.activity.summaryFailed', { count: failed }) : '',
  ].filter(Boolean).join(' / ')

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.inactive}>{title ?? t('ui.activity.title')} </Text>
        <Text color={running > 0 ? theme.brand : failed > 0 ? theme.error : theme.success}>{summary}</Text>
        {summarySuffix && <Text color={theme.success}>{summarySuffix}</Text>}
      </Box>
      {entries.map((entry, index) => {
        const isLast = index === entries.length - 1
        const connector = isLast ? '`-' : '|-'
        const category = formatCategory(entry.kind)
        const labelWidth = Math.max(8, width - 21)
        const duration = entry.status === 'done' || entry.status === 'error'
          ? getDuration(entry.tool)
          : ''
        return (
          <Box key={entry.key} flexDirection="column">
            <Box>
              <Text color={theme.subtle}>{connector} </Text>
              <Text color={theme.inactive}>{category} </Text>
              {entry.status === 'preparing' ? (
                <SpinnerGlyph lastActivity={entry.activityAt} label={cliTruncate(entry.label, labelWidth, { position: 'middle' })} />
              ) : entry.status === 'running' ? (
                <SpinnerGlyph lastActivity={entry.tool.startTime} label={cliTruncate(entry.label, labelWidth, { position: 'middle' })} />
              ) : (
                <Text>
                  <StatusIcon status={entry.status === 'error' ? 'error' : 'success'} />
                  <Text>{cliTruncate(entry.label, Math.max(8, labelWidth - duration.length - 1), { position: 'middle' })}</Text>
                  {duration && <Text color={theme.inactive}> {duration}</Text>}
                </Text>
              )}
            </Box>
            {entry.status !== 'preparing' && entry.status !== 'running' && entry.tool.output && (showOutputs || entry.status === 'error') && (
              <Box paddingLeft={10}>
                <Text color={entry.status === 'error' ? theme.error : theme.inactive}>
                  {cliTruncate(firstOutputLine(entry.tool.output, t), Math.max(12, width - 12), { position: 'end' })}
                </Text>
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

function buildEntries(tools: ToolStatus[], draft: StreamingToolDraft | null | undefined, t: Translator): ToolActivityEntry[] {
  const entries: ToolActivityEntry[] = tools.map((tool, index) => ({
    key: tool.id ?? `${tool.name}-${index}`,
    kind: getToolActivityKind(tool.name),
    status: tool.status,
    label: tool.status === 'running'
      ? formatRunningToolLabel(tool, t)
      : formatToolLabel(tool.name, tool.args, t),
    tool,
  }))
  if (draft && !tools.some(tool => tool.id === draft.id)) {
    entries.push({
      key: `draft-${draft.id}`,
      kind: getToolActivityKind(draft.name),
      status: 'preparing',
      label: formatDraftToolLabel(draft, t),
      activityAt: draft.updatedAt,
    })
  }
  return entries
}

function formatCategory(kind: ToolActivityKind): string {
  return kind.toUpperCase().padEnd(5, ' ')
}

function getDuration(tool: ToolStatus): string {
  if (!tool.startTime || !tool.endTime) return ''
  return formatToolDuration(Math.max(0, tool.endTime - tool.startTime))
}

function firstOutputLine(output: string, t: Translator): string {
  const localized = output === RECOVERED_TOOL_RESULT_MESSAGE
    ? t('ui.recovery.toolResult')
    : output
  return localized.trim().split(/\r?\n/, 1)[0] || localized
}
