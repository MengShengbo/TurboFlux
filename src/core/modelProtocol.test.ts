import { describe, expect, it } from 'vitest'
import {
  ModelProtocolRequestError,
  buildModelProtocolUrl,
  formatProtocolFailure,
  planModelProtocols,
  shouldFallbackProtocol,
  toProtocolAttempt,
  toResponsesInput,
  toResponsesTools,
} from './modelProtocol'

describe('model protocol planning', () => {
  it('prefers Anthropic Messages for Anthropic configs and Claude model hints', () => {
    expect(planModelProtocols('anthropic', 'claude-fable-5')[0]).toBe('anthropic_messages')
    expect(planModelProtocols('custom', 'vendor/claude-fable-5')[0]).toBe('anthropic_messages')
  })

  it('keeps Chat Completions first for ordinary OpenAI-compatible configs', () => {
    expect(planModelProtocols('custom', 'gpt-compatible-model')).toEqual([
      'openai_chat',
      'openai_responses',
      'anthropic_messages',
    ])
  })

  it('normalizes base URLs exactly once', () => {
    expect(buildModelProtocolUrl('https://ai.zyyun.xyz/v1', 'anthropic_messages'))
      .toBe('https://ai.zyyun.xyz/v1/messages')
    expect(buildModelProtocolUrl('https://example.test', 'openai_responses'))
      .toBe('https://example.test/v1/responses')
  })
})

describe('model protocol fallback safety', () => {
  const error = (status: number | undefined, message: string, receivedStreamData = false) => new ModelProtocolRequestError(message, {
    protocol: 'anthropic_messages',
    url: 'https://example.test/v1/messages',
    status,
    kind: status ? 'http' : 'network',
    receivedStreamData,
  })

  it('falls back for endpoint and explicit schema mismatches', () => {
    expect(shouldFallbackProtocol(error(404, 'route not found'))).toBe(true)
    expect(shouldFallbackProtocol(error(415, 'unsupported content type'))).toBe(true)
    expect(shouldFallbackProtocol(error(422, 'messages field is required by this endpoint'))).toBe(true)
  })

  it('does not cross protocols for auth, transient, or post-stream failures', () => {
    expect(shouldFallbackProtocol(error(401, 'invalid API key'))).toBe(false)
    expect(shouldFallbackProtocol(error(429, 'rate limited'))).toBe(false)
    expect(shouldFallbackProtocol(error(503, 'temporarily unavailable'))).toBe(false)
    expect(shouldFallbackProtocol(error(undefined, 'fetch failed'))).toBe(false)
    expect(shouldFallbackProtocol(error(404, 'route not found', true))).toBe(false)
  })

  it('formats every attempted protocol and URL in the final diagnostic', () => {
    const first = toProtocolAttempt(error(404, 'route not found'))
    const second = toProtocolAttempt(new ModelProtocolRequestError('invalid input schema', {
      protocol: 'openai_responses',
      url: 'https://example.test/v1/responses',
      status: 422,
      kind: 'http',
    }))
    expect(formatProtocolFailure([first, second])).toContain('Anthropic Messages https://example.test/v1/messages')
    expect(formatProtocolFailure([first, second])).toContain('OpenAI Responses https://example.test/v1/responses')
  })
})

describe('Responses API conversion', () => {
  it('converts chat tools and tool history into Responses items', () => {
    expect(toResponsesTools([{
      type: 'function',
      function: { name: 'read_file', description: 'Read', parameters: { type: 'object' }, strict: true },
    }])).toEqual([{
      type: 'function',
      name: 'read_file',
      description: 'Read',
      parameters: { type: 'object' },
      strict: true,
    }])

    expect(toResponsesInput([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'inspect it' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
    ])).toEqual([
      { role: 'user', content: 'inspect it' },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file contents' },
    ])
  })
})
