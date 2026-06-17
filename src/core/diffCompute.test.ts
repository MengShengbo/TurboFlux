import { describe, it, expect } from 'vitest'
import {
  computeHunks,
  summarizeHunks,
  hunksToCurrentSpans,
  canComputeDiff,
  classifyOperation,
  MAX_DIFF_INPUT_BYTES,
} from './diffCompute'

describe('diffCompute', () => {
  describe('canComputeDiff', () => {
    it('returns true for two reasonably-sized strings', () => {
      expect(canComputeDiff('a', 'b')).toBe(true)
      expect(canComputeDiff('', '')).toBe(true)
    })

    it('returns false for non-string inputs', () => {
      expect(canComputeDiff(null, 'b')).toBe(false)
      expect(canComputeDiff('a', undefined)).toBe(false)
    })

    it('returns false when either side exceeds the cap', () => {
      const huge = 'x'.repeat(MAX_DIFF_INPUT_BYTES + 1)
      expect(canComputeDiff(huge, 'small')).toBe(false)
      expect(canComputeDiff('small', huge)).toBe(false)
    })
  })

  describe('computeHunks', () => {
    it('returns no hunks for identical inputs', () => {
      const hunks = computeHunks('a\nb\nc\n', 'a\nb\nc\n')
      expect(hunks).toEqual([])
    })

    it('captures pure additions with line-numbered metadata', () => {
      const before = 'a\nb\nc\n'
      const after = 'a\nb\nNEW\nc\n'
      const hunks = computeHunks(before, after)
      expect(hunks.length).toBe(1)
      const addLines = hunks[0].lines.filter(l => l.kind === 'add')
      expect(addLines).toHaveLength(1)
      expect(addLines[0].text).toBe('NEW')
      expect(addLines[0].newLine).toBe(3)
    })

    it('captures pure removals with old-file line numbers', () => {
      const before = 'a\nb\nDEL\nc\n'
      const after = 'a\nb\nc\n'
      const hunks = computeHunks(before, after)
      expect(hunks.length).toBe(1)
      const removeLines = hunks[0].lines.filter(l => l.kind === 'remove')
      expect(removeLines).toHaveLength(1)
      expect(removeLines[0].text).toBe('DEL')
      expect(removeLines[0].oldLine).toBe(3)
    })

    it('captures replacements (remove + add in same hunk)', () => {
      const before = 'a\nb\nOLD\nc\n'
      const after = 'a\nb\nNEW\nc\n'
      const hunks = computeHunks(before, after)
      expect(hunks.length).toBe(1)
      const removes = hunks[0].lines.filter(l => l.kind === 'remove').map(l => l.text)
      const adds = hunks[0].lines.filter(l => l.kind === 'add').map(l => l.text)
      expect(removes).toEqual(['OLD'])
      expect(adds).toEqual(['NEW'])
    })

    it('produces context lines with both old and new line numbers', () => {
      const hunks = computeHunks('a\nb\nc\n', 'a\nb\nz\nc\n')
      const ctx = hunks[0].lines.filter(l => l.kind === 'context')
      // Every context line should have BOTH coords populated.
      ctx.forEach(line => {
        expect(line.oldLine).toBeGreaterThan(0)
        expect(line.newLine).toBeGreaterThan(0)
      })
    })
  })

  describe('summarizeHunks', () => {
    it('counts adds and removes accurately for replacements', () => {
      const hunks = computeHunks('a\nold1\nold2\nb\n', 'a\nnew1\nnew2\nnew3\nb\n')
      const stats = summarizeHunks(hunks)
      expect(stats.added).toBe(3)
      expect(stats.removed).toBe(2)
      expect(stats.hunkCount).toBeGreaterThan(0)
    })

    it('returns zeros for noop diff', () => {
      const stats = summarizeHunks([])
      expect(stats).toEqual({ added: 0, removed: 0, hunkCount: 0 })
    })
  })

  describe('hunksToCurrentSpans', () => {
    it('emits a single add span for consecutive new lines', () => {
      const hunks = computeHunks('a\nb\n', 'a\nNEW1\nNEW2\nb\n')
      const spans = hunksToCurrentSpans(hunks)
      expect(spans).toHaveLength(1)
      expect(spans[0]).toEqual({ startLine: 2, endLine: 3, kind: 'add' })
    })

    it('marks add+remove run as change', () => {
      const hunks = computeHunks('a\nold\nb\n', 'a\nnew\nb\n')
      const spans = hunksToCurrentSpans(hunks)
      expect(spans.length).toBeGreaterThanOrEqual(1)
      // At least one span must be 'change' (because we removed and added on the same line range).
      expect(spans.some(s => s.kind === 'change')).toBe(true)
    })

    it('emits a remove anchor for pure deletion', () => {
      const hunks = computeHunks('a\ngone\nb\n', 'a\nb\n')
      const spans = hunksToCurrentSpans(hunks)
      expect(spans.some(s => s.kind === 'remove')).toBe(true)
    })
  })

  describe('classifyOperation', () => {
    it('classifies pure additions, removals, and changes', () => {
      expect(classifyOperation({ added: 0, removed: 0, hunkCount: 0 })).toBe('noop')
      expect(classifyOperation({ added: 3, removed: 0, hunkCount: 1 })).toBe('add')
      expect(classifyOperation({ added: 0, removed: 2, hunkCount: 1 })).toBe('remove')
      expect(classifyOperation({ added: 1, removed: 1, hunkCount: 1 })).toBe('change')
    })
  })
})
