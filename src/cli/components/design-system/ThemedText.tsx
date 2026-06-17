import React from 'react'
import { Text } from 'ink'
import { useTheme } from '../../theme/index'
import type { Theme } from '../../theme/types'

interface ThemedTextProps {
  color?: keyof Theme
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dim?: boolean
  children: React.ReactNode
}

export function ThemedText({ color, bold, italic, underline, dim, children }: ThemedTextProps) {
  const theme = useTheme()
  const resolvedColor = color ? theme[color] : undefined

  return (
    <Text
      color={resolvedColor}
      bold={bold}
      italic={italic}
      underline={underline}
      dimColor={dim}
    >
      {children}
    </Text>
  )
}
