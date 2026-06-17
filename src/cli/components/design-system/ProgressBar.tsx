import React from 'react'
import { Text } from 'ink'
import { useTheme } from '../../theme/index'

export function ProgressBar({ ratio, width = 20 }: { ratio: number; width?: number }) {
  const theme = useTheme()
  const clamped = Math.max(0, Math.min(1, ratio))
  const filled = Math.round(clamped * width)
  const bar = '#'.repeat(filled) + '-'.repeat(width - filled)

  const color = clamped < 0.5 ? theme.success : clamped < 0.8 ? theme.warning : theme.error

  return <Text color={color}>{bar}</Text>
}
