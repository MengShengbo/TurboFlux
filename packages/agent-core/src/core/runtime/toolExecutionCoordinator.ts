import type { AgentTool, AgentRunInterruption, ToolCall, ToolResult } from '../../shared/agentTypes'
import { executeToolCallBatches, partitionToolCalls, type ToolCallBatch } from '../toolCallOrchestrator'
import { interruptionMetadata, resolveAgentRunInterruption } from './runControl'

export interface ToolExecutionCoordinatorOptions {
  resolveTool(name: string): AgentTool | undefined
  isWrite(toolCall: ToolCall): boolean
  isReadAfterWriteSensitive(toolCall: ToolCall): boolean
  execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult>
  onCallsStarted(toolCalls: readonly ToolCall[]): void
  onResult(toolCall: ToolCall, result: ToolResult): void
  onSettled(): void
}

export function createInterruptedToolResult(
  toolCall: ToolCall,
  interruption: AgentRunInterruption,
): ToolResult {
  return {
    toolCallId: toolCall.id,
    name: toolCall.name,
    output: interruption.kind === 'pause'
      ? 'Cancelled: paused by user'
      : 'Cancelled: stopped by user',
    isError: true,
    errorKind: 'abort',
    interruption,
  }
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

    try {
      return await executeToolCallBatches(toolCalls, {
        batches: this.partition(toolCalls),
        isAborted: () => signal?.aborted === true,
        executeSerial: async toolCall => {
          this.options.onCallsStarted([toolCall])
          const result = await this.executeOne(toolCall, signal)
          this.options.onResult(toolCall, result)
          return result
        },
        executeConcurrent: async calls => {
          this.options.onCallsStarted(calls)
          return Promise.all(calls.map(async toolCall => {
            const result = await this.executeOne(toolCall, signal)
            this.options.onResult(toolCall, result)
            return result
          }))
        },
        createCancelled: toolCall => {
          this.options.onCallsStarted([toolCall])
          const interruption = resolveAgentRunInterruption(signal) || interruptionMetadata('stop')
          const result = createInterruptedToolResult(toolCall, interruption)
          this.options.onResult(toolCall, result)
          return result
        },
      })
    } finally {
      this.options.onSettled()
    }
  }

  private async executeOne(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const interruption = resolveAgentRunInterruption(signal)
    if (interruption) return createInterruptedToolResult(toolCall, interruption)

    try {
      return await this.options.execute(toolCall, signal)
    } catch (error) {
      const executionInterruption = resolveAgentRunInterruption(signal, error)
      if (executionInterruption) return createInterruptedToolResult(toolCall, executionInterruption)
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Tool execution error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
        errorKind: 'execution',
      }
    }
  }
}
