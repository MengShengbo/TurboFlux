import { describe, expect, it } from 'vitest'
import {
  appendRuntimeContextToLatestUserMessage,
  normalizeAnthropicToolMessages,
} from './modelMessages'

describe('appendRuntimeContextToLatestUserMessage', () => {
  it('does not create a synthetic user turn after tool results', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'build the app' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc1' }] },
      { role: 'tool', tool_call_id: 'tc1', content: 'done' },
    ]

    const appended = appendRuntimeContextToLatestUserMessage(messages, '<runtime_context>internal</runtime_context>', 'openai')

    expect(appended).toBe(true)
    expect(messages).toHaveLength(4)
    expect(messages[1]?.content).toContain('build the app')
    expect(messages[1]?.content).toContain('<runtime_context>internal</runtime_context>')
    expect(messages.at(-1)).toMatchObject({ role: 'tool' })
  })

  it('appends to anthropic user content blocks', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: 'system' },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]

    const appended = appendRuntimeContextToLatestUserMessage(messages, '<runtime_context>internal</runtime_context>', 'anthropic')

    expect(appended).toBe(true)
    expect(messages).toHaveLength(3)
    expect(messages[1]?.content).toEqual([
      { type: 'text', text: 'continue' },
      { type: 'text', text: '<runtime_context>internal</runtime_context>' },
    ])
  })
})

describe('normalizeAnthropicToolMessages', () => {
  it('combines matching results and synthesizes missing results immediately after tool use', () => {
    const messages = normalizeAnthropicToolMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'tc1', name: 'read_file', input: { path: 'a.ts' } },
          { type: 'tool_use', id: 'tc2', name: 'read_file', input: { path: 'b.ts' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'a' }] },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ])

    expect(messages).toHaveLength(3)
    expect(messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tc1', content: 'a' },
        {
          type: 'tool_result',
          tool_use_id: 'tc2',
          content: 'Cancelled before the tool completed.',
          is_error: true,
        },
        { type: 'text', text: 'continue' },
      ],
    })
  })

  it('drops orphan and duplicate tool results', () => {
    const messages = normalizeAnthropicToolMessages([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'bad' }, { type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tc1', name: 'read_file', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'first' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'duplicate' }] },
    ])

    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'hello' }] })
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'first' }],
    })
  })
})
