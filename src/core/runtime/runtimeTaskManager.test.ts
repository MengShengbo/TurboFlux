import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('persists events and marks active tasks orphaned on recovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-runtime-journal-'))
    const journalPath = join(root, 'runtime', 'journal.jsonl')
    try {
      const first = new RuntimeTaskManager({ journalPath, now: () => 100 })
      const completed = first.createTask({ kind: 'shell', status: 'running' })
      first.completeTask(completed.id, { exitCode: 0 })
      first.createTask({ kind: 'agent', status: 'running' })

      const recovered = new RuntimeTaskManager({ journalPath, now: () => 200 })
      expect(recovered.getTask(completed.id)).toMatchObject({ status: 'completed', exitCode: 0 })
      expect(recovered.listTasks({ kind: 'agent' })[0]).toMatchObject({
        status: 'orphaned',
        error: 'Recovered process is no longer running',
      })
      const records = readFileSync(journalPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
      expect(records.at(-1)?.event).toMatchObject({
        type: 'runtime-task:finished',
        task: { status: 'orphaned', endedAt: 200 },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('recovers a live process as observable and read-only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-runtime-live-recovery-'))
    const journalPath = join(root, 'journal.jsonl')
    try {
      const first = new RuntimeTaskManager({ journalPath, now: () => 100 })
      const task = first.createTask({ kind: 'terminal', status: 'running', pid: 42 })
      const recovered = new RuntimeTaskManager({
        journalPath,
        now: () => 200,
        isProcessAlive: pid => pid === 42,
      })

      expect(recovered.getTask(task.id)).toMatchObject({
        status: 'running',
        pid: 42,
        endedAt: undefined,
        metadata: { recovered: true, controlAvailable: false },
      })
      await expect(recovered.stopTask(task.id)).rejects.toThrow('cannot be stopped')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('repairs a truncated journal tail', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-runtime-repair-'))
    const journalPath = join(root, 'journal.jsonl')
    try {
      const first = new RuntimeTaskManager({ journalPath, now: () => 100 })
      first.createTask({ kind: 'shell', status: 'running' })
      writeFileSync(journalPath, `${readFileSync(journalPath, 'utf8')}broken`, 'utf8')
      new RuntimeTaskManager({ journalPath, now: () => 200 })
      expect(readFileSync(journalPath, 'utf8')).toContain('truncated-tail')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads task output using a resumable byte cursor', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-runtime-output-'))
    const logPath = join(root, 'task.jsonl')
    try {
      writeFileSync(logPath, '0123456789', 'utf8')
      const manager = new RuntimeTaskManager({ now: () => 100 })
      const task = manager.createTask({ kind: 'shell', logPath })
      const first = manager.readTaskOutput(task.id, 2, 4)
      expect(first).toMatchObject({ offset: 2, nextOffset: 6, content: '2345', eof: false })
      const second = manager.readTaskOutput(task.id, first.nextOffset, 100)
      expect(second).toMatchObject({ offset: 6, nextOffset: 10, content: '6789', eof: true })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps byte cursors on UTF-8 character boundaries', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-runtime-utf8-'))
    const logPath = join(root, 'task.log')
    try {
      writeFileSync(logPath, 'A你B', 'utf8')
      const manager = new RuntimeTaskManager({ now: () => 100 })
      const task = manager.createTask({ kind: 'shell', logPath })

      const first = manager.readTaskOutput(task.id, 0, 2)
      expect(first).toMatchObject({ offset: 0, nextOffset: 4, content: 'A你', eof: false })
      const second = manager.readTaskOutput(task.id, first.nextOffset, 2)
      expect(second).toMatchObject({ offset: 4, nextOffset: 5, content: 'B', eof: true })
      const misaligned = manager.readTaskOutput(task.id, 2, 2)
      expect(misaligned).toMatchObject({ offset: 4, content: 'B' })
      expect(first.content).not.toContain('�')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
