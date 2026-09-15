import { describe, expect, it } from 'vitest'
import { SerializedAsyncQueue, SingleFlightGuard } from './interactionConcurrency'

describe('renderer interaction concurrency', () => {
  it('rejects reentrant work until the active operation releases', () => {
    const guard = new SingleFlightGuard()
    const release = guard.tryAcquire()

    expect(release).toBeTypeOf('function')
    expect(guard.active).toBe(true)
    expect(guard.tryAcquire()).toBeNull()

    release?.()
    expect(guard.active).toBe(false)
    expect(guard.tryAcquire()).toBeTypeOf('function')
  })

  it('serializes writes even when the first write is slow', async () => {
    const queue = new SerializedAsyncQueue()
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const first = queue.enqueue(async () => {
      events.push('first:start')
      await firstGate
      events.push('first:end')
    })
    const second = queue.enqueue(async () => {
      events.push('second')
    })

    await Promise.resolve()
    expect(events).toEqual(['first:start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'first:end', 'second'])
  })

  it('continues the queue after a failed write', async () => {
    const queue = new SerializedAsyncQueue()
    const failed = queue.enqueue(async () => { throw new Error('save failed') })
    const recovered = queue.enqueue(async () => 'saved')

    await expect(failed).rejects.toThrow('save failed')
    await expect(recovered).resolves.toBe('saved')
  })
})
