import { describe, expect, it } from 'vitest'
import {
  activeConversationNavigatorIndices,
  compactConversationNavigatorText,
  conversationNavigatorMinimumItems,
  conversationNavigatorMarkerVisual,
  pairConversationNavigatorTasks,
} from './conversationNavigator'

describe('conversation navigator', () => {
  it('compacts hover summaries without leaving broken whitespace', () => {
    expect(compactConversationNavigatorText('  first\n\nsecond  ', 20)).toBe('first second')
    expect(compactConversationNavigatorText('abcdefghijklmnopqrstuvwxyz', 10)).toBe('abcdefghi…')
  })

  it('matches the Codex marker magnification curve', () => {
    expect(conversationNavigatorMarkerVisual(5)).toEqual({ opacity: 0.4, scaleX: 0.2308, tone: 'idle' })
    expect(conversationNavigatorMarkerVisual(5, 5)).toEqual({ opacity: 1, scaleX: 1, tone: 'focus' })
    expect(conversationNavigatorMarkerVisual(4, 5)).toEqual({ opacity: 0.4, scaleX: 0.7692, tone: 'near' })
    expect(conversationNavigatorMarkerVisual(7, 5)).toEqual({ opacity: 0.4, scaleX: 0.5385, tone: 'mid' })
    expect(conversationNavigatorMarkerVisual(8, 5)).toEqual({ opacity: 0.4, scaleX: 0.3846, tone: 'far' })
    expect(conversationNavigatorMarkerVisual(1, 5)).toEqual({ opacity: 0.4, scaleX: 0.2308, tone: 'idle' })
  })

  it('tracks every user-message section intersecting the viewport', () => {
    expect(activeConversationNavigatorIndices([0, 180, 520, 900], 400, 500)).toEqual([1, 2])
    expect(activeConversationNavigatorIndices([0, 180, 520, 900], 0, 500)).toEqual([0, 1])
    expect(activeConversationNavigatorIndices([], 0, 500)).toEqual([])
  })

  it('only appears for a useful Codex-sized message history', () => {
    expect(conversationNavigatorMinimumItems).toBe(4)
  })

  it('pairs one navigator node with each complete task turn', () => {
    expect(pairConversationNavigatorTasks([
      { kind: 'input', runId: 'run-1' },
      { kind: 'answer', runId: 'run-1' },
      { kind: 'answer', runId: 'run-1', finalDelivery: true },
      { kind: 'input', runId: 'run-2' },
      { kind: 'answer', runId: 'run-2', finalDelivery: true },
    ])).toEqual([
      { inputIndex: 0, answerIndex: 2 },
      { inputIndex: 3, answerIndex: 4 },
    ])
  })

  it('falls back to the last answer before the next task', () => {
    expect(pairConversationNavigatorTasks([
      { kind: 'input', runId: '' },
      { kind: 'answer', runId: '' },
      { kind: 'input', runId: '' },
    ])).toEqual([
      { inputIndex: 0, answerIndex: 1 },
      { inputIndex: 2, answerIndex: undefined },
    ])
  })

  it('gives steering messages their own navigation entries', () => {
    expect(pairConversationNavigatorTasks([
      { kind: 'input', runId: 'run-1' },
      { kind: 'answer', runId: 'run-1' },
      { kind: 'input', runId: 'run-1' },
      { kind: 'answer', runId: 'run-1', finalDelivery: true },
    ])).toEqual([
      { inputIndex: 0, answerIndex: 1 },
      { inputIndex: 2, answerIndex: 3 },
    ])
  })
})
