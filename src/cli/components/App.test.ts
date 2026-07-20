import { describe, expect, it } from 'vitest'
import {
  getEngineUserOrdinalForUiMessage,
  createThinkingTrace,
  formatTaskProgressLabel,
  formatTaskToolSummary,
  isThinkingToggleShortcut,
  resolveAssistantStreamDisplay,
  selectAutoMountedModel,
  shouldUseNoFlicker,
  sliceTurnsBeforeNthUserTurn,
  turnsToMessages,
} from './App'
import type { Message } from './messages/Messages'
import type { AgentTurn } from '../../shared/agentTypes'

describe('no-flicker mode selection', () => {
  it('keeps the full fixed cockpit by default for interactive sessions', () => {
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

describe('automatic model mounting', () => {
  const model = {
    id: 'first-model',
    name: 'First model',
    model: 'first-model',
    provider: 'custom' as const,
    baseUrl: 'https://example.com/v1',
    contextWindow: 200_000,
    maxTokens: 16_384,
    description: 'Discovered model',
  }

  it('mounts the first model returned by network discovery', () => {
    expect(selectAutoMountedModel('', 'network', [model])).toBe(model)
    expect(selectAutoMountedModel('', 'cache', [model])).toBe(model)
  })

  it('does not replace a manual model or mount fallback guesses', () => {
    expect(selectAutoMountedModel('manual-model', 'network', [model])).toBeUndefined()
    expect(selectAutoMountedModel('', 'fallback', [model])).toBeUndefined()
  })
})

describe('reasoning visibility shortcut', () => {
  it('uses the Claude Code compatible Ctrl+O binding', () => {
    expect(isThinkingToggleShortcut('o', true)).toBe(true)
    expect(isThinkingToggleShortcut('O', true)).toBe(true)
    expect(isThinkingToggleShortcut('t', true)).toBe(false)
    expect(isThinkingToggleShortcut('o', false)).toBe(false)
  })
})

describe('stream display classification', () => {
  it('promotes reasoning-only completed output to the visible answer', () => {
    expect(resolveAssistantStreamDisplay('', 'Visible provider answer', false, false)).toEqual({
      visibleText: 'Visible provider answer',
      thinkingText: '',
    })
  })

  it('keeps genuine reasoning separate when text, tools, or interruption exist', () => {
    expect(resolveAssistantStreamDisplay('Answer', 'Reasoning', false, false)).toEqual({
      visibleText: 'Answer',
      thinkingText: 'Reasoning',
    })
    expect(resolveAssistantStreamDisplay('', 'Partial reasoning', false, true).thinkingText).toBe('Partial reasoning')
    expect(resolveAssistantStreamDisplay('', 'Tool reasoning', true, false).thinkingText).toBe('Tool reasoning')
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

  it('restores provider reasoning as a separate folded trace', () => {
    const messages = turnsToMessages([{
      id: 'assistant-thinking',
      role: 'assistant',
      content: 'final answer',
      timestamp: 1,
      metadata: {
        reasoningEffort: 'high',
        thinking: { content: 'inspect first', source: 'provider', durationMs: 1200 },
      },
    }])

    expect(messages[0]).toMatchObject({
      content: 'final answer',
      thinking: { content: 'inspect first', effort: 'high', durationMs: 1200 },
    })
  })

  it('marks interrupted live reasoning without mixing it into the answer', () => {
    expect(createThinkingTrace('partial reasoning', Date.now() - 100, true)).toMatchObject({
      content: 'partial reasoning',
      status: 'interrupted',
      isStreaming: false,
    })
  })
})
