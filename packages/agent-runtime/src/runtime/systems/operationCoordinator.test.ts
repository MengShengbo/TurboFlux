import { describe, expect, it, vi } from 'vitest'
import { abortableDelay, SerializedOperationCoordinator } from './operationCoordinator'

describe('SerializedOperationCoordinator', () => {
  it('releases abort listeners after a completed delay', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    await abortableDelay(1, controller.signal, 'stopped')
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort()
  })

  it('runs operations serially', async () => {
    const coordinator = new SerializedOperationCoordinator('stopped')
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const first = coordinator.enqueue(async () => {
      events.push('first-start')
      await firstGate
      events.push('first-end')
    })
    const second = coordinator.enqueue(async () => {
      events.push('second')
    })

    await Promise.resolve()
    expect(events).toEqual(['first-start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['first-start', 'first-end', 'second'])
  })

  it('aborts active and rejects queued stale operations', async () => {
    const coordinator = new SerializedOperationCoordinator('stopped')
    let observedAbort = false
    const active = coordinator.enqueue(signal => new Promise<void>(resolve => {
      signal.addEventListener('abort', () => {
        observedAbort = true
        resolve()
      }, { once: true })
    }))
    const queued = coordinator.enqueue(async () => {})

    await Promise.resolve()
    coordinator.invalidate()
    await expect(active).rejects.toMatchObject({ name: 'AbortError', message: 'stopped' })
    await expect(queued).rejects.toMatchObject({ name: 'AbortError', message: 'stopped' })
    expect(observedAbort).toBe(true)
  })

  it('forwards external cancellation and runs abort cleanup', async () => {
    const coordinator = new SerializedOperationCoordinator('stopped')
    const external = new AbortController()
    let cleanupCount = 0
    const operation = coordinator.enqueue(signal => new Promise<void>(resolve => {
      signal.addEventListener('abort', () => resolve(), { once: true })
    }), {
      externalSignal: external.signal,
      onAbort: () => { cleanupCount += 1 },
    })

    await Promise.resolve()
    external.abort()
    await expect(operation).rejects.toMatchObject({ name: 'AbortError', message: 'stopped' })
    expect(cleanupCount).toBe(1)
  })
})
