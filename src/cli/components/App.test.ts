import { describe, expect, it } from 'vitest'
import {
  appendLiveReasoningTail,
  appendLiveStreamTail,
  appendTranscriptBuffer,
  createMessageIdFactory,
  getEngineUserOrdinalForUiMessage,
  createThinkingTrace,
  formatTaskProgressLabel,
  formatTaskToolSummary,
  getProvisionalAssistantText,
  isThinkingToggleShortcut,
  resolveAssistantStreamDisplay,
  resolveLandingFrameWidth,
  selectAutoMountedModel,
  StreamTextAccumulator,
  shouldUseFlowUi,
  shouldUseNoFlicker,
  shouldShowLandingView,
  sliceTurnsBeforeNthUserTurn,
  turnsToMessages,
} from './App'
import type { Message } from './messages/Messages'
import type { AgentTurn } from '../../shared/agentTypes'

describe('message identifiers', () => {
  it('keeps ids unique across calls and process namespaces', () => {
    const firstRun = createMessageIdFactory('run-a')
    const secondRun = createMessageIdFactory('run-b')

    expect([firstRun(), firstRun(), secondRun()]).toEqual([
      'msg-run-a-1',
      'msg-run-a-2',
      'msg-run-b-1',
    ])
  })
})

describe('live reasoning buffer', () => {
  it('retains only the configured reasoning tail', () => {
    const first = appendLiveReasoningTail('', 'abcdefgh', 6)
    const second = appendLiveReasoningTail(first, 'ijkl', 6)

    expect(first).toBe('cdefgh')
    expect(second).toBe('ghijkl')
  })
})

describe('live stream buffer', () => {
  it('keeps complete output bounded and exposes a small display tail', () => {
    const accumulator = new StreamTextAccumulator(10)
    expect(accumulator.append('abcdef')).toBe('abcdef')
    expect(accumulator.append('ghijkl')).toBe('ghij')
    expect(accumulator.length).toBe(10)
    expect(accumulator.toString()).toContain('abcdefghij')
    expect(appendLiveStreamTail('', 'abcdefghij', 4)).toBe('ghij')
    expect(appendLiveStreamTail('abcd', 'ef', 4)).toBe('cdef')
  })
})

describe('classic static transcript buffer', () => {
  it('keeps the logical item cursor growing when old messages are trimmed', () => {
    const initial = appendTranscriptBuffer(
      { messages: [], staticRevision: 0, staticItemOffset: 0 },
      Array.from({ length: 1_000 }, (_, index) => ({
        id: `message-${index}`,
        role: 'assistant' as const,
        content: `message ${index}`,
      })),
    )
    const firstTrim = appendTranscriptBuffer(initial, [{ id: 'message-1000', role: 'assistant', content: 'newest' }])
    const secondTrim = appendTranscriptBuffer(firstTrim, [{ id: 'message-1001', role: 'assistant', content: 'newest again' }])

    expect(firstTrim.messages[0]?.id).toMatch(/^transcript-trim-/)
    expect(firstTrim.staticItemOffset + firstTrim.messages.filter(message => !message.id.startsWith('transcript-trim-')).length).toBe(1_001)
    expect(secondTrim.staticItemOffset + secondTrim.messages.filter(message => !message.id.startsWith('transcript-trim-')).length).toBe(1_002)
  })

  it('does not advance the static cursor for a deduplicated progress row', () => {
    const state = appendTranscriptBuffer(
      { messages: [], staticRevision: 0, staticItemOffset: 0 },
      [{ id: 'progress-1', role: 'assistant', content: 'Still working', progress: true }],
    )

    expect(appendTranscriptBuffer(state, [
      { id: 'progress-2', role: 'assistant', content: ' Still working ', progress: true },
    ], { dedupeTail: true })).toBe(state)
  })
})

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

describe('Flow UI selection', () => {
  it('uses Flow selectors by default and supports an emergency read-source rollback', () => {
    expect(shouldUseFlowUi(undefined)).toBe(true)
    expect(shouldUseFlowUi('1')).toBe(true)
    expect(shouldUseFlowUi('off')).toBe(false)
    expect(shouldUseFlowUi('0')).toBe(false)
  })
})

describe('adaptive shell layout', () => {
  it('keeps the landing prompt centered without overflowing narrow terminals', () => {
    expect(resolveLandingFrameWidth(30)).toBe(24)
    expect(resolveLandingFrameWidth(120)).toBe(76)
    expect(resolveLandingFrameWidth(240)).toBe(96)
  })

  it('uses the landing view only before a session has meaningful activity', () => {
    const idle = {
      messageCount: 0,
      isRunning: false,
      hasPendingAsk: false,
      cursorMode: false,
      hasOverlay: false,
      queuedCount: 0,
    }
    expect(shouldShowLandingView(idle)).toBe(true)
    expect(shouldShowLandingView({ ...idle, messageCount: 1 })).toBe(false)
    expect(shouldShowLandingView({ ...idle, isRunning: true })).toBe(false)
    expect(shouldShowLandingView({ ...idle, hasOverlay: true })).toBe(false)
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
  it('never promotes provider reasoning into the visible answer', () => {
    expect(resolveAssistantStreamDisplay('', 'Internal provider reasoning', false, false)).toEqual({
      visibleText: '',
      thinkingText: 'Internal provider reasoning',
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
  it('restores tool-loop assistant text as visible progress instead of swallowing it', () => {
    const messages = turnsToMessages([
      {
        id: 'assistant-tool-step',
        role: 'assistant',
        content: 'The directory is probably empty.',
        timestamp: 1,
        toolCalls: [{ id: 'tool-1', name: 'list_directory', arguments: { path: 'C:/Desktop' } }],
      },
      {
        id: 'tool-result',
        role: 'tool_result',
        content: 'list_directory: [ok]',
        timestamp: 2,
        toolResults: [{
          toolCallId: 'tool-1',
          name: 'list_directory',
          output: '[DIR] project',
          isError: false,
        }],
      },
      {
        id: 'assistant-final',
        role: 'assistant',
        content: 'The desktop contains project.',
        timestamp: 3,
      },
    ])

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      id: 'assistant-tool-step',
      content: 'The directory is probably empty.',
      progress: true,
      tools: [expect.objectContaining({ id: 'tool-1', status: 'done' })],
    })
    expect(messages[1]).toMatchObject({ id: 'assistant-final', content: 'The desktop contains project.' })
  })

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

  it('restores notify_user progress from persisted tool arguments', () => {
    const turn: AgentTurn = {
      id: 'assistant-notify',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolCalls: [{
        id: 'notify-1',
        name: 'notify_user',
        arguments: { message: 'Repository mapping is complete; next I am patching the API.' },
      }],
    }

    expect(getProvisionalAssistantText(turn)).toContain('Repository mapping is complete')
    expect(turnsToMessages([turn])[0]).toMatchObject({
      content: 'Repository mapping is complete; next I am patching the API.',
      progress: true,
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
