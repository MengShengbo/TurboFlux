import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import type { SubAgentDefinition } from '@turboflux/contracts/subAgentTypes'
import type { ToolExecutor } from '@turboflux/contracts/toolExecutor'
import { __testClearSubAgentProtocolCache, getSubAgentDefinition, loadDynamicAgents, registerAgent, runSubAgent } from './subAgent'
import type { SubAgentEvent } from '@turboflux/contracts/subAgentTypes'

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('subagent registry isolation', () => {
  it('replaces workspace agents without removing programmatic registrations', () => {
    const firstWorkspace = mkdtempSync(join(tmpdir(), 'turboflux-agent-first-'))
    const secondWorkspace = mkdtempSync(join(tmpdir(), 'turboflux-agent-second-'))
    mkdirSync(join(firstWorkspace, '.turboflux', 'agents'), { recursive: true })
    writeFileSync(join(firstWorkspace, '.turboflux', 'agents', 'first.md'), [
      '---',
      'name: first_workspace_agent',
      'description: first workspace only',
      'tools: [web_search, web_fetch]',
      '---',
      'Inspect the first workspace.',
    ].join('\n'))
    registerAgent({
      id: 'registered_agent_fixture',
      label: 'Registered fixture',
      description: 'process registration',
      systemPrompt: 'Stay registered.',
      maxTurns: 1,
      maxParallel: 1,
    })

    try {
      const first = loadDynamicAgents(firstWorkspace)
      expect(getSubAgentDefinition('first_workspace_agent', first)).toBeDefined()
      expect(getSubAgentDefinition('first_workspace_agent', first)?.allowedTools).toEqual(['web_search', 'web_fetch'])

      const second = loadDynamicAgents(secondWorkspace)
      expect(getSubAgentDefinition('first_workspace_agent', first)).toBeDefined()
      expect(getSubAgentDefinition('first_workspace_agent', second)).toBeUndefined()
      first.reload(secondWorkspace)
      expect(getSubAgentDefinition('first_workspace_agent', first)).toBeUndefined()
      expect(getSubAgentDefinition('first_workspace_agent')).toBeUndefined()
      expect(getSubAgentDefinition('registered_agent_fixture')).toBeDefined()
    } finally {
      rmSync(firstWorkspace, { recursive: true, force: true })
      rmSync(secondWorkspace, { recursive: true, force: true })
    }
  })
})

