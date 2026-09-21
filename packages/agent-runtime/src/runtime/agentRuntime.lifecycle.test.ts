import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentRuntime } from './agentRuntime'

const config = {
  provider: 'custom' as const, apiKey: 'test', baseUrl: 'http://example.test', model: 'test-model',
  contextWindow: 100_000, maxTokens: 4096, gitEnabled: false,
}
const fixtures: Array<{ workspace: string; runtime: ReturnType<typeof createAgentRuntime> }> = []

function createRuntime() {
  const workspace = mkdtempSync(join(tmpdir(), 'turboflux-runtime-lifecycle-'))
  const runtime = createAgentRuntime({ workspacePath: workspace, workspaceName: 'lifecycle', config })
  fixtures.push({ workspace, runtime })
  return runtime
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fixtures.splice(0).map(async ({ workspace, runtime }) => {
    await runtime.destroy().catch(() => undefined)
    rmSync(workspace, { recursive: true, force: true })
  }))
})

describe('AgentRuntime shutdown', () => {
  it('shares concurrent destruction and cancels the engine before a slow disconnect settles', async () => {
    const runtime = createRuntime()
    vi.spyOn(runtime.engine, 'initializeGit').mockImplementation(() => new Promise(() => undefined))
    const run = runtime.engine.run('pending work').catch(error => error)
    let release!: () => void
    const disconnect = vi.spyOn(runtime.mcpClient, 'disconnectAll').mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const destroyEngine = vi.spyOn(runtime.engine, 'destroy')
    const stopTasks = vi.spyOn(runtime.runtimeTaskManager, 'stopAll')
    const killTerminals = vi.spyOn(runtime.toolExecutor, 'ptyKillAll')
    const first = runtime.destroy()
    const second = runtime.destroy()

    try {
      await vi.waitFor(() => expect(disconnect).toHaveBeenCalled())
      expect(first).toBe(second)
      await expect(run).resolves.toMatchObject({ aborted: true })
      await expect(runtime.engine.run('too late')).rejects.toThrow(/shut|destroy/i)
      expect(() => runtime.applyConfiguration(config)).toThrow(/shut|destroy/i)
      await vi.waitFor(() => expect(destroyEngine).toHaveBeenCalledOnce())
    } finally {
      release()
      await Promise.all([first, second])
    }
    expect(disconnect).toHaveBeenCalledOnce()
    expect(stopTasks).toHaveBeenCalledOnce()
    expect(killTerminals).toHaveBeenCalledOnce()
  })

  it('releases local resources and subscriptions even if external cleanup fails', async () => {
    const runtime = createRuntime()
    const failure = new Error('disconnect failed')
    vi.spyOn(runtime.mcpClient, 'disconnectAll').mockRejectedValue(failure)
    const killTerminals = vi.spyOn(runtime.toolExecutor, 'ptyKillAll').mockResolvedValue({ success: false, error: 'terminal kill failed' })
    const destroyEngine = vi.spyOn(runtime.engine, 'destroy')
    const publish = vi.spyOn(runtime.engine, 'publishRuntimeTaskEvent')
    const result = await runtime.destroy().catch(error => error)

    expect(result).toBeInstanceOf(AggregateError)
    expect(result.errors).toContain(failure)
    expect(result.errors).toContainEqual(expect.objectContaining({ message: 'terminal kill failed' }))
    expect(killTerminals).toHaveBeenCalledOnce()
    expect(destroyEngine).toHaveBeenCalledOnce()
    publish.mockClear()
    runtime.runtimeTaskManager.createTask({ kind: 'shell', status: 'completed' })
    expect(publish).not.toHaveBeenCalled()
    await expect(runtime.destroy()).rejects.toBe(result)
  })
})
