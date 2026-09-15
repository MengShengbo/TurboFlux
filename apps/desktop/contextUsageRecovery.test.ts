import { describe, expect, it } from 'vitest'
import type { AgentTurn } from '@turboflux/agent-core/workbench'
import { contextUsageTokenCount, recoverContextUsage } from './contextUsageRecovery'

const assistantTurn = (id: string, input: number, output: number): AgentTurn => ({
  id,
  role: 'assistant',
  content: '',
  timestamp: Number(id),
  metadata: {
    tokens: { input, output, cached: 0, total: input + output, source: 'provider' },
  },
})

describe('Desktop context usage recovery', () => {
  it('restores the latest persisted provider usage after a runtime reload', () => {
    expect(recoverContextUsage(
      { source: 'unknown' },
      [assistantTurn('1', 12_000, 400), assistantTurn('2', 18_000, 600)],
    )).toEqual({ input: 18_000, output: 600, cached: 0, total: 18_600, source: 'provider' })
  })

  it('keeps newer live usage while a conversation is running', () => {
    const live = { input: 24_000, output: 800, total: 24_800, source: 'provider' as const }
    expect(recoverContextUsage(live, [assistantTurn('1', 12_000, 400)])).toBe(live)
  })

  it('normalizes provider records that omitted total tokens', () => {
    expect(contextUsageTokenCount({ input: 9_000, output: 300, source: 'provider' })).toBe(9_300)
    expect(recoverContextUsage({ source: 'unknown' }, [{
      ...assistantTurn('1', 0, 0),
      metadata: { tokens: { input: 9_000, output: 300, source: 'provider' } },
    }])).toMatchObject({ input: 9_000, output: 300, total: 9_300, source: 'provider' })
  })
})
