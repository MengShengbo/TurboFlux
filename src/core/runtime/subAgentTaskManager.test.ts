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

  it('recovers completed results and marks unfinished tasks interrupted', async () => {
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
        kind: 'fast_context',
        agentType: 'fast_context',
        label: 'FastContext',
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
        expect(recoveredManager.getTask(unfinished.task.id)?.runtimeTask).toMatchObject({
          status: 'interrupted',
          error: 'Subagent runtime restarted before this task completed',
        })
        expect(recoveredManager.readTranscript(unfinished.task.id).records).toContainEqual(expect.objectContaining({
          type: 'state',
          status: 'interrupted',
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
