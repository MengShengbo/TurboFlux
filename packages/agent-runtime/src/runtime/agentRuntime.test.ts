import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE } from '@turboflux/models/profile'
import { composeRuntimeProfileSystemPrompt, createAgentRuntime } from './agentRuntime'

describe('createAgentRuntime runtime tasks', () => {
  it('isolates runtime journals from the inspected workspace when requested', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'turboflux-agent-runtime-workspace-'))
    const runtimeStorage = mkdtempSync(join(tmpdir(), 'turboflux-agent-runtime-storage-'))
    const runtime = createAgentRuntime({
      workspacePath: workspace,
      workspaceName: 'runtime-test',
      runtimeStoragePath: runtimeStorage,
      conversationId: 'conversation-storage',
      config: {
        provider: 'custom',
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
        contextWindow: 100_000,
        maxTokens: 4096,
      },
    })

    try {
      await runtime.toolExecutor.readOnlyProcess(process.execPath, ['-e', 'process.exit(0)'], workspace)
      const sessionKey = createHash('sha256').update('conversation-storage').digest('hex').slice(0, 32)
      const sessionRoot = join(runtimeStorage, 'sessions', sessionKey)

      expect(existsSync(join(sessionRoot, 'runtime', 'journal.jsonl'))).toBe(true)
      expect(existsSync(join(sessionRoot, 'runtime-agents'))).toBe(true)
      expect(existsSync(join(runtimeStorage, 'runtime', 'journal.jsonl'))).toBe(false)
      expect(existsSync(join(runtimeStorage, 'runtime-agents'))).toBe(false)
      expect(existsSync(join(workspace, '.turboflux', 'runtime', 'journal.jsonl'))).toBe(false)
      expect(existsSync(join(workspace, '.turboflux', 'runtime-agents'))).toBe(false)
    } finally {
      await runtime.destroy()
      rmSync(workspace, { recursive: true, force: true })
      rmSync(runtimeStorage, { recursive: true, force: true })
    }
  })

  it('isolates task journals and subagent transcripts between conversations', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'turboflux-agent-runtime-workspace-'))
    const runtimeStorage = mkdtempSync(join(tmpdir(), 'turboflux-agent-runtime-storage-'))
    const config = {
      provider: 'custom' as const,
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }
    let firstRuntime = createAgentRuntime({
      workspacePath: workspace,
      workspaceName: 'runtime-test',
      runtimeStoragePath: runtimeStorage,
      conversationId: 'conversation-a',
      config,
    })
    let secondRuntime = createAgentRuntime({
      workspacePath: workspace,
      workspaceName: 'runtime-test',
      runtimeStoragePath: runtimeStorage,
      conversationId: 'conversation-b',
      config,
    })

    try {
      const started = firstRuntime.subAgentTaskManager.startTask({
        kind: 'agent',
        agentType: 'isolation-test',
        label: 'Isolation test',
        objective: 'Stay in conversation A',
        workspacePath: workspace,
        run: async () => 'conversation-a-result',
      })
      await started.promise

      expect(firstRuntime.subAgentTaskManager.listTasks()).toHaveLength(1)
      expect(secondRuntime.subAgentTaskManager.listTasks()).toEqual([])
      expect(secondRuntime.runtimeTaskManager.listTasks()).toEqual([])

      await firstRuntime.destroy()
      await secondRuntime.destroy()
      firstRuntime = createAgentRuntime({
        workspacePath: workspace,
        workspaceName: 'runtime-test',
        runtimeStoragePath: runtimeStorage,
        conversationId: 'conversation-a',
        config,
      })
      secondRuntime = createAgentRuntime({
        workspacePath: workspace,
        workspaceName: 'runtime-test',
        runtimeStoragePath: runtimeStorage,
        conversationId: 'conversation-b',
        config,
      })

      expect(firstRuntime.subAgentTaskManager.listTasks()).toEqual([
        expect.objectContaining({ objective: 'Stay in conversation A' }),
      ])
      expect(secondRuntime.subAgentTaskManager.listTasks()).toEqual([])
    } finally {
      await firstRuntime.destroy()
      await secondRuntime.destroy()
      rmSync(workspace, { recursive: true, force: true })
      rmSync(runtimeStorage, { recursive: true, force: true })
    }
  })

  it('keeps surface guidance beside the user profile across runtime creation', () => {
    const prompt = composeRuntimeProfileSystemPrompt(DEFAULT_PROFILE, '<desktop_experience>plain-language work</desktop_experience>')

    expect(prompt).toContain('<turboflux_profile>')
    expect(prompt).toContain('<desktop_experience>plain-language work</desktop_experience>')
  })

  it('uses one unique conversation identity across the engine and registry', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'turboflux-agent-runtime-'))
    const runtime = createAgentRuntime({
      workspacePath: workspace,
      workspaceName: 'runtime-test',
      conversationPrefix: 'cli',
      config: {
        provider: 'custom',
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
        contextWindow: 100_000,
        maxTokens: 4096,
      },
    })

    try {
      expect(runtime.engine.getConversationId()).toBe(runtime.sessionRegistry.getCurrentId())
      expect(runtime.engine.getSession().id).toBe(runtime.sessionRegistry.getCurrentId())
      expect(runtime.sessionRegistry.getCurrentId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    } finally {
      await runtime.destroy()
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('turns full approval into unrestricted filesystem access', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'turboflux-agent-runtime-'))
    const outside = mkdtempSync(join(tmpdir(), 'turboflux-agent-runtime-outside-'))
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
      expect(runtime.toolExecutor.getCapabilityProfile()).toBe('danger-full-access')
      await expect(runtime.toolExecutor.writeFile(join(outside, 'allowed.txt'), 'full access'))
        .resolves.toMatchObject({ success: true })
    } finally {
      await runtime.destroy()
      rmSync(workspace, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
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

  it('switches every runtime owner through one session registry', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'turboflux-agent-runtime-'))
    const runtime = createAgentRuntime({
      workspacePath: workspace,
      workspaceName: 'runtime-test',
      conversationId: 'conversation-1',
      config: {
        provider: 'custom',
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
        contextWindow: 100_000,
        maxTokens: 4096,
      },
    })

    try {
      await runtime.toolExecutor.runProcess(process.execPath, ['-e', 'process.exit(0)'], workspace)
      runtime.sessionRegistry.activate('conversation-2')

      expect(runtime.engine.getConversationId()).toBe('conversation-2')
      expect(runtime.engine.getSession().id).toBe('conversation-2')
      expect(runtime.stateProvider.getConversationId()).toBe('conversation-2')
      expect(runtime.runtimeTaskManager.getDefaultOwnerSessionId()).toBe('conversation-2')
      expect(runtime.subAgentTaskManager.getOwnerSessionId()).toBe('conversation-2')
      expect(runtime.runtimeTaskManager.listTasks()).toEqual([])

      await runtime.toolExecutor.runProcess(process.execPath, ['-e', 'process.exit(0)'], workspace)
      expect(runtime.runtimeTaskManager.listTasks()).toEqual([
        expect.objectContaining({ ownerSessionId: 'conversation-2' }),
      ])

      runtime.sessionRegistry.activate('conversation-1')
      expect(runtime.runtimeTaskManager.listTasks()).toEqual([
        expect.objectContaining({ ownerSessionId: 'conversation-1' }),
      ])
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
      expect(runtime.toolExecutor.getCapabilityProfile()).toBe('danger-full-access')
      expect(runtime.engine.getGitState().enabled).toBe(true)
    } finally {
      await runtime.destroy()
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
