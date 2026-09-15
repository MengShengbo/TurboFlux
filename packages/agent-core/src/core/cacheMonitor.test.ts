import { describe, expect, it, vi } from 'vitest'
import { CacheMonitor } from './cacheMonitor'

function snapshot(systemPrompt = 'stable system', model = 'deepseek-chat') {
  return {
    systemPrompt,
    toolCount: 2,
    toolNames: ['read_file', 'edit_file'],
    toolSchemas: [
      { name: 'read_file', input_schema: { properties: { path: { type: 'string' } } } },
      { name: 'edit_file', input_schema: { properties: { old_content: { type: 'string' } } } },
    ],
    model,
    provider: 'deepseek',
    strategy: 'model_decides',
  }
}

describe('CacheMonitor', () => {
  it('reports prompt changes when cache reads drop', () => {
    const monitor = new CacheMonitor()

    monitor.recordPromptState(snapshot())
    expect(monitor.checkCacheBreak(20_000, 0).broken).toBe(false)

    monitor.recordPromptState(snapshot('changed system'))
    const result = monitor.checkCacheBreak(10_000, 0)

    expect(result.broken).toBe(true)
    expect(result.reason).toContain('system prompt changed')
    expect(result.tokenDrop).toBe(10_000)
  })

  it('detects ttl expiry using the previous response time', () => {
    vi.useFakeTimers()
    try {
      const monitor = new CacheMonitor()

      monitor.recordPromptState(snapshot())
      expect(monitor.checkCacheBreak(20_000, 0).broken).toBe(false)

      vi.advanceTimersByTime(6 * 60 * 1000)
      monitor.recordPromptState(snapshot())
      const result = monitor.checkCacheBreak(10_000, 0)

      expect(result.broken).toBe(true)
      expect(result.likelyTtlExpiry).toBe(true)
      expect(result.reason).toContain('TTL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the GPT-5.6 30-minute lifetime when diagnosing unchanged prompts', () => {
    vi.useFakeTimers()
    try {
      const monitor = new CacheMonitor()

      monitor.recordPromptState(snapshot('stable system', 'gpt-5.6-sol'))
      expect(monitor.checkCacheBreak(20_000, 0, 25_000).broken).toBe(false)

      vi.advanceTimersByTime(6 * 60 * 1000)
      monitor.recordPromptState(snapshot('stable system', 'gpt-5.6-sol'))
      const earlyDrop = monitor.checkCacheBreak(10_000, 0, 25_000)
      expect(earlyDrop.likelyTtlExpiry).toBe(false)
      expect(earlyDrop.reason).toContain('<30min gap')

      vi.advanceTimersByTime(31 * 60 * 1000)
      monitor.recordPromptState(snapshot('stable system', 'gpt-5.6-sol'))
      const expired = monitor.checkCacheBreak(5_000, 0, 25_000)
      expect(expired.likelyTtlExpiry).toBe(true)
      expect(expired.reason).toContain('30m+ TTL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports repeated zero reads for an eligible stable prefix once per streak', () => {
    const monitor = new CacheMonitor()

    monitor.recordPromptState(snapshot('stable system', 'gpt-5.6-sol'))
    expect(monitor.checkCacheBreak(0, 0, 20_000).broken).toBe(false)
    monitor.recordPromptState(snapshot('stable system', 'gpt-5.6-sol'))
    const result = monitor.checkCacheBreak(0, 0, 20_100)

    expect(result.broken).toBe(true)
    expect(result.reason).toContain('cache remained at zero')
    expect(result.tokenDrop).toBe(0)

    monitor.recordPromptState(snapshot('stable system', 'gpt-5.6-sol'))
    expect(monitor.checkCacheBreak(0, 0, 20_200).broken).toBe(false)
  })

  it('reports same-name tool schema drift when cache reads drop', () => {
    const monitor = new CacheMonitor()

    monitor.recordPromptState(snapshot())
    expect(monitor.checkCacheBreak(20_000, 0).broken).toBe(false)

    monitor.recordPromptState({
      ...snapshot(),
      toolSchemas: [
        { name: 'read_file', input_schema: { properties: { path: { type: 'string' }, limit: { type: 'number' } } } },
        { name: 'edit_file', input_schema: { properties: { old_content: { type: 'string' } } } },
      ],
    })
    const result = monitor.checkCacheBreak(10_000, 0)

    expect(result.broken).toBe(true)
    expect(result.reason).toContain('tools changed')
    expect(result.reason).toContain('read_file')
  })

  it('can reset only the cache-read baseline after expected compaction', () => {
    const monitor = new CacheMonitor()

    monitor.recordPromptState(snapshot())
    expect(monitor.checkCacheBreak(20_000, 0).broken).toBe(false)
    monitor.resetBaseline()
    monitor.recordPromptState(snapshot('compacted system'))

    expect(monitor.checkCacheBreak(5_000, 0).broken).toBe(false)
  })

  it('pinpoints the first rewritten model message while allowing tail appends', () => {
    const monitor = new CacheMonitor()
    const first = { ...snapshot(), messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }] }
    monitor.recordPromptState(first)
    expect(monitor.checkCacheBreak(20_000, 0).broken).toBe(false)

    monitor.recordPromptState({ ...snapshot(), messages: [...first.messages, { role: 'user', content: 'three' }] })
    expect(monitor.checkCacheBreak(21_000, 0).broken).toBe(false)

    monitor.recordPromptState({ ...snapshot(), messages: [{ role: 'user', content: 'changed' }, ...first.messages.slice(1)] })
    const result = monitor.checkCacheBreak(10_000, 0)

    expect(result.broken).toBe(true)
    expect(result.reason).toContain('message prefix changed at index 0')
    expect(result.firstMessageDifference).toMatchObject({ index: 0, previousRole: 'user', currentRole: 'user' })
  })
})
