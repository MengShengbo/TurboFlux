import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { useTheme } from '../theme/index'
import { useTerminalSize } from '../hooks/useTerminalSize'
import { useI18n, type Translator } from '../i18n/index'

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

export function ConversationHistory({ conversations, onSelect, onDelete, onCancel }: ConversationHistoryProps) {
  const theme = useTheme()
  const { t, locale } = useI18n()
  const { rows } = useTerminalSize()
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [mode, setMode] = useState<'list' | 'action'>('list')
  const [actionIdx, setActionIdx] = useState(0)
  const selectedConversation = conversations[selectedIdx]
  const actions = selectedConversation?.isCurrent
    ? [t('ui.conversations.enter')]
    : [t('ui.conversations.enter'), t('ui.conversations.delete')]

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
        } else if (!conv.isCurrent) {
          onDelete(conv.id)
        }
        return
      }
      if (key.downArrow) setActionIdx(i => Math.min(i + 1, actions.length - 1))
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
        <Text color={theme.inactive}>{t('ui.conversations.none')}</Text>
      </Box>
    )
  }

  if (mode === 'action') {
    const conv = selectedConversation
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}>
          <Text bold color={theme.brandShimmer}>{t('ui.conversations.title')}</Text>
          <Text color={theme.brand}>{t('ui.conversations.selectKeys')}</Text>
        </Box>
        <Box marginBottom={1} paddingLeft={2}>
          <Text color={theme.text}>{conv?.title.slice(0, 60)}</Text>
          <Text color={theme.inactive}> - {conv?.turnCount}t - {conv ? formatRelativeTime(conv.updatedAt, t, locale) : ''}</Text>
        </Box>
        <Box flexDirection="column" paddingLeft={2}>
          {actions.map((label, i) => (
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
        <Text bold color={theme.brandShimmer}>{t('ui.conversations.title')}</Text>
        <Text color={theme.brand}>{t('ui.conversations.openKeys')}</Text>
      </Box>

      {viewStart > 0 && (
        <Box paddingLeft={2}>
          <Text dimColor>{t('common.moreAbove', { count: viewStart })}</Text>
        </Box>
      )}

      {conversations.slice(viewStart, viewEnd).map((conv, i) => {
        const absoluteIdx = viewStart + i
        const isSelected = absoluteIdx === selectedIdx
        const date = formatRelativeTime(conv.updatedAt, t, locale)
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
          <Text dimColor>{t('common.moreBelow', { count: conversations.length - viewEnd })}</Text>
        </Box>
      )}
    </Box>
  )
}

function formatRelativeTime(timestamp: number, t: Translator, locale: 'zh-CN' | 'en'): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return t('ui.conversations.justNow')
  if (minutes < 60) return t('ui.conversations.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('ui.conversations.hoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  if (days < 7) return t('ui.conversations.daysAgo', { count: days })
  return new Date(timestamp).toLocaleDateString(locale)
}
