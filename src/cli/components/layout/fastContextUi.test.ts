import { describe, expect, it } from 'vitest'
import type { FastContextScanEvent } from '../../../core/fastContextTypes'
import { appendFastContextUiEvents, createFastContextUiSummary, reduceFastContextUiSummary } from './fastContextUi'

describe('FastContext UI event buffering', () => {
  it('keeps recent display events bounded', () => {
    const events: FastContextScanEvent[] = Array.from({ length: 10 }, (_, index) => ({
      type: 'file',
      path: `file-${index}.ts`,
      status: 'discovered',
    }))

    expect(appendFastContextUiEvents([], events, 3).map(event => event.type === 'file' ? event.path : '')).toEqual([
      'file-7.ts',
      'file-8.ts',
      'file-9.ts',
    ])
  })

  it('preserves accurate totals outside the bounded display buffer', () => {
    const events: FastContextScanEvent[] = [
      { type: 'phase', phase: 'mapping' },
      { type: 'file', path: 'src/a.ts', status: 'discovered' },
      { type: 'file', path: 'src/a.ts', status: 'absorbed' },
      { type: 'hit', hit: { path: 'src/a.ts', line: 1, startLine: 1, endLine: 1, preview: 'a' } },
      { type: 'worker', id: 'worker-1', label: 'scan', status: 'running', currentPath: 'src/b.ts' },
    ]

    expect(reduceFastContextUiSummary(createFastContextUiSummary(), events)).toEqual({
      phase: 'mapping',
      events: 5,
      files: 1,
      absorbed: 1,
      hits: 1,
      latest: 'src/b.ts',
    })
  })

  it('handles a large scan batch while keeping render history small', () => {
    const events: FastContextScanEvent[] = Array.from({ length: 20_000 }, (_, index) => ({
      type: 'file',
      path: `src/generated/file-${index}.ts`,
      status: 'discovered',
    }))
    const summary = reduceFastContextUiSummary(createFastContextUiSummary(), events)
    const recent = appendFastContextUiEvents([], events)

    expect(summary.files).toBe(20_000)
    expect(summary.latest).toBe('src/generated/file-19999.ts')
    expect(recent).toHaveLength(120)
  })
})
