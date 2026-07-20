import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import cliTruncate from 'cli-truncate'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import type { ModelPreset } from '../../../core/config'

interface Props {
  currentModel?: string
  models: ModelPreset[]
  isRefreshing?: boolean
  stale?: boolean
  error?: string
  onRefresh: () => void
  onSelect: (preset: ModelPreset) => void
  onCancel: () => void
}

const MAX_VISIBLE_MODELS = 10

function formatTokens(value?: number): string {
  if (!value) return '?'
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`
  return String(value)
}

export function capabilitySummary(model: ModelPreset): string {
  const values = [
    `ctx ${formatTokens(model.contextWindow)}`,
    `out ${formatTokens(model.maxOutputTokens)}`,
    model.capabilities?.tools ? 'tools' : null,
    model.capabilities?.vision ? 'vision' : null,
    model.capabilities?.reasoning ? 'reasoning' : null,
  ].filter(Boolean)
  return values.join('  ')
}

export function formatModelPickerLine(model: ModelPreset, width: number): string {
  return cliTruncate(`${model.model}  ${capabilitySummary(model)}`, Math.max(12, width), { position: 'end' })
}

export function ModelPicker({
  currentModel,
  models,
  isRefreshing = false,
  stale = false,
  error,
  onRefresh,
  onSelect,
  onCancel,
}: Props) {
  const theme = useTheme()
  const { columns } = useTerminalSize()
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return models
    return models.filter(model => [model.name, model.model, model.provider, model.description]
      .some(value => value.toLowerCase().includes(normalized)))
  }, [models, query])
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    if (query) {
      setSelected(0)
      return
    }
    setSelected(Math.max(0, filtered.findIndex(model => model.model === currentModel)))
  }, [currentModel, models, query])

  useEffect(() => {
    setSelected(index => Math.max(0, Math.min(index, filtered.length - 1)))
  }, [filtered.length])

  useInput((input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.ctrl && input.toLowerCase() === 'r') {
      onRefresh()
      return
    }
    if (key.return) {
      const model = filtered[selected]
      if (model) onSelect(model)
      return
    }
    if (key.upArrow) {
      setSelected(index => Math.max(0, index - 1))
      return
    }
    if (key.downArrow) {
      setSelected(index => Math.min(filtered.length - 1, index + 1))
      return
    }
    if (key.backspace || key.delete) {
      setQuery(value => value.slice(0, -1))
      return
    }
    if (!key.ctrl && input && !/[\u0000-\u001F\u007F]/.test(input)) {
      setQuery(value => `${value}${input}`)
    }
  }, { isActive: isInteractive })

  const start = Math.max(0, Math.min(selected - Math.floor(MAX_VISIBLE_MODELS / 2), filtered.length - MAX_VISIBLE_MODELS))
  const visible = filtered.slice(start, start + MAX_VISIBLE_MODELS)

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor={theme.brand} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={theme.brand}>Models</Text>
        <Text color={isRefreshing ? theme.brandShimmer : stale ? theme.warning : theme.inactive}>
          {isRefreshing ? 'refreshing' : stale ? 'cached' : `${models.length} available`}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.inactive}>Search  </Text>
        <Text color={query ? theme.text : theme.inactive}>{query || 'type to filter'}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {visible.map((model, visibleIndex) => {
          const index = start + visibleIndex
          const isSelected = index === selected
          const isCurrent = currentModel === model.model || currentModel === model.id
          return (
            <Box key={`${model.baseUrl}:${model.model}`}>
              <Box width={2}><Text color={theme.brand} bold={isSelected}>{isSelected ? '> ' : '  '}</Text></Box>
              <Text color={isSelected ? theme.text : theme.inactive} bold={isSelected} dimColor={!isSelected}>
                {formatModelPickerLine(model, columns - 8)}{isCurrent ? <Text color={theme.success}> *</Text> : null}
              </Text>
            </Box>
          )
        })}
        {filtered.length === 0 ? <Text color={theme.inactive}>No matching chat models.</Text> : null}
      </Box>
      {error ? <Box marginTop={1}><Text color={theme.warning} wrap="truncate-end">{error}</Text></Box> : null}
      <Box marginTop={1} justifyContent="space-between">
        <Text color={theme.inactive}>Up/Down select  Enter apply  Esc close</Text>
        <Text color={theme.inactive}>Ctrl+R refresh</Text>
      </Box>
    </Box>
  )
}
