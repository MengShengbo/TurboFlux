import { describe, expect, it, vi } from 'vitest'
import type { AgentTool, ToolCall, ToolResult } from '@turboflux/contracts/agentTypes'
import { createAgentRunInterruption } from './runControl'
import { ToolExecutionCoordinator, type ToolExecutionCoordinatorOptions } from './toolExecutionCoordinator'

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

function result(toolCall: ToolCall): ToolResult {
  return { toolCallId: toolCall.id, name: toolCall.name, output: 'ok', isError: false }
}

function harness(overrides: Partial<ToolExecutionCoordinatorOptions> = {}) {
  const options = {
    resolveTool: () => readTool,
    isWrite: () => false,
    isReadAfterWriteSensitive: () => false,
    execute: vi.fn(async (toolCall: ToolCall) => result(toolCall)),
    onCallsStarted: vi.fn(),
    onResult: vi.fn(),
    onSettled: vi.fn(),
    ...overrides,
  }
  return { options, coordinator: new ToolExecutionCoordinator(options) }
}

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

  it('drains a concurrent batch before reporting observer failure and skips subsequent writes', async () => {
    let finishSlow!: (value: ToolResult) => void
    let notifyFailure!: () => void
    const failed = new Promise<void>(resolve => { notifyFailure = resolve })
    const observerError = new Error('result observer failed')
    const write = { id: 'write', name: 'write', arguments: {} }
    const onResult = vi.fn((toolCall: ToolCall) => {
      if (toolCall.id === 'read-1') { notifyFailure(); throw observerError }
    })
    const { coordinator, options } = harness({
      resolveTool: name => ({ ...readTool, isConcurrencySafe: name !== 'write' }),
      execute: vi.fn(toolCall => toolCall.id === 'read-2'
        ? new Promise<ToolResult>(resolve => { finishSlow = resolve })
        : Promise.resolve(result(toolCall))),
      onResult,
    })
    const pending = coordinator.execute([...calls, write]).catch(error => error)
    await failed
    expect(options.onSettled).not.toHaveBeenCalled()
    expect(options.execute).toHaveBeenCalledTimes(3)

    finishSlow(result(calls[1]))
    expect(await pending).toBe(observerError)
    expect(options.onSettled).toHaveBeenCalledOnce()
    expect(onResult.mock.calls.map(([call]) => call.id).sort()).toEqual(['read-1', 'read-2', 'read-3', 'write'])
    expect(onResult).toHaveBeenLastCalledWith(write, expect.objectContaining({
      isError: true, errorKind: 'execution', output: expect.stringContaining('not executed'),
    }))
    expect(options.execute).toHaveBeenCalledTimes(3)
  })

  it('closes all calls when startup fails and preserves failures from cleanup', async () => {
    const startError = new Error('start failed')
    const cleanupError = new Error('cleanup failed')
    const { coordinator, options } = harness({
      onCallsStarted: () => { throw startError },
      onSettled: vi.fn(() => { throw cleanupError }),
    })
    const error = await coordinator.execute(calls).catch(error => error)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toEqual([startError, cleanupError])
    expect(options.execute).not.toHaveBeenCalled()
    expect(options.onResult).toHaveBeenCalledTimes(3)
    expect(options.onSettled).toHaveBeenCalledOnce()
  })

  it('settles every call after a partition failure', async () => {
    const partitionError = new Error('invalid concurrency metadata')
    const { coordinator, options } = harness({ resolveTool: () => { throw partitionError } })

    await expect(coordinator.execute(calls)).rejects.toBe(partitionError)
    expect(options.execute).not.toHaveBeenCalled()
    expect(options.onCallsStarted).toHaveBeenCalledTimes(3)
    expect(options.onResult).toHaveBeenCalledTimes(3)
    expect(options.onSettled).toHaveBeenCalledOnce()
  })

  it('continues cancelling remaining calls when a cancellation observer fails', async () => {
    const controller = new AbortController()
    controller.abort(createAgentRunInterruption('stop'))
    const observerError = new Error('observer failed')
    const onResult = vi.fn((toolCall: ToolCall) => {
      if (toolCall.id === 'read-1') throw observerError
    })
    const { coordinator, options } = harness({ onResult })

    await expect(coordinator.execute(calls, controller.signal)).rejects.toBe(observerError)
    expect(options.execute).not.toHaveBeenCalled()
    expect(onResult).toHaveBeenCalledTimes(3)
    expect(onResult.mock.calls.map(([call]) => call.id)).toEqual(calls.map(call => call.id))
    expect(options.onSettled).toHaveBeenCalledOnce()
  })

  it('binds outcomes to the requested identity and isolates execution failures', async () => {
    const { coordinator } = harness({
      execute: toolCall => {
        if (toolCall.id === 'read-2') throw new Error('broken tool')
        return Promise.resolve({ ...result(toolCall), toolCallId: 'wrong-id', name: 'wrong-name' })
      },
    })

    const results = await coordinator.execute(calls)
    expect(results.map(item => [item.toolCallId, item.name, item.errorKind])).toEqual([
      ['read-1', 'read', undefined],
      ['read-2', 'read', 'execution'],
      ['read-3', 'read', undefined],
    ])
  })

  it('waits for a write barrier before starting following reads together', async () => {
    let finishWrite!: (value: ToolResult) => void
    const write = { id: 'write', name: 'write', arguments: {} }
    const events: string[] = []
    const { coordinator } = harness({
      resolveTool: name => ({ ...readTool, isConcurrencySafe: name !== 'write' }),
      isWrite: toolCall => toolCall.name === 'write',
      isReadAfterWriteSensitive: toolCall => toolCall.name === 'read',
      execute: toolCall => toolCall.name === 'write'
        ? new Promise<ToolResult>(resolve => { finishWrite = resolve })
        : Promise.resolve(result(toolCall)),
      onCallsStarted: calls => events.push(calls.map(call => call.id).join(',')),
    })
    const pending = coordinator.execute([write, ...calls])
    expect(events).toEqual(['write'])
    finishWrite(result(write))
    await pending
    expect(events).toEqual(['write', 'read-1,read-2,read-3'])
  })
})
