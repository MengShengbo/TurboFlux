import { describe, expect, it } from 'vitest'
import {
  canonicalModelId,
  getModelReasoningCapabilities,
  getSupportedModelSpec,
  isSupportedModel,
  normalizeNativeReasoningConfig,
  resolveNativeReasoningRequest,
  SUPPORTED_MODEL_SPECS,
} from './modelRegistry'
import type { ModelCapabilities } from './config'

describe('modelRegistry', () => {
  it('includes the current model families exposed by official providers', () => {
    const ids = SUPPORTED_MODEL_SPECS.map(model => model.id)
    expect(ids).toContain('gpt-5.6')
    expect(ids).toContain('gpt-5.6-sol')
    expect(ids).toContain('claude-fable-5')
    expect(ids).toContain('claude-mythos-5')
    expect(ids).toContain('claude-opus-4-8')
    expect(ids).toContain('claude-sonnet-5')
    expect(ids).toContain('deepseek-v4-pro')
    expect(ids).toContain('kimi-k3')
    expect(ids).toContain('glm-5.2')
    expect(isSupportedModel('gpt-4o')).toBe(false)
  })

  it('normalizes aliases and routed model names', () => {
    expect(canonicalModelId('DeepSeekV4Pro')).toBe('deepseek-v4-pro')
    expect(canonicalModelId('anthropic/claude-opus-4-8')).toBe('claude-opus-4-8')
    expect(canonicalModelId('claude-haiku-4-5')).toBe('claude-haiku-4-5-20251001')
  })

  it('keeps model ceilings separate from conservative request defaults', () => {
    const gpt = getSupportedModelSpec('gpt-5.6')
    const deepseek = getSupportedModelSpec('deepseek-v4-pro')

    expect(gpt?.contextWindow).toBe(1_050_000)
    expect(gpt?.maxOutputTokens).toBe(128_000)
    expect(gpt?.defaultRequestTokens).toBe(16_384)
    expect(deepseek?.maxOutputTokens).toBe(384_000)
  })

  it('exposes provider-native effort ranges instead of TurboFlux modes', () => {
    expect(getModelReasoningCapabilities('gpt-5.6')?.efforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(getModelReasoningCapabilities('claude-opus-4-8')?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(getModelReasoningCapabilities('deepseek-v4-pro')?.efforts).toEqual(['high', 'max'])
    expect(getModelReasoningCapabilities('kimi-k3')?.supportsToggle).toBe(false)
  })

  it('builds the native request shape for each provider family', () => {
    expect(resolveNativeReasoningRequest('gpt-5.6', { effort: 'xhigh' })).toMatchObject({ reasoningEffort: 'xhigh' })
    expect(resolveNativeReasoningRequest('claude-opus-4-8', { effort: 'max' })).toMatchObject({
      thinking: { type: 'adaptive' },
      outputConfig: { effort: 'max' },
    })
    expect(resolveNativeReasoningRequest('deepseek-v4-pro', { effort: 'max' })).toMatchObject({
      thinking: { type: 'enabled' },
      reasoningEffort: 'max',
    })
    expect(resolveNativeReasoningRequest('kimi-k2.6', { enabled: true })).toMatchObject({
      thinking: { type: 'enabled', keep: 'all' },
    })
    expect(resolveNativeReasoningRequest('glm-5.2')).toMatchObject({
      thinking: { type: 'enabled' },
      reasoningEffort: 'max',
    })
  })

  it('uses reasoning effort metadata advertised by an API', () => {
    const discovered: ModelCapabilities = {
      reasoning: true,
      reasoningEfforts: ['low', 'high'],
      supportedParameters: ['reasoning_effort'],
    }

    expect(resolveNativeReasoningRequest(
      'vendor/new-model',
      { effort: 'high' },
      'custom',
      discovered,
    )).toMatchObject({ reasoningEffort: 'high' })
  })

  it('narrows builtin effort choices to gateway-advertised values', () => {
    const discovered: ModelCapabilities = {
      reasoning: true,
      reasoningEfforts: ['low', 'high'],
      supportedParameters: ['reasoning_effort'],
    }

    expect(getModelReasoningCapabilities('gpt-5.6', 'custom', discovered)?.efforts).toEqual(['low', 'high'])
    expect(normalizeNativeReasoningConfig('gpt-5.6', { effort: 'max' }, 'custom', discovered)?.effort).toBe('low')
  })

  it('honors an explicit API declaration that reasoning is unavailable', () => {
    expect(getModelReasoningCapabilities('gpt-5.6', 'custom', { reasoning: false })).toBeNull()
  })

  it('clamps unsupported effort values to each model default', () => {
    expect(normalizeNativeReasoningConfig('deepseek-v4-pro', { effort: 'low' })?.effort).toBe('high')
    expect(normalizeNativeReasoningConfig('claude-fable-5', { enabled: false })?.enabled).toBe(true)
  })
})
