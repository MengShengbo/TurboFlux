import { describe, expect, it, vi } from 'vitest'
import type { AgentTool, ToolCall, ToolResult } from '../../shared/agentTypes'
import { createAgentRunInterruption } from './runControl'
import { ToolExecutionCoordinator } from './toolExecutionCoordinator'

const readTool: AgentTool = {
  name: 'read',
  description: 'read',
  category: 'read',
  parameters: [],
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
}

const calls: ToolCall[] = [
  { id: 'read-1', name: 'read', arguments: {} },
  { id: 'read-2', name: 'read', arguments: {} },
  { id: 'read-3', name: 'read', arguments: {} },
]

describe('ToolExecutionCoordinator', () => {
  it('starts a concurrent batch together and reports results as each call completes', async () => {
    const releases = new Map<string, (result: ToolResult) => void>()
    const events: string[] = []
    const coordinator = new ToolExecutionCoordinator({
      resolveTool: () => readTool,
      isWrite: () => false,
      isReadAfterWriteSensitive: () => false,
      execute: toolCall => new Promise(resolve => releases.set(toolCall.id, resolve)),
      onCallsStarted: toolCalls => events.push(`start:${toolCalls.map(call => call.id).join(',')}`),
      onResult: toolCall => events.push(`result:${toolCall.id}`),
      onSettled: () => events.push('settled'),
    })

    const pending = coordinator.execute(calls)
    await Promise.resolve()
    expect(events).toEqual(['start:read-1,read-2,read-3'])

    releases.get('read-2')?.({ toolCallId: 'read-2', name: 'read', output: 'two', isError: false })
    await Promise.resolve()
    releases.get('read-1')?.({ toolCallId: 'read-1', name: 'read', output: 'one', isError: false })
    releases.get('read-3')?.({ toolCallId: 'read-3', name: 'read', output: 'three', isError: false })

    await expect(pending).resolves.toEqual([
      expect.objectContaining({ toolCallId: 'read-1' }),
      expect.objectContaining({ toolCallId: 'read-2' }),
      expect.objectContaining({ toolCallId: 'read-3' }),
    ])
    expect(events).toEqual([
      'start:read-1,read-2,read-3',
      'result:read-2',
      'result:read-1',
      'result:read-3',
      'settled',
    ])
  })

  it('cancels unfinished calls with structured pause metadata', async () => {
    const controller = new AbortController()
    const onResult = vi.fn()
    const coordinator = new ToolExecutionCoordinator({
      resolveTool: () => ({ ...readTool, isConcurrencySafe: false }),
      isWrite: () => false,
      isReadAfterWriteSensitive: () => false,
      execute: async toolCall => {
        controller.abort(createAgentRunInterruption('pause'))
        return { toolCallId: toolCall.id, name: toolCall.name, output: 'ok', isError: false }
      },
      onCallsStarted: vi.fn(),
      onResult,
      onSettled: vi.fn(),
    })

    const results = await coordinator.execute(calls, controller.signal)

    expect(results[0]).toMatchObject({ toolCallId: 'read-1', isError: false })
    expect(results.slice(1)).toEqual([
      expect.objectContaining({ toolCallId: 'read-2', interruption: { kind: 'pause', resumable: true } }),
      expect.objectContaining({ toolCallId: 'read-3', interruption: { kind: 'pause', resumable: true } }),
    ])
    expect(onResult).toHaveBeenCalledTimes(3)
  })
})
