import { describe, expect, it } from 'vitest'
import { isModelRequestRecord, isTokenUsage, mergeModelRequest, summarizeModelRequests } from './modelUsage'
import type { ModelRequestRecord } from './agentTypes'

function record(id = 'attempt', patch: Partial<ModelRequestRecord> = {}): ModelRequestRecord {
  return { id, requestId: 'request', purpose: 'turn', status: 'running', startedAt: 1, updatedAt: 1, usage: { source: 'unknown' }, usageFinal: false, ...patch }
}

describe('model request accounting', () => {
  it('counts attempts separately from requests and unknown usage separately from zero usage', () => {
    const first = record('rejected', { status: 'failed' })
    const second = record('accepted', { status: 'completed', usageFinal: true, usage: { input: 100, output: 10, cached: 80, reasoning: 3, source: 'provider' } })
    expect(summarizeModelRequests([first, second])).toMatchObject({ attempts: 2, requests: 1, knownUsageAttempts: 1, unknownUsageAttempts: 1, incompleteUsageAttempts: 1,
      totals: { input: 100, cached: 80, output: 10, reasoning: 3 }, cacheHitRate: .8 })
  })

  it('upserts cumulative reports and does not let a late running event reopen a completed attempt', () => {
    const start = record()
    const progress = record('attempt', { updatedAt: 2, usage: { input: 100, output: 4, cached: 80, source: 'provider' } })
    const end = record('attempt', { updatedAt: 3, status: 'completed', usageFinal: true, usage: { input: 100, output: 10, cached: 80, source: 'provider' } })
    const result = summarizeModelRequests([start, progress, end, end, { ...progress, updatedAt: 9 }])
    expect(result).toMatchObject({ attempts: 1, unknownUsageAttempts: 0, incompleteUsageAttempts: 0, totals: { input: 100, output: 10, cached: 80 } })
  })

  it('retains measured partial usage when interruption has no final usage', () => {
    const before = record('attempt', { usage: { input: 50, output: 2, source: 'provider' } })
    const after = mergeModelRequest(before, record('attempt', { status: 'interrupted', updatedAt: 2 }))
    expect(after.usage).toEqual(before.usage)
    expect(after.usageFinal).toBe(false)
  })

  it('rejects malformed tokens and identities and isolates merged records', () => {
    expect(isTokenUsage({ input: -1 })).toBe(false)
    expect(isTokenUsage({ input: Number.NaN })).toBe(false)
    expect(isModelRequestRecord(record())).toBe(true)
    expect(isModelRequestRecord(record('', { usage: { input: Infinity } }))).toBe(false)
    expect(() => mergeModelRequest(record(), record('other'))).toThrow('identity')
    const original = record('attempt', { usage: { source: 'provider', input: 20 } })
    const copy = mergeModelRequest(undefined, original)
    copy.usage.input = 500
    expect(original.usage.input).toBe(20)
  })
})
