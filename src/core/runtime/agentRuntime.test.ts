import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE } from '../profile'
import { createAgentRuntime } from './agentRuntime'

describe('createAgentRuntime runtime tasks', () => {
  it('does not turn full approval into unrestricted filesystem access', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'turboflux-agent-runtime-'))
    const runtime = createAgentRuntime({
      workspacePath: workspace,
      workspaceName: 'runtime-test',
      approvalPolicy: 'full',
      config: {
        provider: 'custom',
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
        contextWindow: 100_000,
        maxTokens: 4096,
        approvalPolicy: 'full',
      },
    })

    try {
    } finally {
      await runtime.destroy()
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('shares one task manager and assigns command ownership to the conversation', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'turboflux-agent-runtime-'))
    const runtime = createAgentRuntime({
      workspacePath: workspace,
      workspaceName: 'runtime-test',
      conversationId: 'conversation-1',
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

  it('applies global configuration to every runtime consumer', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'turboflux-agent-runtime-'))
    const runtime = createAgentRuntime({
      workspacePath: workspace,
      workspaceName: 'runtime-test',
      config: {
        provider: 'openai',
        apiKey: 'openai-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.6',
        contextWindow: 1_050_000,
        maxTokens: 16_384,
        approvalPolicy: 'ask',
        gitEnabled: false,
      },
    })

    try {
      runtime.applyConfiguration({
        provider: 'anthropic',
        apiKey: 'anthropic-key',
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'claude-opus-4-8',
        contextWindow: 1_000_000,
        maxTokens: 8192,
        approvalPolicy: 'full',
        gitEnabled: true,
      }, {
        profile: {
          ...DEFAULT_PROFILE,
          enabledPersonaIds: ['architect'],
          defaultPersonaId: 'architect',
        },
      })

      expect(runtime.stateProvider.getActiveConfig()).toEqual(expect.objectContaining({
        provider: 'anthropic',
        defaultModel: 'claude-opus-4-8',
        contextWindow: 1_000_000,
        maxTokens: 8192,
      }))
      expect(runtime.engine.getApprovalPolicy()).toBe('full')
      expect(runtime.engine.getGitState().enabled).toBe(true)
    } finally {
      await runtime.destroy()
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
