import { describe, expect, it, vi } from 'vitest'
import type { ToolCall, ToolResult } from '../shared/agentTypes'
import { ToolExecutionLedger, toolCallSignature } from './toolExecutionLedger'

function call(id: string, name = 'read_file', args: Record<string, unknown> = { path: 'src/app.ts' }): ToolCall {
  return { id, name, arguments: args }
}

function result(toolCall: ToolCall, output = 'source'): ToolResult {
  return { toolCallId: toolCall.id, name: toolCall.name, output, isError: false }
}

describe('ToolExecutionLedger', () => {
  it('uses canonical argument ordering for signatures', () => {
    expect(toolCallSignature(call('a', 'search_content', { path: 'src', pattern: 'Agent' })))
      .toBe(toolCallSignature(call('b', 'search_content', { pattern: 'Agent', path: 'src' })))
  })

  it('reuses an identical completed read without repeating its large output', async () => {
    const ledger = new ToolExecutionLedger()
    const execute = vi.fn(async () => result(call('first'), 'large source output'))

    const first = await ledger.execute(call('first'), execute)
    const second = await ledger.execute(call('second'), execute)

    expect(first.output).toBe('large source output')
    expect(second).toMatchObject({ toolCallId: 'second', isError: false })
    expect(second.output).toContain('prior result remains in context')
    expect(second.output).not.toContain('large source output')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('coalesces identical reads emitted in the same parallel batch', async () => {
    const ledger = new ToolExecutionLedger()
    let release: ((value: ToolResult) => void) | undefined
    const pending = new Promise<ToolResult>(resolve => { release = resolve })
    const execute = vi.fn(() => pending)

    const firstPromise = ledger.execute(call('first'), execute)
    const secondPromise = ledger.execute(call('second'), execute)
    release?.(result(call('first')))

    const [first, second] = await Promise.all([firstPromise, secondPromise])
    expect(first.output).toBe('source')
    expect(second.output).toContain('reused')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('does not reuse commands or writes', async () => {
    const ledger = new ToolExecutionLedger()
    const execute = vi.fn(async () => result(call('command', 'run_command')))

    await ledger.execute(call('first', 'run_command', { command: 'pwd' }), execute)
    await ledger.execute(call('second', 'run_command', { command: 'pwd' }), execute)

    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('allows a transient web failure to be retried', async () => {
    const ledger = new ToolExecutionLedger()
    const execute = vi.fn(async () => ({
      toolCallId: 'web-first',
      name: 'web_search',
      output: 'Error: 502 Bad Gateway',
      isError: true,
      errorKind: 'execution' as const,
    }))

    await ledger.execute(call('web-first', 'web_search', { query: 'docs' }), execute)
    await ledger.execute(call('web-second', 'web_search', { query: 'docs' }), execute)

    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('repeats the original validation error when reusing a failed read', async () => {
    const ledger = new ToolExecutionLedger()
    const execute = vi.fn(async (): Promise<ToolResult> => ({
      toolCallId: 'first',
      name: 'read_file',
      output: 'Error: Unexpected parameter: file_path',
      isError: true,
      errorKind: 'validation',
    }))

    await ledger.execute(call('first', 'read_file', { file_path: 'a.ts' }), execute)
    const repeated = await ledger.execute(call('second', 'read_file', { file_path: 'a.ts' }), execute)

    expect(repeated.output).toContain('Original failure: Error: Unexpected parameter: file_path')
    expect(repeated.output).toContain('Change the arguments before retrying')
    expect(execute).toHaveBeenCalledOnce()
  })

  it('drops cached reads after a workspace mutation', async () => {
    const ledger = new ToolExecutionLedger()
    const execute = vi.fn(async () => result(call('read')))

    await ledger.execute(call('first'), execute)
    ledger.invalidateReadResults()
    await ledger.execute(call('second'), execute)

    expect(execute).toHaveBeenCalledTimes(2)
  })
})
