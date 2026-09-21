import type { AgentTool, ToolCall, ToolResult } from '@turboflux/contracts/agentTypes'
import { ToolExecutionLedger } from '../toolExecutionLedger'
import { type AgentRunControl, createAgentRunInterruption, resolveAgentRunInterruption } from './runControl'
import { settleToolExecution } from './toolExecutionResult'

export interface ToolCallLifecycleOptions {
  runControl: AgentRunControl
  resolveTool(name: string): AgentTool | undefined
  validate(toolCall: ToolCall, tool: AgentTool): ToolResult | undefined
  authorize(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult | null>
  execute(toolCall: ToolCall, tool: AgentTool, signal?: AbortSignal): Promise<ToolResult>
}

/** Owns admission, cancellation and in-flight reuse for a single tool call. */
export class ToolCallLifecycle {
  private ledger = new ToolExecutionLedger()

  constructor(private readonly options: ToolCallLifecycleOptions) {}

  beginRun(): void {
    this.ledger = new ToolExecutionLedger()
  }

  invalidateReadResults(): void {
    this.ledger.invalidateReadResults()
  }

  execute(toolCall: ToolCall, signal = this.options.runControl.getOperationSignal()): Promise<ToolResult> {
    const ledger = this.ledger
    return settleToolExecution(toolCall, signal, async () => {
      this.throwIfInterrupted(signal)
      const tool = this.options.resolveTool(toolCall.name)
      if (!tool) {
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: `Error: unknown tool "${toolCall.name}"`,
          isError: true,
          errorKind: 'validation',
        }
      }

      const validationError = this.options.validate(toolCall, tool)
      if (validationError) return validationError
      const permissionError = await this.options.authorize(toolCall, signal)
      this.throwIfInterrupted(signal)
      if (permissionError) return permissionError
      await this.waitUntilReady(signal)

      // Each caller must pass admission independently. Only physical reads share work.
      return ledger.execute(toolCall, async () => {
        if (!tool.isReadOnly) ledger.invalidateReadResults()
        try {
          const result = await this.options.execute(toolCall, tool, signal)
          await this.waitUntilReady(signal)
          return result
        } finally {
          // A failed or interrupted write can still have changed the workspace.
          if (!tool.isReadOnly) ledger.invalidateReadResults()
        }
      }, signal)
    })
  }

  private async waitUntilReady(signal?: AbortSignal): Promise<void> {
    this.throwIfInterrupted(signal)
    await this.options.runControl.waitIfPaused()
    this.throwIfInterrupted(signal)
  }

  private throwIfInterrupted(signal?: AbortSignal): void {
    const interruption = resolveAgentRunInterruption(this.options.runControl.getRunSignal())
      || resolveAgentRunInterruption(signal)
    if (interruption) throw createAgentRunInterruption(interruption.kind)
  }
}
