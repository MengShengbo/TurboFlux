import { describe, expect, it } from 'vitest'
import type { AgentEventType } from './agentEngine'
import { AgentEngine } from './agentEngine'
import { DefaultAgentStateProvider } from './runtime/stateProvider'
import type { ToolCall, ToolResult } from '../shared/agentTypes'
import type { ToolExecutor } from '../tools/executor'

describe('AgentEngine concurrent approval requests', () => {
  it('serializes two concurrency-safe MCP approvals without losing a resolver', async () => {
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
    const asks: Array<Extract<AgentEventType, { type: 'ask:user' }>> = []
    engine.subscribe(event => {
      if (event.type === 'ask:user') asks.push(event)
    })
    const checkToolPermission = (engine as unknown as {
      checkToolPermission: (toolCall: ToolCall) => Promise<ToolResult | null>
    }).checkToolPermission.bind(engine)
    const firstCall = { id: 'mcp-read-1', name: 'files__read', arguments: { path: 'a.ts' } }
    const secondCall = { id: 'mcp-read-2', name: 'files__read', arguments: { path: 'b.ts' } }

    try {
      const first = checkToolPermission(firstCall)
      const second = checkToolPermission(secondCall)

      expect(asks.map(event => event.requestId)).toEqual(['mcp-read-1'])
      expect(engine.getPendingInteractiveRequests()).toMatchObject({ pendingCount: 2 })
      expect(engine.submitAskUserResponse('allow-once', 'mcp-read-2')).toBe(false)
      expect(engine.submitAskUserResponse('allow-once', 'mcp-read-1')).toBe(true)
      await expect(first).resolves.toBeNull()

      expect(asks.map(event => event.requestId)).toEqual(['mcp-read-1', 'mcp-read-2'])
      expect(engine.submitAskUserResponse('allow-once', 'mcp-read-2')).toBe(true)
      await expect(second).resolves.toBeNull()
      expect(engine.getPendingInteractiveRequests()).toMatchObject({ active: null, queued: [], pendingCount: 0 })
      expect(engine.getRunState()).toMatchObject({ phase: 'tool_running', activeTool: 'files__read' })
    } finally {
      engine.destroy()
    }
  })

  it('settles every pending request when the run is aborted', async () => {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'ask', workspacePath: workspace }, {} as ToolExecutor, stateProvider)
    const checkToolPermission = (engine as unknown as {
      checkToolPermission: (toolCall: ToolCall) => Promise<ToolResult | null>
    }).checkToolPermission.bind(engine)

    try {
      const first = checkToolPermission({ id: 'first', name: 'files__read', arguments: {} })
      const second = checkToolPermission({ id: 'second', name: 'files__read', arguments: {} })
      engine.abort()

      await expect(first).resolves.toMatchObject({ isError: true, errorKind: 'permission' })
      await expect(second).resolves.toMatchObject({ isError: true, errorKind: 'permission' })
      expect(engine.getPendingInteractiveRequests().pendingCount).toBe(0)
    } finally {
      engine.destroy()
    }
  })
})
