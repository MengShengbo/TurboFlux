import type { ToolCall, ToolResult } from '@turboflux/contracts/agentTypes'
import { copyToolResultDetails } from '@turboflux/contracts/toolResultData'

const REUSABLE_READ_TOOLS = new Set([
  'read_file',
  'read_file_full',
  'list_directory',
  'search_files',
  'search_content',
  'web_search',
  'web_fetch',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
])

export class ToolExecutionLedger {
  private readonly inFlight = new Map<AbortSignal | undefined, Map<string, Promise<ToolResult>>>()

  beginRun(): void {
    this.inFlight.clear()
  }

  invalidateReadResults(): void {
    this.inFlight.clear()
  }

  async execute(
    toolCall: ToolCall,
    execute: () => Promise<ToolResult>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    signal?.throwIfAborted()
    if (!REUSABLE_READ_TOOLS.has(toolCall.name)) return execute()

    const signature = toolCallSignature(toolCall)
    const scope = this.inFlight.get(signal) || new Map<string, Promise<ToolResult>>()
    let promise = scope.get(signature)
    if (!promise) {
      promise = execute()
      scope.set(signature, promise)
      this.inFlight.set(signal, scope)
    }
    try {
      // Without an environment revision, only concurrent requests can share a result.
      const result = await promise
      return {
        ...result,
        toolCallId: toolCall.id,
        name: toolCall.name,
        // Never expose the shared result to an individual caller's event handlers.
        ...copyToolResultDetails(result),
      }
    } finally {
      if (scope.get(signature) === promise) scope.delete(signature)
      if (scope.size === 0 && this.inFlight.get(signal) === scope) this.inFlight.delete(signal)
    }
  }
}

export function toolCallSignature(toolCall: Pick<ToolCall, 'name' | 'arguments'>): string {
  return `${toolCall.name}:${stableStringify(toolCall.arguments)}`
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}
