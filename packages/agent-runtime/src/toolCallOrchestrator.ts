import type { AgentTool, ToolCall, ToolResult } from '@turboflux/contracts/agentTypes'
import type { EnhancedToolDef } from '@turboflux/contracts/toolTypes'

export interface ToolCallBatch {
  isConcurrencySafe: boolean
  toolCalls: ToolCall[]
}

export interface ToolCallPartitionOptions {
  resolveTool(name: string): AgentTool | undefined
  isWrite(toolCall: ToolCall): boolean
  isReadAfterWriteSensitive(toolCall: ToolCall): boolean
}

export interface ToolCallExecutionOptions {
  batches: readonly ToolCallBatch[]
  isAborted(): boolean
  executeSerial(toolCall: ToolCall): Promise<ToolResult>
  executeConcurrent(toolCalls: ToolCall[]): Promise<ToolResult[]>
  createCancelled(toolCall: ToolCall): ToolResult
}

export function partitionToolCalls(
  toolCalls: readonly ToolCall[],
  options: ToolCallPartitionOptions,
): ToolCallBatch[] {
  const batches: ToolCallBatch[] = []
  let batchHasWrite = false

  for (const toolCall of toolCalls) {
    const tool = options.resolveTool(toolCall.name)
    const isReadAfterWrite = batchHasWrite && options.isReadAfterWriteSensitive(toolCall)
    const declaredSafe = tool?.isConcurrencySafe === true
    const concurrencyPredicate = (tool as EnhancedToolDef | undefined)?.isConcurrencySafeFor
    const inputSafe = concurrencyPredicate ? concurrencyPredicate(toolCall.arguments) : declaredSafe
    const isSafe = inputSafe
    const previousBatch = batches[batches.length - 1]

    if (isSafe && previousBatch?.isConcurrencySafe && !isReadAfterWrite) {
      previousBatch.toolCalls.push(toolCall)
    } else {
      batches.push({ isConcurrencySafe: isSafe, toolCalls: [toolCall] })
      batchHasWrite = false
    }

    // Awaiting the previous batch is the write barrier; later reads can run together.
    if (options.isWrite(toolCall)) batchHasWrite = true
  }

  return batches
}

export async function executeToolCallBatches(
  toolCalls: readonly ToolCall[],
  options: ToolCallExecutionOptions,
): Promise<ToolResult[]> {
  const results: ToolResult[] = []

  for (const batch of options.batches) {
    if (options.isAborted()) break

    if (batch.isConcurrencySafe && batch.toolCalls.length > 1) {
      results.push(...await options.executeConcurrent(batch.toolCalls))
      continue
    }

    for (const toolCall of batch.toolCalls) {
      if (options.isAborted()) break
      results.push(await options.executeSerial(toolCall))
    }
  }

  const completedIds = new Set(results.map(result => result.toolCallId))
  for (const toolCall of toolCalls) {
    if (completedIds.has(toolCall.id)) continue
    results.push(options.createCancelled(toolCall))
  }

  return results
}
