import { describe, expect, it, vi } from 'vitest'
import type { ToolCall, ToolResult } from '../shared/agentTypes'
import type { McpClient } from './mcp/client'
import { AgentEngine, appendRuntimeContextToLatestUserMessage } from './agentEngine'
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
