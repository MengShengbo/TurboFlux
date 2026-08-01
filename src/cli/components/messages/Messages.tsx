import React from 'react'
import { Box, Text } from 'ink'
import { resolveBackground, useTheme } from '../../theme/index'
import { formatMarkdownForDisplay } from '../markdown/index'
import { ThinkingBlock } from './ThinkingBlock'
import type { ToolStatus } from '../tools/ToolCallTree'
import type { ChangeSummary, ThinkingTrace } from '../../../shared/agentTypes'
import { useI18n } from '../../i18n/index'
import { RECOVERED_ASSISTANT_MESSAGE } from '../../conversations/recoveryMessages'

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  progress?: boolean
  tools?: ToolStatus[]
  changes?: ChangeSummary[]
  interrupted?: boolean
  thinking?: ThinkingTrace
}

export function UserMessage({ content }: { content: string; key?: any }) {
  const theme = useTheme()
  return (
    <Box backgroundColor={resolveBackground(theme, 'surface')} paddingX={1}>
      <Text color={theme.brandShimmer}>{'> '}</Text>
      <Text bold>{content}</Text>
    </Box>
  )
}

export function AssistantMessage({ content, interrupted = false, thinking, showThinking = false }: { content: string; interrupted?: boolean; thinking?: ThinkingTrace; showThinking?: boolean; key?: any }) {
  const theme = useTheme()
  const { t } = useI18n()
  if (!content && !thinking) return null
  const displayContent = content === RECOVERED_ASSISTANT_MESSAGE
    ? t('ui.recovery.assistant')
    : content
  return (
    <Box flexDirection="column">
      {thinking && <ThinkingBlock trace={thinking} expanded={showThinking} streaming={thinking.isStreaming} />}
      <Text>{formatMarkdownForDisplay(displayContent)}</Text>
      {interrupted && <Text dimColor color={theme.inactive}>{t('common.interrupted')}</Text>}
    </Box>
  )
}

export function SystemMessage({ content }: { content: string; key?: any }) {
  const theme = useTheme()
  const { t } = useI18n()
  const trimmed = content.trim()
  const errorPrefix = t('common.error', { message: '' }).trim()
  const color = (/^error:/i.test(trimmed) || trimmed.startsWith(errorPrefix)) ? theme.error
    : /^(created|saved|switched|resumed|started|conversation cleared|context compaction)/i.test(trimmed) ? theme.brandShimmer
    : theme.brand
  return (
    <Box>
      <Text color={color}>{content}</Text>
    </Box>
  )
}
