export interface TranscriptScrollMetrics {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

export interface TranscriptFollowState {
  following: boolean
  lastScrollTop: number
}

const bottomTolerance = 2
const scrollDirectionTolerance = 0.5
const historyRewriteTailRatio = 0.42
const historyRewriteMinimumTail = 180
const historyRewriteMaximumTail = 360
const historyRewriteMinimumAnchorSpace = 96

export function transcriptDistanceFromBottom(metrics: TranscriptScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight)
}

export function historyRewriteTailSpace(input: {
  clientHeight: number
  contentAfterAnchorHeight: number
}): number {
  const availableHeight = Math.max(0, input.clientHeight - historyRewriteMinimumAnchorSpace)
  const desiredTailHeight = Math.min(
    historyRewriteMaximumTail,
    availableHeight,
    Math.max(historyRewriteMinimumTail, input.clientHeight * historyRewriteTailRatio),
  )
  return Math.max(0, desiredTailHeight - Math.max(0, input.contentAfterAnchorHeight))
}

export function historyRewriteLeadingSpace(input: {
  clientHeight: number
  contentBeforeAnchorHeight: number
  anchorHeight: number
  contentAfterAnchorHeight: number
}): number {
  const desiredTailHeight = historyRewriteTailSpace({
    clientHeight: input.clientHeight,
    contentAfterAnchorHeight: 0,
  })
  const desiredAnchorTop = Math.max(
    0,
    input.clientHeight - desiredTailHeight - Math.max(0, input.anchorHeight),
  )
  return Math.max(
    0,
    desiredAnchorTop
      - Math.max(0, input.contentBeforeAnchorHeight)
      - Math.max(0, input.contentAfterAnchorHeight),
  )
}

export function createTranscriptFollowState(metrics: TranscriptScrollMetrics): TranscriptFollowState {
  return {
    following: true,
    lastScrollTop: metrics.scrollTop,
  }
}

export function forceTranscriptFollow(
  _state: TranscriptFollowState,
  metrics: TranscriptScrollMetrics,
): TranscriptFollowState {
  return {
    following: true,
    lastScrollTop: metrics.scrollTop,
  }
}

export function suspendTranscriptFollow(state: TranscriptFollowState): TranscriptFollowState {
  return { ...state, following: false }
}

export function updateTranscriptFollowFromScroll(
  state: TranscriptFollowState,
  metrics: TranscriptScrollMetrics,
  userInitiated = false,
): TranscriptFollowState {
  const reachedBottom = transcriptDistanceFromBottom(metrics) <= bottomTolerance
  const movedUp = metrics.scrollTop < state.lastScrollTop - scrollDirectionTolerance
  return {
    following: reachedBottom || (userInitiated && movedUp ? false : state.following),
    lastScrollTop: metrics.scrollTop,
  }
}
