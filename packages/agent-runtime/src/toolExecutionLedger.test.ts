import { describe, expect, it, vi } from 'vitest'
import type { ToolCall, ToolResult } from '@turboflux/contracts/agentTypes'
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

  it('executes sequential reads again so changed state is visible', async () => {
    const ledger = new ToolExecutionLedger()
    const execute = vi.fn()
      .mockResolvedValueOnce(result(call('first'), 'large source output'))
      .mockResolvedValueOnce(result(call('second'), 'changed source output'))

    const first = await ledger.execute(call('first'), execute)
    const second = await ledger.execute(call('second'), execute)

    expect(first.output).toBe('large source output')
    expect(second).toMatchObject({ toolCallId: 'second', isError: false })
    expect(second.output).toBe('changed source output')
    expect(execute).toHaveBeenCalledTimes(2)
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
    expect(second).toMatchObject({ toolCallId: 'second', output: 'source', isError: false })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('does not reuse commands or writes', async () => {
    const ledger = new ToolExecutionLedger()
    const execute = vi.fn(async () => result(call('command', 'run_command')))

    await ledger.execute(call('first', 'run_command', { command: 'pwd' }), execute)
    await ledger.execute(call('second', 'run_command', { command: 'pwd' }), execute)

    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('only shares reads within the same cancellation scope', async () => {
    const ledger = new ToolExecutionLedger()
    const firstScope = new AbortController()
    const secondScope = new AbortController()
    let release!: (value: ToolResult) => void
    const execute = vi.fn(() => new Promise<ToolResult>(resolve => { release = resolve }))
    const first = ledger.execute(call('first'), execute, firstScope.signal)
    const finishFirst = release
    const second = ledger.execute(call('second'), execute, secondScope.signal)
    const finishSecond = release
    const joined = ledger.execute(call('joined'), execute, firstScope.signal)

    finishFirst(result(call('first'), 'first scope'))
    finishSecond(result(call('second'), 'second scope'))

    expect(await first).toMatchObject({ output: 'first scope' })
    expect(await second).toMatchObject({ output: 'second scope' })
    expect(await joined).toMatchObject({ toolCallId: 'joined', output: 'first scope' })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('isolates nested result details from every consumer, including the first', async () => {
    const ledger = new ToolExecutionLedger()
    const shared: ToolResult = {
      ...result(call('physical')),
      data: { kind: 'items', items: [{ title: 'original' }] },
    }
    const execute = vi.fn(async () => shared)
    const first = ledger.execute(call('first'), execute).then(value => {
      if (value.data?.kind === 'items') value.data.items[0].title = 'mutated'
      return value
    })
    const second = ledger.execute(call('second'), execute)

    await first
    expect((await second).data).toEqual({ kind: 'items', items: [{ title: 'original' }] })
    expect(shared.data).toEqual({ kind: 'items', items: [{ title: 'original' }] })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('does not dispatch or join a read whose scope is already aborted', async () => {
    const ledger = new ToolExecutionLedger()
    const controller = new AbortController()
    const reason = new Error('cancelled')
    controller.abort(reason)
    const execute = vi.fn(async () => result(call('read')))

    await expect(ledger.execute(call('read'), execute, controller.signal)).rejects.toBe(reason)
    expect(execute).not.toHaveBeenCalled()
  })

  it('removes a rejected read so a retry can dispatch again', async () => {
    const ledger = new ToolExecutionLedger()
    const execute = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(result(call('retry')))
    await expect(ledger.execute(call('first'), execute)).rejects.toThrow('offline')
    await expect(ledger.execute(call('retry'), execute)).resolves.toMatchObject({ isError: false })
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

  it.each(['abort', 'timeout', 'permission', 'execution', 'validation', undefined] as const)('retries a failed read after %s', async errorKind => {
    const ledger = new ToolExecutionLedger()
    const execute = vi.fn(async (): Promise<ToolResult> => ({
      toolCallId: 'first',
      name: 'read_file',
      output: 'Error: Unexpected parameter: file_path',
      isError: true,
      errorKind,
    }))

    await ledger.execute(call('first', 'read_file', { file_path: 'a.ts' }), execute)
    execute.mockResolvedValueOnce(result(call('second'), 'retry succeeded'))
    const repeated = await ledger.execute(call('second', 'read_file', { file_path: 'a.ts' }), execute)
    expect(repeated).toMatchObject({ output: 'retry succeeded', isError: false })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('permits another read after a workspace mutation', async () => {
    const ledger = new ToolExecutionLedger()
    const execute = vi.fn(async () => result(call('read')))

    await ledger.execute(call('first'), execute)
    ledger.invalidateReadResults()
    await ledger.execute(call('second'), execute)

    expect(execute).toHaveBeenCalledTimes(2)
  })

  it.each(['beginRun', 'invalidateReadResults'] as const)('does not join or delete newer reads after %s', async invalidate => {
    const ledger = new ToolExecutionLedger()
    let finishOld!: (result: ToolResult) => void
    let finishNew!: (result: ToolResult) => void
    const execute = vi.fn()
      .mockImplementationOnce(() => new Promise<ToolResult>(resolve => { finishOld = resolve }))
      .mockImplementationOnce(() => new Promise<ToolResult>(resolve => { finishNew = resolve }))
    const oldRead = ledger.execute(call('old'), execute)
    ledger[invalidate]()
    const newRead = ledger.execute(call('new'), execute)
    finishOld(result(call('old'), 'old state'))
    await oldRead
    const joinedRead = ledger.execute(call('joined'), execute)
    finishNew(result(call('new'), 'new state'))
    expect((await newRead).output).toBe('new state')
    expect(await joinedRead).toMatchObject({ toolCallId: 'joined', output: 'new state' })
    expect(execute).toHaveBeenCalledTimes(2)
  })
})
