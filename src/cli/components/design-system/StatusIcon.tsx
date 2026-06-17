import React from 'react'
import { Text } from 'ink'
import { useTheme } from '../../theme/index'

export type StatusType = 'success' | 'error' | 'warning' | 'info' | 'pending' | 'loading'

const ICONS: Record<StatusType, string> = {
  success: 'ok',
  error: 'err',
  warning: 'warn',
  info: 'info',
  pending: '...',
  loading: '...',
}

export function StatusIcon({ status, trailing = true }: { status: StatusType; trailing?: boolean }) {
  const theme = useTheme()
  const icon = ICONS[status]

  const colorMap: Record<StatusType, string> = {
    success: theme.success,
    error: theme.error,
    warning: theme.warning,
    info: theme.info,
    pending: theme.inactive,
    loading: theme.inactive,
  }

  return <Text color={colorMap[status]}>{icon}{trailing ? ' ' : ''}</Text>
}
