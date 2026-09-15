import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { installDesktopPowerLifecycle } from './desktopPowerLifecycle'

describe('Desktop power lifecycle', () => {
  it('forwards suspend and resume without creating or focusing a window', async () => {
    const source = new EventEmitter()
    const onSuspend = vi.fn()
    const onResume = vi.fn(async () => undefined)
    const dispose = installDesktopPowerLifecycle(source, { onSuspend, onResume })

    source.emit('suspend')
    source.emit('resume')
    await Promise.resolve()

    expect(onSuspend).toHaveBeenCalledTimes(1)
    expect(onResume).toHaveBeenCalledTimes(1)
    dispose()
    source.emit('suspend')
    source.emit('resume')
    expect(onSuspend).toHaveBeenCalledTimes(1)
    expect(onResume).toHaveBeenCalledTimes(1)
  })

  it('reports synchronous and asynchronous lifecycle failures', async () => {
    const source = new EventEmitter()
    const failures: unknown[] = []
    installDesktopPowerLifecycle(source, {
      onSuspend: () => { throw new Error('suspend failed') },
      onResume: async () => { throw new Error('resume failed') },
      onError: error => failures.push(error),
    })

    source.emit('suspend')
    source.emit('resume')
    await Promise.resolve()
    await Promise.resolve()

    expect(failures.map(error => error instanceof Error ? error.message : String(error))).toEqual([
      'suspend failed',
      'resume failed',
    ])
  })
})
