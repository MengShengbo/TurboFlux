import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './sessionRegistry'

describe('SessionRegistry', () => {
  it('publishes one identity change after all guards pass', () => {
    const registry = new SessionRegistry('session-1')
    const listener = vi.fn()
    registry.addGuard((nextId, currentId) => {
      expect({ nextId, currentId }).toEqual({ nextId: 'session-2', currentId: 'session-1' })
    })
    registry.subscribe(listener)

    registry.activate('session-2')

    expect(registry.getCurrentId()).toBe('session-2')
    expect(listener).toHaveBeenCalledWith({ previousId: 'session-1', currentId: 'session-2' })
  })

  it('keeps the current identity when a guard rejects switching', () => {
    const registry = new SessionRegistry('session-1')
    const listener = vi.fn()
    registry.addGuard(() => { throw new Error('busy') })
    registry.subscribe(listener)

    expect(() => registry.activate('session-2')).toThrow('busy')
    expect(registry.getCurrentId()).toBe('session-1')
    expect(listener).not.toHaveBeenCalled()
  })
})
