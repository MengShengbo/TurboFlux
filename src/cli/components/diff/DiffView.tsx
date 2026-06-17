import React from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../theme/index'
import { canComputeDiff, computeHunks } from '../../../core/diffCompute'
import { DiffHunks } from './DiffHunks'

interface DiffViewProps {
  oldContent: string
  newContent: string
  filename?: string
}

export function DiffView({ oldContent, newContent, filename }: DiffViewProps) {
  const theme = useTheme()
  const canRenderDiff = canComputeDiff(oldContent, newContent)
  const hunks = canRenderDiff ? computeHunks(oldContent, newContent) : []

  return (
    <Box flexDirection="column" marginBottom={1}>
      {filename && <Text color={theme.inactive}>  diff: {filename}</Text>}
      {canRenderDiff
        ? <DiffHunks hunks={hunks} maxLines={80} addedColor={theme.diffAddedWord} removedColor={theme.diffRemovedWord} contextColor={theme.inactive} />
        : <Text color={theme.inactive}>  diff omitted: file snapshot is too large</Text>}
    </Box>
  )
}
