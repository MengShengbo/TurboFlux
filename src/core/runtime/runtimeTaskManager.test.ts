import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTaskEvent } from '../../shared/runtimeTaskTypes'
import { RuntimeTaskManager } from './runtimeTaskManager'

describe('RuntimeTaskManager', () => {
  it('creates serializable task snapshots with an owner and lifecycle events', () => {
    let now = 100
    const manager = new RuntimeTaskManager({ defaultOwnerSessionId: 'session-1', now: () => now })
    const events: RuntimeTaskEvent[] = []
    manager.subscribe(event => events.push(event))

    const created = manager.createTask({
      kind: 'shell',
      command: 'npm test',
      cwd: '/workspace',
      pid: 42,
    })
    created.metadata = { changed: true }
    now = 200
    const running = manager.markRunning(created.id)
    now = 300
    const completed = manager.completeTask(created.id, { exitCode: 0, outputBytes: 12 })

    expect(running?.status).toBe('running')
    expect(completed).toMatchObject({
      ownerSessionId: 'session-1',
      status: 'completed',
      exitCode: 0,
      outputBytes: 12,
      endedAt: 300,
    })
    expect(manager.getTask(created.id)?.metadata).toBeUndefined()
    expect(events.map(event => event.type)).toEqual([
      'runtime-task:created',
      'runtime-task:updated',
      'runtime-task:updated',
      'runtime-task:finished',
    ])
  })

  it('routes input and stop requests through private controls', async () => {
    let now = 100
    const stop = vi.fn(async () => {})
    const write = vi.fn(async () => {})
    const manager = new RuntimeTaskManager({ now: () => now })
    const task = manager.createTask({ kind: 'terminal', status: 'running' }, { stop, write })

    now = 200
    await manager.writeTask(task.id, 'npm test\n')
    now = 300
    const stopped = await manager.stopTask(task.id)

    expect(write).toHaveBeenCalledWith('npm test\n')
    expect(stop).toHaveBeenCalledOnce()
    expect(stopped).toMatchObject({ status: 'stopped', endedAt: 300 })
    await expect(manager.writeTask(task.id, 'again')).rejects.toThrow('is stopped')
  })

  it('interrupts active tasks without controls when the runtime stops', async () => {
    const manager = new RuntimeTaskManager({ now: () => 100 })
    const controlled = manager.createTask({ kind: 'shell', status: 'running' }, { stop: () => {} })
    const detached = manager.createTask({ kind: 'agent', status: 'running' })

    const errors = await manager.stopAll('Runtime destroyed')

    expect(errors).toEqual([])
    expect(manager.getTask(controlled.id)?.status).toBe('stopped')
    expect(manager.getTask(detached.id)).toMatchObject({ status: 'interrupted', error: 'Runtime destroyed' })
  })

  it('marks a task as failed when its stop control fails', async () => {
    const manager = new RuntimeTaskManager({ now: () => 100 })
    const task = manager.createTask({ kind: 'shell', status: 'running' }, {
      stop: () => { throw new Error('kill failed') },
    })

    const stopped = await manager.stopTask(task.id)

    expect(stopped).toMatchObject({ status: 'failed', error: 'kill failed', endedAt: 100 })
  })

  it('preserves the first terminal status while accepting final metadata', () => {
    const manager = new RuntimeTaskManager({ now: () => 100 })
    const finished: string[] = []
    manager.subscribe(event => {
      if (event.type === 'runtime-task:finished') finished.push(event.task.status)
    })
    const task = manager.createTask({ kind: 'shell', status: 'running' })

    manager.completeTask(task.id, { exitCode: 0 })
    const unchanged = manager.failTask(task.id, 'late error', { outputBytes: 20 })

    expect(unchanged).toMatchObject({ status: 'completed', exitCode: 0, outputBytes: 20 })
    expect(finished).toEqual(['completed'])
  })
})
