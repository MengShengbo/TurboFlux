import { describe, expect, it, vi } from 'vitest'
import { ModelProtocolRequestError, type ModelProtocol } from './modelProtocol'
import { runModelRequest } from './modelRequestOrchestrator'

function urlFor(protocol: ModelProtocol): string {
  return `https://example.test/${protocol}`
}

describe('runModelRequest', () => {
  it('retries transient failures on the same protocol', async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(new ModelProtocolRequestError('busy', {
        protocol: 'openai_chat',
        url: urlFor('openai_chat'),
        status: 429,
      }))
      .mockResolvedValueOnce('ok')
    const waitForRetry = vi.fn(async () => {})

    await expect(runModelRequest({
      protocols: ['openai_chat', 'openai_responses'],
      urlFor,
      invoke,
      isAborted: () => false,
      shouldRetry: error => error.status === 429,
      waitForRetry,
    })).resolves.toBe('ok')

    expect(invoke).toHaveBeenNthCalledWith(1, 'openai_chat')
    expect(invoke).toHaveBeenNthCalledWith(2, 'openai_chat')
    expect(waitForRetry).toHaveBeenCalledOnce()
  })

  it('falls back only for protocol-compatible failures', async () => {
    const fallback = vi.fn()
    const invoke = vi.fn(async (protocol: ModelProtocol) => {
      if (protocol === 'openai_responses') {
        throw new ModelProtocolRequestError('unknown endpoint schema', {
          protocol,
          url: urlFor(protocol),
          status: 404,
        })
      }
      return 'chat result'
    })

    await expect(runModelRequest({
      protocols: ['openai_responses', 'openai_chat'],
      urlFor,
      invoke,
      isAborted: () => false,
      shouldRetry: () => false,
      waitForRetry: async () => {},
      onFallback: fallback,
    })).resolves.toBe('chat result')

    expect(fallback).toHaveBeenCalledWith(expect.objectContaining({
      nextProtocol: 'openai_chat',
      nextUrl: urlFor('openai_chat'),
    }))
  })

  it('preserves aborted errors without converting them', async () => {
    const aborted = Object.assign(new Error('aborted'), { aborted: true })

    await expect(runModelRequest({
      protocols: ['anthropic_messages'],
      urlFor,
      invoke: async () => { throw aborted },
      isAborted: error => (error as { aborted?: boolean }).aborted === true,
      shouldRetry: () => false,
      waitForRetry: async () => {},
    })).rejects.toBe(aborted)
  })
})
