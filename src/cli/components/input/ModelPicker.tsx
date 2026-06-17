import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { useTheme } from '../../theme/index'
import type { ModelPreset } from '../../../core/config'

interface Props {
  currentModel?: string
  models: ModelPreset[]
  onSelect: (preset: ModelPreset) => void
  onCancel: () => void
}

export function ModelPicker({ currentModel, models, onSelect, onCancel }: Props) {
  const theme = useTheme()
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const options = models.map(p => ({
    id: p.id,
    label: p.name,
    description: p.description,
    model: p.model,
    provider: p.provider,
    baseUrl: p.baseUrl,
    contextWindow: p.contextWindow,
    maxTokens: p.maxTokens,
  }))

  const initialIndex = Math.max(
    0,
    options.findIndex(o => o.model === currentModel || o.id === currentModel)
  )
  const [selected, setSelected] = useState(initialIndex)

  useInput((_, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.return) {
      const opt = options[selected]
      if (opt) onSelect({
        id: opt.id,
        name: opt.label,
        description: opt.description,
        model: opt.model,
        provider: opt.provider,
        baseUrl: opt.baseUrl,
        contextWindow: opt.contextWindow,
        maxTokens: opt.maxTokens,
      })
      return
    }
    if (key.upArrow) {
      setSelected(s => Math.max(0, s - 1))
    }
    if (key.downArrow) {
      setSelected(s => Math.min(options.length - 1, s + 1))
    }
  }, { isActive: isInteractive })

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={theme.brand}>Select model</Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map((opt, idx) => {
          const isSelected = idx === selected
          return (
            <Box key={opt.id} flexDirection="row">
              <Box width={2}>
                {isSelected ? (
                  <Text color={theme.brand} bold>{'> '}</Text>
                ) : (
                  <Text>  </Text>
                )}
              </Box>
              <Box flexDirection="column">
                <Text color={isSelected ? theme.text : theme.inactive} dimColor={!isSelected}>
                  {opt.label}
                  {currentModel === opt.model || currentModel === opt.id ? (
                    <Text color={theme.success}> *</Text>
                  ) : null}
                </Text>
                {isSelected && (
                  <Text dimColor color={theme.inactive}>{opt.description}</Text>
                )}
              </Box>
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Up/Down navigate - Enter select - Esc cancel</Text>
      </Box>
    </Box>
  )
}
