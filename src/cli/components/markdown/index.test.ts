import { beforeEach, describe, expect, it } from 'vitest'
import { formatMarkdown, formatMarkdownForDisplay, getMarkdownCacheStats, resetMarkdownCache } from './index'

describe('Markdown render cache', () => {
  beforeEach(() => resetMarkdownCache())

  it('reuses committed source without formatting it again', () => {
    const source = '**Done** with `tests`.'
    const first = formatMarkdown(source)
    const second = formatMarkdown(source)

    expect(second).toBe(first)
    expect(getMarkdownCacheStats()).toMatchObject({ hits: 1, misses: 1, entries: 1, hitRate: 0.5 })
  })

  it('keeps the cache bounded under unique transcript cells', () => {
    for (let index = 0; index < 600; index += 1) {
      formatMarkdown(`message ${index}: **${'x'.repeat(64)}**`)
    }

    const stats = getMarkdownCacheStats()
    expect(stats.entries).toBeLessThanOrEqual(512)
    expect(stats.evictions).toBeGreaterThan(0)
    expect(stats.bytes).toBeLessThanOrEqual(4 * 1024 * 1024)
  })

  it('bounds markdown work for oversized live display text', () => {
    const formatted = formatMarkdownForDisplay('x'.repeat(100), 16)
    expect(formatted).toContain('display truncated after 16 characters')
    expect(formatted).not.toContain('x'.repeat(17))
  })
})
