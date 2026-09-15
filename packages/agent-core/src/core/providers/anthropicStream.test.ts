import { describe, expect, it, vi } from 'vitest'
import { AnthropicStreamParser } from './anthropicStream'

function createParser() {
  const onTextDelta = vi.fn()
  const onReasoningDelta = vi.fn()
  const onToolCallDelta = vi.fn()
  const onUsage = vi.fn()
  const parser = new AnthropicStreamParser({
    extractReasoningDelta: delta => {
      const value = delta as { type?: string; thinking?: string }
      return value?.type === 'thinking_delta' ? value.thinking || '' : ''
    },
    onTextDelta,
    onReasoningDelta,
    onToolCallDelta,
    onUsage,
  })
  return { parser, onTextDelta, onReasoningDelta, onToolCallDelta, onUsage }
}

describe('AnthropicStreamParser', () => {
  it('assembles text, reasoning, signatures, and tool arguments', () => {
    const { parser, onTextDelta, onReasoningDelta, onToolCallDelta } = createParser()

    parser.handleLine('event: content_block_start')
    parser.handleLine(`data: ${JSON.stringify({ index: 0, content_block: { type: 'thinking', thinking: '' } })}`)
    parser.handleLine(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } })}`)
    parser.handleLine(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } })}`)
    parser.handleLine(`data: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'hello ' } })}`)
    parser.handleLine(`data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'world' } })}`)
    parser.handleLine(`data: ${JSON.stringify({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} } })}`)
    parser.handleLine(`data: ${JSON.stringify({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } })}`)

    expect(parser.snapshot()).toMatchObject({
      text: 'hello world',
      reasoning: 'plan',
      rawReasoningBlocks: [{ type: 'thinking', thinking: 'plan', signature: 'sig' }],
      toolCalls: [{ id: 'tool-1', name: 'read_file', argumentsJson: '{"path":"a.ts"}' }],
      receivedData: true,
    })
    expect(onTextDelta).toHaveBeenCalledTimes(2)
    expect(onReasoningDelta).toHaveBeenCalledWith('plan')
    expect(onToolCallDelta).toHaveBeenCalledWith({
      id: 'tool-1',
      name: 'read_file',
      argumentsJson: '{"path":"a.ts"}',
    })
  })

  it('tracks usage and output-limit termination', () => {
    const { parser, onUsage } = createParser()

    parser.handleLine(`data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } })}`)
    parser.handleLine(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 5 } })}`)

    expect(parser.snapshot()).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheCreationTokens: 2,
      sawTerminalEvent: true,
      interrupted: true,
    })
    expect(onUsage).toHaveBeenLastCalledWith({
      input: 15,
      output: 5,
      cached: 3,
      total: 20,
      source: 'provider',
    })
  })

  it('ignores malformed data while preserving stream receipt', () => {
    const { parser } = createParser()

    parser.handleLine('data: not-json')

    expect(parser.snapshot()).toMatchObject({ receivedData: true, text: '', reasoning: '' })
  })
})
