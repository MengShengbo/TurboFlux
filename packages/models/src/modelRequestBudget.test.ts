import { describe, expect, it } from 'vitest'
import { DEFAULT_REQUEST_MAX_TOKENS, resolveRequestMaxTokens } from './modelRequestBudget'

describe('model request output budget', () => {
  it('uses a restrained default for ordinary requests', () => {
    expect(resolveRequestMaxTokens(undefined)).toBe(DEFAULT_REQUEST_MAX_TOKENS)
  })

  it('uses the configured model output limit for managed requests', () => {
    expect(resolveRequestMaxTokens(undefined, 384_000)).toBe(384_000)
    expect(resolveRequestMaxTokens(undefined, 128_000)).toBe(128_000)
    expect(resolveRequestMaxTokens(393_216, 384_000)).toBe(384_000)
  })

  it('normalizes invalid configured values', () => {
    expect(resolveRequestMaxTokens(0, 8_192)).toBe(8_192)
    expect(resolveRequestMaxTokens(Number.NaN, undefined)).toBe(DEFAULT_REQUEST_MAX_TOKENS)
  })
})
