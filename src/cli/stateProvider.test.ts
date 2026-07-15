import { describe, expect, it, vi } from 'vitest'
import { CliStateProvider } from './stateProvider'
import type { TurboFluxConfig } from '../core/config'

const baseConfig: TurboFluxConfig = {
  provider: 'custom',
  apiKey: 'test-key',
  baseUrl: 'https://example.test',
  model: 'test-model',
  contextWindow: 1_000_000,
  maxTokens: 4096,
  temperature: 0.7,
}

describe('CliStateProvider context segments', () => {
  it('adds and replaces context segments by covered message range', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123)
    const provider = new CliStateProvider(baseConfig, 'C:/workspace')

    provider.addContextSegment({
      startMessageId: 'u1',
      endMessageId: 'a1',
      summary: 'first summary',
      isModelGenerated: true,
      originalCharCount: 100,
      isValid: true,
    })
    provider.addContextSegment({
      startMessageId: 'u1',
      endMessageId: 'a1',
      summary: 'replacement summary',
      isModelGenerated: false,
      originalCharCount: 100,
      isValid: true,
      createdAt: 456,
    })

    expect(provider.getContextSegments()).toHaveLength(1)
    expect(provider.getContextSegments()[0]).toMatchObject({
      summary: 'replacement summary',
      createdAt: 456,
    })

    vi.restoreAllMocks()
  })

  it('restores persisted context segments with createdAt defaults', () => {
    vi.spyOn(Date, 'now').mockReturnValue(789)
    const provider = new CliStateProvider(baseConfig, 'C:/workspace')

    provider.setContextSegments([
      {
        startMessageId: 'u1',
        endMessageId: 'a1',
        summary: 'persisted summary',
        isModelGenerated: true,
        originalCharCount: 100,
        isValid: true,
      },
    ])

    expect(provider.getContextSegments()[0]?.createdAt).toBe(789)

    vi.restoreAllMocks()
  })

  it('keeps only the newest overlapping context segment', () => {
    const provider = new CliStateProvider(baseConfig, 'C:/workspace')
    provider.addContextSegment({
      startMessageId: 'u1',
      endMessageId: 'a1',
      coveredTurnIds: ['u1', 'a1'],
      summary: 'older',
      isModelGenerated: true,
      originalCharCount: 10,
      isValid: true,
      createdAt: 1,
    })
    provider.addContextSegment({
      startMessageId: 'u1',
      endMessageId: 'a2',
      coveredTurnIds: ['u1', 'a1', 'u2', 'a2'],
      summary: 'newer',
      isModelGenerated: true,
      originalCharCount: 20,
      isValid: true,
      createdAt: 2,
    })

    expect(provider.getContextSegments()).toHaveLength(1)
    expect(provider.getContextSegments()[0]?.summary).toBe('newer')
  })
})
