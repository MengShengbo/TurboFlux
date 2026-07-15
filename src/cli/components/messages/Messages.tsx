import React from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../theme/index'
import { formatMarkdown } from '../markdown/index'
import type { ToolStatus } from '../tools/ToolCallTree'
import type { ChangeSummary } from '../../../shared/agentTypes'

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  tools?: ToolStatus[]
  changes?: ChangeSummary[]
}

export function UserMessage({ content }: { content: string; key?: any }) {
  const theme = useTheme()
  return (
    <Box backgroundColor={theme.surface} paddingX={1}>
      <Text color={theme.brand}>{'> '}</Text>
      <Text bold>{content}</Text>
    </Box>
  )
}

export function AssistantMessage({ content }: { content: string; key?: any }) {
  if (!content) return null
  return (
    <Box>
      <Text>{formatMarkdown(content)}</Text>
    </Box>
  )
}

export function SystemMessage({ content }: { content: string; key?: any }) {
  const theme = useTheme()
  const trimmed = content.trim()
  const color = /^error:/i.test(trimmed) ? theme.error
    : /^(created|saved|switched|resumed|started|conversation cleared|context compaction)/i.test(trimmed) ? theme.brandShimmer
    : theme.brand
  return (
    <Box>
      <Text color={color}>{content}</Text>
    </Box>
  )
}
