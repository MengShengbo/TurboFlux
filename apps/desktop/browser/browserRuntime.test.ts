import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserOperationError, BrowserRuntime, browserFailure } from './browserRuntime'
import { SerializedOperationCoordinator } from '../systems/operationCoordinator'

afterEach(() => vi.useRealTimers())

describe('browser runtime boundaries', () => {
  it('bounds a renderer command that never responds', async () => {
    vi.useFakeTimers()
    const runtime = new BrowserRuntime()
    const pending = runtime.call(() => new Promise(() => {}), 200)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'command-timeout' })
    await vi.advanceTimersByTimeAsync(200)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts a hung command, drains the queue and prevents late follow-up mutations', async () => {
    const runtime = new BrowserRuntime()
    const queue = new SerializedOperationCoordinator('Browser operation aborted')
    const controller = new AbortController()
    let settle!: () => void
    const started = new Promise<void>(resolve => { settle = resolve })
    let release!: () => void
    const continuation = vi.fn()
    const first = queue.enqueue(signal => runtime.run(signal, async () => {
      await runtime.call(() => { settle(); return new Promise<void>(resolve => { release = resolve }) })
      await runtime.call(async () => continuation())
    }), { externalSignal: controller.signal })
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await started
    controller.abort()
    await rejected
    await expect(queue.enqueue(signal => runtime.run(signal, async () => 'next'))).resolves.toBe('next')
    release()
    await queue.drain()
    expect(continuation).not.toHaveBeenCalled()
  })

  it('does not invoke work for a pre-aborted run and releases timers', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    controller.abort()
    const work = vi.fn()
    await expect(new BrowserRuntime().run(controller.signal, work)).rejects.toMatchObject({ name: 'AbortError' })
    expect(work).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes abort listeners after successful delays', async () => {
    vi.useFakeTimers()
    const runtime = new BrowserRuntime()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const task = runtime.run(controller.signal, () => runtime.delay(10))
    await vi.advanceTimersByTimeAsync(10)
    await task
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('distinguishes failure recovery without promising action retries are safe', () => {
    expect(browserFailure(new Error('Element ref is stale; observe the page again'), 'click')).toMatchObject({ code: 'stale-reference', retrySafe: false })
    expect(browserFailure(new BrowserOperationError('not-actionable', 'Covered', 'Inspect overlay'), 'click', 'tab-1')).toMatchObject({ code: 'not-actionable', recovery: 'Inspect overlay', tabId: 'tab-1' })
  })
})
