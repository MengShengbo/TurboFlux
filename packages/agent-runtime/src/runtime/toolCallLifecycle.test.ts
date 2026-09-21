import { describe, expect, it, vi } from 'vitest'
import type { AgentTool, ToolCall, ToolResult } from '@turboflux/contracts/agentTypes'
import { AgentRunControl, createAgentRunInterruption } from './runControl'
import { ToolCallLifecycle, type ToolCallLifecycleOptions } from './toolCallLifecycle'

const readTool: AgentTool = {
  name: 'read_file', description: 'read', category: 'read', parameters: [],
  isReadOnly: true, isDestructive: false, isConcurrencySafe: true,
}

function call(id: string, name = 'read_file'): ToolCall {
  return { id, name, arguments: { path: 'file.txt' } }
}

function result(toolCall: ToolCall, output = 'ok'): ToolResult {
  return { toolCallId: toolCall.id, name: toolCall.name, output, isError: false }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness(overrides: Partial<ToolCallLifecycleOptions> = {}) {
  const runControl = new AgentRunControl()
  runControl.start()
  const options = {
    runControl,
    resolveTool: vi.fn(() => readTool),
    validate: vi.fn(() => undefined),
    authorize: vi.fn(async () => null),
    execute: vi.fn(async (toolCall: ToolCall) => result(toolCall)),
    ...overrides,
  }
  return { lifecycle: new ToolCallLifecycle(options), options, runControl }
}

describe('ToolCallLifecycle', () => {
  it('returns unknown-tool and validation errors without asking permission or dispatching', async () => {
    const { lifecycle, options } = harness({ resolveTool: () => undefined })
    await expect(lifecycle.execute(call('unknown'))).resolves.toMatchObject({ errorKind: 'validation' })
    expect(options.authorize).not.toHaveBeenCalled()
    expect(options.execute).not.toHaveBeenCalled()

    const invalid = harness({ validate: toolCall => ({ ...result(toolCall), isError: true, errorKind: 'validation' }) })
    await expect(invalid.lifecycle.execute(call('invalid'))).resolves.toMatchObject({ errorKind: 'validation' })
    expect(invalid.options.authorize).not.toHaveBeenCalled()
    expect(invalid.options.execute).not.toHaveBeenCalled()
  })

  it.each(['validate', 'authorize', 'execute'] as const)('normalizes exceptions from %s into a terminal result', async phase => {
    const { lifecycle } = harness({ [phase]: () => { throw new Error('stage failed') } })
    await expect(lifecycle.execute(call('failed'))).resolves.toMatchObject({
      toolCallId: 'failed', name: 'read_file', isError: true,
      errorKind: 'execution', output: 'Tool execution error: stage failed',
    })
  })

  it('honors a supplied signal through dispatch and suppresses late success after cancellation', async () => {
    const controller = new AbortController()
    const dispatched = deferred<void>()
    const finished = deferred<ToolResult>()
    const execute = vi.fn((_call: ToolCall, _tool: AgentTool, _signal?: AbortSignal) => {
      dispatched.resolve()
      return finished.promise
    })
    const { lifecycle } = harness({ execute })
    const pending = lifecycle.execute(call('external'), controller.signal)
    await dispatched.promise
    expect(execute.mock.calls[0][2]).toBe(controller.signal)

    controller.abort(createAgentRunInterruption('pause'))
    finished.resolve(result(call('external')))

    await expect(pending).resolves.toMatchObject({
      errorKind: 'abort', interruption: { kind: 'pause', resumable: true },
    })
  })

  it('does not admit a call after cancellation', async () => {
    const { lifecycle, runControl, options } = harness()
    runControl.stop()
    await expect(lifecycle.execute(call('stopped'))).resolves.toMatchObject({ errorKind: 'abort' })
    expect(options.resolveTool).not.toHaveBeenCalled()
    expect(options.authorize).not.toHaveBeenCalled()
    expect(options.execute).not.toHaveBeenCalled()
  })

  it('reports cancellation during approval instead of a synthetic permission denial', async () => {
    const approved = deferred<ToolResult | null>()
    const { lifecycle, runControl, options } = harness({ authorize: () => approved.promise })
    const pending = lifecycle.execute(call('approval'))
    runControl.stop()
    approved.resolve({ ...result(call('approval')), isError: true, errorKind: 'permission' })

    await expect(pending).resolves.toMatchObject({ errorKind: 'abort', interruption: { kind: 'stop' } })
    expect(options.execute).not.toHaveBeenCalled()
  })

  it('keeps an approved call gated across a non-interrupting pause', async () => {
    const ready = deferred<void>()
    const { lifecycle, runControl, options } = harness({
      authorize: async () => {
        runControl.pause({ interruptOperation: false })
        ready.resolve()
        return null
      },
    })
    const signal = runControl.getOperationSignal()
    const pending = lifecycle.execute(call('paused'))
    await ready.promise
    expect(options.execute).not.toHaveBeenCalled()
    runControl.resume()
    await expect(pending).resolves.toMatchObject({ isError: false })
    expect(options.execute).toHaveBeenCalledWith(call('paused'), readTool, signal)
  })

  it('does not move an interrupted call onto a resumed operation signal', async () => {
    const approved = deferred<ToolResult | null>()
    const { lifecycle, runControl, options } = harness({ authorize: () => approved.promise })
    const pending = lifecycle.execute(call('old-generation'))
    runControl.pause()
    runControl.resume()
    approved.resolve(null)

    await expect(pending).resolves.toMatchObject({ errorKind: 'abort', interruption: { kind: 'pause' } })
    expect(options.execute).not.toHaveBeenCalled()
  })

  it('preserves a stop that supersedes a pause while dispatch is settling', async () => {
    const dispatched = deferred<void>()
    const finished = deferred<ToolResult>()
    const { lifecycle, runControl } = harness({ execute: () => { dispatched.resolve(); return finished.promise } })
    const pending = lifecycle.execute(call('stopping'))
    await dispatched.promise
    runControl.pause()
    runControl.stop()
    finished.resolve(result(call('stopping')))

    await expect(pending).resolves.toMatchObject({ errorKind: 'abort', interruption: { kind: 'stop', resumable: false } })
  })

  it('checks each caller before sharing an already running read', async () => {
    const dispatched = deferred<void>()
    const finished = deferred<ToolResult>()
    const { lifecycle, options } = harness({
      authorize: async toolCall => toolCall.id === 'denied'
        ? { ...result(toolCall), isError: true, errorKind: 'permission' }
        : null,
      execute: vi.fn(() => { dispatched.resolve(); return finished.promise }),
    })
    const first = lifecycle.execute(call('allowed'))
    await dispatched.promise
    await expect(lifecycle.execute(call('denied'))).resolves.toMatchObject({ errorKind: 'permission' })
    const joined = lifecycle.execute(call('also-allowed'))
    finished.resolve(result(call('allowed')))

    await expect(first).resolves.toMatchObject({ toolCallId: 'allowed', isError: false })
    await expect(joined).resolves.toMatchObject({ toolCallId: 'also-allowed', isError: false })
    expect(options.validate).toHaveBeenCalledTimes(3)
    expect(options.execute).toHaveBeenCalledOnce()
  })

  it('invalidates reads both before and after a partially failed write', async () => {
    const releases = new Map<string, ReturnType<typeof deferred<ToolResult>>>()
    const starts = new Map<string, ReturnType<typeof deferred<void>>>()
    for (const id of ['before', 'write', 'during', 'after']) starts.set(id, deferred<void>())
    const execute = vi.fn((toolCall: ToolCall) => {
      const pending = deferred<ToolResult>()
      releases.set(toolCall.id, pending)
      starts.get(toolCall.id)?.resolve()
      return pending.promise
    })
    const { lifecycle } = harness({
      resolveTool: name => ({ ...readTool, name, isReadOnly: name === 'read_file' }),
      execute,
    })
    const before = lifecycle.execute(call('before'))
    await starts.get('before')!.promise
    const write = lifecycle.execute(call('write', 'write_file'))
    await starts.get('write')!.promise
    const during = lifecycle.execute(call('during'))
    await starts.get('during')!.promise
    releases.get('write')!.reject(new Error('write partially failed'))
    await expect(write).resolves.toMatchObject({ errorKind: 'execution' })
    const after = lifecycle.execute(call('after'))
    await starts.get('after')!.promise
    for (const id of ['before', 'during', 'after']) releases.get(id)!.resolve(result(call(id), id))

    expect((await Promise.all([before, during, after])).map(value => value.output)).toEqual(['before', 'during', 'after'])
    expect(execute).toHaveBeenCalledTimes(4)
  })

  it('keeps a previous run write from invalidating a newer run read', async () => {
    const writeStarted = deferred<void>()
    const readStarted = deferred<void>()
    const writeResult = deferred<ToolResult>()
    const readResult = deferred<ToolResult>()
    const execute = vi.fn((toolCall: ToolCall) => {
      if (toolCall.name === 'write_file') {
        writeStarted.resolve()
        return writeResult.promise
      }
      readStarted.resolve()
      return readResult.promise
    })
    const { lifecycle } = harness({
      resolveTool: name => ({ ...readTool, name, isReadOnly: name === 'read_file' }),
      execute,
    })
    const oldWrite = lifecycle.execute(call('old-write', 'write_file'))
    await writeStarted.promise
    lifecycle.beginRun()
    const newRead = lifecycle.execute(call('new-read'))
    await readStarted.promise
    writeResult.resolve(result(call('old-write', 'write_file')))
    await oldWrite
    const joinedRead = lifecycle.execute(call('joined-read'))
    readResult.resolve(result(call('new-read')))

    await Promise.all([newRead, joinedRead])
    expect(execute).toHaveBeenCalledTimes(2)
  })
})
