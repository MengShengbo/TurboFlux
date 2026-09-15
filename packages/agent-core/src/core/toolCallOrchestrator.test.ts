import { describe, expect, it, vi } from 'vitest'
import type { AgentTool, ToolCall, ToolResult } from '../shared/agentTypes'
import { executeToolCallBatches, partitionToolCalls } from './toolCallOrchestrator'

const readTool: AgentTool = {
  name: 'read',
  description: 'read',
  category: 'read',
  parameters: [],
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
}

const writeTool: AgentTool = {
  ...readTool,
  name: 'write',
  category: 'write',
  isReadOnly: false,
  isConcurrencySafe: false,
}

const calls: ToolCall[] = [
  { id: 'read-1', name: 'read', arguments: {} },
  { id: 'read-2', name: 'read', arguments: {} },
  { id: 'write-1', name: 'write', arguments: {} },
  { id: 'read-3', name: 'read', arguments: {} },
]

function result(toolCall: ToolCall): ToolResult {
  return { toolCallId: toolCall.id, name: toolCall.name, output: 'ok', isError: false }
}

describe('tool call orchestration', () => {
  it('keeps reads parallel until a write makes following reads sensitive', () => {
    const batches = partitionToolCalls(calls, {
      resolveTool: name => name === 'write' ? writeTool : readTool,
      isWrite: toolCall => toolCall.name === 'write',
      isReadAfterWriteSensitive: toolCall => toolCall.name === 'read',
    })

    expect(batches.map(batch => ({
      safe: batch.isConcurrencySafe,
      ids: batch.toolCalls.map(toolCall => toolCall.id),
    }))).toEqual([
      { safe: true, ids: ['read-1', 'read-2'] },
      { safe: false, ids: ['write-1'] },
      { safe: false, ids: ['read-3'] },
    ])
  })

  it('runs safe batches concurrently and fills cancellation results after abort', async () => {
    let aborted = false
    const executeConcurrent = vi.fn(async (batch: ToolCall[]) => {
      aborted = true
      return batch.map(result)
    })
    const executeSerial = vi.fn(async (toolCall: ToolCall) => result(toolCall))

    const results = await executeToolCallBatches(calls, {
      batches: [
        { isConcurrencySafe: true, toolCalls: calls.slice(0, 2) },
        { isConcurrencySafe: false, toolCalls: calls.slice(2) },
      ],
      isAborted: () => aborted,
      executeSerial,
      executeConcurrent,
      createCancelled: toolCall => ({
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: 'cancelled',
        isError: true,
        errorKind: 'abort',
      }),
    })

    expect(executeConcurrent).toHaveBeenCalledOnce()
    expect(executeSerial).not.toHaveBeenCalled()
    expect(results.map(item => [item.toolCallId, item.errorKind])).toEqual([
      ['read-1', undefined],
      ['read-2', undefined],
      ['write-1', 'abort'],
      ['read-3', 'abort'],
    ])
  })
})
