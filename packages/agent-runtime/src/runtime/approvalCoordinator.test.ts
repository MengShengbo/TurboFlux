import { describe, expect, it, vi } from 'vitest'
import { ApprovalCoordinator } from './approvalCoordinator'

describe('ApprovalCoordinator', () => {
  it('presents FIFO requests and settles each Deferred exactly once', async () => {
    const presented: Array<{ id: string; queued: number }> = []
    const coordinator = new ApprovalCoordinator<{ id: string }, string>((request, queued) => {
      presented.push({ id: request.id, queued })
    })
    const first = coordinator.request({ id: 'first' }, { cancelDecision: 'deny' })
    const second = coordinator.request({ id: 'second' }, { cancelDecision: 'deny' })

    expect(presented).toEqual([{ id: 'first', queued: 0 }])
    expect(coordinator.resolve('second', 'allow')).toBe(false)
    expect(coordinator.resolve('first', 'allow')).toBe(true)
    expect(coordinator.resolve('first', 'deny')).toBe(false)
    await expect(first).resolves.toBe('allow')
    expect(presented).toEqual([
      { id: 'first', queued: 0 },
      { id: 'second', queued: 0 },
    ])

    expect(coordinator.resolve('second', 'deny')).toBe(true)
    await expect(second).resolves.toBe('deny')
    expect(coordinator.getSnapshot()).toEqual({ active: null, queued: [], pendingCount: 0 })
  })

  it('cancels active and queued requests on abort', async () => {
    const present = vi.fn()
    const coordinator = new ApprovalCoordinator<{ id: string }, string>(present)
    const controller = new AbortController()
    const first = coordinator.request({ id: 'first' }, { cancelDecision: 'deny', signal: controller.signal })
    const second = coordinator.request({ id: 'second' }, { cancelDecision: 'deny', signal: controller.signal })

    controller.abort()

    await expect(first).resolves.toBe('deny')
    await expect(second).resolves.toBe('deny')
    expect(coordinator.getSnapshot().pendingCount).toBe(0)
    expect(present).toHaveBeenCalledTimes(1)
  })

  it('supports a synchronous decision from the presentation callback', async () => {
    let coordinator!: ApprovalCoordinator<{ id: string }, string>
    coordinator = new ApprovalCoordinator(request => {
      coordinator.resolve(request.id, 'allow-session')
    })

    await expect(coordinator.request({ id: 'sync' }, { cancelDecision: 'deny' })).resolves.toBe('allow-session')
  })

  it('publishes requested and terminal lifecycle records in settlement order', async () => {
    const lifecycle: Array<{ id: string; state: string; decision?: string }> = []
    const coordinator = new ApprovalCoordinator<{ id: string }, string>(
      () => {},
      event => lifecycle.push({ id: event.request.id, state: event.state, decision: event.decision }),
    )
    const pending = coordinator.request({ id: 'request-1' }, { cancelDecision: 'deny' })

    coordinator.resolve('request-1', 'allow')

    await expect(pending).resolves.toBe('allow')
    expect(lifecycle).toEqual([
      { id: 'request-1', state: 'requested', decision: undefined },
      { id: 'request-1', state: 'resolved', decision: 'allow' },
    ])
  })

  it('keeps a request pending when terminal durability fails', async () => {
    let shouldFail = true
    const coordinator = new ApprovalCoordinator<{ id: string }, string>(
      () => {},
      event => {
        if (event.state === 'resolved' && shouldFail) throw new Error('journal unavailable')
      },
    )
    const pending = coordinator.request({ id: 'request-1' }, { cancelDecision: 'deny' })

    expect(() => coordinator.resolve('request-1', 'allow')).toThrow('journal unavailable')
    expect(coordinator.getSnapshot().pendingCount).toBe(1)
    shouldFail = false
    expect(coordinator.resolve('request-1', 'allow')).toBe(true)
    await expect(pending).resolves.toBe('allow')
  })
})
