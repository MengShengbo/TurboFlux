import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { useTheme } from '../theme/index'
import { useTerminalSize } from '../hooks/useTerminalSize'

export interface ConversationEntry {
  id: string
  title: string
  turnCount: number
  updatedAt: number
  isCurrent?: boolean
}

interface ConversationHistoryProps {
  conversations: ConversationEntry[]
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onCancel: () => void
}

const ACTIONS = ['Enter conversation', 'Delete conversation'] as const

export function ConversationHistory({ conversations, onSelect, onDelete, onCancel }: ConversationHistoryProps) {
  const theme = useTheme()
  const { rows } = useTerminalSize()
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [mode, setMode] = useState<'list' | 'action'>('list')
  const [actionIdx, setActionIdx] = useState(0)

  const maxVisible = Math.max(5, rows - 8)
  const viewStart = Math.max(0, Math.min(selectedIdx - Math.floor(maxVisible / 2), conversations.length - maxVisible))
  const viewEnd = Math.min(conversations.length, viewStart + maxVisible)

  useInput((ch, key) => {
    if (mode === 'action') {
      if (key.escape) {
        setMode('list')
        setActionIdx(0)
        return
      }
      if (key.return) {
        const conv = conversations[selectedIdx]
        if (!conv) return
        if (actionIdx === 0) {
          onSelect(conv.id)
        } else {
          onDelete(conv.id)
        }
        return
      }
      if (key.downArrow) setActionIdx(i => Math.min(i + 1, ACTIONS.length - 1))
      if (key.upArrow) setActionIdx(i => Math.max(i - 1, 0))
      return
    }

    if (key.escape) {
      onCancel()
      return
    }
    if (key.return) {
      if (conversations[selectedIdx]) {
        setMode('action')
        setActionIdx(0)
      }
      return
    }
    if (key.downArrow) {
      setSelectedIdx(i => Math.min(i + 1, conversations.length - 1))
    }
    if (key.upArrow) {
      setSelectedIdx(i => Math.max(i - 1, 0))
    }
  }, { isActive: isInteractive })

  if (conversations.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text color={theme.inactive}>No saved conversations. Press ESC to go back.</Text>
      </Box>
    )
  }

  if (mode === 'action') {
    const conv = conversations[selectedIdx]
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}>
          <Text bold color={theme.brandShimmer}>Conversations</Text>
          <Text color={theme.brand}> - Up/Down select, Enter confirm, Esc back</Text>
        </Box>
        <Box marginBottom={1} paddingLeft={2}>
          <Text color={theme.text}>{conv?.title.slice(0, 60)}</Text>
          <Text color={theme.inactive}> - {conv?.turnCount}t - {conv ? formatRelativeTime(conv.updatedAt) : ''}</Text>
        </Box>
        <Box flexDirection="column" paddingLeft={2}>
          {ACTIONS.map((label, i) => (
            <Box key={label}>
              <Text color={i === actionIdx ? (i === 1 ? theme.error : theme.brand) : theme.text}>
                {i === actionIdx ? '> ' : '  '}{label}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color={theme.brandShimmer}>Conversations</Text>
        <Text color={theme.brand}> - Up/Down select, Enter open, Esc back</Text>
      </Box>

      {viewStart > 0 && (
        <Box paddingLeft={2}>
          <Text dimColor>... {viewStart} more above</Text>
        </Box>
      )}

      {conversations.slice(viewStart, viewEnd).map((conv, i) => {
        const absoluteIdx = viewStart + i
        const isSelected = absoluteIdx === selectedIdx
        const date = formatRelativeTime(conv.updatedAt)
        const current = conv.isCurrent ? ' *' : ''

        return (
          <Box key={conv.id}>
            <Text color={isSelected ? theme.brand : theme.text}>
              {isSelected ? '> ' : '  '}
              {conv.title.slice(0, 50)}
            </Text>
            <Text color={isSelected ? theme.brandShimmer : theme.inactive}> {conv.turnCount}t - {date}{current}</Text>
          </Box>
        )
      })}

      {viewEnd < conversations.length && (
        <Box paddingLeft={2}>
          <Text dimColor>... {conversations.length - viewEnd} more below</Text>
        </Box>
      )}
    </Box>
  )
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
}
