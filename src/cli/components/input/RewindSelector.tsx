import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import figures from 'figures'
import type { Message } from '../messages/Messages'

interface Props {
  messages: Message[]
  onRewind: (index: number) => void
  onCancel: () => void
}

export function RewindSelector({ messages, onRewind, onCancel }: Props) {
  const theme = useTheme()
  const { rows } = useTerminalSize()
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const userIndices = messages
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.role === 'user')

  const [selected, setSelected] = useState(Math.max(0, userIndices.length - 1))

  const maxVisible = Math.max(5, rows - 8)
  const viewStart = Math.max(0, Math.min(selected - Math.floor(maxVisible / 2), userIndices.length - maxVisible))
  const viewEnd = Math.min(userIndices.length, viewStart + maxVisible)

  useInput((_, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.return) {
      const target = userIndices[selected]
      if (target) onRewind(target.i)
      return
    }
    if (key.upArrow) {
      setSelected(s => Math.max(0, s - 1))
    }
    if (key.downArrow) {
      setSelected(s => Math.min(userIndices.length - 1, s + 1))
    }
  }, { isActive: isInteractive })

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={theme.brand}>Rewind conversation</Text>
      <Text dimColor>Restore to before a message:</Text>

      {viewStart > 0 && (
        <Box marginTop={1} paddingLeft={2}>
          <Text dimColor>↑ {viewStart} more above</Text>
        </Box>
      )}

      <Box flexDirection="column" marginTop={viewStart === 0 ? 1 : 0}>
        {userIndices.slice(viewStart, viewEnd).map(({ m }, idx) => {
          const absoluteIdx = viewStart + idx
          const isSelected = absoluteIdx === selected
          const preview = m.content.slice(0, 60).replace(/\n/g, ' ')
          return (
            <Box key={m.id} flexDirection="row">
              <Box width={2}>
                {isSelected ? (
                  <Text color={theme.brand} bold>{figures.pointer} </Text>
                ) : (
                  <Text>  </Text>
                )}
              </Box>
              <Text color={isSelected ? theme.text : theme.inactive} dimColor={!isSelected}>
                {preview || '(empty)'}
              </Text>
            </Box>
          )
        })}
      </Box>

      {viewEnd < userIndices.length && (
        <Box paddingLeft={2}>
          <Text dimColor>↓ {userIndices.length - viewEnd} more below</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>Up/Down navigate - Enter rewind - Esc cancel</Text>
      </Box>
    </Box>
  )
}
