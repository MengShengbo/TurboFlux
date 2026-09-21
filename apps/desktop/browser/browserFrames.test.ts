import { describe, expect, it } from 'vitest'
import {
  browserFrameRefPrefix,
  interleaveBrowserFrameElements,
  isBrowserRefForEpoch,
  transientBrowserTabIds,
} from './browserFrames'

describe('browser frame refs', () => {
  it('scopes refs to an observation epoch and frame', () => {
    const ref = `${browserFrameRefPrefix(37, 4)}-e1`
    expect(ref).toBe('o11-r4-e1')
    expect(isBrowserRefForEpoch(ref, 37)).toBe(true)
    expect(isBrowserRefForEpoch(ref, 38)).toBe(false)
  })

  it('rejects refs from another tab even when epochs and frame indexes match', () => {
    const ref = `${browserFrameRefPrefix(3, 0, 'tab-a')}-e1`
    expect(isBrowserRefForEpoch(ref, 3, 'tab-a')).toBe(true)
    expect(isBrowserRefForEpoch(ref, 3, 'tab-b')).toBe(false)
  })

  it('keeps child frames represented under a global element cap', () => {
    const merged = interleaveBrowserFrameElements([
      { frameIndex: 0, elements: ['main-1', 'main-2', 'main-3'] },
      { frameIndex: 1, elements: ['child-1', 'child-2'] },
      { frameIndex: 2, elements: ['nested-1'] },
    ], 4)
    expect(merged).toEqual([
      { frameIndex: 0, element: 'main-1' },
      { frameIndex: 1, element: 'child-1' },
      { frameIndex: 2, element: 'nested-1' },
      { frameIndex: 0, element: 'main-2' },
    ])
  })

  it('cleans up only unmarked task tabs', () => {
    expect(transientBrowserTabIds([
      { id: 'research', retention: 'transient' },
      { id: 'result', retention: 'deliverable' },
      { id: 'continue', retention: 'handoff' },
    ])).toEqual(['research'])
  })
})
