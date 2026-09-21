import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentRuntime } from './runtime/agentRuntime'
import { registerAgent } from './subAgent'
import type { ToolResultData } from '@turboflux/contracts/toolResultData'

function registerTestAgent(id: string): void {
  registerAgent({
    id,
    label: id,
    description: 'Background subagent lifecycle fixture',
    systemPrompt: 'Complete the requested read-only task and return a concise result.',
    maxTurns: 2,
    maxParallel: 2,
    thinking: 'disabled',
  })
}

async function waitForStatus(getStatus: () => string | undefined, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (getStatus() === expected) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for subagent status ${expected}; received ${getStatus()}`)
}

describe('AgentEngine background subagent tools', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('does not offer spawn_agent when no agent definitions are available', async () => {
    const workspacePath = mkdtempSync(path.join(tmpdir(), 'turboflux-agent-engine-empty-'))
    const runtime = createAgentRuntime({
      workspacePath,
      workspaceName: 'empty-agent-test',
      conversationId: 'conversation-empty',
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

    try {
      const disabledTools = (runtime.engine as unknown as {
        modelDisabledToolNames: () => string[]
      }).modelDisabledToolNames()
      expect(disabledTools).toContain('spawn_agent')
      expect(disabledTools).not.toContain('list_agents')
      expect(disabledTools).not.toContain('read_agent')
      expect(disabledTools).not.toContain('cancel_agent')
    } finally {
      await runtime.destroy()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('returns an agent ID immediately, then exposes the persisted result', async () => {
    const workspacePath = mkdtempSync(path.join(tmpdir(), 'turboflux-agent-engine-bg-'))
    registerTestAgent('background_test_agent')
    const runtime = createAgentRuntime({
      workspacePath,
      workspaceName: 'background-agent-test',
      conversationId: 'conversation-bg',
      approvalPolicy: 'full',
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
    const dispatchTool = (runtime.engine as unknown as {
      dispatchTool: (name: string, args: Record<string, unknown>) => Promise<string | { output: string; data?: ToolResultData }>
    }).dispatchTool.bind(runtime.engine)
    let resolveFetch!: (response: Response) => void
    const events: Array<{ type: string }> = []
    const unsubscribe = runtime.engine.subscribe(event => events.push(event))
    globalThis.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      resolveFetch = resolve
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('Aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    })) as unknown as typeof fetch

    try {
      const launchResult = await dispatchTool('spawn_agent', {
        agent_type: 'background_test_agent',
        objective: 'Find the runtime entry point',
      })
      if (typeof launchResult !== 'string') throw new Error('Expected a subagent launch receipt')
      const agentId = launchResult.match(/Agent ID: ([\w-]+)/)?.[1]

      expect(agentId).toBeTruthy()
      expect(runtime.subAgentTaskManager.getTask(agentId!)?.runtimeTask.status).toBe('running')
      expect(await dispatchTool('list_agents', {})).toMatchObject({
        output: expect.stringContaining(`[running] ${agentId}`),
        data: { kind: 'items', items: [{ title: 'Find the runtime entry point', description: 'background_test_agent', status: 'running' }] },
      })

      for (let attempt = 0; !resolveFetch && attempt < 50; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(resolveFetch).toBeTypeOf('function')
      resolveFetch(new Response(JSON.stringify({
        choices: [{ message: { content: 'The runtime starts in agentRuntime.ts.' } }],
      }), { status: 200 }))
      await waitForStatus(() => runtime.subAgentTaskManager.getTask(agentId!)?.runtimeTask.status, 'completed')

      const result = await dispatchTool('read_agent', { agent_id: agentId })
      expect(result).toContain('Status: completed')
      expect(result).toContain('The runtime starts in agentRuntime.ts.')
      expect(result).toContain('Transcript:')
      expect(events.some(event => event.type === 'subagent:progress')).toBe(true)
    } finally {
      unsubscribe()
      await runtime.destroy()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('cancels a running agent by ID', async () => {
    const workspacePath = mkdtempSync(path.join(tmpdir(), 'turboflux-agent-engine-cancel-'))
    registerTestAgent('cancel_test_agent')
    const runtime = createAgentRuntime({
      workspacePath,
      workspaceName: 'cancel-agent-test',
      conversationId: 'conversation-cancel',
      approvalPolicy: 'full',
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
    const dispatchTool = (runtime.engine as unknown as {
      dispatchTool: (name: string, args: Record<string, unknown>) => Promise<string>
    }).dispatchTool.bind(runtime.engine)
    globalThis.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('Aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    })) as unknown as typeof fetch

    try {
      const launchResult = await dispatchTool('spawn_agent', {
        agent_type: 'cancel_test_agent',
        objective: 'Review cancellation behavior',
      })
      const agentId = launchResult.match(/Agent ID: ([\w-]+)/)?.[1]
      expect(agentId).toBeTruthy()

      expect(await dispatchTool('cancel_agent', { agent_id: agentId })).toContain('is stopped')
      await waitForStatus(() => runtime.subAgentTaskManager.getTask(agentId!)?.runtimeTask.status, 'stopped')
      expect(await dispatchTool('read_agent', { agent_id: agentId })).toContain('Status: stopped')
    } finally {
      await runtime.destroy()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('enforces the frozen automation strategy for child agents', async () => {
    const workspacePath = mkdtempSync(path.join(tmpdir(), 'turboflux-agent-engine-policy-'))
    registerTestAgent('automation_allowed_agent')
    registerTestAgent('automation_denied_agent')
    const runtime = createAgentRuntime({
      workspacePath,
      workspaceName: 'automation-agent-policy-test',
      conversationId: 'conversation-policy',
      approvalPolicy: 'full',
      connectMcp: false,
      config: { provider: 'custom', apiKey: 'test', baseUrl: 'http://example.test', model: 'test-model', contextWindow: 100_000, maxTokens: 4096 },
    })
    const dispatchTool = (runtime.engine as unknown as {
      dispatchTool: (name: string, args: Record<string, unknown>) => Promise<string>
    }).dispatchTool.bind(runtime.engine)
    globalThis.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true })
    })) as unknown as typeof fetch

    try {
      const authorizeSubtask = vi.fn()
      runtime.engine.setAutomationSubAgentPolicy({
        runId: '',
        allowedTools: ['read_file'],
        deniedTools: ['write_file'],
        allowedAgentTypes: ['automation_allowed_agent'],
        maxSubtasks: 1,
        maxParallel: 1,
        authorizeSubtask,
      })
      await expect(dispatchTool('spawn_agent', { agent_type: 'automation_denied_agent', objective: 'Write outside scope' }))
        .rejects.toThrow('not authorized')
      const started = await dispatchTool('spawn_agent', { agent_type: 'automation_allowed_agent', objective: 'Read within scope' })
      expect(started).toContain('started in the background')
      expect(authorizeSubtask).toHaveBeenCalledTimes(1)
      await expect(dispatchTool('spawn_agent', { agent_type: 'automation_allowed_agent', objective: 'Start another task' }))
        .rejects.toThrow('subtask limit')
    } finally {
      await runtime.destroy()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })
})
