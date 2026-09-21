import type { AgentRunInterruption, ToolCall, ToolResult } from '@turboflux/contracts/agentTypes'
import { isAgentRunInterruption, resolveAgentRunInterruption } from './runControl'

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

export function createToolExecutionErrorResult(toolCall: ToolCall, error: unknown): ToolResult {
  return {
    toolCallId: toolCall.id,
    name: toolCall.name,
    output: `Tool execution error: ${error instanceof Error ? error.message : String(error)}`,
    isError: true,
    errorKind: 'execution',
  }
}

/** Bind every outcome to its caller, including failures before dispatch. */
export async function settleToolExecution(
  toolCall: ToolCall,
  signal: AbortSignal | undefined,
  execute: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const interruption = resolveAgentRunInterruption(signal)
  if (interruption) return createInterruptedToolResult(toolCall, interruption)

  try {
    const result = await execute()
    return { ...result, toolCallId: toolCall.id, name: toolCall.name }
  } catch (error) {
    const executionInterruption = isAgentRunInterruption(error)
      ? resolveAgentRunInterruption(undefined, error)
      : resolveAgentRunInterruption(signal, error)
    return executionInterruption
      ? createInterruptedToolResult(toolCall, executionInterruption)
      : createToolExecutionErrorResult(toolCall, error)
  }
}
