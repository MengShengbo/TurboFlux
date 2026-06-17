import React from 'react'
import { Text } from 'ink'
import { useTheme } from '../../theme/index'

interface Shortcut {
  key: string
  label: string
}

export function KeyboardHint({ shortcuts }: { shortcuts: Shortcut[] }) {
  const theme = useTheme()

  return (
    <Text color={theme.inactive}>
      {'  '}
      {shortcuts.map((s, i) => {
        const prefix = i > 0 ? ' - ' : ''
        return `${prefix}[${s.key}] ${s.label}`
      }).join('')}
    </Text>
  )
}
