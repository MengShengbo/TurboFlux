import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentRuntime } from './runtime/agentRuntime'

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

  it('returns an agent ID immediately, then exposes the persisted result', async () => {
    const workspacePath = mkdtempSync(path.join(tmpdir(), 'turboflux-agent-engine-bg-'))
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
      dispatchTool: (name: string, args: Record<string, unknown>) => Promise<string>
    }).dispatchTool.bind(runtime.engine)
    let resolveFetch!: (response: Response) => void
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
        agent_type: 'explorer',
        objective: 'Find the runtime entry point',
      })
      const agentId = launchResult.match(/Agent ID: ([\w-]+)/)?.[1]

      expect(agentId).toBeTruthy()
      expect(runtime.subAgentTaskManager.getTask(agentId!)?.runtimeTask.status).toBe('running')
      expect(await dispatchTool('list_agents', {})).toContain(`[running] ${agentId}`)

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
    } finally {
      await runtime.destroy()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('cancels a running agent by ID', async () => {
    const workspacePath = mkdtempSync(path.join(tmpdir(), 'turboflux-agent-engine-cancel-'))
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
        agent_type: 'reviewer',
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

  it('waits once for a running FastContext task instead of exposing a pollable transcript', async () => {
    const workspacePath = mkdtempSync(path.join(tmpdir(), 'turboflux-fast-context-push-'))
    const runtime = createAgentRuntime({
      workspacePath,
      workspaceName: 'fast-context-push-test',
      conversationId: 'conversation-fast-context-push',
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
    let resolveTask!: (result: unknown) => void
    const started = runtime.subAgentTaskManager.startTask({
      kind: 'fast_context',
      agentType: 'fast_context',
      label: 'FastContext',
      objective: 'Map the runtime owner',
      workspacePath,
      run: () => new Promise(resolve => { resolveTask = resolve }),
    })
    const engineState = runtime.engine as unknown as {
      fastContextRuntimeTaskId: string | null
      fastContextRunPromise: Promise<unknown> | null
    }
    engineState.fastContextRuntimeTaskId = started.task.id
    engineState.fastContextRunPromise = started.promise

    try {
      let settled = false
      const read = dispatchTool('read_agent', { agent_id: started.task.id }).then(result => {
        settled = true
        return result
      })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(settled).toBe(false)

      resolveTask({
        objective: 'Map the runtime owner',
        evidencePack: 'src/core/agentEngine.ts:1',
        filesScanned: 1,
        hits: [],
        elapsedMs: 10,
        truncated: false,
      })
      await expect(read).resolves.toContain('injected automatically')
      expect(await dispatchTool('read_agent', { agent_id: started.task.id })).not.toContain('Transcript records')
    } finally {
      await runtime.destroy()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('emits a terminal FastContext event when a scan is already aborted', async () => {
    const workspacePath = mkdtempSync(path.join(tmpdir(), 'turboflux-fast-context-abort-'))
    const runtime = createAgentRuntime({
      workspacePath,
      workspaceName: 'fast-context-abort-test',
      conversationId: 'conversation-fast-context-abort',
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
    const events: Array<{ type: string }> = []
    const unsubscribe = runtime.engine.subscribe(event => events.push(event))
    const engineState = runtime.engine as unknown as {
      fastContextGeneration: number
      runFastContextScan: (objective: string, options: Record<string, unknown>) => Promise<unknown>
    }
    engineState.fastContextGeneration = 1

    try {
      await engineState.runFastContextScan('Map the runtime owner', {
        signal: AbortSignal.abort(),
        injectPack: true,
        generation: 1,
        sourceUserTurnId: null,
      })
      expect(events.filter(event => event.type === 'fast_context:complete')).toHaveLength(1)
    } finally {
      unsubscribe()
      await runtime.destroy()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })
})
