import { describe, expect, it } from 'vitest'
import {
  createTranscriptFollowState,
  forceTranscriptFollow,
  historyRewriteLeadingSpace,
  historyRewriteTailSpace,
  suspendTranscriptFollow,
  transcriptDistanceFromBottom,
  updateTranscriptFollowFromScroll,
} from './transcriptFollow'

describe('transcript bottom following', () => {
  it('reserves a stable response region after an edited message', () => {
    expect(historyRewriteTailSpace({ clientHeight: 700, contentAfterAnchorHeight: 0 })).toBe(294)
    expect(historyRewriteTailSpace({ clientHeight: 700, contentAfterAnchorHeight: 120 })).toBe(174)
  })

  it('releases the edited-message reserve as the new response grows', () => {
    expect(historyRewriteTailSpace({ clientHeight: 700, contentAfterAnchorHeight: 294 })).toBe(0)
    expect(historyRewriteTailSpace({ clientHeight: 700, contentAfterAnchorHeight: 500 })).toBe(0)
  })

  it('keeps the rewrite reserve within a small viewport', () => {
    expect(historyRewriteTailSpace({ clientHeight: 240, contentAfterAnchorHeight: 0 })).toBe(144)
  })

  it('pushes a short rewritten branch away from the viewport top', () => {
    expect(historyRewriteLeadingSpace({
      clientHeight: 700,
      contentBeforeAnchorHeight: 0,
      anchorHeight: 70,
      contentAfterAnchorHeight: 0,
    })).toBe(336)
  })

  it('removes leading rewrite space as the response fills the viewport', () => {
    expect(historyRewriteLeadingSpace({
      clientHeight: 700,
      contentBeforeAnchorHeight: 0,
      anchorHeight: 70,
      contentAfterAnchorHeight: 120,
    })).toBe(216)
    expect(historyRewriteLeadingSpace({
      clientHeight: 700,
      contentBeforeAnchorHeight: 0,
      anchorHeight: 70,
      contentAfterAnchorHeight: 400,
    })).toBe(0)
  })

  it('keeps following when content grows without user scrolling', () => {
    const state = createTranscriptFollowState({ scrollHeight: 600, scrollTop: 200, clientHeight: 400 })
    expect(state.following).toBe(true)
    expect(transcriptDistanceFromBottom({ scrollHeight: 1_100, scrollTop: 200, clientHeight: 400 })).toBe(500)
    expect(state.following).toBe(true)
  })

  it('stops following when the user scrolls upward', () => {
    const state = createTranscriptFollowState({ scrollHeight: 1_000, scrollTop: 600, clientHeight: 400 })
    const next = updateTranscriptFollowFromScroll(state, { scrollHeight: 1_000, scrollTop: 520, clientHeight: 400 }, true)
    expect(next.following).toBe(false)
  })

  it('does not resume until the user returns to the bottom', () => {
    const state = suspendTranscriptFollow(createTranscriptFollowState({ scrollHeight: 1_000, scrollTop: 600, clientHeight: 400 }))
    const nearBottom = updateTranscriptFollowFromScroll(state, { scrollHeight: 1_000, scrollTop: 597, clientHeight: 400 }, true)
    expect(nearBottom.following).toBe(false)
    const bottom = updateTranscriptFollowFromScroll(nearBottom, { scrollHeight: 1_000, scrollTop: 600, clientHeight: 400 })
    expect(bottom.following).toBe(true)
  })

  it('preserves follow state during programmatic scroll and layout updates', () => {
    const state = createTranscriptFollowState({ scrollHeight: 600, scrollTop: 200, clientHeight: 400 })
    const grown = updateTranscriptFollowFromScroll(state, { scrollHeight: 1_200, scrollTop: 200, clientHeight: 400 })
    expect(grown.following).toBe(true)
    const collapsed = updateTranscriptFollowFromScroll(grown, { scrollHeight: 900, scrollTop: 100, clientHeight: 400 })
    expect(collapsed.following).toBe(true)
    expect(forceTranscriptFollow(suspendTranscriptFollow(grown), { scrollHeight: 1_200, scrollTop: 200, clientHeight: 400 }).following).toBe(true)
  })
})
