import { describe, expect, it } from 'vitest'
import { ExclusiveControlLease } from './controlLease'

describe('shared foreground control', () => {
  it('prevents two tasks from controlling the same desktop', () => {
    const lease = new ExclusiveControlLease()
    expect(lease.acquire('first')).toBe(true)
    expect(lease.acquire('first')).toBe(true)
    expect(lease.acquire('second')).toBe(false)
    expect(lease.ownerId).toBe('first')
    expect(lease.release('second')).toBe(false)
    expect(lease.acquire('second')).toBe(false)
    expect(lease.release('first')).toBe(true)
    expect(lease.acquire('second')).toBe(true)
    expect(lease.release('first')).toBe(false)
    expect(lease.ownerId).toBe('second')
  })

  it('releases control when the host tears down its task environments', () => {
    const lease = new ExclusiveControlLease()
    lease.acquire('old-profile-task')
    lease.reset()
    expect(lease.ownerId).toBeNull()
    expect(lease.acquire('new-profile-task')).toBe(true)
  })

  it('rejects missing task identity', () => {
    expect(() => new ExclusiveControlLease().acquire(' ')).toThrow('task ID')
  })
})
