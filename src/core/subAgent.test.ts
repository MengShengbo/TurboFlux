import { describe, expect, it, vi } from 'vitest'
import type { SubAgentDefinition } from '../shared/subAgentTypes'
import type { ToolExecutor } from '../tools/executor'
import { runSubAgent } from './subAgent'
import type { SubAgentEvent } from '../shared/subAgentTypes'

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('runSubAgent', () => {
  it('reports model wait progress and enforces a caller-specific timeout', async () => {
    const originalFetch = globalThis.fetch
    const events: SubAgentEvent[] = []
    vi.useFakeTimers()
    globalThis.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    })) as unknown as typeof fetch

    const executor = {
      readFile: async () => ({ success: true, data: '' }),
      searchFiles: async () => ({ success: true, data: { matches: [] } }),
      searchContent: async () => ({ success: true, data: [] }),
      searchCodeSymbols: async () => ({ success: true, data: [] }),
      getCodeMap: async () => ({ success: true, data: { map: [] } }),
    } as unknown as ToolExecutor
    const definition: SubAgentDefinition = {
      id: 'fast_context',
      label: 'FastContext',
      description: 'test',
      driver: 'main-model',
      systemPrompt: 'test',
      maxTurns: 1,
      maxParallel: 1,
    }

    try {
      const resultPromise = runSubAgent({
        definition,
        objective: 'find the entry point',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
        requestTimeoutMs: 6_000,
        onEvent: event => events.push(event),
      })

      await vi.advanceTimersByTimeAsync(6_000)
      const result = await resultPromise

      expect(result).toMatchObject({ ok: false, error: 'Model request timed out after 6000ms' })
      expect(events.filter(event => event.type === 'model_wait')).toHaveLength(2)
    } finally {
      globalThis.fetch = originalFetch
      vi.useRealTimers()
    }
  })

  it('executes independent tool calls in parallel and returns results in request order', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ at: number; path: string }> = []
    const startedAt = Date.now()

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: '',
          tool_calls: [
            { id: 'a', function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.ts' }) } },
            { id: 'b', function: { name: 'read_file', arguments: JSON.stringify({ path: 'b.ts' }) } },
          ],
        },
      }],
    }), { status: 200 })) as unknown as typeof fetch

    const executor = {
      readFile: async (path: string) => {
        calls.push({ at: Date.now() - startedAt, path })
        await delay(80)
        return { success: true, data: `content for ${path}` }
      },
      searchFiles: async () => ({ success: true, data: { matches: [] } }),
      searchContent: async () => ({ success: true, data: [] }),
      searchCodeSymbols: async () => ({ success: true, data: [] }),
      getCodeMap: async () => ({ success: true, data: { map: [] } }),
    } as unknown as ToolExecutor

    const definition: SubAgentDefinition = {
      id: 'fast_context',
      label: 'FastContext',
      description: 'test',
      driver: 'deepseek-flash',
      systemPrompt: 'test',
      maxTurns: 1,
      maxParallel: 2,
      temperature: 0,
    }

    const result = await runSubAgent({
      definition,
      objective: 'read two files',
      workspacePath: 'C:/repo',
      toolExecutor: executor,
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
    })

    globalThis.fetch = originalFetch

    expect(result.ok).toBe(true)
    expect(calls.map(call => call.path.replace(/\\/g, '/'))).toEqual(['C:/repo/a.ts', 'C:/repo/b.ts'])
    expect(Math.abs(calls[1].at - calls[0].at)).toBeLessThan(40)
  })

  it('uses Anthropic messages, headers, and tool-result blocks', async () => {
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: string; init?: RequestInit }> = []
    let requestCount = 0
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init })
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'finished' }] }), { status: 200 })
    }) as unknown as typeof fetch

    const executor = {
      readFile: async () => ({ success: true, data: 'export const value = 1' }),
      searchFiles: async () => ({ success: true, data: { matches: [] } }),
      searchContent: async () => ({ success: true, data: [] }),
      searchCodeSymbols: async () => ({ success: true, data: [] }),
      getCodeMap: async () => ({ success: true, data: { map: [] } }),
    } as unknown as ToolExecutor
    const definition: SubAgentDefinition = {
      id: 'explorer',
      label: 'Explorer',
      description: 'test',
      driver: 'main-model',
      systemPrompt: 'inspect code',
      maxTurns: 2,
      maxParallel: 2,
    }

    try {
      const result = await runSubAgent({
        definition,
        objective: 'inspect a.ts',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'anthropic-key',
        baseUrl: 'https://api.anthropic.test/v1',
        provider: 'anthropic',
        model: 'claude-test',
      })

      expect(result).toMatchObject({ ok: true, finalText: 'finished' })
      expect(requests).toHaveLength(2)
      expect(requests[0].url).toBe('https://api.anthropic.test/v1/messages')
      expect(new Headers(requests[0].init?.headers).get('x-api-key')).toBe('anthropic-key')
      const secondBody = JSON.parse(String(requests[1].init?.body))
      expect(JSON.stringify(secondBody.messages)).toContain('tool_result')
      expect(secondBody.model).toBe('claude-test')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('reports search infrastructure failures instead of pretending there were no matches', async () => {
    const originalFetch = globalThis.fetch
    const events: SubAgentEvent[] = []
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: '',
          tool_calls: [{
            id: 'search-1',
            function: { name: 'search_files', arguments: JSON.stringify({ pattern: '**/*.ts' }) },
          }],
        },
      }],
    }), { status: 200 })) as unknown as typeof fetch

    const executor = {
      searchFiles: async () => ({ success: false, error: 'rg unavailable' }),
      searchContent: async () => ({ success: true, data: [] }),
      searchCodeSymbols: async () => ({ success: true, data: [] }),
      getCodeMap: async () => ({ success: true, data: { map: [] } }),
      readFile: async () => ({ success: true, data: '' }),
    } as unknown as ToolExecutor
    const definition: SubAgentDefinition = {
      id: 'fast_context',
      label: 'FastContext',
      description: 'test',
      driver: 'main-model',
      systemPrompt: 'test',
      maxTurns: 1,
      maxParallel: 1,
    }

    try {
      const result = await runSubAgent({
        definition,
        objective: 'find source files',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
        onEvent: event => events.push(event),
      })

      expect(result).toMatchObject({ ok: true, truncated: true })
      expect(events).toContainEqual(expect.objectContaining({
        type: 'tool_result',
        tool: 'search_files',
        ok: false,
        summary: expect.stringContaining('rg unavailable'),
      }))
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
