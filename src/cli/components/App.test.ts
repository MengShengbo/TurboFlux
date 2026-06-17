import { describe, expect, it } from 'vitest'
import {
  buildTranscriptSlice,
  clipTextToRows,
  getNextTranscriptOffsetAfterAppend,
  getEngineUserOrdinalForUiMessage,
  shouldUseNoFlicker,
  sliceTurnsBeforeNthUserTurn,
} from './App'
import type { Message } from './messages/Messages'
import type { AgentTurn } from '../../shared/agentTypes'

function message(id: string, content: string): Message {
  return { id, role: 'assistant', content }
}

function diffMessage(id: string): Message {
  return {
    id,
    role: 'assistant',
    content: '',
    changes: [{
      path: 'src/example.ts',
      operation: 'edit',
      before: 'const value = 1\n',
      after: 'const value = 2\n',
    }],
  }
}

describe('no-flicker transcript slicing', () => {
  it('keeps the newest messages inside the row budget', () => {
    const messages = [
      message('1', 'one'),
      message('2', 'two'),
      message('3', 'three'),
      message('4', 'four'),
    ]

    const slice = buildTranscriptSlice(messages, 6, 80, 0)

    expect(slice.start).toBe(2)
    expect(slice.end).toBe(4)
    expect(slice.messages.map(m => m.id)).toEqual(['3', '4'])
  })

  it('can page upward from the latest transcript tail', () => {
    const messages = [
      message('1', 'one'),
      message('2', 'two'),
      message('3', 'three'),
      message('4', 'four'),
    ]

    const slice = buildTranscriptSlice(messages, 6, 80, 2)

    expect(slice.start).toBe(0)
    expect(slice.end).toBe(2)
    expect(slice.messages.map(m => m.id)).toEqual(['1', '2'])
  })

  it('clips an oversized single message instead of overflowing the viewport', () => {
    const longText = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')

    const slice = buildTranscriptSlice([message('1', longText)], 5, 80, 0)

    expect(slice.start).toBe(0)
    expect(slice.end).toBe(1)
    expect(slice.messages[0]?.content).toContain('[... clipped for screen ...]')
    expect(slice.messages[0]?.content).toContain('line 20')
  })

  it('budgets diff cards as rendered rows when slicing history', () => {
    const slice = buildTranscriptSlice([
      diffMessage('diff'),
      message('plain', 'tail'),
    ], 8, 80, 0, 0)

    expect(slice.messages.map(m => m.id)).toEqual(['diff', 'plain'])
  })
})

describe('no-flicker mode selection', () => {
  it('uses normal terminal scrollback by default for interactive sessions', () => {
    expect(shouldUseNoFlicker(true)).toBe(false)
  })

  it('can use the fixed viewport when explicitly requested', () => {
    expect(shouldUseNoFlicker(true, undefined, true)).toBe(true)
  })

  it('stays disabled for one-shot and non-interactive output', () => {
    expect(shouldUseNoFlicker(true, 'hello', true)).toBe(false)
    expect(shouldUseNoFlicker(false, undefined, true)).toBe(false)
  })

  it('can be disabled for terminals that dislike alternate screen', () => {
    const previous = process.env.TURBOFLUX_NO_FLICKER
    process.env.TURBOFLUX_NO_FLICKER = '0'

    try {
      expect(shouldUseNoFlicker(true)).toBe(false)
    } finally {
      if (previous === undefined) {
        delete process.env.TURBOFLUX_NO_FLICKER
      } else {
        process.env.TURBOFLUX_NO_FLICKER = previous
      }
    }
  })

  it('can be forced on through the environment for compatibility', () => {
    const previous = process.env.TURBOFLUX_NO_FLICKER
    process.env.TURBOFLUX_NO_FLICKER = '1'

    try {
      expect(shouldUseNoFlicker(true)).toBe(true)
    } finally {
      if (previous === undefined) {
        delete process.env.TURBOFLUX_NO_FLICKER
      } else {
        process.env.TURBOFLUX_NO_FLICKER = previous
      }
    }
  })
})

describe('clipTextToRows', () => {
  it('returns unchanged text when it fits', () => {
    expect(clipTextToRows('short\ntext', 4, 80)).toBe('short\ntext')
  })

  it('keeps the tail of a very long line', () => {
    const clipped = clipTextToRows('x'.repeat(200), 2, 40)

    expect(clipped).toContain('[... clipped for screen ...]')
    expect(clipped.endsWith('x'.repeat(64))).toBe(true)
  })
})

describe('transcript offset behavior', () => {
  it('stays pinned to latest when the viewport is already at the bottom', () => {
    expect(getNextTranscriptOffsetAfterAppend(0, 2, true)).toBe(0)
  })

  it('preserves the current history view when new messages append', () => {
    expect(getNextTranscriptOffsetAfterAppend(3, 2, false)).toBe(5)
  })
})

describe('rewind helpers', () => {
  it('maps a UI user message back to the corresponding engine user ordinal', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'first' },
      { id: 'a1', role: 'assistant', content: 'reply one' },
      { id: 'u2', role: 'user', content: 'second' },
      { id: 'a2', role: 'assistant', content: 'reply two' },
    ]
    const turns: AgentTurn[] = [
      { id: 'turn-u1', role: 'user', content: 'first', timestamp: 1 },
      { id: 'turn-a1', role: 'assistant', content: 'reply one', timestamp: 2 },
      { id: 'turn-u2', role: 'user', content: 'second', timestamp: 3 },
      { id: 'turn-a2', role: 'assistant', content: 'reply two', timestamp: 4 },
    ]

    expect(getEngineUserOrdinalForUiMessage(messages, turns, 2)).toBe(1)
  })

  it('slices turns to immediately before the selected user turn', () => {
    const turns: AgentTurn[] = [
      { id: 'turn-u1', role: 'user', content: 'first', timestamp: 1 },
      { id: 'turn-a1', role: 'assistant', content: 'reply one', timestamp: 2 },
      { id: 'turn-u2', role: 'user', content: 'second', timestamp: 3 },
      { id: 'turn-a2', role: 'assistant', content: 'reply two', timestamp: 4 },
    ]

    expect(sliceTurnsBeforeNthUserTurn(turns, 1).map(turn => turn.id)).toEqual(['turn-u1', 'turn-a1'])
  })
})
