import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApprovalPresentationScheduler } from './approvalPresentationScheduler'

describe('ApprovalPresentationScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('presents immediately when the composer has been idle', () => {
    const present = vi.fn()
    const scheduler = new ApprovalPresentationScheduler()

    scheduler.request('approval-1', present)

    expect(present).toHaveBeenCalledOnce()
    expect(scheduler.getSnapshot()).toMatchObject({ requestId: 'approval-1', presented: true })
  })

  it('waits until one second after the latest composer activity', () => {
    const present = vi.fn()
    const scheduler = new ApprovalPresentationScheduler()
    scheduler.noteComposerActivity()
    scheduler.request('approval-1', present)

    vi.advanceTimersByTime(900)
    scheduler.noteComposerActivity()
    vi.advanceTimersByTime(999)
    expect(present).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(present).toHaveBeenCalledOnce()
  })

  it('cancels delayed requests without a ghost presentation', () => {
    const present = vi.fn()
    const scheduler = new ApprovalPresentationScheduler()
    scheduler.noteComposerActivity()
    scheduler.request('approval-1', present)

    expect(scheduler.cancel('approval-1')).toBe(true)
    vi.advanceTimersByTime(2_000)

    expect(present).not.toHaveBeenCalled()
    expect(scheduler.getSnapshot().requestId).toBeNull()
  })

  it('does not let an old timer present a replacement request', () => {
    const first = vi.fn()
    const second = vi.fn()
    const scheduler = new ApprovalPresentationScheduler()
    scheduler.noteComposerActivity()
    scheduler.request('approval-1', first)

    vi.advanceTimersByTime(500)
    scheduler.request('approval-2', second)
    vi.advanceTimersByTime(500)

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
    expect(scheduler.cancel('approval-1')).toBe(false)
  })
})
