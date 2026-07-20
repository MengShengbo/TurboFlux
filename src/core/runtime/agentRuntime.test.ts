import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAgentRuntime } from './agentRuntime'

describe('createAgentRuntime runtime tasks', () => {
  it('shares one task manager and assigns command ownership to the conversation', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'turboflux-agent-runtime-'))
    const runtime = createAgentRuntime({
      workspacePath: workspace,
      workspaceName: 'runtime-test',
      conversationId: 'conversation-1',
      sandboxPolicy: 'full',
      connectMcp: false,
      config: {
        provider: 'custom',
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
        contextWindow: 100_000,
        maxTokens: 4096,
      },
    })
    const finishedTasks: string[] = []
    runtime.engine.subscribe(event => {
      if (event.type === 'runtime-task:finished') finishedTasks.push(event.task.id)
    })

    try {
      expect(runtime.toolExecutor.getRuntimeTaskManager()).toBe(runtime.runtimeTaskManager)

      await runtime.toolExecutor.runProcess(process.execPath, ['-e', 'process.exit(0)'], workspace)

      expect(runtime.runtimeTaskManager.listTasks({ ownerSessionId: 'conversation-1' })).toEqual([
        expect.objectContaining({ kind: 'shell', status: 'completed', ownerSessionId: 'conversation-1' }),
      ])
      expect(finishedTasks).toEqual([runtime.runtimeTaskManager.listTasks()[0].id])
    } finally {
      await runtime.destroy()
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
