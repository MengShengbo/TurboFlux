import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createTerminalSizeStore, type TerminalSizeSource } from './useTerminalSize'

class FakeTerminalSizeSource extends EventEmitter implements TerminalSizeSource {
  columns = 80
  rows = 24
}

describe('terminal size store', () => {
  it('shares one resize listener across every subscriber', () => {
    const source = new FakeTerminalSizeSource()
    const store = createTerminalSizeStore(source)
    const first = vi.fn()
    const second = vi.fn()

    const unsubscribeFirst = store.subscribe(first)
    const unsubscribeSecond = store.subscribe(second)

    expect(source.listenerCount('resize')).toBe(1)
    source.columns = 120
    source.rows = 40
    source.emit('resize')
    expect(store.getSnapshot()).toEqual({ columns: 120, rows: 40 })
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()

    unsubscribeFirst()
    expect(source.listenerCount('resize')).toBe(1)
    unsubscribeSecond()
    expect(source.listenerCount('resize')).toBe(0)
  })

  it('does not publish unchanged dimensions', () => {
    const source = new FakeTerminalSizeSource()
    const store = createTerminalSizeStore(source)
    const subscriber = vi.fn()
    const unsubscribe = store.subscribe(subscriber)

    source.emit('resize')

    expect(subscriber).not.toHaveBeenCalled()
    unsubscribe()
  })
})
