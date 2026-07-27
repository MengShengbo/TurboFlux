import React, { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import cliTruncate from 'cli-truncate'
import type { ModelReasoningCapabilities } from '../../../core/modelRegistry'
import type { NativeReasoningConfig, ReasoningEffort } from '../../../shared/agentTypes'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import { createTranslator, useI18n, type Translator } from '../../i18n/index'

export type EffortSelection =
  | { type: 'effort'; effort: ReasoningEffort }
  | { type: 'toggle'; enabled: boolean }
  | { type: 'budget'; budgetTokens: number }

export interface EffortOption {
  id: string
  label: string
  description: string
  selection: EffortSelection
  current: boolean
}

interface Props {
  model: string
  capability: ModelReasoningCapabilities
  current?: NativeReasoningConfig
  onSelect: (selection: EffortSelection) => void
  onCancel: () => void
}

const BUDGET_PRESETS = [4_096, 8_192, 16_384, 32_768, 65_536]

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function effortDescription(effort: ReasoningEffort, t: Translator): string {
  if (effort === 'none') return t('ui.effort.none')
  if (effort === 'minimal') return t('ui.effort.minimal')
  if (effort === 'low') return t('ui.effort.low')
  if (effort === 'medium') return t('ui.effort.medium')
  if (effort === 'high') return t('ui.effort.high')
  if (effort === 'xhigh') return t('ui.effort.xhigh')
  return t('ui.effort.max')
}

function budgetLabel(value: number): string {
  return `${Math.round(value / 1024)}K tokens`
}

export function buildEffortOptions(
  capability: ModelReasoningCapabilities,
  current?: NativeReasoningConfig,
  t: Translator = createTranslator('en'),
): EffortOption[] {
  if (capability.control === 'fixed') return []
  const enabled = current?.enabled ?? capability.defaultEnabled
  const activeEffort = current?.effort ?? capability.defaultEffort

  if (capability.control === 'budget') {
    const activeBudget = current?.budgetTokens ?? capability.defaultBudgetTokens
    const budgets = [...BUDGET_PRESETS]
    if (activeBudget && !budgets.includes(activeBudget)) budgets.push(activeBudget)
    budgets.sort((left, right) => left - right)
    const options: EffortOption[] = budgets.map(budgetTokens => ({
      id: `budget:${budgetTokens}`,
      label: budgetLabel(budgetTokens),
      description: t('ui.effort.budget', { tokens: budgetTokens.toLocaleString() }),
      selection: { type: 'budget' as const, budgetTokens },
      current: enabled && activeBudget === budgetTokens,
    }))
    if (capability.supportsToggle) {
      options.unshift({
        id: 'toggle:off',
        label: t('ui.effort.off'),
        description: t('ui.effort.disableThinking'),
        selection: { type: 'toggle' as const, enabled: false },
        current: !enabled,
      })
    }
    return options
  }

  if (capability.efforts.length > 0) {
    const options: EffortOption[] = capability.efforts.map(effort => ({
      id: `effort:${effort}`,
      label: titleCase(effort),
      description: effortDescription(effort, t),
      selection: { type: 'effort', effort },
      current: enabled && activeEffort === effort,
    }))
    if (capability.supportsToggle && !capability.efforts.includes('none')) {
      options.unshift({
        id: 'toggle:off',
        label: t('ui.effort.off'),
        description: t('ui.effort.disableReasoning'),
        selection: { type: 'toggle', enabled: false },
        current: !enabled,
      })
    }
    return options
  }

  return capability.supportsToggle
    ? [
        {
          id: 'toggle:off',
          label: t('ui.effort.off'),
          description: t('ui.effort.disableReasoning'),
          selection: { type: 'toggle', enabled: false },
          current: !enabled,
        },
        {
          id: 'toggle:on',
          label: t('ui.effort.on'),
          description: t('ui.effort.enableReasoning'),
          selection: { type: 'toggle', enabled: true },
          current: enabled,
        },
      ]
    : []
}

export function EffortPicker({ model, capability, current, onSelect, onCancel }: Props) {
  const theme = useTheme()
  const { t } = useI18n()
  const { columns } = useTerminalSize()
  const options = useMemo(() => buildEffortOptions(capability, current, t), [capability, current, t])
  const initialIndex = Math.max(0, options.findIndex(option => option.current))
  const [selected, setSelected] = useState(initialIndex)
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY)

  useInput((_, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.return) {
      const option = options[selected]
      if (option) onSelect(option.selection)
      return
    }
    if (key.upArrow) setSelected(index => Math.max(0, index - 1))
    if (key.downArrow) setSelected(index => Math.min(options.length - 1, index + 1))
  }, { isActive: isInteractive })

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor={theme.brand} paddingX={1}>
      <Text bold color={theme.brand}>{t('ui.effort.title')}</Text>
      <Text color={theme.inactive} wrap="truncate-end">{model}</Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => {
          const isSelected = index === selected
          return (
            <Box key={option.id}>
                <Box width={2}><Text color={theme.brand} bold={isSelected}>{isSelected ? '> ' : '  '}</Text></Box>
                <Box width={16} flexShrink={0}>
                <Text color={isSelected ? theme.text : theme.inactive} bold={isSelected} dimColor={!isSelected}>
                  {option.label}{option.current ? <Text color={theme.success}> *</Text> : null}
                </Text>
                </Box>
                <Text color={theme.inactive}>{cliTruncate(option.description, Math.max(12, columns - 24), { position: 'end' })}</Text>
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.inactive}>{t('ui.effort.keys')}</Text>
      </Box>
    </Box>
  )
}
