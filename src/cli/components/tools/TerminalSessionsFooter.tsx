import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import cliTruncate from 'cli-truncate'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import type { TerminalSessionInfo } from '../../../shared/terminalTypes'
import { useI18n } from '../../i18n/index'

interface TerminalSessionsFooterProps {
  sessions: TerminalSessionInfo[]
}

export function TerminalSessionsFooter({ sessions }: TerminalSessionsFooterProps) {
  const theme = useTheme()
  const { t } = useI18n()
  const { columns } = useTerminalSize()
  const [, setTick] = useState(0)
  const active = sessions.filter(session => session.status === 'running' || session.status === 'starting')
  useEffect(() => {
    if (active.length === 0) return
    const timer = setInterval(() => setTick(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [active.length])
  if (active.length === 0) return null

  const latest = active[active.length - 1]
  const elapsed = formatDuration(Date.now() - latest.createdAt)
  const text = t('ui.terminal.background', { count: active.length, duration: elapsed, title: latest.title || latest.shell })

  return (
    <Box flexShrink={0}>
      <Text color={theme.inactive}>{cliTruncate(text, Math.max(20, columns - 2), { position: 'middle' })}</Text>
    </Box>
  )
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}
