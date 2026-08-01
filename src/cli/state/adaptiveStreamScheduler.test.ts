import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdaptiveStreamScheduler } from './adaptiveStreamScheduler'

describe('AdaptiveStreamScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces a light burst into one smooth frame', () => {
    const flush = vi.fn()
    const scheduler = new AdaptiveStreamScheduler(flush)
    scheduler.enqueue(4)
    scheduler.enqueue(6)

    vi.advanceTimersByTime(63)
    expect(flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(flush).toHaveBeenCalledWith(expect.objectContaining({ depth: 2, bytes: 10, mode: 'smooth' }))
  })

  it('switches to catch-up and advances an existing deadline under pressure', () => {
    const flush = vi.fn()
    const scheduler = new AdaptiveStreamScheduler(flush)
    for (let index = 0; index < 8; index += 1) scheduler.enqueue(1)

    vi.advanceTimersByTime(47)
    expect(flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(flush).toHaveBeenCalledWith(expect.objectContaining({ depth: 8, mode: 'catch-up' }))
  })

  it('gives a pending stream an earlier input-priority frame', () => {
    const flush = vi.fn()
    const scheduler = new AdaptiveStreamScheduler(flush)
    scheduler.enqueue(1)
    vi.advanceTimersByTime(10)
    scheduler.noteInput()

    vi.advanceTimersByTime(31)
    expect(flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(flush).toHaveBeenCalledWith(expect.objectContaining({ inputPriority: true }))
  })

  it('holds catch-up re-entry briefly after draining', () => {
    const flush = vi.fn()
    const scheduler = new AdaptiveStreamScheduler(flush)
    for (let index = 0; index < 8; index += 1) scheduler.enqueue(1)
    scheduler.flushNow()

    for (let index = 0; index < 8; index += 1) scheduler.enqueue(1)
    expect(scheduler.flushNow()).toBe(true)
    expect(flush.mock.calls[1]?.[0]).toMatchObject({ mode: 'smooth' })

    vi.advanceTimersByTime(251)
    for (let index = 0; index < 8; index += 1) scheduler.enqueue(1)
    expect(scheduler.flushNow()).toBe(true)
    expect(flush.mock.calls[2]?.[0]).toMatchObject({ mode: 'catch-up' })
  })

  it('reports and clears backlog deterministically', () => {
    const scheduler = new AdaptiveStreamScheduler(() => {})
    scheduler.enqueue(12)
    vi.advanceTimersByTime(20)
    expect(scheduler.getBacklogSnapshot()).toEqual({ depth: 1, oldestAgeMs: 20 })
    scheduler.cancel()
    expect(scheduler.getBacklogSnapshot()).toEqual({ depth: 0, oldestAgeMs: 0 })
  })
})
