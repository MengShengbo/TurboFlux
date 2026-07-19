import { describe, expect, it, vi } from 'vitest'
import type { AgentTurn, ToolCall, ToolResult } from '../shared/agentTypes'
import type { ToolExecutor } from '../tools/executor'
import type { McpClient } from './mcp/client'
import { AgentEngine, appendRuntimeContextToLatestUserMessage, splitTurnsForCompaction, type AgentEventType } from './agentEngine'
import { NodeToolExecutor } from './runtime/nodeToolExecutor'
import { DefaultAgentStateProvider } from './runtime/stateProvider'

describe('appendRuntimeContextToLatestUserMessage', () => {
  it('does not create a synthetic user turn after tool results', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'build the app' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc1' }] },
      { role: 'tool', tool_call_id: 'tc1', content: 'done' },
    ]

    const appended = appendRuntimeContextToLatestUserMessage(messages, '<runtime_context>internal</runtime_context>', 'openai')

    expect(appended).toBe(true)
    expect(messages).toHaveLength(4)
    expect(messages[1]?.content).toContain('build the app')
    expect(messages[1]?.content).toContain('<runtime_context>internal</runtime_context>')
    expect(messages.at(-1)).toMatchObject({ role: 'tool' })
  })

  it('appends to anthropic user content blocks', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: 'system' },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]

    const appended = appendRuntimeContextToLatestUserMessage(messages, '<runtime_context>internal</runtime_context>', 'anthropic')

    expect(appended).toBe(true)
    expect(messages).toHaveLength(3)
    expect(messages[1]?.content).toEqual([
      { type: 'text', text: 'continue' },
      { type: 'text', text: '<runtime_context>internal</runtime_context>' },
    ])
  })
})

describe('AgentEngine MCP dispatch', () => {
  it('executes connected MCP tools instead of rejecting them as unknown', async () => {
    const workspace = process.cwd()
    const runtimeConfig = {
      provider: 'custom' as const,
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }
    const stateProvider = new DefaultAgentStateProvider(runtimeConfig, workspace)
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      temperature: 0,
      maxTokens: 4096,
      maxTurns: 2,
      workspacePath: workspace,
    }, new NodeToolExecutor(workspace), stateProvider)
    const callTool = vi.fn(async () => ({ content: 'mcp result', isError: false }))
    engine.setMcpClient({
      getAllTools: () => [{
        name: 'files__replace',
        serverName: 'files',
        description: 'replace',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        annotations: { readOnlyHint: false, destructiveHint: true },
      }],
      callTool,
    } as unknown as McpClient)
    const executeSingleTool = (engine as unknown as {
      executeSingleTool: (toolCall: ToolCall) => Promise<ToolResult>
    }).executeSingleTool.bind(engine)

    const result = await executeSingleTool({ id: 'mcp-1', name: 'files__replace', arguments: { path: 'a.ts' } })

    expect(result).toMatchObject({ isError: false, output: 'mcp result' })
    expect(callTool).toHaveBeenCalledWith('files', 'replace', { path: 'a.ts' })
    engine.destroy()
  })
})

