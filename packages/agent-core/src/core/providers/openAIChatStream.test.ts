import { describe, expect, it, vi } from 'vitest'
import { OpenAIChatStreamParser } from './openAIChatStream'

function createParser() {
  const onTextDelta = vi.fn()
  const onReasoningDelta = vi.fn()
  const onToolCallDelta = vi.fn()
  const onUsage = vi.fn()
  const parser = new OpenAIChatStreamParser({
    extractReasoningDelta: delta => {
      const value = delta as { reasoning_content?: string }
      return value?.reasoning_content || ''
    },
    onTextDelta,
    onReasoningDelta,
    onToolCallDelta,
    onUsage,
  })
  return { parser, onTextDelta, onReasoningDelta, onToolCallDelta, onUsage }
}

describe('OpenAIChatStreamParser', () => {
  it('assembles text, reasoning, and indexed tool calls', () => {
    const { parser, onTextDelta, onReasoningDelta, onToolCallDelta } = createParser()

    parser.handleLine(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'plan', content: 'hello' } }] })}`)
    parser.handleLine(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tool-1', function: { name: 'read_file', arguments: '{"path":' } }] } }] })}`)
    parser.handleLine(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }] })}`)
    parser.handleLine('data: [DONE]')

    expect(parser.snapshot()).toMatchObject({
      text: 'hello',
      reasoning: 'plan',
      toolCalls: [{ id: 'tool-1', name: 'read_file', argumentsJson: '{"path":"a.ts"}' }],
      sawTerminalEvent: true,
      receivedData: true,
    })
    expect(onTextDelta).toHaveBeenCalledWith('hello')
    expect(onReasoningDelta).toHaveBeenCalledWith('plan')
    expect(onToolCallDelta).toHaveBeenLastCalledWith({
      id: 'tool-1',
      name: 'read_file',
      argumentsJson: '{"path":"a.ts"}',
    })
  })

  it('records usage, cache fields, and output-limit termination', () => {
    const { parser, onUsage } = createParser()

    parser.handleLine(`data: ${JSON.stringify({ usage: {
      prompt_tokens: 100,
      completion_tokens: 40,
      completion_tokens_details: { reasoning_tokens: 12 },
      prompt_tokens_details: { cached_tokens: 70 },
      prompt_cache_miss_tokens: 30,
    }, choices: [] })}`)
    parser.handleLine(`data: ${JSON.stringify({ choices: [{ finish_reason: 'length', delta: {} }] })}`)

    expect(parser.snapshot()).toMatchObject({
      inputTokens: 100,
      outputTokens: 40,
      reasoningTokens: 12,
      cacheReadTokens: 70,
      cacheMissTokens: 30,
      sawTerminalEvent: true,
      interrupted: true,
    })
    expect(onUsage).toHaveBeenCalledWith({
      input: 100,
      output: 40,
      cached: 70,
      total: 140,
      source: 'provider',
    })
  })

  it('ignores malformed data while preserving stream receipt', () => {
    const { parser } = createParser()

    parser.handleLine('data: not-json')

    expect(parser.snapshot()).toMatchObject({ receivedData: true, text: '', reasoning: '' })
  })
})
