import { describe, expect, it, vi } from 'vitest'
import { RenderScheduler, type FrameClock } from './scheduler'

function harness() {
  let id = 0
  const frames = new Map<number, () => void>()
  const clock: FrameClock = { request: callback => { frames.set(++id, callback); return id }, cancel: handle => { frames.delete(handle) } }
  const errors = vi.fn()
  const scheduler = new RenderScheduler(clock, errors)
  return { scheduler, errors, frames, frame: () => { const jobs = [...frames.values()]; frames.clear(); jobs.forEach(job => job()) } }
}

describe('render scheduler', () => {
  it('coalesces a stream burst and paints surfaces in dependency order', () => {
    const h = harness(); const seen: string[] = []
    for (let i = 0; i < 1000; i++) h.scheduler.schedule('transcript', () => seen.push(`turn:${i}`), 10)
    h.scheduler.schedule('shell', () => seen.push('shell'))
    expect(h.frames.size).toBe(1)
    h.frame()
    expect(seen).toEqual(['shell', 'turn:999'])
    expect(h.frames.size).toBe(0)
  })

  it('defers reentrant work and lets one surface cancel another pending paint', () => {
    const h = harness(); const seen: string[] = []
    h.scheduler.schedule('shell', () => {
      seen.push('shell')
      h.scheduler.cancel('transcript')
      h.scheduler.schedule('shell', () => seen.push('next'))
    })
    h.scheduler.schedule('transcript', () => seen.push('stale'), 10)
    h.frame(); expect(seen).toEqual(['shell']); expect(h.frames.size).toBe(1)
    h.frame(); expect(seen).toEqual(['shell', 'next'])
  })

  it('isolates paint failures and prevents callbacks after unmount', () => {
    const h = harness(); const paint = vi.fn()
    h.scheduler.schedule('broken', () => { throw new Error('broken') })
    h.scheduler.schedule('healthy', paint)
    h.frame(); expect(h.errors).toHaveBeenCalledOnce(); expect(paint).toHaveBeenCalledOnce()
    h.scheduler.schedule('healthy', paint); h.scheduler.dispose(); h.scheduler.schedule('late', paint)
    h.frame(); expect(paint).toHaveBeenCalledOnce(); expect(h.frames.size).toBe(0)
  })
})
