import { describe, expect, it } from 'vitest'
import {
  clipTextToRows,
  getEngineUserOrdinalForUiMessage,
  formatTaskProgressLabel,
  formatTaskToolSummary,
  shouldUseNoFlicker,
  sliceTurnsBeforeNthUserTurn,
  turnsToMessages,
} from './App'
import type { Message } from './messages/Messages'
import type { AgentTurn } from '../../shared/agentTypes'

describe('no-flicker mode selection', () => {
  it('uses the fixed cockpit by default for interactive sessions', () => {
    expect(shouldUseNoFlicker(true)).toBe(true)
  })

  it('keeps the fixed viewport when explicitly requested', () => {
    expect(shouldUseNoFlicker(true, undefined, true)).toBe(true)
  })

  it('stays disabled for one-shot and non-interactive output', () => {
    expect(shouldUseNoFlicker(true, 'hello', true)).toBe(false)
    expect(shouldUseNoFlicker(false, undefined, true)).toBe(false)
  })

  it('can opt back into classic terminal scrollback', () => {
    expect(shouldUseNoFlicker(true, undefined, false)).toBe(false)
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

describe('task progress labels', () => {
  it('does not surface 99% as the primary task state', () => {
    expect(formatTaskProgressLabel(0)).toBe('')
    expect(formatTaskProgressLabel(42)).toBe('42%')
    expect(formatTaskProgressLabel(99)).toBe('finishing')
    expect(formatTaskProgressLabel(100)).toBe('')
  })

  it('summarizes task tools without a fake percentage', () => {
    expect(formatTaskToolSummary(0, 0, 0, 0)).toBe('planning')
    expect(formatTaskToolSummary(2, 4, 1, 0)).toBe('tools 2/4, 1 running')
    expect(formatTaskToolSummary(3, 4, 0, 1)).toBe('tools 3/4, 1 failed')
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

describe('interrupted assistant messages', () => {
  it('preserves the interrupted marker when restoring engine turns', () => {
    const messages = turnsToMessages([{
      id: 'partial-assistant',
      role: 'assistant',
      content: 'partial response',
      timestamp: 1,
      metadata: { interrupted: true },
    }])

    expect(messages).toEqual([expect.objectContaining({
      id: 'partial-assistant',
      content: 'partial response',
      interrupted: true,
    })])
  })
})
