import React from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'

export function Divider({ title, char = '-' }: { title?: string; char?: string }) {
  const theme = useTheme()
  const { columns } = useTerminalSize()
  const width = Math.max(20, columns - 2)

  if (!title) {
    return <Text color={theme.subtle}>{char.repeat(width)}</Text>
  }

  const label = ` ${title} `
  const remaining = width - label.length
  const left = Math.floor(remaining / 2)
  const right = remaining - left

  return (
    <Text color={theme.subtle}>
      {char.repeat(left)}{label}{char.repeat(right)}
    </Text>
  )
}
