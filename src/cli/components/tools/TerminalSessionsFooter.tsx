import React from 'react'
import { Box, Text } from 'ink'
import cliTruncate from 'cli-truncate'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import type { TerminalSessionInfo } from '../../../shared/terminalTypes'

interface TerminalSessionsFooterProps {
  sessions: TerminalSessionInfo[]
}

export function TerminalSessionsFooter({ sessions }: TerminalSessionsFooterProps) {
  const theme = useTheme()
  const { columns } = useTerminalSize()
  const active = sessions.filter(session => session.status === 'running' || session.status === 'starting')
  if (active.length === 0) return null

  const latest = active[active.length - 1]
  const plural = active.length === 1 ? '' : 's'
  const command = latest?.title && latest.title !== latest.shell ? ` - ${latest.title}` : ''
  const text = `${active.length} background terminal${plural} running${command} - use list_terminals to view, kill_terminal to stop`

  return (
    <Box flexShrink={0}>
      <Text color={theme.inactive}>{cliTruncate(text, Math.max(20, columns - 2), { position: 'middle' })}</Text>
    </Box>
  )
}
