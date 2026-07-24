import { describe, expect, it, vi } from 'vitest'
import type { SubAgentDefinition } from '../shared/subAgentTypes'
import type { ToolExecutor } from '../tools/executor'
import { __testClearSubAgentProtocolCache, __testTraceDefinitionReadLimit, buildFastContextSystemPrompt, runSubAgent } from './subAgent'
import type { SubAgentEvent } from '../shared/subAgentTypes'

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('runSubAgent', () => {
  it('reads structural symbol definitions deeply enough to expose their stored representation', () => {
    expect(__testTraceDefinitionReadLimit({ startLine: 754, endLine: 759, symbolKind: 'class' })).toBe(160)
    expect(__testTraceDefinitionReadLimit({ startLine: 20, endLine: 25, symbolKind: 'function' })).toBe(40)
    expect(__testTraceDefinitionReadLimit({ startLine: 1, endLine: 400, symbolKind: 'class' })).toBe(220)
  })

  it('honors a definition-level disabled thinking policy', async () => {
    const originalFetch = globalThis.fetch
    let requestBody: Record<string, unknown> | undefined
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
      }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      const result = await runSubAgent({
        definition: {
          id: 'planner',
          label: 'Planner',
          description: 'test',
          driver: 'main-model',
          systemPrompt: 'plan',
          maxTurns: 1,
          maxParallel: 1,
          thinking: 'disabled',
        },
        objective: 'locate owner',
        workspacePath: 'C:/repo',
        toolExecutor: {} as ToolExecutor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        provider: 'openai',
        model: 'gpt-5.6',
        reasoning: { enabled: true, effort: 'high' },
        allowedTools: [],
      })

      expect(result).toMatchObject({ ok: true, finalText: 'done' })
      expect(requestBody?.reasoning).toBeUndefined()
      expect(requestBody?.reasoning_effort).toBeUndefined()
      expect(requestBody?.prompt_cache_key).toMatch(/^tf:subagent:gpt-5\.6:/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('marks stable Anthropic system and workspace prefixes for prompt caching', async () => {
    const originalFetch = globalThis.fetch
    let requestBody: Record<string, any> | undefined
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'done' }] }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      const result = await runSubAgent({
        definition: {
          id: 'planner-cache-test',
          label: 'Planner cache test',
          description: 'test',
          driver: 'main-model',
          systemPrompt: 'stable system prompt',
          maxTurns: 1,
          maxParallel: 1,
        },
        objective: 'locate owner',
        workspacePath: 'C:/repo',
        toolExecutor: {} as ToolExecutor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        provider: 'anthropic',
        model: 'claude-sonnet-test',
        codemap: '- src\n  - core',
        allowedTools: [],
      })

      expect(result).toMatchObject({ ok: true, finalText: 'done' })
      expect(requestBody?.system?.[0]?.cache_control).toEqual({ type: 'ephemeral' })
      expect(requestBody?.messages?.[0]?.content?.[0]?.cache_control).toEqual({ type: 'ephemeral' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

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

  it('shares one request deadline across protocol fallback attempts', async () => {
    const originalFetch = globalThis.fetch
    vi.useFakeTimers()
    let requestCount = 0
    globalThis.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      requestCount += 1
      if (requestCount === 1) {
        return new Promise<Response>(resolve => {
          setTimeout(() => resolve(new Response('not found', { status: 404 })), 600)
        })
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    }) as unknown as typeof fetch
    const executor = {
      readFile: async () => ({ success: true, data: '' }),
      searchFiles: async () => ({ success: true, data: { matches: [] } }),
      searchContent: async () => ({ success: true, data: [] }),
      searchCodeSymbols: async () => ({ success: true, data: [] }),
      getCodeMap: async () => ({ success: true, data: { map: [] } }),
    } as unknown as ToolExecutor

    try {
      __testClearSubAgentProtocolCache()
      const resultPromise = runSubAgent({
        definition: {
          id: 'deadline-test',
          label: 'Deadline test',
          description: 'test',
          driver: 'main-model',
          systemPrompt: 'test',
          maxTurns: 1,
          maxParallel: 1,
        },
        objective: 'inspect the project',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'deadline-key',
        baseUrl: 'http://deadline.test',
        provider: 'custom',
        model: 'deadline-model',
        requestTimeoutMs: 1_000,
      })

      await vi.advanceTimersByTimeAsync(1_000)
      await expect(resultPromise).resolves.toMatchObject({
        ok: false,
        error: 'Model request timed out after 1000ms',
      })
      expect(requestCount).toBe(2)
    } finally {
      __testClearSubAgentProtocolCache()
      globalThis.fetch = originalFetch
      vi.useRealTimers()
    }
  })

  it('reuses a successful protocol across subagent calls', async () => {
    const originalFetch = globalThis.fetch
    const requestUrls: string[] = []
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      requestUrls.push(url)
      if (url.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
      return new Response(JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
      }), { status: 200 })
    }) as unknown as typeof fetch
    const executor = {
      readFile: async () => ({ success: true, data: '' }),
      searchFiles: async () => ({ success: true, data: { matches: [] } }),
      searchContent: async () => ({ success: true, data: [] }),
      searchCodeSymbols: async () => ({ success: true, data: [] }),
      getCodeMap: async () => ({ success: true, data: { map: [] } }),
    } as unknown as ToolExecutor
    const options = {
      definition: {
        id: 'protocol-cache-test',
        label: 'Protocol cache test',
        description: 'test',
        driver: 'main-model' as const,
        systemPrompt: 'test',
        maxTurns: 1,
        maxParallel: 1,
      },
      objective: 'inspect the project',
      workspacePath: 'C:/repo',
      toolExecutor: executor,
      apiKey: 'protocol-cache-key',
      baseUrl: 'http://protocol-cache.test',
      provider: 'custom',
      model: 'unknown-protocol-model',
    }

    try {
      __testClearSubAgentProtocolCache()
      await expect(runSubAgent(options)).resolves.toMatchObject({ ok: true })
      await expect(runSubAgent(options)).resolves.toMatchObject({ ok: true })

      expect(requestUrls).toEqual([
        'http://protocol-cache.test/v1/chat/completions',
        'http://protocol-cache.test/v1/responses',
        'http://protocol-cache.test/v1/responses',
      ])
    } finally {
      __testClearSubAgentProtocolCache()
      globalThis.fetch = originalFetch
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
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } },
            { type: 'tool_use', id: 'toolu_2', name: 'read_file', input: { path: 'b.ts' } },
          ],
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
      const toolResultMessage = secondBody.messages.find((message: any) => message.role === 'user' && Array.isArray(message.content) && message.content.some((block: any) => block.type === 'tool_result'))
      expect(toolResultMessage.content).toHaveLength(2)
      expect(secondBody.model).toBe('claude-test')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('uses a Claude model hint and falls back from Messages to Chat', async () => {
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const events: SubAgentEvent[] = []
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init })
      if (String(url).endsWith('/messages')) {
        return new Response(JSON.stringify({ error: { message: 'route not found' } }), { status: 404 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'chat fallback finished' } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const executor = {
      readFile: async () => ({ success: true, data: '' }),
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
      maxTurns: 1,
      maxParallel: 1,
    }

    try {
      const result = await runSubAgent({
        definition,
        objective: 'inspect the project',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'proxy-key',
        baseUrl: 'https://proxy.test/v1',
        provider: 'custom',
        model: 'vendor/claude-fable-5',
        onEvent: event => events.push(event),
      })

      expect(result).toMatchObject({ ok: true, finalText: 'chat fallback finished' })
      expect(requests.map(request => request.url)).toEqual([
        'https://proxy.test/v1/messages',
        'https://proxy.test/v1/chat/completions',
      ])
      const firstHeaders = new Headers(requests[0].init?.headers)
      expect(firstHeaders.get('x-api-key')).toBe('proxy-key')
      expect(firstHeaders.get('authorization')).toBe('Bearer proxy-key')
      expect(events).toContainEqual(expect.objectContaining({
        type: 'model_retry',
        reason: expect.stringContaining('Protocol fallback'),
      }))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('falls back from Chat to Responses and converts the request shape', async () => {
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: string; body: Record<string, any> }> = []
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) })
      if (String(url).endsWith('/chat/completions')) {
        return new Response(JSON.stringify({ error: { message: 'endpoint not found' } }), { status: 404 })
      }
      return new Response(JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'responses finished' }] }],
      }), { status: 200 })
    }) as unknown as typeof fetch
    const executor = {
      readFile: async () => ({ success: true, data: '' }),
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
      maxTurns: 1,
      maxParallel: 1,
    }

    try {
      const result = await runSubAgent({
        definition,
        objective: 'inspect the project',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'proxy-key',
        baseUrl: 'https://proxy.test/v1',
        provider: 'custom',
        model: 'gpt-compatible-model',
      })

      expect(result).toMatchObject({ ok: true, finalText: 'responses finished' })
      expect(requests.map(request => request.url)).toEqual([
        'https://proxy.test/v1/chat/completions',
        'https://proxy.test/v1/responses',
      ])
      expect(requests[1].body.messages).toBeUndefined()
      expect(requests[1].body.input).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: expect.stringContaining('Objective:') }),
      ]))
      expect(requests[1].body.tools[0]).toMatchObject({ type: 'function', name: 'search_content' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('retries a transient network failure and exposes the underlying cause', async () => {
    const originalFetch = globalThis.fetch
    const events: SubAgentEvent[] = []
    let requestCount = 0
    globalThis.fetch = vi.fn(async () => {
      requestCount += 1
      if (requestCount === 1) {
        const cause = Object.assign(new Error('socket closed'), {
          code: 'ECONNRESET',
          address: '127.0.0.1',
          port: 443,
        })
        throw new TypeError('fetch failed', { cause })
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'finished' } }],
      }), { status: 200 })
    }) as unknown as typeof fetch

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
      const result = await runSubAgent({
        definition,
        objective: 'find the entry point',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
        onEvent: event => events.push(event),
      })

      expect(result).toMatchObject({ ok: true, finalText: 'finished' })
      expect(requestCount).toBe(2)
      expect(events).toContainEqual(expect.objectContaining({
        type: 'model_retry',
        attempt: 2,
        reason: expect.stringContaining('ECONNRESET'),
      }))
      expect(events.find(event => event.type === 'model_retry' && event.reason.includes('127.0.0.1:443'))).toBeTruthy()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it.each([429, 503])('retries transient HTTP status %s once', async status => {
    const originalFetch = globalThis.fetch
    let requestCount = 0
    globalThis.fetch = vi.fn(async () => {
      requestCount += 1
      if (requestCount === 1) {
        return new Response('temporary failure', { status, headers: { 'retry-after': '0' } })
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'finished' } }],
      }), { status: 200 })
    }) as unknown as typeof fetch

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
      const result = await runSubAgent({
        definition,
        objective: 'find the entry point',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
      })

      expect(result).toMatchObject({ ok: true, finalText: 'finished' })
      expect(requestCount).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('honors a bounded transient-attempt budget without protocol fallback', async () => {
    const originalFetch = globalThis.fetch
    let requestCount = 0
    globalThis.fetch = vi.fn(async () => {
      requestCount += 1
      return new Response('upstream unavailable', { status: 503, headers: { 'retry-after': '0' } })
    }) as unknown as typeof fetch

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
      const result = await runSubAgent({
        definition,
        objective: 'find the entry point',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
        maxTransientAttempts: 3,
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain('HTTP 503')
      expect(requestCount).toBe(3)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rewrites an empty search wave once before concluding', async () => {
    const originalFetch = globalThis.fetch
    const requestBodies: any[] = []
    let requestCount = 0
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'search-1',
                function: { name: 'search_content', arguments: JSON.stringify({ pattern: 'missing' }) },
              }],
            },
          }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'RANKED_CODE_MAP\nUNCERTAINTY: no evidence' } }],
      }), { status: 200 })
    }) as unknown as typeof fetch

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
      maxTurns: 2,
      maxParallel: 2,
    }

    try {
      const result = await runSubAgent({
        definition,
        objective: 'find missing behavior',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
      })

      expect(result.ok).toBe(true)
      expect(requestBodies).toHaveLength(2)
      expect(JSON.stringify(requestBodies[1].messages)).toContain('last search wave returned no matches')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('requires read evidence before accepting a FastContext final report', async () => {
    const originalFetch = globalThis.fetch
    const requestBodies: any[] = []
    let requestCount = 0
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'RANKED_CODE_MAP\n1. src/a.ts candidate only' } }],
        }), { status: 200 })
      }
      if (requestCount === 2) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'read-1',
                function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/a.ts', offset: 1, limit: 20 }) },
              }],
            },
          }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
        id: 'submit-1',
        function: { name: 'submit_code_map', arguments: JSON.stringify({
          candidates: [{ path: 'src/a.ts', start_line: 1, end_line: 2, role: 'entry', confidence: 'high', why: 'read and confirmed' }],
          relationships: [{ from: 'entry', to: 'run', relationship: 'invokes', evidence_path: 'src/a.ts', start_line: 1, end_line: 2 }],
          rejected_hypotheses: [],
          searches_tried: ['entry identifier'],
          uncertainty: ['none'],
        }) },
      }] } }] }), { status: 200 })
    }) as unknown as typeof fetch

    const executor = {
      readFile: async () => ({ success: true, data: 'export const entry = true\nrun()' }),
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
      systemPrompt: buildFastContextSystemPrompt(),
      maxTurns: 3,
      maxParallel: 2,
    }

    try {
      const result = await runSubAgent({
        definition,
        objective: 'find entry',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
        requireGroundedReport: true,
        initialEvidence: [{
          path: 'src/a.ts',
          startLine: 1,
          endLine: 1,
          preview: 'src/a.ts',
          reason: 'prefetch search: entry',
        }],
      })

      expect(result).toMatchObject({ ok: true, finalText: expect.stringContaining('L1-L2') })
      expect(requestBodies).toHaveLength(3)
      expect(JSON.stringify(requestBodies[1].messages)).toContain('Search snippets and paths are not proof')
      expect(result.evidence?.some(evidence => evidence.reason === 'file read')).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('keeps only executable tool calls in assistant history when parallel calls are capped', async () => {
    const originalFetch = globalThis.fetch
    const requestBodies: any[] = []
    let requestCount = 0
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [
                { id: 'read-a', function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.ts' }) } },
                { id: 'read-b', function: { name: 'read_file', arguments: JSON.stringify({ path: 'b.ts' }) } },
              ],
            },
          }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'finished' } }],
      }), { status: 200 })
    }) as unknown as typeof fetch

    const executor = {
      readFile: async (path: string) => ({ success: true, data: `content for ${path}` }),
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
      systemPrompt: 'test',
      maxTurns: 2,
      maxParallel: 1,
    }

    try {
      await runSubAgent({
        definition,
        objective: 'read candidates',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
      })

      const assistantMessage = requestBodies[1].messages.find((message: any) => message.role === 'assistant' && message.tool_calls)
      expect(assistantMessage.tool_calls).toHaveLength(1)
      expect(assistantMessage.tool_calls[0].id).toBe('read-a')
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

  it('retries without an optional request parameter rejected by a compatible provider', async () => {
    const originalFetch = globalThis.fetch
    const bodies: Array<Record<string, unknown>> = []
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      if (bodies.length === 1) {
        return new Response(JSON.stringify({ error: { message: '`temperature` is deprecated for this model.' } }), { status: 400 })
      }
      return new Response(JSON.stringify('input' in bodies.at(-1)!
        ? { output: [{ type: 'message', content: [{ type: 'output_text', text: 'finished' }] }] }
        : { choices: [{ message: { content: 'finished' } }] }), { status: 200 })
    }) as unknown as typeof fetch

    const executor = {
      readFile: async () => ({ success: true, data: '' }),
      searchFiles: async () => ({ success: true, data: { matches: [] } }),
      searchContent: async () => ({ success: true, data: [] }),
      searchCodeSymbols: async () => ({ success: true, data: [] }),
      getCodeMap: async () => ({ success: true, data: { map: [] } }),
    } as unknown as ToolExecutor

    try {
      const result = await runSubAgent({
        definition: {
          id: 'explorer',
          label: 'Explorer',
          description: 'test',
          driver: 'main-model',
          systemPrompt: 'test',
          maxTurns: 1,
          maxParallel: 1,
          temperature: 0,
        },
        objective: 'find entry',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        provider: 'openai',
        model: 'test-model',
      })

      expect(result).toMatchObject({ ok: true, finalText: 'finished' })
      expect(bodies).toHaveLength(2)
      expect(bodies[0]).toHaveProperty('temperature')
      expect(bodies[1]).not.toHaveProperty('temperature')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('traces a symbol declaration and references in one tool round', async () => {
    const originalFetch = globalThis.fetch
    let requestCount = 0
    globalThis.fetch = vi.fn(async () => {
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
          id: 'trace-1',
          function: { name: 'trace_symbol', arguments: JSON.stringify({ query: 'startRuntime' }) },
        }] } }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'finished' } }] }), { status: 200 })
    }) as unknown as typeof fetch

    const executor = {
      searchCodeSymbols: vi.fn(async () => ({ success: true, data: [{
        path: 'C:/repo/src/core.ts',
        line: 4,
        startLine: 4,
        endLine: 8,
        title: 'startRuntime',
        symbolName: 'startRuntime',
        symbolKind: 'function',
        preview: 'export function startRuntime()',
      }] })),
      searchContentPage: vi.fn(async () => ({ success: true, data: {
        hits: [{ file: 'C:/repo/src/app.ts', line: 12, text: 'startRuntime()' }],
        totalMatches: 1,
        offset: 0,
        limit: 30,
        truncated: false,
      } })),
      searchContent: async () => ({ success: true, data: [] }),
      searchFiles: async () => ({ success: true, data: { matches: [] } }),
      readFile: async () => ({ success: true, data: 'export function startRuntime() {}' }),
      readFileRange: vi.fn(async (_path: string, offset: number, limit: number) => ({
        success: true,
        data: {
          content: Array.from({ length: Math.min(limit, 8) }, (_, index) => `line ${offset + index + 1}`).join('\n'),
          startLine: offset + 1,
          endLine: offset + Math.min(limit, 8),
          totalLines: 40,
          truncated: true,
        },
      })),
      getCodeMap: async () => ({ success: true, data: { map: [] } }),
    } as unknown as ToolExecutor

    try {
      const result = await runSubAgent({
        definition: {
          id: 'explorer',
          label: 'Explorer',
          description: 'test',
          driver: 'main-model',
          systemPrompt: 'test',
          maxTurns: 2,
          maxParallel: 2,
        },
        objective: 'trace runtime',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
      })

      expect(result.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'src/core.ts', reason: 'symbol: startRuntime' }),
        expect.objectContaining({ path: 'src/app.ts', reason: 'reference: startRuntime' }),
        expect.objectContaining({ path: 'src/core.ts', reason: 'file read' }),
        expect.objectContaining({ path: 'src/app.ts', reason: 'file read' }),
      ]))
      expect(executor.searchCodeSymbols).toHaveBeenCalledTimes(1)
      expect(executor.searchCodeSymbols).toHaveBeenCalledWith(expect.objectContaining({ query: 'startRuntime', exact: true }))
      expect(executor.searchContentPage).toHaveBeenCalledTimes(1)
      expect(executor.readFileRange).toHaveBeenCalledTimes(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects an ungrounded structured submission and allows one correction', async () => {
    const originalFetch = globalThis.fetch
    const requestBodies: any[] = []
    let requestCount = 0
    const submission = (startLine: number, endLine: number) => ({
      candidates: [{ path: 'src/core.ts', start_line: startLine, end_line: endLine, role: 'implementation', confidence: 'high', why: 'verified implementation' }],
      relationships: [{ from: 'caller', to: 'startRuntime', relationship: 'invokes', evidence_path: 'src/core.ts', start_line: startLine, end_line: endLine }],
      rejected_hypotheses: [],
      searches_tried: ['startRuntime symbol'],
      uncertainty: ['none'],
    })
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
          id: 'read-1',
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/core.ts', offset: 1, limit: 3 }) },
        }] } }] }), { status: 200 })
      }
      const range = requestCount === 2 ? [50, 60] : [1, 3]
      return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
        id: `submit-${requestCount}`,
        function: { name: 'submit_code_map', arguments: JSON.stringify(submission(range[0], range[1])) },
      }] } }] }), { status: 200 })
    }) as unknown as typeof fetch

    const executor = {
      readFile: async () => ({ success: true, data: 'export function startRuntime() {\n  return true\n}' }),
      searchFiles: async () => ({ success: true, data: { matches: [] } }),
      searchContent: async () => ({ success: true, data: [] }),
      searchCodeSymbols: async () => ({ success: true, data: [] }),
      getCodeMap: async () => ({ success: true, data: { map: [] } }),
    } as unknown as ToolExecutor

    try {
      const result = await runSubAgent({
        definition: {
          id: 'fast_context',
          label: 'FastContext',
          description: 'test',
          driver: 'main-model',
          systemPrompt: buildFastContextSystemPrompt(),
          maxTurns: 3,
          maxParallel: 2,
        },
        objective: 'find runtime implementation',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
        requireGroundedReport: true,
      })

      expect(result.error).toBeUndefined()
      expect(result).toMatchObject({ ok: true, turns: 3, finalText: expect.stringContaining('src/core.ts L1-L3') })
      expect(JSON.stringify(requestBodies[2].messages)).toContain('at least one grounded architecture node is required')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('supports a wider grounded candidate budget for repository censuses', async () => {
    const originalFetch = globalThis.fetch
    let requestBody: any
    const candidates = Array.from({ length: 15 }, (_, index) => ({
      path: `src/migration/Use${index}.ts`,
      start_line: 1,
      end_line: 4,
      role: 'direct deprecated API occurrence',
      edit_kind: 'implementation',
      confidence: 'high',
      why: 'read-confirmed migration target',
    }))
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
        id: 'submit-census',
        function: { name: 'submit_code_map', arguments: JSON.stringify({
          candidates,
          relationships: [],
          rejected_hypotheses: [],
          searches_tried: ['legacy API census'],
          uncertainty: ['none'],
        }) },
      }] } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const executor = {
      readFile: async () => ({ success: true, data: '' }),
      searchFiles: async () => ({ success: true, data: { matches: [] } }),
      searchContent: async () => ({ success: true, data: [] }),
      searchCodeSymbols: async () => ({ success: true, data: [] }),
      getCodeMap: async () => ({ success: true, data: { map: [] } }),
    } as unknown as ToolExecutor

    try {
      const result = await runSubAgent({
        definition: {
          id: 'fast_context',
          label: 'FastContext Census',
          description: 'test',
          driver: 'main-model',
          systemPrompt: 'submit the census',
          maxTurns: 1,
          maxParallel: 1,
        },
        objective: 'replace every deprecated API call',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'census-test',
        baseUrl: 'http://census-candidates.test',
        model: 'census-model',
        requireGroundedReport: true,
        submissionOnly: true,
        allowRelationshiplessReport: true,
        maxCandidates: 15,
        initialEvidence: candidates.map(candidate => ({
          path: candidate.path,
          startLine: 1,
          endLine: 4,
          preview: 'legacyClient.send()',
          content: 'legacyClient.send()',
          reason: 'file read',
        })),
      })

      expect(result.codeMap?.candidates).toHaveLength(15)
      const tools = requestBody.tools as Array<{ function?: { name?: string; parameters?: { properties?: { candidates?: { maxItems?: number } } } } }>
      expect(tools[0].function?.parameters?.properties?.candidates?.maxItems).toBe(15)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('grants one correction request when the final-turn submission is ungrounded', async () => {
    const originalFetch = globalThis.fetch
    let requestCount = 0
    globalThis.fetch = vi.fn(async () => {
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
          id: 'read-final-recovery',
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/core.ts', offset: 1, limit: 3 }) },
        }] } }] }), { status: 200 })
      }
      const range = requestCount === 2 ? [1, 10] : [1, 3]
      return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
        id: `submit-final-recovery-${requestCount}`,
        function: { name: 'submit_code_map', arguments: JSON.stringify({
          candidates: [{ path: 'src/core.ts', start_line: range[0], end_line: range[1], role: 'implementation', confidence: 'high', why: 'verified implementation' }],
          relationships: [{ from: 'caller', to: 'startRuntime', relationship: 'invokes', evidence_path: 'src/core.ts', start_line: range[0], end_line: range[1] }],
          rejected_hypotheses: [],
          searches_tried: ['core runtime'],
          uncertainty: ['none'],
        }) },
      }] } }] }), { status: 200 })
    }) as unknown as typeof fetch

    const executor = {
      readFile: async () => ({ success: true, data: 'export function startRuntime() {\n  return true\n}' }),
      searchFiles: async () => ({ success: true, data: { matches: [] } }),
      searchContent: async () => ({ success: true, data: [] }),
      searchCodeSymbols: async () => ({ success: true, data: [] }),
      getCodeMap: async () => ({ success: true, data: { map: [] } }),
    } as unknown as ToolExecutor

    try {
      const result = await runSubAgent({
        definition: {
          id: 'fast_context',
          label: 'FastContext',
          description: 'test',
          driver: 'main-model',
          systemPrompt: buildFastContextSystemPrompt(),
          maxTurns: 2,
          maxParallel: 2,
        },
        objective: 'find runtime implementation',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
        requireGroundedReport: true,
      })

      expect(result.error).toBeUndefined()
      expect(result).toMatchObject({ ok: true, turns: 3, finalText: expect.stringContaining('src/core.ts L1-L3') })
      expect(requestCount).toBe(3)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('accepts a submitted range covered by adjacent read slices', async () => {
    const originalFetch = globalThis.fetch
    let requestCount = 0
    globalThis.fetch = vi.fn(async () => {
      requestCount += 1
      if (requestCount <= 2) {
        const offset = requestCount === 1 ? 1 : 4
        return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
          id: `read-${requestCount}`,
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/core.ts', offset, limit: 3 }) },
        }] } }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
        id: 'submit-adjacent',
        function: { name: 'submit_code_map', arguments: JSON.stringify({
          candidates: [
            { path: 'src/core.ts', start_line: 2, end_line: 5, role: 'implementation', confidence: 'high', why: 'covered by adjacent reads' },
            { path: 'src/core.ts', start_line: 1, end_line: 2, role: 'synchronized copy', edit_kind: 'mirror', confidence: 'high', why: 'requires the same edit' },
            { path: 'src/unread.ts', start_line: 1, end_line: 20, role: 'test', confidence: 'low', why: 'not actually read' },
          ],
          relationships: [{ from: 'entry', to: 'implementation', relationship: 'delegates', evidence_path: 'src/core.ts', start_line: 2, end_line: 5 }],
          rejected_hypotheses: [],
          searches_tried: ['core runtime'],
          uncertainty: ['none'],
        }) },
      }] } }] }), { status: 200 })
    }) as unknown as typeof fetch

    const executor = {
      readFile: async () => ({ success: true, data: 'line one\nline two\nline three\nline four\nline five\nline six' }),
      searchFiles: async () => ({ success: true, data: { matches: [] } }),
      searchContent: async () => ({ success: true, data: [] }),
      searchCodeSymbols: async () => ({ success: true, data: [] }),
      getCodeMap: async () => ({ success: true, data: { map: [] } }),
    } as unknown as ToolExecutor

    try {
      const result = await runSubAgent({
        definition: {
          id: 'fast_context',
          label: 'FastContext',
          description: 'test',
          driver: 'main-model',
          systemPrompt: buildFastContextSystemPrompt(),
          maxTurns: 3,
          maxParallel: 2,
        },
        objective: 'find runtime implementation',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
        requireGroundedReport: true,
      })

      expect(result.error).toBeUndefined()
      expect(result).toMatchObject({ ok: true, turns: 3, finalText: expect.stringContaining('src/core.ts L2-L5') })
      expect(result.finalText).toContain('1. src/core.ts L2-L5 kind=implementation')
      expect(result.finalText).not.toContain('src/unread.ts')
      expect(result.finalText).toContain('evidence gate excluded 1 ungrounded candidate')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('exposes only submit_code_map during the reserved final turn', async () => {
    const originalFetch = globalThis.fetch
    const requestBodies: any[] = []
    let requestCount = 0
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      requestBodies.push(body)
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
          id: 'read-before-final',
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/core.ts', offset: 1, limit: 5 }) },
        }] } }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
        id: 'submit-final',
        function: { name: 'submit_code_map', arguments: JSON.stringify({
          candidates: [{ path: 'src/core.ts', start_line: 1, end_line: 6, role: 'implementation', confidence: 'high', why: 'verified implementation' }],
          relationships: [{ from: 'entry', to: 'implementation', relationship: 'invokes', evidence_path: 'src/core.ts', start_line: 1, end_line: 5 }],
          rejected_hypotheses: [],
          searches_tried: ['core runtime'],
          uncertainty: ['none'],
        }) },
      }] } }] }), { status: 200 })
    }) as unknown as typeof fetch

    const executor = {
      readFile: async () => ({ success: true, data: 'line one\nline two\nline three\nline four\nline five' }),
      searchFiles: async () => ({ success: true, data: { matches: [] } }),
      searchContent: async () => ({ success: true, data: [] }),
      searchCodeSymbols: async () => ({ success: true, data: [] }),
      getCodeMap: async () => ({ success: true, data: { map: [] } }),
    } as unknown as ToolExecutor

    try {
      const result = await runSubAgent({
        definition: {
          id: 'fast_context',
          label: 'FastContext',
          description: 'test',
          driver: 'main-model',
          systemPrompt: buildFastContextSystemPrompt(),
          maxTurns: 2,
          maxParallel: 2,
        },
        objective: 'find runtime implementation',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
        requireGroundedReport: true,
      })

      expect(result).toMatchObject({ ok: true, turns: 2, finalText: expect.stringContaining('src/core.ts L1-L5') })
      const finalTools = requestBodies[1].tools.map((tool: any) => tool.function.name)
      expect(finalTools).toEqual(['submit_code_map'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('surfaces bounded same-name source mirrors after a read', async () => {
    const originalFetch = globalThis.fetch
    const requestBodies: any[] = []
    let requestCount = 0
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
          id: 'read-primary',
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/core/Runtime.java', offset: 1, limit: 3 }) },
        }] } }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'finished' } }] }), { status: 200 })
    }) as unknown as typeof fetch

    const executor = {
      readFile: async () => ({ success: true, data: 'class Runtime {\n  void start() {}\n}' }),
      searchFiles: async () => ({ success: true, data: { matches: [
        'C:/repo/src/core/Runtime.java',
        'C:/repo/android/src/core/Runtime.java',
      ] } }),
      searchContent: async () => ({ success: true, data: [] }),
      searchCodeSymbols: async () => ({ success: true, data: [] }),
      getCodeMap: async () => ({ success: true, data: { map: [] } }),
    } as unknown as ToolExecutor

    try {
      await runSubAgent({
        definition: {
          id: 'explorer',
          label: 'Explorer',
          description: 'test',
          driver: 'main-model',
          systemPrompt: 'test',
          maxTurns: 2,
          maxParallel: 2,
        },
        objective: 'find runtime implementation',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
      })

      expect(JSON.stringify(requestBodies[1].messages)).toContain('android/src/core/Runtime.java')
      expect(JSON.stringify(requestBodies[1].messages)).toContain('Same-name source candidates')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('forces strict FastContext to submit a structured grounded execution flow', async () => {
    const originalFetch = globalThis.fetch
    const requestBodies: any[] = []
    let requestCount = 0
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: 'src/core.ts looks relevant' } }] }), { status: 200 })
      }
      if (requestCount === 2) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
          id: 'search-1',
          function: { name: 'search_content', arguments: JSON.stringify({ pattern: 'startRuntime' }) },
        }] } }] }), { status: 200 })
      }
      if (requestCount === 3) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
          id: 'read-1',
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/core.ts', offset: 1, limit: 20 }) },
        }] } }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
        id: 'submit-1',
        function: { name: 'submit_code_map', arguments: JSON.stringify({
          candidates: [
            { path: 'src/core.ts', start_line: 1, end_line: 3, role: 'execution-core', confidence: 'high', why: 'read and confirmed' },
            { path: 'src/core.ts', start_line: 1, end_line: 2, role: 'runtime caller', confidence: 'medium', why: 'same grounded range' },
          ],
          relationships: [{ from: 'caller', to: 'startRuntime', relationship: 'invokes', evidence_path: 'src/core.ts', start_line: 1, end_line: 3 }],
          rejected_hypotheses: [],
          searches_tried: ['startRuntime'],
          uncertainty: ['none'],
        }) },
      }] } }] }), { status: 200 })
    }) as unknown as typeof fetch

    const executor = {
      searchContent: async () => ({ success: true, data: [{ file: 'C:/repo/src/core.ts', line: 1, text: 'export function startRuntime() {' }] }),
      readFile: async () => ({ success: true, data: 'export function startRuntime() {\n  return true\n}' }),
      searchFiles: async () => ({ success: true, data: { matches: [] } }),
      searchCodeSymbols: async () => ({ success: true, data: [] }),
      getCodeMap: async () => ({ success: true, data: { map: [] } }),
    } as unknown as ToolExecutor

    try {
      const result = await runSubAgent({
        definition: {
          id: 'fast_context',
          label: 'FastContext',
          description: 'test',
          driver: 'main-model',
          systemPrompt: buildFastContextSystemPrompt(),
          maxTurns: 4,
          maxParallel: 2,
        },
        objective: 'trace runtime lifecycle',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
        requireGroundedReport: true,
      })

      expect(result).toMatchObject({ ok: true, turns: 4, finalText: expect.stringContaining('EXECUTION_FLOW') })
      expect(result.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'src/core.ts', reason: 'file read' })]))
      expect(requestBodies).toHaveLength(4)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
