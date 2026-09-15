import { describe, expect, it } from 'vitest'
import { maskedApiKey } from './apiKeyPresentation'

describe('API key previews', () => {
  it('exposes only a prefix and suffix for identifying a saved credential', () => {
    expect(maskedApiKey('sk-proj-very-private-credential-9x2a')).toBe('sk-proj********9x2a')
    expect(maskedApiKey('  desktop-secret  ')).toBe('des********ret')
  })

  it('keeps the interior of short credentials hidden without revealing very short keys', () => {
    expect(maskedApiKey('123456789')).toBe('1********9')
    expect(maskedApiKey('12345')).toBe('1********5')
    expect(maskedApiKey('1234')).toBe('********')
    expect(maskedApiKey('')).toBe('')
    expect(maskedApiKey('   ')).toBe('')
  })
})
