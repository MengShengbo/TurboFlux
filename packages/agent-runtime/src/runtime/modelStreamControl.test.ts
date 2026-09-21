import { describe, expect, it, vi } from 'vitest'
import { ModelStreamControl } from './modelStreamControl'

describe('ModelStreamControl', () => {
  it('registers one stream, aborts it by the same id, and clears it after completion', async () => {
    const control = new ModelStreamControl(() => 42)
    let release: (() => void) | undefined
    const operation = control.run(undefined, async streamId => {
      expect(streamId).toBe(42)
      await new Promise<void>(resolve => {
        release = resolve
      })
      return 'done'
    })
    await Promise.resolve()
    const abort = vi.fn()

    expect(control.getSnapshot()).toEqual({ active: true, streamId: 42, aborted: false })
    expect(control.abortActive(abort)).toBe(true)
    expect(abort).toHaveBeenCalledWith(42)

    release?.()
    await expect(operation).resolves.toBe('done')
    expect(control.getSnapshot()).toEqual({ active: false, streamId: undefined, aborted: false })
  })

  it('clears a failed stream and rejects overlapping streams', async () => {
    const control = new ModelStreamControl(() => 7)
    let rejectOperation: ((error: Error) => void) | undefined
    const operation = control.run(undefined, () => new Promise((_resolve, reject) => {
      rejectOperation = reject
    }))
    await Promise.resolve()

    await expect(control.run(undefined, async () => 'overlap')).rejects.toThrow('already active')
    rejectOperation?.(new Error('transport failed'))
    await expect(operation).rejects.toThrow('transport failed')
    expect(control.getSnapshot().active).toBe(false)
  })

  it('reports the abort state of the active operation signal', async () => {
    const signalController = new AbortController()
    const control = new ModelStreamControl(() => 9)
    let release: (() => void) | undefined
    const operation = control.run(signalController.signal, () => new Promise<void>(resolve => {
      release = resolve
    }))
    await Promise.resolve()

    signalController.abort()
    expect(control.getSnapshot()).toMatchObject({ active: true, streamId: 9, aborted: true })

    release?.()
    await operation
  })
})
