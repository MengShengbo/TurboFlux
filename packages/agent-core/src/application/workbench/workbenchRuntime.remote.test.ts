import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TurboFluxConfig } from '../../core/config'
import { WorkbenchRuntime } from './workbenchRuntime'

const runtimes: WorkbenchRuntime[] = []
const directories: string[] = []

function createRuntime(): WorkbenchRuntime {
  const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-remote-'))
  directories.push(workspacePath)
  const config: TurboFluxConfig = {
    provider: 'custom',
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    contextWindow: 200_000,
    maxTokens: 16_384,
    approvalPolicy: 'ask',
    capabilityProfile: 'workspace-write',
    gitEnabled: true,
    apiConfigs: [],
  }
  const runtime = new WorkbenchRuntime({ workspacePath, config })
  runtimes.push(runtime)
  return runtime
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.destroy()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('WorkbenchRuntime directed remote operations', () => {
  it('submits concurrent prompts to their explicit conversations without changing the active conversation', async () => {
    const runtime = createRuntime()
    const firstId = runtime.getSnapshot().conversation.id
    const secondId = (await runtime.newConversation()).id
    const slots = (runtime as unknown as { conversationRuntimes: Map<string, { runtime: { engine: { run: (...args: unknown[]) => Promise<unknown[]> } } }> }).conversationRuntimes
    const firstRun = vi.spyOn(slots.get(firstId)!.runtime.engine, 'run').mockResolvedValue([])
    const secondRun = vi.spyOn(slots.get(secondId)!.runtime.engine, 'run').mockResolvedValue([])

    await Promise.all([
      runtime.submitPromptToConversation(firstId, 'for-a'),
      runtime.submitPromptToConversation(secondId, 'for-b'),
    ])

    expect(firstRun).toHaveBeenCalledWith('for-a', expect.any(Object))
    expect(secondRun).toHaveBeenCalledWith('for-b', expect.any(Object))
    expect(runtime.getSnapshot().conversation.id).toBe(secondId)
  })

  it('does not turn a steering request into a new run when the target is idle', async () => {
    const runtime = createRuntime()
    const conversationId = runtime.getSnapshot().conversation.id
    const run = vi.spyOn(runtime.runtime.engine, 'run').mockResolvedValue([])

    await expect(runtime.submitPromptToConversation(conversationId, 'steer only', undefined, undefined, 'steer'))
      .rejects.toThrow(/not accepting steering/u)
    expect(run).not.toHaveBeenCalled()
  })
})
