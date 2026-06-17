import { describe, expect, it } from 'vitest'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, setConfigValue, type TurboFluxConfig } from './config'

const baseConfig: TurboFluxConfig = {
  provider: 'custom',
  apiKey: 'turboflux-local',
  baseUrl: 'http://127.0.0.1:8787',
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
