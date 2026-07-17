import { describe, expect, it } from 'vitest'
import type { ModelReasoningCapabilities } from '../../../core/modelRegistry'
import { buildEffortOptions } from './EffortPicker'

function capability(overrides: Partial<ModelReasoningCapabilities>): ModelReasoningCapabilities {
  return {
    family: 'openai',
    control: 'effort',
    efforts: [],
    supportsToggle: true,
    defaultEnabled: true,
    omitTemperature: false,
    description: 'test',
    ...overrides,
  }
}

describe('buildEffortOptions', () => {
  it('does not duplicate off when the provider exposes none', () => {
    const options = buildEffortOptions(capability({
      efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium',
    }))

    expect(options.map(option => option.id)).toEqual([
      'effort:none',
      'effort:low',
      'effort:medium',
      'effort:high',
      'effort:xhigh',
      'effort:max',
    ])
    expect(options.find(option => option.current)?.id).toBe('effort:medium')
  })

  it('adds an off choice for adjustable models without a none effort', () => {
    const options = buildEffortOptions(capability({
      control: 'adaptive-effort',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
    }), { enabled: false, effort: 'high' })

    expect(options[0]).toMatchObject({ id: 'toggle:off', current: true })
    expect(options.map(option => option.id)).toContain('effort:high')
  })

  it('offers practical token budgets and highlights the provider default', () => {
    const options = buildEffortOptions(capability({
      family: 'anthropic',
      control: 'budget',
      defaultBudgetTokens: 8_192,
      efforts: [],
    }))

    expect(options[0].id).toBe('toggle:off')
    expect(options.find(option => option.current)?.id).toBe('budget:8192')
    expect(options.map(option => option.id)).toContain('budget:65536')
  })

  it('does not present fake controls for fixed reasoning', () => {
    expect(buildEffortOptions(capability({ control: 'fixed', efforts: ['max'], supportsToggle: false }))).toEqual([])
  })
})
