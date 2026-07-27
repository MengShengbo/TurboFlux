import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import { useTheme } from '../../theme/index'
import { canComputeDiff, computeHunks, summarizeHunks } from '../../../core/diffCompute'
import { DiffHunks } from './DiffHunks'
import { useI18n } from '../../i18n/index'

interface InteractiveDiffProps {
  oldContent: string
  newContent: string
  filename: string
  onAccept: () => void
  onReject: () => void
}

export function InteractiveDiff({ oldContent, newContent, filename, onAccept, onReject }: InteractiveDiffProps) {
  const theme = useTheme()
  const { t } = useI18n()
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
          <Text color={theme.diffAddedWord}>+{addedLines}</Text>
          <Text> </Text>
          <Text color={theme.diffRemovedWord}>-{removedLines}</Text>
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {canRenderDiff
          ? <DiffHunks hunks={hunks} maxLines={20} />
          : <Text dimColor>{t('ui.diff.tooLarge')}</Text>}
      </Box>

      {!decided && (
        <Box marginTop={1}>
          <Text bold color={theme.brand}>{t('ui.diff.apply')} </Text>
          <Text color={theme.success}>{t('ui.diff.yes')}</Text>
          <Text> / </Text>
          <Text color={theme.error}>{t('ui.diff.no')}</Text>
        </Box>
      )}
      {decided === 'accepted' && <Text color={theme.success} bold>{t('ui.diff.accepted')}</Text>}
      {decided === 'rejected' && <Text color={theme.error} bold>{t('ui.diff.rejected')}</Text>}
    </Box>
  )
}