describe('AgentEngine command output', () => {
  function createHarness(result: Awaited<ReturnType<ToolExecutor['runCommand']>>) {
    const workspace = process.cwd()
    const runtimeConfig = {
      provider: 'custom' as const,
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }
    const stateProvider = new DefaultAgentStateProvider(runtimeConfig, workspace)
    const executor = {
      runCommand: vi.fn(async () => result),
    } as unknown as ToolExecutor
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      workspacePath: workspace,
    }, executor, stateProvider)
    const executeSingleTool = (engine as unknown as {
      executeSingleTool: (toolCall: ToolCall) => Promise<ToolResult>
    }).executeSingleTool.bind(engine)
    return { engine, executeSingleTool }
  }

  it('shows stdout and stderr for successful commands', async () => {
    const { engine, executeSingleTool } = createHarness({
      success: true,
      data: { stdout: 'build output', stderr: 'build warning', exitCode: 0 },
    })
    try {
      const result = await executeSingleTool({
        id: 'command-success-1',
        name: 'run_command',
        arguments: { command: 'build' },
      })

      expect(result.output).toContain('stdout:\nbuild output')
      expect(result.output).toContain('stderr:\nbuild warning')
    } finally {
      engine.destroy()
    }
  })

  it('shows stdout and stderr for failed commands', async () => {
    const { engine, executeSingleTool } = createHarness({
      success: false,
      error: 'Command exited with code 2',
      data: { stdout: 'partial output', stderr: 'build failed', exitCode: 2 },
    })
    try {
      const result = await executeSingleTool({
        id: 'command-failure-1',
        name: 'run_command',
        arguments: { command: 'build' },
      })

      expect(result.output).toContain('stdout:\npartial output')
      expect(result.output).toContain('stderr:\nbuild failed')
    } finally {
      engine.destroy()
    }
  })

  it('writes raw stdin to a running terminal', async () => {
    const workspace = process.cwd()
    const ptyWrite = vi.fn(async () => ({ success: true }))
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      workspacePath: workspace,
    }, { ptyWrite } as unknown as ToolExecutor, stateProvider)
    const executeSingleTool = (engine as unknown as {
      executeSingleTool: (toolCall: ToolCall) => Promise<ToolResult>
    }).executeSingleTool.bind(engine)

    try {
      const result = await executeSingleTool({
        id: 'terminal-write-1',
        name: 'write_terminal',
        arguments: { session_id: 'term-1', data: 'yes\n' },
      })

      expect(result.isError).toBe(false)
      expect(result.output).toContain('Wrote 4 byte(s)')
      expect(ptyWrite).toHaveBeenCalledWith('term-1', 'yes\n')
    } finally {
      engine.destroy()
    }
  })

  it('reports the persistent log path for background commands', async () => {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const executor = {
      validateCommand: vi.fn(async () => ({ success: true })),
      ptyCreate: vi.fn(async () => ({
        success: true,
        data: { sessionId: 'term-1', session: { logPath: 'C:/logs/term-1.jsonl' } },
      })),
      ptyWrite: vi.fn(async () => ({ success: true })),
    } as unknown as ToolExecutor
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      workspacePath: workspace,
    }, executor, stateProvider)
    const executeSingleTool = (engine as unknown as {
      executeSingleTool: (toolCall: ToolCall) => Promise<ToolResult>
    }).executeSingleTool.bind(engine)

    try {
      const result = await executeSingleTool({
        id: 'background-command-1',
        name: 'run_command',
        arguments: { command: 'npm test', run_in_background: true },
      })

      expect(result.output).toContain('Log: C:/logs/term-1.jsonl')
    } finally {
      engine.destroy()
    }
  })
})

describe('AgentEngine FastContext scheduling', () => {
  it('returns explore_code immediately while FastContext continues in the background', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const rejectAborted = () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      }
      if (init?.signal?.aborted) rejectAborted()
      else init?.signal?.addEventListener('abort', rejectAborted, { once: true })
    })) as unknown as typeof fetch

    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const executor = {
      listTree: async () => ({
        success: true,
        data: { name: 'repo', type: 'folder', children: [{ name: 'src', type: 'folder', children: [] }] },
      }),
    } as unknown as ToolExecutor
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      temperature: 0,
      maxTokens: 4096,
      maxTurns: 2,
      workspacePath: workspace,
    }, executor, stateProvider)
    const executeSingleTool = (engine as unknown as {
      executeSingleTool: (toolCall: ToolCall) => Promise<ToolResult>
    }).executeSingleTool.bind(engine)

    try {
      const result = await executeSingleTool({
        id: 'explore-1',
        name: 'explore_code',
        arguments: { objective: 'find the CLI entry point', thoroughness: 'medium' },
      })

      expect(result.isError).toBe(false)
      expect(result.output).toContain('background scan started')
      expect(engine.isFastContextRunning()).toBe(true)
    } finally {
      engine.destroy()
      globalThis.fetch = originalFetch
    }
  })
})

