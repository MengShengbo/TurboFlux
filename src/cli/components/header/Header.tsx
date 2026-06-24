import React from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import { getSafeFrameWidth } from '../../terminalLayout'
import { renderLogo, type MascotMood } from './Mascot'

interface HeaderProps {
  workspaceName: string
  model: string
  mood: MascotMood
  hasApiKey: boolean
}

export function Header({ workspaceName, model, mood, hasApiKey }: HeaderProps) {
  const theme = useTheme()
  const { columns } = useTerminalSize()

  const frame = 0
  const lines = renderLogo(mood, frame)
  const moodColor = mood === 'error' ? theme.error
    : mood === 'thinking' ? theme.brandShimmer
    : mood === 'happy' ? theme.success
    : theme.brand

  const leftWidth = 24
  const isNarrow = columns < 60
  const frameWidth = getSafeFrameWidth(columns)
  const sessionLabel = mood === 'error'
    ? 'Attention needed'
    : mood === 'thinking'
      ? 'Thinking'
      : mood === 'happy'
        ? 'Response ready'
        : 'Session live'

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box
        flexDirection={isNarrow ? 'column' : 'row'}
        borderStyle="round"
        borderColor={theme.brand}
        paddingX={1}
        paddingY={1}
        gap={isNarrow ? 0 : 1}
        width={frameWidth}
      >
        <Box flexDirection="column" width={isNarrow ? undefined : leftWidth} alignItems="center" justifyContent="center">
          <Box flexDirection="column">
            {lines.map((line, i) => (
              <Box key={i}><Text color={moodColor}>{line}</Text></Box>
            ))}
          </Box>
          <Box flexDirection="column" alignItems="center">
            <Text bold color={theme.brand}>TurboFlux</Text>
            <Text color={theme.inactive}>v0.1.1</Text>
            {model ? <Text color={theme.statusLine}>{fitModelLabel(model)}</Text> : null}
          </Box>
        </Box>

        {/* Vertical divider */}
        {!isNarrow && (
          <Box
            borderStyle="single"
            borderColor={theme.brand}
            borderTop={false}
            borderBottom={false}
            borderLeft={false}
            borderRight={true}
          />
        )}

        <Box flexDirection="column" paddingLeft={isNarrow ? 0 : 1} justifyContent="center" flexGrow={1}>
          <Box flexDirection="column" marginBottom={1}>
            <Box marginBottom={1}><Text bold color={theme.brandShimmer}>TurboFlux Workbench</Text></Box>
            <Text color={theme.text}>Attached to {workspaceName || 'current workspace'}.</Text>
          </Box>
          <Box flexDirection="column">
            <Box marginBottom={1}><Text bold color={theme.brand}>{sessionLabel}</Text></Box>
            <Text color={theme.text}>Search, inspect, edit, and resume work without leaving the terminal.</Text>
          </Box>
        </Box>
      </Box>

      {!hasApiKey && (
        <Box paddingLeft={1} height={1}>
          <Text color={theme.brandShimmer}>No model provider configured. Run turboflux setup to connect one.</Text>
        </Box>
      )}
    </Box>
  )
}

function fitModelLabel(model: string): string {
  return model.length > 22 ? `${model.slice(0, 19)}...` : model
}
