import { describe, expect, it } from 'vitest'
import { CacheMonitor } from './cacheMonitor'
import { modelCacheSnapshot, observeModelCache, type SentModelCacheRequest } from './modelRequestCache'

function request(body: Record<string, unknown> = {}, protocol: SentModelCacheRequest['protocol'] = 'openai_responses'): SentModelCacheRequest {
  return {
    protocol,
    provider: 'custom',
    serializedBody: JSON.stringify({ model: 'test-model', instructions: 'stable', input: [{ role: 'user', content: 'inspect' }], ...body }),
  }
}

describe('model request cache boundary', () => {
  it('passes final dispatch time into cache diagnosis without comparing timestamps as prompt parameters', () => {
    const monitor = new CacheMonitor()
    observeModelCache(monitor, { ...request(), requestStartedAt: 1000, responseReceivedAt: 2000 }, { inputTokens: 25000, cacheReadTokens: 20000 })
    const result = observeModelCache(monitor, { ...request(), requestStartedAt: 2100, responseReceivedAt: 402100 }, { inputTokens: 25000, cacheReadTokens: 10000 })
    expect(result?.reason).not.toContain('params changed')
    expect(result?.likelyTtlExpiry).toBe(false)
    expect(result?.requestTiming).toEqual({ idleMs: 100, durationMs: 400000 })
  })

  it('captures the actual Responses body without retaining credentials or volatile tracing headers', () => {
    const snapshot = modelCacheSnapshot({
      ...request({
        tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
        tool_choice: 'auto', parallel_tool_calls: true, reasoning: { effort: 'high' },
        prompt_cache_key: 'workspace-key', store: false,
      }),
      headers: { Authorization: 'secret', 'x-client-request-id': 'volatile', 'Anthropic-Beta': 'accepted-beta' },
    })

    expect(snapshot).toMatchObject({ model: 'test-model', toolNames: ['read_file'], toolCount: 1, systemPrompt: 'stable' })
    expect(snapshot.extraBodyParams).toMatchObject({
      tool_choice: 'auto', parallel_tool_calls: true, reasoning: { effort: 'high' },
      prompt_cache_key: 'workspace-key', protocolHeaders: { 'anthropic-beta': 'accepted-beta' },
    })
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|volatile|Authorization|x-client-request-id/)
  })

  it('captures Chat reasoning, nested tool definitions, and every instruction message', () => {
    const snapshot = modelCacheSnapshot(request({
      messages: [{ role: 'system', content: 'system' }, { role: 'developer', content: 'developer' }, { role: 'user', content: 'task' }],
      tools: [{ type: 'function', function: { name: 'read_file' } }], reasoning_effort: 'max',
    }, 'openai_chat'))
    expect(snapshot.toolNames).toEqual(['read_file'])
    expect(snapshot.messages).toHaveLength(3)
    expect(snapshot.systemPrompt).toContain('developer')
    expect(snapshot.extraBodyParams).toMatchObject({ reasoning_effort: 'max' })
  })

  it('uses Anthropic forced tool choice, thinking and real cache breakpoints', () => {
    const snapshot = modelCacheSnapshot(request({
      system: [{ type: 'text', text: 'instructions', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'task', cache_control: { type: 'ephemeral' } }] }],
      tools: [{ name: 'set_response_mode', cache_control: { type: 'ephemeral' } }],
      tool_choice: { type: 'tool', name: 'set_response_mode' }, thinking: { type: 'adaptive' },
    }, 'anthropic_messages'))
    expect(snapshot.extraBodyParams).toMatchObject({ tool_choice: { type: 'tool', name: 'set_response_mode' }, thinking: { type: 'adaptive' } })
    expect(snapshot.toolSchemas).toEqual([{ name: 'set_response_mode', cache_control: { type: 'ephemeral' } }])
    expect(snapshot.systemPrompt).toContain('cache_control')
  })

  it('compares the final successful retry against the previous observed request', () => {
    const monitor = new CacheMonitor()
    observeModelCache(monitor, request({ prompt_cache_retention: '24h' }), { inputTokens: 12000, cacheReadTokens: 11000 })
    // The endpoint rejected retention on the next call; only the accepted body is observed.
    const result = observeModelCache(monitor, request(), { inputTokens: 12000, cacheReadTokens: 5000 })
    expect(result).toMatchObject({ broken: true, tokenDrop: 6000 })
    expect(result?.reason).toContain('request params changed')
    expect(result?.reason).not.toContain('server-side')
  })

  it('does not poison the baseline with a response that has no input usage', () => {
    const monitor = new CacheMonitor()
    observeModelCache(monitor, request(), { inputTokens: 12000, cacheReadTokens: 11000 })
    expect(observeModelCache(monitor, { ...request(), serializedBody: 'not a measured request' }, { inputTokens: 0, cacheReadTokens: 0 })).toBeUndefined()
    const result = observeModelCache(monitor, request(), { inputTokens: 12000, cacheReadTokens: 5000 })
    expect(result?.reason).toContain('server-side')
    expect(result?.reason).not.toContain('params changed')
  })

  it('identifies Responses function items when reporting a changed prefix', () => {
    const monitor = new CacheMonitor()
    observeModelCache(monitor, request({ input: [{ type: 'function_call', call_id: 'a', name: 'read_file', arguments: '{}' }] }), { inputTokens: 12000, cacheReadTokens: 11000 })
    const result = observeModelCache(monitor, request({ input: [{ type: 'function_call_output', call_id: 'a', output: 'source' }] }), { inputTokens: 12000, cacheReadTokens: 5000 })
    expect(result?.firstMessageDifference).toMatchObject({ previousRole: 'function_call', currentRole: 'function_call_output' })
  })
})
