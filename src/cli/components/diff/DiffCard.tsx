import React, { useMemo } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../theme/index'
import { canComputeDiff, computeHunks, MAX_DIFF_INPUT_BYTES, MAX_DIFF_INPUT_LINES, summarizeHunks } from '../../../core/diffCompute'
import { DiffHunks } from './DiffHunks'
import { useI18n } from '../../i18n/index'

interface DiffCardProps {
  filename: string
  operation: 'write' | 'edit' | 'delete'
  before?: string
  after?: string
  addedLines?: number
  removedLines?: number
  totalLines?: number
  maxDiffRows?: number
  availableWidth?: number
  diffStatus?: 'complete' | 'snapshot-too-large' | 'postimage-unavailable'
  beforeBytes?: number
  afterBytes?: number
}

export function DiffCard({
  filename,
  operation,
  before,
  after,
  addedLines,
  removedLines,
  totalLines,
  maxDiffRows,
  availableWidth,
  diffStatus,
  beforeBytes,
  afterBytes,
}: DiffCardProps) {
  const theme = useTheme()
  const { t } = useI18n()

  const hasSnapshots = before !== undefined && after !== undefined
  const canRenderDiff = canComputeDiff(before, after)
  const hunks = useMemo(
    () => canRenderDiff ? computeHunks(before!, after!) : [],
    [after, before, canRenderDiff],
  )
  const stats = useMemo(
    () => canRenderDiff ? summarizeHunks(hunks) : null,
    [canRenderDiff, hunks],
  )
  const added = addedLines ?? stats?.added ?? 0
  const removed = removedLines ?? stats?.removed ?? 0

  const opLabel = t(operation === 'write' ? 'ui.diff.created' : operation === 'delete' ? 'ui.diff.deleted' : 'ui.diff.modified')
  const opColor = operation === 'write' ? theme.success : operation === 'delete' ? theme.error : theme.info

  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={0}>
      <Box>
        <Text color={opColor} bold>{operation === 'write' ? '+' : operation === 'delete' ? 'x' : '~'} </Text>
        <Text bold>{filename}</Text>
        <Text color={theme.inactive}> {opLabel}</Text>
        {(added > 0 || removed > 0) && (
          <Text> <Text color={theme.diffAddedWord}>+{added}</Text> <Text color={theme.diffRemovedWord}>-{removed}</Text></Text>
        )}
        {totalLines && !added && !removed && <Text color={theme.inactive}> ({t('ui.diff.lines', { count: totalLines })})</Text>}
      </Box>

      {canRenderDiff && hunks.length > 0 && (
        <Box flexDirection="column" marginLeft={2} marginTop={0}>
          <DiffHunks
            hunks={hunks}
            maxLines={maxDiffRows && maxDiffRows > 0 ? maxDiffRows : undefined}
            availableWidth={availableWidth ? Math.max(24, availableWidth - 4) : undefined}
          />
        </Box>
      )}
      {diffStatus === 'snapshot-too-large' && (
        <Box marginLeft={2}>
          <Text color={theme.warning}>
            {t('ui.diff.limit', { before: formatBytes(beforeBytes, t('ui.diff.unknownSize')), after: formatBytes(afterBytes, t('ui.diff.unknownSize')), limit: formatBytes(MAX_DIFF_INPUT_BYTES, t('ui.diff.unknownSize')), lines: MAX_DIFF_INPUT_LINES })}
          </Text>
        </Box>
      )}
      {diffStatus === 'postimage-unavailable' && (
        <Box marginLeft={2}>
          <Text color={theme.warning}>{t('ui.diff.unavailableRead')}</Text>
        </Box>
      )}
      {diffStatus !== 'snapshot-too-large' && hasSnapshots && !canRenderDiff && (
        <Box marginLeft={2}>
          <Text color={theme.inactive}>{t('ui.diff.tooLarge')}</Text>
        </Box>
      )}
      {!hasSnapshots && !diffStatus && (
        <Box marginLeft={2}>
          <Text color={theme.inactive}>{t('ui.diff.noSnapshot')}</Text>
        </Box>
      )}
    </Box>
  )
}

function formatBytes(bytes: number | undefined, unknown: string): string {
  if (bytes === undefined) return unknown
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
