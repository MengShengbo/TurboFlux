import React from 'react'
import { Box, Text } from 'ink'
import cliTruncate from 'cli-truncate'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import { centerText, centerTextBlock, revealTextBlock, shouldUseCompactWordmark, TURBOFLUX_COMPACT_MARK, TURBOFLUX_VERSION, TURBOFLUX_WORDMARK_LINES } from '../../brand'
import { getSafeFrameWidth } from '../../terminalLayout'
import type { MascotMood } from './Mascot'

interface HeaderProps {
  workspacePath: string
  mood: MascotMood
  hasApiKey: boolean
  logoReveal?: number
  showVersion?: boolean
  showWorkspace?: boolean
}

export function Header({
  workspacePath,
  mood,
  hasApiKey,
  logoReveal = 1,
  showVersion = true,
  showWorkspace = true,
}: HeaderProps) {
  const theme = useTheme()
  const { columns, rows } = useTerminalSize()
  const compact = shouldUseCompactWordmark(columns, rows)
  const width = getSafeFrameWidth(columns, 3)
  const workspaceLabel = `workspace ${workspacePath}`
  const path = cliTruncate(workspaceLabel, Math.max(20, width), { position: 'middle' })
  const wordmarkSource = compact ? [TURBOFLUX_COMPACT_MARK] : TURBOFLUX_WORDMARK_LINES
  const revealedWordmark = revealTextBlock(wordmarkSource, logoReveal)
  const wordmark = compact
    ? [centerText(revealedWordmark[0] ?? '', width)]
    : centerTextBlock(revealedWordmark, width)
  const moodColor = mood === 'error' ? theme.error
    : mood === 'thinking' ? theme.brandShimmer
    : mood === 'happy' ? theme.success
    : theme.brand

  return (
    <Box flexDirection="column" marginBottom={1} flexShrink={0} width={width}>
      {wordmark.map((line, index) => (
        <Text key={index} color={index === wordmark.length - 1 ? theme.brand : moodColor} bold>{line}</Text>
      ))}
      <Text color={theme.brandShimmer} bold>{centerText(showVersion ? `v${TURBOFLUX_VERSION}` : ' ', width)}</Text>
      <Text color={theme.inactive}>{centerText(showWorkspace ? path : ' ', width)}</Text>
      {!hasApiKey && <Text color={theme.warning}>{centerText(showWorkspace ? 'setup required' : ' ', width)}</Text>}
    </Box>
  )
}
