import { describe, expect, it, vi } from 'vitest'
import { AgentEventHub } from './agentEventHub'

type TestEvent = { type: 'stream:start' | 'stream:delta' | 'stream:end' | 'status'; value?: string }

describe('AgentEventHub', () => {
  it('delivers recorder and listeners synchronously in registration order', () => {
    const hub = new AgentEventHub<TestEvent>()
    const delivered: string[] = []
    hub.setRecorder(event => delivered.push(`recorder:${event.type}`))
    hub.subscribe(event => delivered.push(`first:${event.type}`))
    hub.subscribe(event => delivered.push(`second:${event.type}`))

    hub.emit({ type: 'status' })

    expect(delivered).toEqual(['recorder:status', 'first:status', 'second:status'])
  })

  it('unsubscribes listeners without changing recorder delivery', () => {
    const hub = new AgentEventHub<TestEvent>()
    const recorder = vi.fn()
    const listener = vi.fn()
    hub.setRecorder(recorder)
    const unsubscribe = hub.subscribe(listener)
    unsubscribe()

    hub.emit({ type: 'status' })

    expect(recorder).toHaveBeenCalledOnce()
    expect(listener).not.toHaveBeenCalled()
  })

  it('suppresses nested replay scopes until the outer scope releases', () => {
    const hub = new AgentEventHub<TestEvent>()
    const listener = vi.fn()
    hub.subscribe(listener)
    const releaseOuter = hub.suppress()
    const releaseInner = hub.suppress()

    hub.emit({ type: 'status', value: 'nested' })
    releaseInner()
    hub.emit({ type: 'status', value: 'outer' })
    releaseOuter()
    releaseOuter()
    hub.emit({ type: 'status', value: 'live' })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({ type: 'status', value: 'live' })
  })

  it('reports one completed stream trace and resets before the next stream', () => {
    let now = 0
    const reportTrace = vi.fn()
    const hub = new AgentEventHub<TestEvent>({
      traceScope: 'test-agent',
      traceEnabled: () => true,
      now: () => now++,
      reportTrace,
    })
    hub.setRecorder(() => undefined)
    hub.subscribe(() => undefined)

    hub.emit({ type: 'stream:start' })
    hub.emit({ type: 'stream:delta' })
    hub.emit({ type: 'stream:end' })

    expect(reportTrace).toHaveBeenCalledTimes(1)
    expect(reportTrace).toHaveBeenCalledWith('test-agent', expect.objectContaining({
      recorder: expect.objectContaining({
        'stream:start': expect.objectContaining({ count: 1 }),
        'stream:delta': expect.objectContaining({ count: 1 }),
        'stream:end': expect.objectContaining({ count: 1 }),
      }),
      listeners: expect.objectContaining({
        'stream:start': expect.objectContaining({ count: 1 }),
      }),
    }))

    hub.emit({ type: 'status' })
    expect(reportTrace).toHaveBeenCalledTimes(1)
  })
})
