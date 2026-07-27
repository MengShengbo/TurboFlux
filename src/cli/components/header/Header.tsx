import React from 'react'
import { Box, Text } from 'ink'
import cliTruncate from 'cli-truncate'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import { centerText, centerTextBlock, revealTextBlock, shouldUseCompactWordmark, TURBOFLUX_COMPACT_MARK, TURBOFLUX_VERSION, TURBOFLUX_WORDMARK_LINES } from '../../brand'
import { getSafeFrameWidth } from '../../terminalLayout'
import type { MascotMood } from './Mascot'
import { useI18n } from '../../i18n/index'

interface HeaderProps {
  workspacePath: string
  mood: MascotMood
  hasApiKey: boolean
  width?: number
  showConnector?: boolean
  logoReveal?: number
  showVersion?: boolean
  showWorkspace?: boolean
}

export function Header({
  workspacePath,
  mood,
  hasApiKey,
  width: requestedWidth,
  showConnector = false,
  logoReveal = 1,
  showVersion = true,
  showWorkspace = true,
}: HeaderProps) {
  const theme = useTheme()
  const { t } = useI18n()
  const { columns, rows } = useTerminalSize()
  const compact = shouldUseCompactWordmark(columns, rows)
  const width = Math.max(24, Math.min(requestedWidth ?? getSafeFrameWidth(columns, 3), getSafeFrameWidth(columns, 3)))
  const workspaceLabel = t('ui.header.workspace', { path: workspacePath })
  const path = cliTruncate(workspaceLabel, Math.max(20, width), { position: 'middle' })
  const wordmarkSource = compact ? [TURBOFLUX_COMPACT_MARK] : TURBOFLUX_WORDMARK_LINES
  const revealedWordmark = revealTextBlock(wordmarkSource, logoReveal)
  const wordmark = compact
    ? [centerText(revealedWordmark[0] ?? '', width)]
    : centerTextBlock(revealedWordmark, width)
  const moodColor = mood === 'error' ? theme.error : theme.brand

  return (
    <Box flexDirection="column" marginBottom={1} flexShrink={0} width={width}>
      {wordmark.map((line, index) => (
        <Text key={index} color={index === wordmark.length - 1 ? theme.brand : moodColor} bold>{line}</Text>
      ))}
      <Text color={theme.brandShimmer} bold>{centerText(showVersion ? `v${TURBOFLUX_VERSION}` : ' ', width)}</Text>
      {showConnector && <Text color={theme.info}>{centerText(showVersion ? '├────────────┤' : ' ', width)}</Text>}
      <Text color={theme.inactive}>{centerText(showWorkspace ? path : ' ', width)}</Text>
      {!hasApiKey && <Text color={theme.warning}>{centerText(showWorkspace ? t('ui.header.setupRequired') : ' ', width)}</Text>}
    </Box>
  )
}
