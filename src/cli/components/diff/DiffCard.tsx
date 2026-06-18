import React from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../theme/index'
import { canComputeDiff, computeHunks, summarizeHunks } from '../../../core/diffCompute'
import { DiffHunks } from './DiffHunks'

export const MAX_INLINE_DIFF_RENDER_ROWS = 96

interface DiffCardProps {
  filename: string
  operation: 'write' | 'edit' | 'delete'
  before?: string
  after?: string
  addedLines?: number
  removedLines?: number
  totalLines?: number
  maxDiffRows?: number
}

export function DiffCard({
  filename,
  operation,
  before,
  after,
  addedLines,
  removedLines,
  totalLines,
  maxDiffRows = MAX_INLINE_DIFF_RENDER_ROWS,
}: DiffCardProps) {
  const theme = useTheme()

  const hasSnapshots = before !== undefined && after !== undefined
  const canRenderDiff = canComputeDiff(before, after)
  const hunks = canRenderDiff ? computeHunks(before!, after!) : []
  const stats = canRenderDiff ? summarizeHunks(hunks) : null
  const added = addedLines ?? stats?.added ?? 0
  const removed = removedLines ?? stats?.removed ?? 0

  const opLabel = operation === 'write' ? 'created' : operation === 'delete' ? 'deleted' : 'modified'
  const opColor = operation === 'write' ? theme.success : operation === 'delete' ? theme.error : theme.info

  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={0}>
      <Box>
        <Text color={opColor} bold>{operation === 'write' ? '+' : operation === 'delete' ? 'x' : '~'} </Text>
        <Text bold>{filename}</Text>
        <Text color={theme.inactive}> {opLabel}</Text>
        {(added > 0 || removed > 0) && (
          <Text> <Text color="green">+{added}</Text> <Text color="red">-{removed}</Text></Text>
        )}
        {totalLines && !added && !removed && <Text color={theme.inactive}> ({totalLines} lines)</Text>}
      </Box>

      {canRenderDiff && maxDiffRows > 0 && (
        <Box flexDirection="column" marginLeft={2} marginTop={0}>
          <DiffHunks hunks={hunks} maxLines={maxDiffRows} />
        </Box>
      )}
      {canRenderDiff && maxDiffRows <= 0 && hunks.length > 0 && (
        <Box marginLeft={2}>
          <Text color={theme.inactive}>diff collapsed: {hunks.length} hunk{hunks.length === 1 ? '' : 's'} hidden</Text>
        </Box>
      )}
      {hasSnapshots && !canRenderDiff && (
        <Box marginLeft={2}>
          <Text color={theme.inactive}>diff omitted: file snapshot is too large</Text>
        </Box>
      )}
      {!hasSnapshots && (
        <Box marginLeft={2}>
          <Text color={theme.inactive}>diff unavailable: no file snapshot captured</Text>
        </Box>
      )}
    </Box>
  )
}