describe('AgentEngine permission requests', () => {
  it('includes the concrete tool and target path without requiring a chat turn', async () => {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'ask',
      workspacePath: workspace,
    }, {} as ToolExecutor, stateProvider)
    const askEvents: AgentEventType[] = []
    engine.subscribe(event => {
      if (event.type !== 'ask:user') return
      askEvents.push(event)
      engine.submitAskUserResponse('allow-session')
    })
    const checkToolPermission = (engine as unknown as {
      checkToolPermission: (toolCall: ToolCall) => Promise<ToolResult | null>
    }).checkToolPermission.bind(engine)
    const toolCall: ToolCall = {
      id: 'write-approval-1',
      name: 'write_file',
      arguments: { path: 'src/example.ts', content: 'export const value = 1' },
    }

    try {
      await expect(checkToolPermission(toolCall)).resolves.toBeNull()
      await expect(checkToolPermission({
        ...toolCall,
        id: 'edit-approval-2',
        name: 'edit_file',
        arguments: { path: 'src/other.ts', old_string: 'before', new_string: 'after' },
      })).resolves.toBeNull()
      expect(askEvents).toEqual([expect.objectContaining({
        type: 'ask:user',
        requestId: 'write-approval-1',
        toolName: 'write_file',
        path: 'src/example.ts',
        options: ['allow-once', 'allow-session', 'deny'],
      })])
      expect(engine.getSession().turns).toHaveLength(0)
    } finally {
      engine.destroy()
    }
  })
})

