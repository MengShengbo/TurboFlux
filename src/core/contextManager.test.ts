import { describe, expect, it } from 'vitest'
import type { AgentTurn } from '../shared/agentTypes'
import type { ContextSegment } from '../state/types'
import { ContextManager } from './contextManager'

function userTurn(id: string, content: string): AgentTurn {
  return { id, role: 'user', content, timestamp: 1 }
}

function segment(params: Partial<ContextSegment> & { summary: string }): ContextSegment {
  return {
    startMessageId: params.startMessageId ?? 'start',
    endMessageId: params.endMessageId ?? 'end',
    summary: params.summary,
    isModelGenerated: params.isModelGenerated ?? true,
    originalCharCount: params.originalCharCount ?? params.summary.length,
    isValid: params.isValid ?? true,
    createdAt: params.createdAt,
    checkpointId: params.checkpointId,
  }
}

describe('ContextManager', () => {
  it('injects valid compressed conversation segments as a cache-safe context message', () => {
    const manager = new ContextManager()
    const messages = manager.buildMessages(
      [userTurn('u1', 'continue please')],
      'system prompt',
      1_000_000,
      'openai',
      4096,
      [
        segment({
          startMessageId: 'u-old',
          endMessageId: 'a-old',
          summary: '<continuation_summary>old task state</continuation_summary>',
          createdAt: 10,
        }),
      ],
      undefined,
      'gpt-5.5',
    )

    expect(messages[0]).toMatchObject({ role: 'system' })
    expect(messages[0]?.content).toBe('system prompt')
    expect(messages[1]).toMatchObject({ role: 'user' })
    expect(messages[1]?.content).toContain('<compressed_conversation_history>')
    expect(messages[1]?.content).toContain('old task state')
    expect(messages[1]?.content).toContain('Earlier conversation turns were compacted')
  })

  it('does not inject invalid or empty context segments', () => {
    const manager = new ContextManager()
    const messages = manager.buildMessages(
      [userTurn('u1', 'continue please')],
      'system prompt',
      1_000_000,
      'openai',
      4096,
      [
        segment({ summary: 'valid segment', createdAt: 1 }),
        segment({ summary: 'invalid segment', isValid: false, createdAt: 2 }),
        segment({ summary: '   ', createdAt: 3 }),
      ],
      undefined,
      'gpt-5.5',
    )

    expect(messages[1]?.content).toContain('valid segment')
    expect(messages[1]?.content).not.toContain('invalid segment')
  })

  it('does not duplicate recap segments while the covered turns are still live', () => {
    const manager = new ContextManager()
    const messages = manager.buildMessages(
      [userTurn('u-old', 'original task'), userTurn('a-old', 'assistant note'), userTurn('u1', 'continue please')],
      'system prompt',
      1_000_000,
      'openai',
      4096,
      [
        segment({
          startMessageId: 'u-old',
          endMessageId: 'a-old',
          summary: '<cache_safe_recap>old task state</cache_safe_recap>',
          createdAt: 10,
        }),
      ],
      undefined,
      'gpt-5.5',
    )

    expect(messages.some(message => String(message.content).includes('cache_safe_recap'))).toBe(false)
  })

  it('tracks provider usage without local estimates', () => {
    const manager = new ContextManager()

    expect(manager.getLastProviderUsage()).toEqual({ source: 'unknown' })

    manager.updateTokenCounting(42_000, 500)

    expect(manager.getLastProviderUsage()).toEqual({
      input: 42_000,
      output: 500,
      total: 42_500,
      source: 'provider',
    })
  })

  it('deduplicates read_file_full with later reads of the same path', () => {
    const manager = new ContextManager()
    const turns: AgentTurn[] = [
      userTurn('u1', 'inspect file'),
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: 2,
        toolCalls: [{ id: 'tc-full', name: 'read_file_full', arguments: { path: 'src/a.ts' } }],
      },
      {
        id: 'tr1',
        role: 'tool_result',
        content: '',
        timestamp: 3,
        toolResults: [{ toolCallId: 'tc-full', name: 'read_file_full', output: 'export const oldHint = 1\nlarge stale body', isError: false }],
      },
      {
        id: 'a2',
        role: 'assistant',
        content: '',
        timestamp: 4,
        toolCalls: [{ id: 'tc-range', name: 'read_file', arguments: { path: 'src/a.ts', offset: 1, limit: 5 } }],
      },
      {
        id: 'tr2',
        role: 'tool_result',
        content: '',
        timestamp: 5,
        toolResults: [{ toolCallId: 'tc-range', name: 'read_file', output: 'latest range content', isError: false }],
      },
    ]

    const messages = manager.buildMessages(turns, 'system prompt', 1_000_000, 'openai', 4096, undefined, undefined, 'gpt-5.5')
    const toolMessages = messages.filter(message => message.role === 'tool')

    expect(toolMessages[0]?.content).toContain('[evicted: src/a.ts')
    expect(toolMessages[0]?.content).toContain('oldHint')
    expect(toolMessages[0]?.content).not.toContain('large stale body')
    expect(toolMessages[1]?.content).toBe('latest range content')
  })

  it('budgets messages for smaller model windows by summarizing older live turns', () => {
    const manager = new ContextManager()
    const turns: AgentTurn[] = [
      userTurn('u1', `original goal ${'old '.repeat(5000)}`),
      {
        id: 'a1',
        role: 'assistant',
        content: `old assistant ${'details '.repeat(5000)}`,
        timestamp: 2,
      },
      userTurn('u2', 'recent user request'),
      {
        id: 'a2',
        role: 'assistant',
        content: 'recent assistant answer',
        timestamp: 3,
      },
    ]

    const messages = manager.buildMessages(turns, 'system prompt', 12_000, 'openai', 1_000, undefined, undefined, 'gpt-5.5')

    expect(messages[0]).toMatchObject({ role: 'system' })
    expect(messages.some(message => String(message.content).includes('<windowed_history_summary>'))).toBe(true)
    expect(messages.some(message => String(message.content).includes('recent user request'))).toBe(true)
    expect(messages.some(message => String(message.content).includes('details '.repeat(100)))).toBe(false)
  })

  it('uses rough estimates to budget models without a local tokenizer', () => {
    const manager = new ContextManager()
    const turns: AgentTurn[] = [
      userTurn('u1', `original goal ${'old '.repeat(5000)}`),
      {
        id: 'a1',
        role: 'assistant',
        content: `old assistant ${'details '.repeat(5000)}`,
        timestamp: 2,
      },
      userTurn('u2', 'recent user request'),
      {
        id: 'a2',
        role: 'assistant',
        content: 'recent assistant answer',
        timestamp: 3,
      },
      userTurn('u3', 'final follow up'),
    ]

    const messages = manager.buildMessages(turns, 'system prompt', 6_000, 'openai', 1_000, undefined, undefined, 'deepseek-v4-pro')

    expect(messages.some(message => String(message.content).includes('<windowed_history_summary>'))).toBe(true)
    expect(messages.some(message => String(message.content).includes('recent user request'))).toBe(true)
  })
})
