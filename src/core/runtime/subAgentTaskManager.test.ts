import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RuntimeTaskManager } from './runtimeTaskManager'
import { SubAgentTaskManager } from './subAgentTaskManager'

function createWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), 'turboflux-subagents-'))
}

describe('SubAgentTaskManager', () => {
  it('runs a subagent in the background and persists its transcript and result', async () => {
    const workspacePath = createWorkspace()
    const runtimeTaskManager = new RuntimeTaskManager({ defaultOwnerSessionId: 'conversation-1' })
    const manager = new SubAgentTaskManager({ workspacePath, runtimeTaskManager, ownerSessionId: 'conversation-1' })

    try {
      const started = manager.startTask({
        kind: 'agent',
        agentType: 'explorer',
        label: 'Explorer',
        objective: 'Inspect the runtime',
        workspacePath,
        run: async ({ recordEvent }) => {
          recordEvent({ type: 'turn_start', turn: 1, maxTurns: 2 })
          return { ok: true, finalText: 'Runtime inspected', turns: 1, elapsedMs: 5, evidence: [] }
        },
        isSuccess: result => result.ok,
      })

      expect(started.task).toMatchObject({ kind: 'agent', status: 'running' })
      await started.promise

      const snapshot = manager.getTask(started.task.id)
      expect(snapshot?.runtimeTask).toMatchObject({ status: 'completed', ownerSessionId: 'conversation-1' })
      expect(snapshot?.result).toMatchObject({ ok: true, finalText: 'Runtime inspected' })
      expect(readFileSync(snapshot!.transcriptPath, 'utf8')).toContain('Runtime inspected')
      expect(manager.readTranscript(started.task.id, { offset: 0, limit: 20 }).records.map(record => record.type)).toEqual([
        'start',
        'event',
        'result',
        'state',
      ])
      if (process.platform !== 'win32') expect(statSync(snapshot!.transcriptPath).mode & 0o777).toBe(0o600)
    } finally {
      manager.destroy()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('releases old completed task results from memory', async () => {
    const workspacePath = createWorkspace()
    const runtimeTaskManager = new RuntimeTaskManager()
    const manager = new SubAgentTaskManager({ workspacePath, runtimeTaskManager, maxRetainedTasks: 2 })

    try {
      const started = []
      for (let index = 0; index < 3; index += 1) {
        const task = manager.startTask({
          kind: 'agent',
          agentType: 'explorer',
          label: `Explorer ${index}`,
          objective: `Inspect ${index}`,
          workspacePath,
          run: async () => ({ ok: true, payload: 'x'.repeat(10_000) }),
        })
        started.push(task)
        await task.promise
      }

      expect(manager.getTask(started[0]!.task.id)).toBeNull()
      expect(runtimeTaskManager.getTask(started[0]!.task.id)).toBeNull()
      expect(manager.listTasks().map(task => task.id)).toEqual(started.slice(-2).map(task => task.task.id))
    } finally {
      manager.destroy()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('restores transcript results when the runtime journal recovered the task first', async () => {
    const workspacePath = createWorkspace()
    const journalPath = path.join(workspacePath, '.turboflux', 'runtime', 'journal.jsonl')
    const firstRuntime = new RuntimeTaskManager({ journalPath })
    const firstManager = new SubAgentTaskManager({ workspacePath, runtimeTaskManager: firstRuntime })

    try {
      const started = firstManager.startTask({
        kind: 'agent',
        agentType: 'reviewer',
        label: 'Reviewer',
        objective: 'Persist a result',
        workspacePath,
        run: async () => ({ ok: true, finalText: 'Recovered result' }),
      })
      await started.promise
      firstManager.destroy()

      const recoveredRuntime = new RuntimeTaskManager({ journalPath })
      const recoveredManager = new SubAgentTaskManager({ workspacePath, runtimeTaskManager: recoveredRuntime })
      try {
        expect(recoveredManager.getTask(started.task.id)).toMatchObject({
          runtimeTask: { status: 'completed' },
          result: { ok: true, finalText: 'Recovered result' },
        })
      } finally {
        recoveredManager.destroy()
      }
    } finally {
      firstManager.destroy()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('redacts evidence bodies, bounds event bytes, and always persists terminal records', async () => {
    const workspacePath = createWorkspace()
    const runtimeTaskManager = new RuntimeTaskManager()
    const manager = new SubAgentTaskManager({
      workspacePath,
      runtimeTaskManager,
      maxTranscriptEventBytes: 1024,
    })

    try {
      const started = manager.startTask({
        kind: 'agent',
        agentType: 'reviewer',
        label: 'Reviewer',
        objective: 'Bound the trace',
        workspacePath,
        run: async ({ recordEvent }) => {
          recordEvent({
            type: 'review_trace',
            event: {
              type: 'evidence',
              evidence: {
                path: 'src/secret.ts',
                startLine: 1,
                endLine: 2,
                preview: 'export const secret',
                content: 'SOURCE_BODY_MUST_NOT_PERSIST',
                reason: 'file read',
              },
            },
          })
          for (let index = 0; index < 30; index += 1) {
            recordEvent({ type: 'insight', text: `${index}:${'x'.repeat(300)}` })
          }
          return {
            outcome: 'succeeded',
            evidence: [{
              path: 'src/secret.ts',
              startLine: 1,
              endLine: 2,
              preview: 'export const secret',
              content: 'SOURCE_BODY_MUST_NOT_PERSIST',
              reason: 'file read',
            }],
          }
        },
      })

      await started.promise
      const transcript = readFileSync(manager.getTask(started.task.id)!.transcriptPath, 'utf8')
      const records = manager.readTranscript(started.task.id, { offset: 0, limit: 200 }).records
      expect(transcript).not.toContain('SOURCE_BODY_MUST_NOT_PERSIST')
      expect(transcript).toContain('export const secret')
      expect(records.filter(record => record.type === 'event').length).toBeLessThan(30)
      expect(records.at(-2)).toMatchObject({ type: 'result', status: 'completed' })
      expect(records.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
    } finally {
      manager.destroy()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('cancels a running task through the shared runtime controller', async () => {
    const workspacePath = createWorkspace()
    const runtimeTaskManager = new RuntimeTaskManager()
    const manager = new SubAgentTaskManager({ workspacePath, runtimeTaskManager })

    try {
      const started = manager.startTask({
        kind: 'agent',
        agentType: 'reviewer',
        label: 'Reviewer',
        objective: 'Wait for cancellation',
        workspacePath,
        run: ({ signal }) => new Promise<{ ok: boolean; error: string }>(resolve => {
          const finish = () => setTimeout(() => resolve({ ok: false, error: 'Aborted' }), 10)
          if (signal.aborted) finish()
          else signal.addEventListener('abort', finish, { once: true })
        }),
        isSuccess: result => result.ok,
        getError: result => result.error,
      })

      const stopped = await manager.stopTask(started.task.id)
      await started.promise

      expect(stopped.status).toBe('stopped')
      expect(manager.getTask(started.task.id)?.runtimeTask.status).toBe('stopped')
      expect(manager.readTranscript(started.task.id).records).toContainEqual(expect.objectContaining({
        type: 'state',
        status: 'stopped',
      }))
      expect(manager.readTranscript(started.task.id).records).toContainEqual(expect.objectContaining({
        type: 'result',
        status: 'stopped',
      }))
      manager.destroy()
      const recoveredManager = new SubAgentTaskManager({ workspacePath, runtimeTaskManager: new RuntimeTaskManager() })
      try {
        expect(recoveredManager.getTask(started.task.id)?.runtimeTask.status).toBe('stopped')
      } finally {
        recoveredManager.destroy()
      }
    } finally {
      manager.destroy()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('stops every active child task when the parent run is cancelled', async () => {
    const workspacePath = createWorkspace()
    const runtimeTaskManager = new RuntimeTaskManager()
    const manager = new SubAgentTaskManager({ workspacePath, runtimeTaskManager })

    try {
      const startWaitingTask = (agentType: string) => manager.startTask({
        kind: 'agent' as const,
        agentType,
        label: agentType,
        objective: `Wait for ${agentType}`,
        workspacePath,
        run: ({ signal }) => new Promise<{ ok: boolean }>(resolve => {
          signal.addEventListener('abort', () => resolve({ ok: false }), { once: true })
        }),
        isSuccess: result => result.ok,
      })
      const first = startWaitingTask('one')
      const second = startWaitingTask('two')

      await manager.stopAll('parent cancelled')
      await Promise.all([first.promise, second.promise])

      expect(manager.getTask(first.task.id)?.runtimeTask.status).toBe('stopped')
      expect(manager.getTask(second.task.id)?.runtimeTask.status).toBe('stopped')
    } finally {
      manager.destroy()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('keeps a stopped task stopped when its runner resolves successfully after abort', async () => {
    const workspacePath = createWorkspace()
    const runtimeTaskManager = new RuntimeTaskManager()
    const manager = new SubAgentTaskManager({ workspacePath, runtimeTaskManager })

    try {
      const started = manager.startTask({
        kind: 'agent',
        agentType: 'worker',
        label: 'Worker',
        objective: 'Finish while stopping',
        workspacePath,
        run: ({ signal }) => new Promise<{ ok: boolean }>(resolve => {
          signal.addEventListener('abort', () => resolve({ ok: true }), { once: true })
        }),
        isSuccess: result => result.ok,
      })

      await Promise.resolve()
      await manager.stopTask(started.task.id)
      await started.promise

      expect(manager.getTask(started.task.id)?.runtimeTask.status).toBe('stopped')
      expect(manager.readTranscript(started.task.id).records).toContainEqual(expect.objectContaining({
        type: 'result',
        status: 'stopped',
      }))
    } finally {
      manager.destroy()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('aborts active tasks and rejects new work after destruction', async () => {
    const workspacePath = createWorkspace()
    const runtimeTaskManager = new RuntimeTaskManager()
    const manager = new SubAgentTaskManager({ workspacePath, runtimeTaskManager })
    const started = manager.startTask({
      kind: 'agent',
      agentType: 'worker',
      label: 'Worker',
      objective: 'Wait for shutdown',
      workspacePath,
      run: ({ signal }) => new Promise<{ ok: boolean }>(resolve => {
        signal.addEventListener('abort', () => resolve({ ok: false }), { once: true })
      }),
    })

    await Promise.resolve()
    manager.destroy()
    await started.promise

    expect(runtimeTaskManager.getTask(started.task.id)?.status).toBe('stopped')
    expect(() => manager.startTask({
      kind: 'agent',
      agentType: 'worker',
      label: 'Worker',
      objective: 'Too late',
      workspacePath,
      run: async () => ({ ok: true }),
    })).toThrow('destroyed')
    rmSync(workspacePath, { recursive: true, force: true })
  })

  it('aborts and releases a subagent that exceeds its runtime deadline', async () => {
    const workspacePath = createWorkspace()
    const runtimeTaskManager = new RuntimeTaskManager()
    const manager = new SubAgentTaskManager({ workspacePath, runtimeTaskManager })
    let aborted = false

    try {
      const started = manager.startTask({
        kind: 'agent',
        agentType: 'reviewer',
        label: 'Reviewer',
        objective: 'Never finish',
        workspacePath,
        timeoutMs: 20,
        run: ({ signal }) => new Promise(() => {
          signal.addEventListener('abort', () => { aborted = true }, { once: true })
        }),
      })

      await expect(started.promise).rejects.toThrow('Reviewer timed out after 20ms')
      expect(aborted).toBe(true)
      expect(manager.getTask(started.task.id)?.runtimeTask).toMatchObject({
        status: 'failed',
        error: 'Reviewer timed out after 20ms',
      })
    } finally {
      manager.destroy()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('recovers completed and explicitly stopped tasks', async () => {
    const workspacePath = createWorkspace()
    const firstRuntime = new RuntimeTaskManager()
    const firstManager = new SubAgentTaskManager({ workspacePath, runtimeTaskManager: firstRuntime })

    try {
      const completed = firstManager.startTask({
        kind: 'agent',
        agentType: 'explorer',
        label: 'Explorer',
        objective: 'Complete before restart',
        workspacePath,
        run: async () => ({ ok: true, finalText: 'Persisted result' }),
        isSuccess: result => result.ok,
      })
      await completed.promise

      const unfinished = firstManager.startTask({
        kind: 'agent',
        agentType: 'reviewer',
        label: 'Reviewer',
        objective: 'Still running at restart',
        workspacePath,
        run: () => new Promise(() => {}),
      })
      appendFileSync(unfinished.task.logPath!, '{broken tail\n', 'utf8')
      firstManager.destroy()

      const recoveredRuntime = new RuntimeTaskManager()
      const recoveredManager = new SubAgentTaskManager({ workspacePath, runtimeTaskManager: recoveredRuntime })
      try {
        expect(recoveredManager.getTask(completed.task.id)).toMatchObject({
          runtimeTask: { status: 'completed' },
          result: { ok: true, finalText: 'Persisted result' },
        })
        expect(recoveredManager.getTask(unfinished.task.id)?.runtimeTask.status).toBe('stopped')
        expect(recoveredManager.readTranscript(unfinished.task.id).records).toContainEqual(expect.objectContaining({
          type: 'state',
          status: 'stopped',
        }))
      } finally {
        recoveredManager.destroy()
      }
    } finally {
      firstManager.destroy()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })
})
