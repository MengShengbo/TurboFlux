import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  configFromProviderPreset,
  createApiConfigProfile,
  createEmptyConfig,
  deleteApiConfigProfile,
  getFastContextApiConfig,
  getProviderPreset,
  saveApiConfigProfile,
  setConfigValue,
  setFastContextModelConfig,
  switchActiveApiConfig,
  type TurboFluxConfig,
} from './config'

const baseConfig: TurboFluxConfig = {
  provider: 'custom',
  apiKey: 'test-key',
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-5.5',
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  maxTokens: DEFAULT_MAX_TOKENS,
  approvalPolicy: 'ask',
}

describe('setConfigValue', () => {
  it('uses a 200K compatibility default context window', () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(200_000)
    expect(createEmptyConfig().contextWindow).toBe(200_000)
  })

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

  it('keeps request output within a discovered model ceiling', () => {
    const limited = { ...baseConfig, maxOutputTokens: 8192 }

    expect(() => setConfigValue(limited, 'maxTokens', '16384')).toThrow(/cannot exceed/)
    expect(setConfigValue(limited, 'maxTokens', '4096').maxTokens).toBe(4096)
  })

  it('accepts reasoning efforts advertised by a discovered model', () => {
    const discovered: TurboFluxConfig = {
      ...baseConfig,
      model: 'vendor/reasoning-model',
      modelCapabilities: {
        reasoning: true,
        reasoningEfforts: ['low', 'high'],
        supportedParameters: ['reasoning_effort'],
      },
    }
    const next = setConfigValue(discovered, 'reasoningEffort', 'high')

    expect(next.reasoning?.effort).toBe('high')
  })

  it('migrates legacy approval names and stores native reasoning effort', () => {
    const approval = setConfigValue(baseConfig, 'approvalPolicy', 'auto')
    const reasoning = setConfigValue({ ...baseConfig, provider: 'openai', model: 'gpt-5.6' }, 'reasoningEffort', 'xhigh')

    expect(approval.approvalPolicy).toBe('agent')
    expect(reasoning.reasoning?.effort).toBe('xhigh')
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
    expect(config.reasoning?.effort).toBe('medium')
  })

  it('supports custom OpenAI-compatible endpoints', () => {
    const preset = getProviderPreset('custom')!
    const config = configFromProviderPreset(preset, 'key', 'custom-model', 'https://api.example.com/v1')

    expect(config.provider).toBe('custom')
    expect(config.baseUrl).toBe('https://api.example.com/v1')
    expect(config.model).toBe('custom-model')
    expect(config.reasoning).toBeUndefined()
  })
})

describe('API config profiles', () => {
  it('can save and switch between multiple API profiles', () => {
    let config = createEmptyConfig()
    const openai = createApiConfigProfile({
      name: 'OpenAI main',
      provider: 'openai',
      apiKey: 'sk-openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
    })
    const local = createApiConfigProfile({
      name: 'Local model',
      provider: 'custom',
      apiKey: 'local-key',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen-local',
    })

    config = saveApiConfigProfile(config, openai, true)
    config = saveApiConfigProfile(config, local, false)
    const switched = switchActiveApiConfig(config, local.id)

    expect(switched.activeApiConfigId).toBe(local.id)
    expect(switched.provider).toBe('custom')
    expect(switched.model).toBe('qwen-local')
    expect(switched.apiConfigs).toHaveLength(2)
  })

  it('uses a selected API profile for FastContext', () => {
    let config = createEmptyConfig()
    const main = createApiConfigProfile({
      name: 'Main',
      provider: 'openai',
      apiKey: 'sk-main',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
    })
    const fast = createApiConfigProfile({
      name: 'FastContext',
      provider: 'custom',
      apiKey: 'sk-fast',
      baseUrl: 'https://fast.example/v1',
      model: 'fast-context-model',
    })

    config = saveApiConfigProfile(config, main, true)
    config = saveApiConfigProfile(config, fast, false)
    config = setFastContextModelConfig(config, { mode: 'api-config', apiConfigId: fast.id })

    expect(getFastContextApiConfig(config)?.model).toBe('fast-context-model')
  })

  it('falls back to follow-main when deleting the FastContext profile', () => {
    let config = createEmptyConfig()
    const main = createApiConfigProfile({
      name: 'Main',
      provider: 'openai',
      apiKey: 'sk-main',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
    })
    const fast = createApiConfigProfile({
      name: 'FastContext',
      provider: 'custom',
      apiKey: 'sk-fast',
      baseUrl: 'https://fast.example/v1',
      model: 'fast-context-model',
    })

    config = saveApiConfigProfile(config, main, true)
    config = saveApiConfigProfile(config, fast, false)
    config = setFastContextModelConfig(config, { mode: 'api-config', apiConfigId: fast.id })
    const next = deleteApiConfigProfile(config, fast.id)

    expect(next.fastContextModel?.mode).toBe('follow-main')
    expect(getFastContextApiConfig(next)).toBeUndefined()
  })
})