describe('runSubAgent', () => {

  it.each(['timeout', 'parent'] as const)('closes a real stalled HTTP model body on %s interruption', async reason => {
    const events: SubAgentEvent[] = []
    const controller = new AbortController()
    let received!: () => void
    let closed!: () => void
    const headersSent = new Promise<void>(resolve => { received = resolve })
    const bodyClosed = new Promise<void>(resolve => { closed = resolve })
    const server = createServer((_request, response) => {
      response.on('close', closed)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"choices":[')
      received()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    try {
      const result = runSubAgent({
        definition: { id: 'http-body-test', label: 'HTTP body test', description: 'test', systemPrompt: 'test', maxTurns: 1, maxParallel: 1 },
        objective: 'inspect',
        workspacePath: process.cwd(),
        toolExecutor: {} as ToolExecutor,
        apiKey: 'test', provider: 'custom', model: 'test-model',
        baseUrl: `http://127.0.0.1:${address.port}`,
        requestTimeoutMs: reason === 'timeout' ? 1_000 : 30_000,
        maxTransientAttempts: 1,
        abortSignal: controller.signal,
        onEvent: event => events.push(event),
      })
      await headersSent
      await new Promise<void>(resolve => setImmediate(resolve))
      if (reason === 'parent') controller.abort()
      await expect(result).resolves.toMatchObject({
        ok: false, error: reason === 'parent' ? 'Aborted' : 'Model request timed out after 1000ms',
      })
      await bodyClosed
      expect(events.some(event => event.type === 'final' || event.type === 'model_response' || event.type === 'tool_call')).toBe(false)
    } finally {
      controller.abort()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
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
      expect(requestBody?.prompt_cache_options).toEqual({ ttl: '30m' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('caches the Anthropic system prompt without synthetic workspace messages', async () => {
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
        allowedTools: [],
      })

      expect(result).toMatchObject({ ok: true, finalText: 'done' })
      expect(requestBody?.system?.[0]?.cache_control).toEqual({ type: 'ephemeral' })
      expect(requestBody?.messages).toEqual([{ role: 'user', content: expect.stringContaining('Objective: locate owner') }])
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
    } as unknown as ToolExecutor
    const definition: SubAgentDefinition = {
      id: 'test_agent',
      label: 'Test Agent',
      description: 'test',
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

  it('enforces the deadline while a model response body is stalled', async () => {
    const originalFetch = globalThis.fetch
    vi.useFakeTimers()
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"choices":[')) },
    })
    globalThis.fetch = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    try {
      const resultPromise = runSubAgent({
        definition: { id: 'body-stall-test', label: 'Body stall test', description: 'test', systemPrompt: 'test', maxTurns: 1, maxParallel: 1 },
        objective: 'inspect the project',
        workspacePath: 'C:/repo',
        toolExecutor: {} as ToolExecutor,
        apiKey: 'test',
        baseUrl: 'http://body-stall.test',
        provider: 'custom',
        model: 'test-model',
        requestTimeoutMs: 1_000,
        requestAttemptTimeoutMs: 1_000,
      })
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(resultPromise).resolves.toMatchObject({ ok: false, error: 'Model request timed out after 1000ms' })
    } finally {
      globalThis.fetch = originalFetch
      vi.useRealTimers()
    }
  })

  it('cancels a stalled response body when the parent run is aborted', async () => {
    const originalFetch = globalThis.fetch
    const abortController = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"choices":[')) },
    })
    globalThis.fetch = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    try {
      const resultPromise = runSubAgent({
        definition: { id: 'body-abort-test', label: 'Body abort test', description: 'test', systemPrompt: 'test', maxTurns: 1, maxParallel: 1 },
        objective: 'inspect the project',
        workspacePath: 'C:/repo',
        toolExecutor: {} as ToolExecutor,
        apiKey: 'test',
        baseUrl: 'http://body-abort.test',
        provider: 'custom',
        model: 'test-model',
        requestTimeoutMs: 30_000,
        abortSignal: abortController.signal,
      })
      await new Promise<void>(resolve => setImmediate(resolve))
      abortController.abort()
      await expect(resultPromise).resolves.toMatchObject({ ok: false, error: 'Aborted' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('retries an attempt timeout while the overall request deadline remains', async () => {
    const originalFetch = globalThis.fetch
    const events: SubAgentEvent[] = []
    vi.useFakeTimers()
    let requestCount = 0
    globalThis.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      requestCount += 1
      if (requestCount === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          }, { once: true })
        })
      }
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: 'finished after retry' } }],
      }), { status: 200 }))
    }) as unknown as typeof fetch

    const executor = {
      readFile: async () => ({ success: true, data: '' }),
      searchFiles: async () => ({ success: true, data: { matches: [] } }),
      searchContent: async () => ({ success: true, data: [] }),
    } as unknown as ToolExecutor

    try {
      const resultPromise = runSubAgent({
        definition: {
          id: 'attempt-timeout-test',
          label: 'Attempt timeout test',
          description: 'test',
          systemPrompt: 'test',
          maxTurns: 1,
          maxParallel: 1,
        },
        objective: 'inspect the project',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://attempt-timeout.test',
        model: 'test-model',
        requestTimeoutMs: 3_000,
        requestAttemptTimeoutMs: 1_000,
        maxTransientAttempts: 2,
        onEvent: event => events.push(event),
      })

      await vi.advanceTimersByTimeAsync(1_300)
      await expect(resultPromise).resolves.toMatchObject({ ok: true, finalText: 'finished after retry' })
      expect(requestCount).toBe(2)
      expect(events).toContainEqual(expect.objectContaining({
        type: 'model_retry',
        attempt: 2,
        reason: expect.stringContaining('timed out after 1000ms'),
      }))
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
    } as unknown as ToolExecutor

    try {
      __testClearSubAgentProtocolCache()
      const resultPromise = runSubAgent({
        definition: {
          id: 'deadline-test',
          label: 'Deadline test',
          description: 'test',
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
    } as unknown as ToolExecutor
    const options = {
      definition: {
        id: 'protocol-cache-test',
        label: 'Protocol cache test',
        description: 'test',
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
    } as unknown as ToolExecutor

    const definition: SubAgentDefinition = {
      id: 'test_agent',
      label: 'Test Agent',
      description: 'test',
      systemPrompt: 'test',
      maxTurns: 1,
      maxParallel: 2,
      temperature: 0,
    }

    const workspacePath = resolve('repo')
    const result = await runSubAgent({
      definition,
      objective: 'read two files',
      workspacePath,
      toolExecutor: executor,
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
    })

    globalThis.fetch = originalFetch

    expect(result).toMatchObject({ ok: false, truncated: true, error: expect.stringContaining('turn limit') })
    expect(calls.map(call => call.path)).toEqual([
      join(workspacePath, 'a.ts'),
      join(workspacePath, 'b.ts'),
    ])
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
    } as unknown as ToolExecutor
    const definition: SubAgentDefinition = {
      id: 'explorer',
      label: 'Explorer',
      description: 'test',
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

  it('gives research agents a scoped web and report toolset', async () => {
    const originalFetch = globalThis.fetch
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-design-research-agent-'))
    const requestBodies: Array<Record<string, any>> = []
    let requestCount = 0
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body || '{}')))
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [
          { id: 'search-1', function: { name: 'web_search', arguments: JSON.stringify({ query: 'premium product design' }) } },
          { id: 'report-1', function: { name: 'write_research_report', arguments: JSON.stringify({ path: '.turboflux/design-research/run-1/index.json', content: '{"items":[]}' }) } },
        ] } }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'REPORT: index.json' } }] }), { status: 200 })
    }) as unknown as typeof fetch

    const writeFile = vi.fn(async () => ({ success: true }))
    const executor = {
      writeFile,
      webSearch: vi.fn(async () => ({ success: true, data: {
        results: [{ id: 'S1', title: 'Reference', url: 'https://example.com', snippet: 'Evidence' }],
        provider: 'test', query: 'premium product design', queries: ['premium product design'], retrievedAt: new Date().toISOString(), partial: false, providers: [], warnings: [],
      } })),
      readFile: async () => ({ success: true, data: '' }),
      searchFiles: async () => ({ success: true, data: { matches: [] } }),
      searchContent: async () => ({ success: true, data: [] }),
    } as unknown as ToolExecutor

    try {
      const result = await runSubAgent({
        definition: {
          id: 'design-researcher', label: 'Design researcher', description: 'test', systemPrompt: 'Research.',
          allowedTools: ['web_search', 'web_fetch', 'write_research_report'], maxTurns: 2, maxParallel: 2,
        },
        objective: 'Research design references',
        workspacePath,
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
      })

      expect(result).toMatchObject({ ok: true, finalText: 'REPORT: index.json' })
      expect(requestBodies[0].tools.map((tool: any) => tool.function.name)).toEqual(['web_search', 'web_fetch', 'write_research_report'])
      expect(executor.webSearch).toHaveBeenCalledWith(expect.objectContaining({ query: 'premium product design' }))
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining(join('.turboflux', 'design-research', 'run-1', 'index.json')),
        '{"items":[]}',
        expect.objectContaining({ source: 'subagent' }),
      )
    } finally {
      globalThis.fetch = originalFetch
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('keeps a delegated agent running until its declared outputs are written', async () => {
    const originalFetch = globalThis.fetch
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-agent-completion-gate-'))
    let requestCount = 0
    globalThis.fetch = vi.fn(async () => {
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: 'I am done early.' } }] }), { status: 200 })
      }
      if (requestCount === 2) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [
          { id: 'report', function: { name: 'write_research_report', arguments: JSON.stringify({ path: '.turboflux/design-research/run/report.md', content: '# Report' }) } },
          { id: 'index', function: { name: 'write_research_report', arguments: JSON.stringify({ path: '.turboflux/design-research/run/index.json', content: '{"sources":[]}' }) } },
        ] } }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'REPORT and INDEX written.' } }] }), { status: 200 })
    }) as unknown as typeof fetch

    const writeFile = vi.fn(async () => ({ success: true }))
    const executor = {
      writeFile,
      readFile: async () => ({ success: true, data: '' }),
      searchFiles: async () => ({ success: true, data: { matches: [] } }),
      searchContent: async () => ({ success: true, data: [] }),
    } as unknown as ToolExecutor

    try {
      const result = await runSubAgent({
        definition: {
          id: 'gated-researcher', label: 'Gated researcher', description: 'test', systemPrompt: 'Write both outputs.',
          allowedTools: ['write_research_report'], maxTurns: 3, maxParallel: 2,
          requiredToolCalls: { write_research_report: 2 },
        },
        objective: 'Write the report and index',
        workspacePath,
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
      })

      expect(result).toMatchObject({ ok: true, finalText: 'REPORT and INDEX written.' })
      expect(requestCount).toBe(3)
      expect(writeFile).toHaveBeenCalledTimes(2)
    } finally {
      globalThis.fetch = originalFetch
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('uses Chat first for Claude model names on custom gateways', async () => {
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
    } as unknown as ToolExecutor
    const definition: SubAgentDefinition = {
      id: 'explorer',
      label: 'Explorer',
      description: 'test',
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
        'https://proxy.test/v1/chat/completions',
      ])
      const firstHeaders = new Headers(requests[0].init?.headers)
      expect(firstHeaders.get('authorization')).toBe('Bearer proxy-key')
      expect(firstHeaders.get('x-api-key')).toBeNull()
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'model_retry' }))
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
    } as unknown as ToolExecutor
    const definition: SubAgentDefinition = {
      id: 'explorer',
      label: 'Explorer',
      description: 'test',
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
      expect(requests[1].body.tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function', name: 'search_content' })]))
      expect(requests[1].body.tools.map((tool: { name: string }) => tool.name)).not.toContain('search_symbol')
      expect(requests[1].body.tools.map((tool: { name: string }) => tool.name)).not.toContain('get_codemap')
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
    } as unknown as ToolExecutor
    const definition: SubAgentDefinition = {
      id: 'test_agent',
      label: 'Test Agent',
      description: 'test',
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
    } as unknown as ToolExecutor
    const definition: SubAgentDefinition = {
      id: 'test_agent',
      label: 'Test Agent',
      description: 'test',
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
    } as unknown as ToolExecutor
    const definition: SubAgentDefinition = {
      id: 'test_agent',
      label: 'Test Agent',
      description: 'test',
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

  it('does not force an alternate search after an empty wave', async () => {
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
        choices: [{ message: { content: 'No matching evidence found.' } }],
      }), { status: 200 })
    }) as unknown as typeof fetch

    const executor = {
      readFile: async () => ({ success: true, data: '' }),
      searchFiles: async () => ({ success: true, data: { matches: [] } }),
      searchContent: async () => ({ success: true, data: [] }),
    } as unknown as ToolExecutor
    const definition: SubAgentDefinition = {
      id: 'test_agent',
      label: 'Test Agent',
      description: 'test',
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
      expect(JSON.stringify(requestBodies[1].messages)).not.toContain('last search wave returned no matches')
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
    } as unknown as ToolExecutor
    const definition: SubAgentDefinition = {
      id: 'explorer',
      label: 'Explorer',
      description: 'test',
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
      readFile: async () => ({ success: true, data: '' }),
    } as unknown as ToolExecutor
    const definition: SubAgentDefinition = {
      id: 'test_agent',
      label: 'Test Agent',
      description: 'test',
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

      expect(result).toMatchObject({ ok: false, truncated: true, error: expect.stringContaining('turn limit') })
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
    } as unknown as ToolExecutor

    try {
      const result = await runSubAgent({
        definition: {
          id: 'explorer',
          label: 'Explorer',
          description: 'test',
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


  it('rejects paths that escape the delegated subagent scope', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
      id: 'escape-read',
      function: { name: 'read_file', arguments: JSON.stringify({ path: '../outside.ts', offset: 1, limit: 10 }) },
    }] } }] }), { status: 200 })) as unknown as typeof fetch

    const readFile = vi.fn(async () => ({ success: true, data: 'should not be read' }))
    const events: SubAgentEvent[] = []
    const executor = {
      readFile,
      searchFiles: async () => ({ success: true, data: { matches: [] } }),
      searchContent: async () => ({ success: true, data: [] }),
    } as unknown as ToolExecutor

    try {
      const result = await runSubAgent({
        definition: {
          id: 'explorer',
          label: 'Explorer',
          description: 'test',
          systemPrompt: 'test',
          maxTurns: 1,
          maxParallel: 1,
        },
        objective: 'inspect only the delegated subtree',
        workspacePath: 'C:/repo/src/core',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
        onEvent: event => events.push(event),
      })

      expect(result).toMatchObject({ ok: false, truncated: true, error: expect.stringContaining('turn limit') })
      expect(readFile).not.toHaveBeenCalled()
      expect(events).toContainEqual(expect.objectContaining({
        type: 'tool_result',
        tool: 'read_file',
        ok: false,
        summary: expect.stringContaining('Path escapes the delegated subagent scope'),
      }))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('does not launch a same-name repository scan after every read', async () => {
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
      searchFiles: vi.fn(async () => ({ success: true, data: { matches: [
        'C:/repo/src/core/Runtime.java',
        'C:/repo/android/src/core/Runtime.java',
      ] } })),
      searchContent: async () => ({ success: true, data: [] }),
    } as unknown as ToolExecutor

    try {
      await runSubAgent({
        definition: {
          id: 'explorer',
          label: 'Explorer',
          description: 'test',
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

      expect(JSON.stringify(requestBodies[1].messages)).not.toContain('android/src/core/Runtime.java')
      expect(executor.searchFiles).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('reports a missing package index without silently reading a different module', async () => {
    const originalFetch = globalThis.fetch
    let requestCount = 0
    globalThis.fetch = vi.fn(async () => {
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
          id: 'locate-old-module',
          function: { name: 'search_content', arguments: JSON.stringify({ pattern: 'Grouper' }) },
        }] } }] }), { status: 200 })
      }
      if (requestCount === 2) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
          id: 'read-old-module',
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'lib/matplotlib/cbook/__init__.py', offset: 1, limit: 10 }) },
        }] } }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'lib/matplotlib/cbook.py owns Grouper serialization.' } }] }), { status: 200 })
    }) as unknown as typeof fetch

    const executor = {
      readFileRange: vi.fn(async (path: string) => path.replace(/\\/g, '/').endsWith('/lib/matplotlib/cbook.py')
        ? { success: true, data: { content: 'class Grouper:\n    pass', truncated: false } }
        : { success: false, error: 'File not found' }),
      readFile: async () => ({ success: false, error: 'File not found' }),
      searchFiles: vi.fn(async () => ({ success: true, data: { matches: [] } })),
      searchContent: async () => ({ success: true, data: [] }),
    } as unknown as ToolExecutor

    try {
      const result = await runSubAgent({
        definition: {
          id: 'test_agent',
          label: 'Test Agent',
          description: 'test',
          systemPrompt: 'Use grounded repository evidence.',
          maxTurns: 3,
          maxParallel: 2,
        },
        objective: 'find Grouper serialization owner',
        workspacePath: 'C:/repo',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
      })

      expect(result).toMatchObject({ ok: true, turns: 3, finalText: expect.stringContaining('lib/matplotlib/cbook.py') })
      expect(result.evidence).toEqual([])
      expect(executor.readFileRange).toHaveBeenCalledOnce()
      expect(executor.readFileRange).toHaveBeenCalledWith(expect.stringContaining('__init__.py'), 0, 10, 48 * 1024)
      expect(executor.searchFiles).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
