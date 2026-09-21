import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WorkbenchRuntime } from './workbenchRuntime'

function createWorkbench() {
  const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-lifecycle-'))
  const runtime = new WorkbenchRuntime({
    workspacePath,
    config: {
      provider: 'custom', apiKey: 'test', baseUrl: 'http://example.test', model: 'test-model',
      contextWindow: 100_000, maxTokens: 4096, gitEnabled: false,
    },
  })
  return { runtime, workspacePath }
}

describe('WorkbenchRuntime shutdown', () => {
  it('shares shutdown completion and cancels active work before waiting for plugins', async () => {
    const { runtime, workspacePath } = createWorkbench()
    const engine = runtime.runtime.engine
    vi.spyOn(engine, 'initializeGit').mockImplementation(() => new Promise(() => undefined))
    const run = engine.run('pending work').catch(error => error)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const stopPlugins = vi.spyOn(runtime.plugins, 'destroy').mockReturnValue(gate)
    const first = runtime.destroy()
    const second = runtime.destroy()
    let completed = false
    void second.then(() => { completed = true })

    try {
      expect(first).toBe(second)
      await vi.waitFor(() => expect(stopPlugins).toHaveBeenCalled())
      expect(completed).toBe(false)
      await expect(run).resolves.toMatchObject({ aborted: true })
      await expect(runtime.newConversation()).rejects.toThrow('destroyed')
    } finally {
      release()
      await Promise.all([first, second])
      rmSync(workspacePath, { recursive: true, force: true })
    }
    expect(stopPlugins).toHaveBeenCalledOnce()
  })

  it('joins conversation teardown already in progress', async () => {
    const { runtime, workspacePath } = createWorkbench()
    type Slot = { runtime: WorkbenchRuntime['runtime'] }
    const internals = runtime as unknown as {
      conversationRuntimes: Map<string, Slot>
      destroyConversationRuntime(slot: Slot): Promise<void>
    }
    const slot = [...internals.conversationRuntimes.values()][0]!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const detach = vi.spyOn(runtime.plugins, 'detachMcpClient').mockReturnValue(gate)
    const first = internals.destroyConversationRuntime(slot)
    const second = internals.destroyConversationRuntime(slot)
    const shutdown = runtime.destroy()
    let completed = false
    void shutdown.then(() => { completed = true })

    try {
      expect(first).toBe(second)
      await vi.waitFor(() => expect(detach).toHaveBeenCalled())
      expect(completed).toBe(false)
      expect(internals.conversationRuntimes.size).toBe(1)
    } finally {
      release()
      await Promise.all([first, second, shutdown])
      rmSync(workspacePath, { recursive: true, force: true })
    }
    expect(detach).toHaveBeenCalledOnce()
    expect(internals.conversationRuntimes.size).toBe(0)
  })
})
