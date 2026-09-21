import type { AgentTool, ToolCall, ToolResult } from '@turboflux/contracts/agentTypes'
import { executeToolCallBatches, partitionToolCalls, type ToolCallBatch } from '../toolCallOrchestrator'
import { interruptionMetadata, resolveAgentRunInterruption } from './runControl'
import { createInterruptedToolResult, createToolExecutionErrorResult, settleToolExecution } from './toolExecutionResult'

export { createInterruptedToolResult } from './toolExecutionResult'

export interface ToolExecutionCoordinatorOptions {
  resolveTool(name: string): AgentTool | undefined
  isWrite(toolCall: ToolCall): boolean
  isReadAfterWriteSensitive(toolCall: ToolCall): boolean
  execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult>
  onCallsStarted(toolCalls: readonly ToolCall[]): void
  onResult(toolCall: ToolCall, result: ToolResult): void
  onSettled(): void
}

export class ToolExecutionCoordinator {
  constructor(private readonly options: ToolExecutionCoordinatorOptions) {}

  partition(toolCalls: readonly ToolCall[]): ToolCallBatch[] {
    return partitionToolCalls(toolCalls, {
      resolveTool: this.options.resolveTool,
      isWrite: this.options.isWrite,
      isReadAfterWriteSensitive: this.options.isReadAfterWriteSensitive,
    })
  }

  async execute(toolCalls: readonly ToolCall[], signal?: AbortSignal): Promise<ToolResult[]> {
    if (toolCalls.length === 0) return []

    const started = new Set<ToolCall>()
    const completed = new Set<ToolCall>()
    const errors: unknown[] = []
    let results: ToolResult[] = []
    const start = (calls: readonly ToolCall[]) => {
      for (const call of calls) started.add(call)
      this.options.onCallsStarted(calls)
    }
    const finish = (call: ToolCall, result: ToolResult) => {
      // Record settlement before publishing, so a failing observer cannot cause a retry.
      completed.add(call)
      this.options.onResult(call, result)
      return result
    }
    const executeBatch = async (calls: ToolCall[]): Promise<ToolResult[]> => {
      start(calls)
      const outcomes = await Promise.allSettled(calls.map(async call => {
        const result = await settleToolExecution(call, signal, () => this.options.execute(call, signal))
        return finish(call, result)
      }))
      // A notification failure must not release ownership of other running tools.
      const failures = outcomes.filter(outcome => outcome.status === 'rejected')
      if (failures.length === 1) throw failures[0].reason
      if (failures.length > 1) throw new AggregateError(failures.map(failure => failure.reason), 'Tool result notifications failed')
      return outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : [])
    }

    try {
      results = await executeToolCallBatches(toolCalls, {
        batches: this.partition(toolCalls),
        isAborted: () => signal?.aborted === true,
        executeSerial: async toolCall => (await executeBatch([toolCall]))[0],
        executeConcurrent: executeBatch,
        createCancelled: toolCall => {
          start([toolCall])
          const interruption = resolveAgentRunInterruption(signal) || interruptionMetadata('stop')
          return finish(toolCall, createInterruptedToolResult(toolCall, interruption))
        },
      })
    } catch (error) {
      errors.push(error)
      // No new tools are dispatched after a lifecycle failure. Still close every call.
      for (const call of toolCalls) {
        if (completed.has(call)) continue
        if (!started.has(call)) {
          try { start([call]) } catch (startError) { errors.push(startError) }
        }
        const interruption = resolveAgentRunInterruption(signal)
        const result = interruption
          ? createInterruptedToolResult(call, interruption)
          : createToolExecutionErrorResult(call, new Error('Tool was not executed because its batch failed', { cause: error }))
        try { finish(call, result) } catch (resultError) { errors.push(resultError) }
      }
    }

    try { this.options.onSettled() } catch (error) { errors.push(error) }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Tool execution lifecycle failed')
    return results
  }
}
