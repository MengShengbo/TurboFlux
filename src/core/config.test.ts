import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  configFromProviderPreset,
  getProviderPreset,
  setConfigValue,
  type TurboFluxConfig,
} from './config'

const baseConfig: TurboFluxConfig = {
  provider: 'custom',
  apiKey: 'test-key',
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-5.5',
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  maxTokens: DEFAULT_MAX_TOKENS,
}

describe('setConfigValue', () => {
  it('stores positive integer fields as numbers', () => {
    const next = setConfigValue(baseConfig, 'contextWindow', '2048')

    expect(next.contextWindow).toBe(2048)
  })

  it('keeps custom model names valid for custom providers', () => {
    const next = setConfigValue(baseConfig, 'model', 'my-local-model')

    expect(next.model).toBe('my-local-model')
  })

  it('rejects invalid providers', () => {
    expect(() => setConfigValue(baseConfig, 'provider', 'unknown')).toThrow(/Invalid provider/)
  })

  it('rejects invalid URLs', () => {
    expect(() => setConfigValue(baseConfig, 'baseUrl', 'not a url')).toThrow(/Invalid baseUrl/)
  })

  it('rejects unknown keys', () => {
    expect(() => setConfigValue(baseConfig, 'debugMode', 'true')).toThrow(/Unknown config key/)
  })
})

describe('provider presets', () => {
  it('keeps provider defaults explicit', () => {
    const preset = getProviderPreset('deepseek')

    expect(preset?.baseUrl).toBe('https://api.deepseek.com')
    expect(preset?.defaultModel).toBe('deepseek-v4-flash')
  })

  it('creates complete direct provider config', () => {
    const preset = getProviderPreset('openai')!
    const config = configFromProviderPreset(preset, 'sk-test', 'gpt-5.5')

    expect(config.provider).toBe('openai')
    expect(config.apiKey).toBe('sk-test')
    expect(config.baseUrl).toBe('https://api.openai.com/v1')
    expect(config.model).toBe('gpt-5.5')
    expect(config.contextWindow).toBeGreaterThan(100_000)
  })

  it('supports custom OpenAI-compatible endpoints', () => {
    const preset = getProviderPreset('custom')!
    const config = configFromProviderPreset(preset, 'key', 'custom-model', 'https://api.example.com/v1')

    expect(config.provider).toBe('custom')
    expect(config.baseUrl).toBe('https://api.example.com/v1')
    expect(config.model).toBe('custom-model')
  })
})
