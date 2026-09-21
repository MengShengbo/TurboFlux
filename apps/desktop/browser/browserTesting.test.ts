import { describe, expect, it } from 'vitest'
import {
  normalizeBrowserKey,
  normalizeBrowserTimeout,
  redactDiagnosticUrl,
  sanitizeBrowserRef,
} from './browserTesting'

describe('browser testing helpers', () => {
  it('normalizes the bounded keyboard vocabulary', () => {
    expect(normalizeBrowserKey('Arrow Down')).toBe('Down')
    expect(normalizeBrowserKey('esc')).toBe('Escape')
    expect(() => normalizeBrowserKey('Cmd+Q')).toThrow('Unsupported browser key')
  })

  it('bounds waits and sanitizes element refs', () => {
    expect(normalizeBrowserTimeout(80)).toBe(100)
    expect(normalizeBrowserTimeout(60_000)).toBe(15_000)
    expect(sanitizeBrowserRef('o2-scope-r0-e12')).toBe('o2-scope-r0-e12')
    expect(() => sanitizeBrowserRef('e12<script>')).toThrow('Invalid element ref')
    expect(() => sanitizeBrowserRef('***')).toThrow('Invalid element ref')
  })

  it('removes credentials, queries, and fragments from diagnostic URLs', () => {
    expect(redactDiagnosticUrl('https://user:secret@example.com/api/items?token=secret#result'))
      .toBe('https://example.com/api/items')
  })
})
