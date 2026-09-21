import { describe, expect, it, vi } from 'vitest'
import { createSessionId, SessionRegistry } from './sessionRegistry'

describe('SessionRegistry', () => {
  it('uses UUIDs for newly created conversation identities', () => {
    expect(createSessionId('conversation')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(new SessionRegistry().createAndActivate()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  })

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
