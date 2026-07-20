import React, { useEffect, useState } from 'react'
import cliTruncate from 'cli-truncate'
import { Box, Text } from 'ink'
import { useTheme } from '../../theme/index'
import { formatMarkdown } from '../markdown/index'
import { SpinnerGlyph } from '../spinner/SpinnerGlyph'
import type { ThinkingTrace } from '../../../shared/agentTypes'

interface ThinkingBlockProps {
  trace: ThinkingTrace
  expanded: boolean
  streaming?: boolean
  lastActivity?: number
}

export function ThinkingBlock({ trace, expanded, streaming = false, lastActivity }: ThinkingBlockProps) {
  const theme = useTheme()
  const [now, setNow] = useState(Date.now())
  const startedAt = trace.startedAt ?? 0
  const duration = trace.durationMs ?? (streaming && startedAt > 0 ? now - startedAt : undefined)
  const tokenCount = trace.tokenCount ?? estimateThinkingTokens(trace.content)

  useEffect(() => {
    if (!streaming) return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [streaming])

  const label = streaming ? 'Reasoning' : 'Thought'
  const durationLabel = typeof duration === 'number' ? ` · ${formatDuration(duration)}` : ''
  const tokenLabel = tokenCount > 0 ? ` · ${formatTokenCount(tokenCount)} tokens` : ''
  const effortLabel = trace.effort ? ` · ${trace.effort}` : ''
  const summary = `${label}${effortLabel}${durationLabel}${tokenLabel}`
  const displayContent = cliTruncate(
    trace.content.trim(),
    streaming ? 1600 : 6000,
    { position: streaming ? 'start' : 'end' },
  )

  if (!expanded) {
    return (
      <Box>
        {streaming ? (
          <SpinnerGlyph lastActivity={lastActivity ?? startedAt} label={summary} />
        ) : (
          <Text color={trace.status === 'interrupted' ? theme.warning : theme.inactive}>{`▸ ${summary}${trace.status === 'interrupted' ? ' · interrupted' : ''}`}</Text>
        )}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={streaming ? theme.brand : theme.subtle} paddingX={1} marginBottom={1}>
      <Box>
        {streaming ? (
          <SpinnerGlyph lastActivity={lastActivity ?? startedAt} label={summary} />
        ) : (
          <Text color={trace.status === 'interrupted' ? theme.warning : theme.inactive}>{`▾ ${summary}${trace.status === 'interrupted' ? ' · interrupted' : ''}`}</Text>
        )}
      </Box>
      {displayContent && (
        <Box paddingLeft={2} marginTop={1}>
          <Text color={theme.inactive}>{formatMarkdown(displayContent)}</Text>
        </Box>
      )}
    </Box>
  )
}

function estimateThinkingTokens(content: string): number {
  return content.trim() ? Math.max(1, Math.ceil(content.length / 4)) : 0
}

function formatTokenCount(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`
  return String(value)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`
}
