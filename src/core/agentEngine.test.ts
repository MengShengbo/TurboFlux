import { describe, expect, it, vi } from 'vitest'
import type { ToolCall, ToolResult } from '../shared/agentTypes'
import type { ToolExecutor } from '../tools/executor'
import type { McpClient } from './mcp/client'
import { AgentEngine, appendRuntimeContextToLatestUserMessage, splitTurnsForCompaction } from './agentEngine'
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
