import type { ToolCall, ToolResult } from '../shared/agentTypes'

const REUSABLE_READ_TOOLS = new Set([
  'read_file',
  'read_file_full',
  'list_directory',
  'search_files',
  'search_content',
  'search_symbols',
  'get_codemap',
  'web_search',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
])

const REUSABLE_FAILURE_TOOLS = new Set([
  'read_file',
  'read_file_full',
  'list_directory',
  'search_files',
  'search_content',
  'search_symbols',
  'get_codemap',
])

interface CachedToolResult {
  sourceCallId: string
  result: ToolResult
}

export class ToolExecutionLedger {
  private readonly completed = new Map<string, CachedToolResult>()
  private readonly inFlight = new Map<string, Promise<ToolResult>>()

  beginRun(): void {
    this.completed.clear()
    this.inFlight.clear()
  }

  invalidateReadResults(): void {
    this.completed.clear()
  }

  async execute(
    toolCall: ToolCall,
    execute: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    if (!REUSABLE_READ_TOOLS.has(toolCall.name)) return execute()

    const signature = toolCallSignature(toolCall)
    const cached = this.completed.get(signature)
    if (cached) return reusedResult(toolCall, cached)

    const pending = this.inFlight.get(signature)
    if (pending) {
      const result = await pending
      return reusedResult(toolCall, { sourceCallId: result.toolCallId, result })
    }

    const promise = execute()
    this.inFlight.set(signature, promise)
    try {
      const result = await promise
      if (!result.isError || REUSABLE_FAILURE_TOOLS.has(toolCall.name)) {
        this.completed.set(signature, { sourceCallId: toolCall.id, result })
      }
      return result
    } finally {
      this.inFlight.delete(signature)
    }
  }
}

export function toolCallSignature(toolCall: Pick<ToolCall, 'name' | 'arguments'>): string {
  return `${toolCall.name}:${stableStringify(toolCall.arguments)}`
}

function reusedResult(toolCall: ToolCall, cached: CachedToolResult): ToolResult {
  const status = cached.result.isError ? 'failed' : 'completed'
  return {
    toolCallId: toolCall.id,
    name: toolCall.name,
    output: `[reused: identical ${toolCall.name} call already ${status} as ${cached.sourceCallId}; the prior result remains in context]`,
    isError: cached.result.isError,
    ...(cached.result.errorKind ? { errorKind: cached.result.errorKind } : {}),
  }
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
