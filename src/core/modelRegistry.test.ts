import { describe, expect, it } from 'vitest'
import { canonicalModelId, getSupportedModelSpec, isSupportedModel, resolveReasoningParam, SUPPORTED_MODEL_SPECS } from './modelRegistry'

describe('modelRegistry', () => {
  it('only exposes the conservative supported-model whitelist', () => {
    expect(SUPPORTED_MODEL_SPECS.map(model => model.id)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'gpt-5.5',
      'gpt-5.4',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
    ])
    expect(isSupportedModel('gpt-4o')).toBe(false)
    expect(isSupportedModel('claude-sonnet-4')).toBe(false)
  })

  it('normalizes user-facing aliases to canonical ids', () => {
    expect(canonicalModelId('DeepSeekV4Pro')).toBe('deepseek-v4-pro')
    expect(canonicalModelId('ClaudeOpus4.8')).toBe('claude-opus-4-8')
    expect(canonicalModelId('GPT5.5')).toBe('gpt-5.5')
  })

  it('keeps model ceilings separate from conservative request defaults', () => {
    const gpt = getSupportedModelSpec('gpt-5.5')
    const deepseek = getSupportedModelSpec('deepseek-v4-pro')

    expect(gpt?.contextWindow).toBe(1_050_000)
    expect(gpt?.maxOutputTokens).toBe(128_000)
    expect(gpt?.defaultRequestTokens).toBe(16_384)
    expect(deepseek?.maxOutputTokens).toBe(384_000)
    expect(deepseek?.defaultRequestTokens).toBe(16_384)
  })

  it('maps TurboFlux thinking modes to provider-specific reasoning controls', () => {
    expect(resolveReasoningParam('gpt-5.5', 'max')).toEqual({ kind: 'openai-chat', effort: 'xhigh' })
    expect(resolveReasoningParam('deepseek-v4-pro', 'standard')).toEqual({ kind: 'deepseek-chat', thinking: 'enabled', effort: 'high' })
    expect(resolveReasoningParam('claude-opus-4-8', 'off')).toEqual({ kind: 'anthropic-adaptive', thinking: 'disabled' })
  })
})
