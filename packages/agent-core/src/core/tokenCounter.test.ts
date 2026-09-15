import { describe, expect, it } from 'vitest'
import { countMessagesTokens, countTextTokens } from './tokenCounter'

describe('tokenCounter', () => {
  it('counts whitelisted GPT-5 text with an actual tokenizer', () => {
    const result = countTextTokens('hello world', { provider: 'openai', model: 'gpt-5.5' })

    expect(result.source).toBe('tokenizer')
    expect(result.tokenizer).toBe('o200k_base')
    expect(result.tokens).toBeGreaterThan(0)
  })

  it('counts whitelisted GPT aliases with the canonical tokenizer', () => {
    const result = countTextTokens('hello world', { provider: 'custom', model: 'GPT5.4' })

    expect(result.source).toBe('tokenizer')
    expect(result.tokenizer).toBe('o200k_base')
    expect(result.tokens).toBeGreaterThan(0)
  })

  it('uses a clearly marked rough estimate for DeepSeek without a provider count', () => {
    const result = countMessagesTokens([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'long coding task' },
    ], { provider: 'custom', model: 'deepseek-v4-pro' })

    expect(result.source).toBe('estimate')
    expect(result.tokens).toBeGreaterThan(0)
    expect(result.reason).toContain('Rough')
  })

  it('does not give legacy broad family matches a real tokenizer', () => {
    const result = countTextTokens('hello world', { provider: 'openai', model: 'gpt-4o' })

    expect(result.source).toBe('estimate')
    expect(result.tokens).toBeGreaterThan(0)
    expect(result.tokenizer).toBeUndefined()
    expect(result.reason).toContain('Rough token estimate')
  })

  it('can still fail closed when estimates are explicitly disabled', () => {
    const result = countTextTokens('hello world', { provider: 'unknown', model: 'mystery-model', allowEstimate: false })

    expect(result.source).toBe('unavailable')
    expect(result.tokens).toBe(0)
    expect(result.reason).toContain('No tokenizer mapping')
  })
})
