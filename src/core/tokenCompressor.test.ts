import { describe, it, expect } from 'vitest'
import { compressToolResult } from './tokenCompressor'

describe('tokenCompressor', () => {
  it('skips small outputs', () => {
    const r = compressToolResult('read_file', 'short content')
    expect(r.method).toBe('skipped')
    expect(r.compressed).toBe('short content')
  })

  it('span-folds long read_file output keeping head/tail', () => {
    const body = [
      ...Array.from({ length: 20 }, (_, i) => `header line ${i}`),
      ...Array.from({ length: 80 }, (_, i) => `   // boilerplate ${i}`),
      ...Array.from({ length: 20 }, (_, i) => `tail line ${i}`),
    ].join('\n')
    const padded = body + '\n' + 'x'.repeat(2000)
    const r = compressToolResult('read_file', padded)
    expect(r.method).toBe('span_fold')
    expect(r.compressed.length).toBeLessThan(padded.length)
    expect(r.compressed).toContain('header line 0')
    expect(r.compressed).toContain('tail line 19')
    expect(r.compressed).toMatch(/<compressed method="span_fold"/)
  })

  it('aggregates search results by file', () => {
    const long = Array.from({ length: 50 }, (_, i) => `src/foo/bar${i % 5}.ts:${10 + i}: match content ${i}`).join('\n')
    const r = compressToolResult('search_content', long)
    expect(r.method).toBe('search_aggregate')
    expect(r.compressed).toContain('<search_summary>')
    expect(r.compressed).toMatch(/more match/)
  })

  it('line-prunes generic long output and preserves signal lines', () => {
    const lines: string[] = []
    for (let i = 0; i < 400; i++) lines.push(`noise noise noise noise noise line ${i}`)
    lines.push('export function doSomething()')
    const body = lines.join('\n')
    const r = compressToolResult('some_other_tool', body)
    expect(r.method).toBe('line_prune')
    expect(r.compressed).toContain('export function doSomething')
  })
})
