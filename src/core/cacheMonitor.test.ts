import { describe, expect, it, vi } from 'vitest'
import { CacheMonitor } from './cacheMonitor'

function snapshot(systemPrompt = 'stable system') {
  return {
    systemPrompt,
    toolCount: 2,
    toolNames: ['read_file', 'edit_file'],
    toolSchemas: [
      { name: 'read_file', input_schema: { properties: { path: { type: 'string' } } } },
      { name: 'edit_file', input_schema: { properties: { old_content: { type: 'string' } } } },
    ],
    model: 'deepseek-chat',
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
})
