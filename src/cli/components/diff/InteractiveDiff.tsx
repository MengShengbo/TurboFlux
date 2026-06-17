import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import { useTheme } from '../../theme/index'
import { canComputeDiff, computeHunks, summarizeHunks } from '../../../core/diffCompute'
import { DiffHunks } from './DiffHunks'

interface InteractiveDiffProps {
  oldContent: string
  newContent: string
  filename: string
  onAccept: () => void
  onReject: () => void
}

export function InteractiveDiff({ oldContent, newContent, filename, onAccept, onReject }: InteractiveDiffProps) {
  const theme = useTheme()
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const [decided, setDecided] = useState<'accepted' | 'rejected' | null>(null)
  const canRenderDiff = canComputeDiff(oldContent, newContent)
  const hunks = canRenderDiff ? computeHunks(oldContent, newContent) : []
  const stats = canRenderDiff ? summarizeHunks(hunks) : null

  const addedLines = stats?.added ?? 0
  const removedLines = stats?.removed ?? 0

  useInput(useCallback((ch: string) => {
    if (decided) return
    if (ch === 'y' || ch === 'Y') {
      setDecided('accepted')
      onAccept()
    } else if (ch === 'n' || ch === 'N') {
      setDecided('rejected')
      onReject()
    }
  }, [decided, onAccept, onReject]), { isActive: isInteractive })

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.brand} paddingX={1} marginBottom={1}>
      <Box justifyContent="space-between">
        <Text bold color={theme.brand}>{filename}</Text>
        <Text>
          <Text color="green">+{addedLines}</Text>
          <Text> </Text>
          <Text color="red">-{removedLines}</Text>
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {canRenderDiff
          ? <DiffHunks hunks={hunks} maxLines={20} />
          : <Text dimColor>diff omitted: file snapshot is too large</Text>}
      </Box>

      {!decided && (
        <Box marginTop={1}>
          <Text bold color={theme.brand}>Apply this change? </Text>
          <Text color="green">[y]es</Text>
          <Text> / </Text>
          <Text color="red">[n]o</Text>
        </Box>
      )}
      {decided === 'accepted' && <Text color="green" bold>Change accepted.</Text>}
      {decided === 'rejected' && <Text color="red" bold>Change rejected.</Text>}
    </Box>
  )
}