describe('AgentEngine interrupted streams', () => {
  function createHarness(provider: 'custom' | 'anthropic', streamLine?: string, abortStream = true) {
    const workspace = process.cwd()
    const runtimeConfig = {
      provider,
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }
    const stateProvider = new DefaultAgentStateProvider(runtimeConfig, workspace)
    let engine!: AgentEngine
    const streamAbort = vi.fn(async () => {})
    const executor = {
      streamMessage: vi.fn(async (_url: string, _headers: Record<string, string>, _body: string, onLine: (line: string) => void) => {
        if (streamLine) onLine(streamLine)
        if (abortStream) {
          engine.abort()
          return { success: false, error: 'Request aborted' }
        }
        return { success: true, data: '' }
      }),
      streamAbort,
    } as unknown as ToolExecutor
    engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      temperature: 0,
      maxTokens: 4096,
      maxTurns: 2,
      workspacePath: workspace,
    }, executor, stateProvider)
    ;(engine as unknown as { abortController: AbortController }).abortController = new AbortController()
    const events: AgentEventType[] = []
    engine.subscribe(event => events.push(event))
    return { engine, stateProvider, events, streamAbort }
  }

  it('keeps partial OpenAI-compatible text and strips incomplete tool markup', async () => {
    const line = `data: ${JSON.stringify({
      choices: [{ delta: { content: 'Keep this answer.\n<tool_calls><invoke name="read_file">' }, finish_reason: null }],
    })}`
    const { engine, stateProvider, events, streamAbort } = createHarness('custom', line)
    const internal = engine as unknown as {
      callOpenAICompatibleAPI: (
        config: ReturnType<DefaultAgentStateProvider['getActiveConfig']>,
        model: ReturnType<DefaultAgentStateProvider['getActiveModel']>,
        messages: Array<Record<string, unknown>>,
        startTime: number,
      ) => Promise<AgentTurn>
    }

    try {
      const turn = await internal.callOpenAICompatibleAPI(
        stateProvider.getActiveConfig(),
        stateProvider.getActiveModel(),
        [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
        Date.now(),
      )

      expect(turn.content).toBe('Keep this answer.')
      expect(turn.metadata?.interrupted).toBe(true)
      expect(turn.toolCalls).toBeUndefined()
      expect(events).toContainEqual({ type: 'stream:end', interrupted: true })
      expect(streamAbort).toHaveBeenCalledOnce()
    } finally {
      engine.destroy()
    }
  })

  it('keeps partial Anthropic text as an interrupted assistant turn', async () => {
    const line = `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Anthropic partial response' },
    })}`
    const { engine, stateProvider, events } = createHarness('anthropic', line)
    const internal = engine as unknown as {
      callAnthropicAPI: (
        config: ReturnType<DefaultAgentStateProvider['getActiveConfig']>,
        model: ReturnType<DefaultAgentStateProvider['getActiveModel']>,
        systemPrompt: string,
        messages: Array<Record<string, unknown>>,
        startTime: number,
      ) => Promise<AgentTurn>
    }

    try {
      const turn = await internal.callAnthropicAPI(
        stateProvider.getActiveConfig(),
        stateProvider.getActiveModel(),
        'system',
        [{ role: 'user', content: 'hello' }],
        Date.now(),
      )

      expect(turn.content).toBe('Anthropic partial response')
      expect(turn.metadata?.interrupted).toBe(true)
      expect(events).toContainEqual({ type: 'stream:end', interrupted: true })
    } finally {
      engine.destroy()
    }
  })

  it('does not create an empty assistant turn when interrupted before output', async () => {
    const { engine, stateProvider, events } = createHarness('custom')
    const internal = engine as unknown as {
      callOpenAICompatibleAPI: (
        config: ReturnType<DefaultAgentStateProvider['getActiveConfig']>,
        model: ReturnType<DefaultAgentStateProvider['getActiveModel']>,
        messages: Array<Record<string, unknown>>,
        startTime: number,
      ) => Promise<AgentTurn>
    }

    try {
      await expect(internal.callOpenAICompatibleAPI(
        stateProvider.getActiveConfig(),
        stateProvider.getActiveModel(),
        [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
        Date.now(),
      )).rejects.toMatchObject({ message: 'aborted', aborted: true })
      expect(events).toContainEqual({ type: 'stream:end', interrupted: true })
    } finally {
      engine.destroy()
    }
  })

  it('accepts OpenAI-compatible text when the provider omits the terminal marker', async () => {
    const line = `data: ${JSON.stringify({
      choices: [{ delta: { content: 'Provider response without DONE.' }, finish_reason: null }],
    })}`
    const { engine, stateProvider, events } = createHarness('custom', line, false)
    const internal = engine as unknown as {
      callOpenAICompatibleAPI: (
        config: ReturnType<DefaultAgentStateProvider['getActiveConfig']>,
        model: ReturnType<DefaultAgentStateProvider['getActiveModel']>,
        messages: Array<Record<string, unknown>>,
        startTime: number,
      ) => Promise<AgentTurn>
    }

    try {
      const turn = await internal.callOpenAICompatibleAPI(
        stateProvider.getActiveConfig(),
        stateProvider.getActiveModel(),
        [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
        Date.now(),
      )

      expect(turn.content).toBe('Provider response without DONE.')
      expect(turn.metadata?.interrupted).not.toBe(true)
      expect(events).toContainEqual({ type: 'stream:end' })
    } finally {
      engine.destroy()
    }
  })

  it('accepts Anthropic text when message_stop is omitted', async () => {
    const line = `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Anthropic response without message_stop.' },
    })}`
    const { engine, stateProvider, events } = createHarness('anthropic', line, false)
    const internal = engine as unknown as {
      callAnthropicAPI: (
        config: ReturnType<DefaultAgentStateProvider['getActiveConfig']>,
        model: ReturnType<DefaultAgentStateProvider['getActiveModel']>,
        systemPrompt: string,
        messages: Array<Record<string, unknown>>,
        startTime: number,
      ) => Promise<AgentTurn>
    }

    try {
      const turn = await internal.callAnthropicAPI(
        stateProvider.getActiveConfig(),
        stateProvider.getActiveModel(),
        'system',
        [{ role: 'user', content: 'hello' }],
        Date.now(),
      )

      expect(turn.content).toBe('Anthropic response without message_stop.')
      expect(events).toContainEqual({ type: 'stream:end' })
    } finally {
      engine.destroy()
    }
  })

  it('rejects an unterminated stream that only contains an incomplete tool call', async () => {
    const line = `data: ${JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'partial-tool',
            function: { name: 'write_file', arguments: '{"path":' },
          }],
        },
        finish_reason: null,
      }],
    })}`
    const { engine, stateProvider } = createHarness('custom', line, false)
    const internal = engine as unknown as {
      callOpenAICompatibleAPI: (
        config: ReturnType<DefaultAgentStateProvider['getActiveConfig']>,
        model: ReturnType<DefaultAgentStateProvider['getActiveModel']>,
        messages: Array<Record<string, unknown>>,
        startTime: number,
      ) => Promise<AgentTurn>
    }

    try {
      await expect(internal.callOpenAICompatibleAPI(
        stateProvider.getActiveConfig(),
        stateProvider.getActiveModel(),
        [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
        Date.now(),
      )).rejects.toThrow('Model stream ended before a terminal event')
    } finally {
      engine.destroy()
    }
  })

  it('persists a partial assistant turn through the full run loop', async () => {
    const workspace = process.cwd()
    const runtimeConfig = {
      provider: 'custom' as const,
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }
    const stateProvider = new DefaultAgentStateProvider(runtimeConfig, workspace)
    const executor = new NodeToolExecutor(workspace)
    let engine!: AgentEngine
    const streamAbort = vi.spyOn(executor, 'streamAbort').mockResolvedValue()
    vi.spyOn(executor, 'streamMessage').mockImplementation(async (_url, _headers, _body, onLine) => {
      onLine(`data: ${JSON.stringify({
        choices: [{ delta: { content: 'Persist this partial reply.' }, finish_reason: null }],
      })}`)
      engine.abort()
      return { success: false, error: 'Request aborted' }
    })
    engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      temperature: 0,
      maxTokens: 4096,
      maxTurns: 2,
      workspacePath: workspace,
    }, executor, stateProvider)

    try {
      const turns = await engine.run('start a partial response')
      const assistantTurn = turns.find(turn => turn.role === 'assistant')

      expect(assistantTurn?.content).toBe('Persist this partial reply.')
      expect(assistantTurn?.metadata?.interrupted).toBe(true)
      expect(engine.getSession().turns.at(-1)).toMatchObject({
        role: 'assistant',
        content: 'Persist this partial reply.',
        metadata: expect.objectContaining({ interrupted: true }),
      })
      expect(streamAbort).toHaveBeenCalledOnce()
    } finally {
      engine.destroy()
    }
  })
})

