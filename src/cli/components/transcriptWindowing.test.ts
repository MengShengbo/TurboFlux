import { describe, expect, it } from 'vitest'
import {
  describeTranscriptCells,
  estimateTranscriptMessageRows,
  projectTranscriptCellWindow,
} from './transcriptWindowing'

describe('transcript cell windowing', () => {
  it('mounts a bounded tail for ten thousand committed cells', () => {
    const cells = Array.from({ length: 10_000 }, (_, index) => ({ id: `cell-${index}`, estimatedRows: 2 }))
    const window = projectTranscriptCellWindow(cells, {}, 40, 0, 12)

    expect(window.totalRows).toBe(20_000)
    expect(window.endIndex - window.startIndex).toBeLessThanOrEqual(32)
    expect(window.endIndex).toBe(10_000)
    expect(window.paddingTopRows).toBeGreaterThan(19_000)
  })

  it('uses measured heights while preserving a row anchor from the bottom', () => {
    const cells = Array.from({ length: 20 }, (_, index) => ({ id: `cell-${index}`, estimatedRows: 2 }))
    const measured = { 'cell-10': 12 }
    const window = projectTranscriptCellWindow(cells, measured, 10, 15, 0)

    expect(window.totalRows).toBe(50)
    expect(window.topRow).toBe(25)
    expect(window.paddingTopRows).toBeLessThanOrEqual(window.topRow)
  })

  it('mounts a pinned selection even when it is outside the current tail', () => {
    const cells = Array.from({ length: 100 }, (_, index) => ({ id: `cell-${index}`, estimatedRows: 2 }))
    const window = projectTranscriptCellWindow(cells, {}, 20, 0, 4, 'cell-4')

    expect(window.startIndex).toBeLessThanOrEqual(4)
    expect(window.endIndex).toBeGreaterThan(4)
    expect(window.endIndex - window.startIndex).toBeLessThan(20)
  })

  it('estimates wrapped content, thinking, tools, and diffs', () => {
    const message = {
      id: 'assistant-1',
      role: 'assistant' as const,
      content: 'x'.repeat(80),
      thinking: { content: 'reasoning', source: 'provider' as const },
      tools: [{ id: 'tool-1', name: 'read', status: 'done' as const }],
      changes: [{ path: 'a.ts', operation: 'write' as const, before: '', after: 'a\nb\nc' }],
    }
    expect(estimateTranscriptMessageRows(message, 22, true)).toBeGreaterThan(10)
    expect(describeTranscriptCells([message], 22, true)[0]?.id).toBe('assistant-1')
  })
})
