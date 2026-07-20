import { describe, expect, it } from 'vitest'
import type { ModelPreset } from '../../../core/config'
import { formatModelPickerLine } from './ModelPicker'

const preset: ModelPreset = {
  id: 'claude-sonnet-5',
  name: 'Claude Sonnet 5',
  model: 'claude-sonnet-5',
  provider: 'anthropic',
  baseUrl: 'https://example.com/v1',
  contextWindow: 1_000_000,
  maxTokens: 16_384,
  maxOutputTokens: 128_000,
  description: 'A long marketing description that should not appear in the picker row.',
  capabilities: { tools: true, vision: true, reasoning: true },
}

describe('ModelPicker rows', () => {
  it('keeps model metadata on one concise line', () => {
    const line = formatModelPickerLine(preset, 100)

    expect(line).toBe('claude-sonnet-5  ctx 1M  out 128K  tools  vision  reasoning')
    expect(line).not.toContain(preset.description)
  })

  it('truncates long rows to the available terminal width', () => {
    expect(formatModelPickerLine(preset, 36).length).toBeLessThanOrEqual(36)
  })
})