describe('AgentEngine model protocol compatibility', () => {
  function createProtocolHarness(
    provider: 'custom' | 'anthropic',
    model: string,
    streamMessage: ToolExecutor['streamMessage'],
  ) {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider,
      apiKey: 'test-key',
      baseUrl: 'https://ai.zyyun.xyz/v1',
      model,
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const executor = {
      streamMessage: vi.fn(streamMessage),
      streamAbort: vi.fn(async () => {}),
    } as unknown as ToolExecutor
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      temperature: 0,
      maxTokens: 4096,
      maxTurns: 2,
      workspacePath: workspace,
    }, executor, stateProvider)
    engine.restoreFromTurns([{
      id: 'user-protocol-test',
      role: 'user',
      content: 'hello',
      timestamp: Date.now(),
    }])
    ;(engine as unknown as { abortController: AbortController }).abortController = new AbortController()
    const events: AgentEventType[] = []
    engine.subscribe(event => events.push(event))
    const callModel = () => (engine as unknown as { callModel: () => Promise<AgentTurn> }).callModel()
    return { engine, executor, stateProvider, events, callModel }
  }

  it('uses /messages immediately after an Anthropic config is active', async () => {
    const harness = createProtocolHarness('anthropic', 'claude-fable-5', async (url, headers, body, onLine) => {
      expect(url).toBe('https://ai.zyyun.xyz/v1/messages')
      expect(headers['x-api-key']).toBe('test-key')
      expect(headers.Authorization).toBeUndefined()
      expect(JSON.parse(body)).toMatchObject({ model: 'claude-fable-5', stream: true })
      onLine(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'messages-ok' } })}`)
      onLine(`data: ${JSON.stringify({ type: 'message_stop' })}`)
      return { success: true, data: '' }
    })

    try {
      await expect(harness.callModel()).resolves.toMatchObject({ content: 'messages-ok' })
      expect(harness.executor.streamMessage).toHaveBeenCalledOnce()
    } finally {
      harness.engine.destroy()
    }
  })

  it('uses the newly active Anthropic config without retaining the old Chat route', async () => {
    const harness = createProtocolHarness('custom', 'generic-model', async (url, headers, _body, onLine) => {
      expect(url).toBe('https://ai.zyyun.xyz/v1/messages')
      expect(headers['x-api-key']).toBe('updated-key')
      onLine(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'updated-config-ok' } })}`)
      onLine(`data: ${JSON.stringify({ type: 'message_stop' })}`)
      return { success: true, data: '' }
    })
    harness.stateProvider.updateConfig({
      provider: 'anthropic',
      apiKey: 'updated-key',
      baseUrl: 'https://ai.zyyun.xyz/v1',
      model: 'claude-fable-5',
      contextWindow: 100_000,
      maxTokens: 4096,
    })

    try {
      await expect(harness.callModel()).resolves.toMatchObject({ content: 'updated-config-ok' })
      expect(harness.executor.streamMessage).toHaveBeenCalledOnce()
    } finally {
      harness.engine.destroy()
    }
  })

  it('retries /messages without an unsupported optional feature before changing protocols', async () => {
    const requestBodies: Array<Record<string, any>> = []
    const harness = createProtocolHarness('anthropic', 'claude-fable-5', async (_url, _headers, body, onLine) => {
      requestBodies.push(JSON.parse(body))
      if (requestBodies.length === 1) {
        return { success: false, status: 400, error: 'HTTP 400: unknown parameter: cache_control' }
      }
      onLine(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'messages-downgrade-ok' } })}`)
      onLine(`data: ${JSON.stringify({ type: 'message_stop' })}`)
      return { success: true, data: '' }
    })

    try {
      await expect(harness.callModel()).resolves.toMatchObject({ content: 'messages-downgrade-ok' })
      expect(JSON.stringify(requestBodies[0])).toContain('cache_control')
      expect(JSON.stringify(requestBodies[1])).not.toContain('cache_control')
      expect(vi.mocked(harness.executor.streamMessage).mock.calls.map(call => call[0])).toEqual([
        'https://ai.zyyun.xyz/v1/messages',
        'https://ai.zyyun.xyz/v1/messages',
      ])
      expect(harness.events.filter(event => event.type === 'model:protocol' && event.phase === 'fallback')).toHaveLength(0)
    } finally {
      harness.engine.destroy()
    }
  })

  it('uses a Claude model hint and falls back from Messages to Chat on a route mismatch', async () => {
    const harness = createProtocolHarness('custom', 'vendor/claude-fable-5', async (url, headers, _body, onLine) => {
      if (url.endsWith('/messages')) {
        expect(headers.Authorization).toBe('Bearer test-key')
      }
      if (url.endsWith('/messages')) return { success: false, status: 404, error: 'HTTP 404: route not found' }
      onLine(`data: ${JSON.stringify({ choices: [{ delta: { content: 'chat-fallback-ok' }, finish_reason: 'stop' }] })}`)
      onLine('data: [DONE]')
      return { success: true, data: '' }
    })

    try {
      await expect(harness.callModel()).resolves.toMatchObject({ content: 'chat-fallback-ok' })
      expect(vi.mocked(harness.executor.streamMessage).mock.calls.map(call => call[0])).toEqual([
        'https://ai.zyyun.xyz/v1/messages',
        'https://ai.zyyun.xyz/v1/chat/completions',
      ])
      expect(harness.events).toContainEqual(expect.objectContaining({
        type: 'model:protocol',
        phase: 'fallback',
        protocol: 'openai_chat',
      }))
    } finally {
      harness.engine.destroy()
    }
  })

  it('does not cross protocols for authentication failures or after stream bytes arrive', async () => {
    for (const emitBytes of [false, true]) {
      const harness = createProtocolHarness('anthropic', 'claude-fable-5', async (_url, _headers, _body, onLine) => {
        if (emitBytes) onLine('event: message_start')
        return {
          success: false,
          status: emitBytes ? 404 : 401,
          error: emitBytes ? 'HTTP 404: route not found' : 'HTTP 401: invalid API key',
        }
      })
      try {
        const turn = await harness.callModel()
        expect(turn.content).toContain('All compatible model protocols failed')
        expect(harness.executor.streamMessage).toHaveBeenCalledOnce()
      } finally {
        harness.engine.destroy()
      }
    }
  })

  it('falls back to Responses and parses typed function-call streaming events', async () => {
    let responseRequest: Record<string, any> | undefined
    const harness = createProtocolHarness('custom', 'gpt-compatible-model', async (url, _headers, body, onLine) => {
      if (url.endsWith('/chat/completions')) return { success: false, status: 404, error: 'HTTP 404: endpoint not found' }
      expect(url).toBe('https://ai.zyyun.xyz/v1/responses')
      responseRequest = JSON.parse(body)
      onLine(`data: ${JSON.stringify({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'read_file', arguments: '' },
      })}`)
      onLine(`data: ${JSON.stringify({
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        item_id: 'item_1',
        delta: '{"path":"README.md"}',
      })}`)
      onLine(`data: ${JSON.stringify({
        type: 'response.completed',
        response: { usage: { input_tokens: 100, output_tokens: 12, input_tokens_details: { cached_tokens: 20 } }, output: [] },
      })}`)
      return { success: true, data: '' }
    })

    try {
      const turn = await harness.callModel()
      expect(responseRequest?.messages).toBeUndefined()
      expect(responseRequest?.input).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: expect.stringContaining('hello') }),
      ]))
      expect(responseRequest?.tools[0]).toMatchObject({ type: 'function', name: expect.any(String) })
      expect(turn.toolCalls).toEqual([{
        id: 'call_1',
        name: 'read_file',
        arguments: { path: 'README.md' },
      }])
      expect(turn.metadata?.tokens).toMatchObject({ input: 100, output: 12 })
      expect(vi.mocked(harness.executor.streamMessage).mock.calls.map(call => call[0])).toEqual([
        'https://ai.zyyun.xyz/v1/chat/completions',
        'https://ai.zyyun.xyz/v1/responses',
      ])
    } finally {
      harness.engine.destroy()
    }
  })

  it('reports every attempted protocol and URL when all candidates fail', async () => {
    const harness = createProtocolHarness('custom', 'gpt-compatible-model', async url => {
      if (url.endsWith('/chat/completions')) return { success: false, status: 404, error: 'HTTP 404: endpoint not found' }
      if (url.endsWith('/responses')) return { success: false, status: 415, error: 'HTTP 415: unsupported request format' }
      return { success: false, status: 401, error: 'HTTP 401: invalid API key' }
    })

    try {
      const turn = await harness.callModel()
      expect(turn.content).toContain('https://ai.zyyun.xyz/v1/chat/completions')
      expect(turn.content).toContain('https://ai.zyyun.xyz/v1/responses')
      expect(turn.content).toContain('https://ai.zyyun.xyz/v1/messages')
      expect(harness.executor.streamMessage).toHaveBeenCalledTimes(3)
    } finally {
      harness.engine.destroy()
    }
  })
})

describe('context compaction boundaries', () => {
  it('keeps assistant tool calls together with their tool results', () => {
    const turns = [
      { id: 'u1', role: 'user' as const, content: 'start', timestamp: 1 },
      { id: 'a1', role: 'assistant' as const, content: '', timestamp: 2, toolCalls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'a.ts' } }] },
      { id: 'tr1', role: 'tool_result' as const, content: 'result', timestamp: 3, toolResults: [{ toolCallId: 'tc1', name: 'read_file', output: 'result', isError: false }] },
      { id: 'a2', role: 'assistant' as const, content: 'done', timestamp: 4 },
    ]

    const split = splitTurnsForCompaction(turns, 2)

    expect(split.oldTurns.map(turn => turn.id)).toEqual(['u1'])
    expect(split.recentTurns.map(turn => turn.id)).toEqual(['a1', 'tr1', 'a2'])
  })
})
