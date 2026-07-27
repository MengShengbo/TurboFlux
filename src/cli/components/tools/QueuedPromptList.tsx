import React from 'react'
import { Box, Text } from 'ink'
import cliTruncate from 'cli-truncate'
import { useTheme } from '../../theme/index'
import { useI18n } from '../../i18n/index'

export interface QueuedPromptDisplay {
  id: string
  prompt: string
  attachmentCount?: number
}

export function QueuedPromptList({ prompts, width }: { prompts: readonly QueuedPromptDisplay[]; width: number }) {
  const theme = useTheme()
  const { t } = useI18n()
  if (prompts.length === 0) return null

  const contentWidth = Math.max(12, width - 17)
  return (
    <Box flexDirection="column" marginBottom={1}>
      {prompts.map((prompt, index) => {
        const normalized = prompt.prompt.replace(/\s+/g, ' ').trim()
        const attachments = prompt.attachmentCount
          ? t(prompt.attachmentCount === 1 ? 'ui.queue.image' : 'ui.queue.images', { count: prompt.attachmentCount })
          : ''
        return (
          <Box key={prompt.id} paddingLeft={1}>
            <Text color={theme.warning}>{t('ui.queue.item', { index: index + 1 })}</Text>
            <Text color={theme.inactive}>{cliTruncate(`${normalized}${attachments}`, contentWidth, { position: 'end' })}</Text>
          </Box>
        )
      })}
    </Box>
  )
}
