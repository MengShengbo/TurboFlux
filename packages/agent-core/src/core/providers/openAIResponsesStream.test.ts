import { describe, expect, it, vi } from 'vitest'
import { OpenAIResponsesStreamParser } from './openAIResponsesStream'

describe('OpenAIResponsesStreamParser', () => {
  it('assembles reasoning, text, aliased function calls, and completed output', () => {
    const onTextDelta = vi.fn()
    const onReasoningDelta = vi.fn()
    const onToolCallDelta = vi.fn()
    const parser = new OpenAIResponsesStreamParser({ onTextDelta, onReasoningDelta, onToolCallDelta })

    parser.handleLine(`data: ${JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: 'plan' })}`)
    parser.handleLine(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' })}`)
    parser.handleLine(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'read_file' } })}`)
    parser.handleLine(`data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '{"path":"a.ts"}' })}`)
    parser.handleLine(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' }] } })}`)

    expect(parser.snapshot()).toMatchObject({
      text: 'hello',
      reasoning: 'plan',
      toolCalls: [{ id: 'call-1', name: 'read_file', argumentsJson: '{"path":"a.ts"}' }],
      sawTerminalEvent: true,
      streamFailure: '',
      receivedData: true,
    })
    expect(onTextDelta).toHaveBeenCalledWith('hello')
    expect(onReasoningDelta).toHaveBeenCalledWith('plan')
    expect(onToolCallDelta).toHaveBeenCalledWith({
      id: 'call-1',
      name: 'read_file',
      argumentsJson: '{"path":"a.ts"}',
    })
  })

  it('harvests completed reasoning and usage, and reports incomplete failures', () => {
    const onReasoningDelta = vi.fn()
    const onUsage = vi.fn()
    const parser = new OpenAIResponsesStreamParser({ onReasoningDelta, onUsage })

    parser.handleLine(`data: ${JSON.stringify({ type: 'response.incomplete', response: {
      usage: { input_tokens: 20, output_tokens: 8, output_tokens_details: { reasoning_tokens: 4 }, input_tokens_details: { cached_tokens: 6 } },
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'completed plan' }] }],
    } })}`)

    expect(parser.snapshot()).toMatchObject({
      reasoning: 'completed plan',
      inputTokens: 20,
      outputTokens: 8,
      reasoningTokens: 4,
      cacheReadTokens: 6,
      sawTerminalEvent: true,
      streamFailure: 'max_output_tokens',
    })
    expect(onReasoningDelta).toHaveBeenCalledWith('completed plan')
    expect(onUsage).toHaveBeenCalledWith({ input: 20, output: 8, cached: 6, total: 28, source: 'provider' })
  })

  it('ignores malformed events while preserving stream receipt', () => {
    const parser = new OpenAIResponsesStreamParser()

    parser.handleLine('data: not-json')

    expect(parser.snapshot()).toMatchObject({ receivedData: true, text: '', reasoning: '' })
  })
})
