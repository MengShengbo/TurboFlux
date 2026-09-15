import { describe, expect, it } from 'vitest'
import { normalizeBrowserAddress, validateBrowserNavigation } from './browserPolicy'

describe('browser navigation policy', () => {
  it('normalizes searches, domains, and local previews', () => {
    expect(normalizeBrowserAddress('electron security')).toBe('https://duckduckgo.com/?q=electron%20security')
    expect(normalizeBrowserAddress('example.com/docs')).toBe('https://example.com/docs')
    expect(normalizeBrowserAddress('localhost:5174')).toBe('http://localhost:5174')
    expect(normalizeBrowserAddress('site:hai.stanford.edu AI Index')).toBe('https://duckduckgo.com/?q=site%3Ahai.stanford.edu%20AI%20Index')
    expect(normalizeBrowserAddress('model: DeepSeek V4 Pro')).toBe('https://duckduckgo.com/?q=model%3A%20DeepSeek%20V4%20Pro')
    expect(normalizeBrowserAddress('')).toBe('about:blank')
  })

  it('allows only normal web navigation without embedded credentials', () => {
    expect(validateBrowserNavigation('https://example.com').protocol).toBe('https:')
    expect(validateBrowserNavigation('http://127.0.0.1:3000').hostname).toBe('127.0.0.1')
    expect(() => validateBrowserNavigation('file:///etc/passwd')).toThrow('Blocked browser protocol')
    expect(() => validateBrowserNavigation('javascript:alert(1)')).toThrow('Blocked browser protocol')
    expect(() => validateBrowserNavigation('https://user:secret@example.com')).toThrow('embedded credentials')
  })
})
