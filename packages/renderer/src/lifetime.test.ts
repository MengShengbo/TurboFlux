import { describe, expect, it, vi } from 'vitest'
import { RenderLifetime } from './lifetime'

describe('render lifetime', () => {
  it('releases subscriptions once and ignores late async results', () => {
    const lifetime = new RenderLifetime(); const event = vi.fn(); const result = vi.fn(); const cleanup = vi.fn()
    const target = new EventTarget()
    lifetime.listen(target, 'update', event); lifetime.add(cleanup)
    const apply = lifetime.guard(result)
    target.dispatchEvent(new Event('update')); apply('current')
    lifetime.dispose(); lifetime.dispose()
    target.dispatchEvent(new Event('update')); apply('stale')
    expect(event).toHaveBeenCalledOnce(); expect(result).toHaveBeenCalledOnce(); expect(cleanup).toHaveBeenCalledOnce()
  })
  it('cleans remaining resources when one cleanup fails', () => {
    const lifetime = new RenderLifetime(); const cleanup = vi.fn()
    lifetime.add(cleanup); lifetime.add(() => { throw new Error('cleanup') })
    expect(() => lifetime.dispose()).toThrow(AggregateError); expect(cleanup).toHaveBeenCalledOnce()
  })
})
