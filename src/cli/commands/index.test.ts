import { describe, expect, it, vi } from 'vitest'
import { commandRegistry } from './index'
import type { CommandContext } from './types'
import { RuntimeTaskManager } from '../../core/runtime/runtimeTaskManager'

function contextWithUsage(usage: { input?: number; output?: number; source?: 'provider' | 'unknown' }): CommandContext {
  return {
    engine: {
      getContextUsage: () => usage,
      isRunning: () => false,
    } as CommandContext['engine'],
    config: {
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'https://api.example.com/v1',
      model: 'test-model',
      contextWindow: 1_000_000,
      maxTokens: 16_384,
      approvalPolicy: 'ask',
      gitEnabled: true,
    },
    modelPresets: [],
    workspacePath: process.cwd(),
    setConfig: () => {},
    setMessages: () => {},
    exit: () => {},
  }
}

function fullContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    ...contextWithUsage({ source: 'unknown' }),
    engine: {
      getContextUsage: () => ({ source: 'unknown' }),
      isRunning: () => false,
      resetSession: () => {},
    } as CommandContext['engine'],
    ...overrides,
  }
}

describe('/context', () => {
  it('does not display local token estimates when provider usage is unavailable', () => {
    const result = commandRegistry.execute('/context', contextWithUsage({ source: 'unknown' }))

    expect(result.type).toBe('text')
    expect(result.text).toContain('Context usage: unknown')
    expect(result.text).toContain('Local character/token estimates are intentionally not used')
  })

  it('displays provider-reported prompt tokens when available', () => {
    const result = commandRegistry.execute('/context', contextWithUsage({ input: 42_000, output: 500, source: 'provider' }))

    expect(result.type).toBe('text')
    expect(result.text).toContain('Context usage: 42,000 / 1,000,000 tokens')
    expect(result.text).toContain('Last provider prompt_tokens: 42,000')
    expect(result.text).toContain('Last provider completion_tokens: 500')
  })
})

describe('/git', () => {
  it('reports state without toggling integration', () => {
    let toggled = false
    const ctx = fullContext({
      engine: {
        ...fullContext().engine,
        getGitState: () => ({ enabled: true, phase: 'ready', snapshot: null, updatedAt: 1 }),
        setGitEnabled: () => { toggled = true },
      } as CommandContext['engine'],
    })

    const result = commandRegistry.execute('/git', ctx)

    expect(result.text).toBe('Git: ready')
    expect(toggled).toBe(false)
  })

  it('persists explicit Git disablement', () => {
    let nextConfig: CommandContext['config'] | null = null
    const ctx = fullContext({
      setConfig: config => { nextConfig = config },
    })

    const result = commandRegistry.execute('/git off', ctx)

    expect(result.text).toBe('Git integration disabled.')
    expect(nextConfig?.gitEnabled).toBe(false)
  })
})

describe('background terminal commands', () => {
  it('shows durable task state with /ps and stops sessions with /stop', async () => {
    const stop = vi.fn(async () => {})
    const now = Date.now()
    const manager = new RuntimeTaskManager({ now: () => now })
    manager.createTask({
      kind: 'terminal',
      status: 'running',
      command: 'npm run watch',
      pid: 42,
      startedAt: now - 3_600_000,
      outputBytes: 2048,
      metadata: { sessionId: 'term-1' },
    }, { stop })
    const ctx = fullContext({ runtimeTaskManager: manager })

    const listed = commandRegistry.execute('/ps', ctx)
    expect(listed.text).toContain('term-1 · running')
    expect(listed.text).toContain('pid 42')
    expect(listed.text).toContain('1h 0m')
    expect(listed.text).toContain('2.0 KiB')

    const stopped = commandRegistry.execute('/stop term-1', ctx)
    expect(stopped.text).toBe('Stopping 1 background terminal...')
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce())
  })

  it('keeps asynchronous command activity pending until terminals stop', async () => {
    let release: (() => void) | undefined
    const stop = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const manager = new RuntimeTaskManager()
    const task = manager.createTask({
      kind: 'terminal',
      status: 'running',
      command: 'npm run watch',
      startedAt: Date.now(),
      metadata: { sessionId: 'term-async' },
    }, { stop })
    const pending = commandRegistry.executeAsync('/stop term-async', fullContext({ runtimeTaskManager: manager }))
    let settled = false
    void pending.finally(() => { settled = true })

    await Promise.resolve()
    expect(stop).toHaveBeenCalledOnce()
    expect(settled).toBe(false)

    release?.()
    await expect(pending).resolves.toMatchObject({ type: 'text' })
    expect(manager.getTask(task.id)?.status).toBe('stopped')
  })
})

describe('/model', () => {
  it('mounts a manually supplied model id when discovery is unavailable', () => {
    let nextConfig: CommandContext['config'] | null = null
    const ctx = fullContext({
      config: { ...fullContext().config, model: '' },
      modelPresets: [],
      setConfig: config => { nextConfig = config },
    })

    const result = commandRegistry.execute('/model add claude-sonnet-5', ctx)

    expect(result.text).toBe('Mounted model: claude-sonnet-5')
    expect(nextConfig?.model).toBe('claude-sonnet-5')
  })

  it('requires an id after the add subcommand', () => {
    const result = commandRegistry.execute('/model add', fullContext())

    expect(result.text).toBe('Usage: /model add <model-id>')
  })
})

describe('/clear', () => {
  it('starts a new saved conversation before clearing the current session', () => {
    let startedNew = 0
    let reset = 0
    let clearedMessages = false
    const ctx = fullContext({
      engine: {
        ...fullContext().engine,
        resetSession: () => { reset += 1 },
      } as CommandContext['engine'],
      conversationManager: {
        startNew: () => {
          startedNew += 1
          return 'conv-next'
        },
      } as CommandContext['conversationManager'],
      setMessages: (value) => {
        clearedMessages = Array.isArray(value) && value.length === 0
      },
    })

    const result = commandRegistry.execute('/clear', ctx)

    expect(result.type).toBe('text')
    expect(result.text).toBe('Conversation cleared.')
    expect(startedNew).toBe(1)
    expect(reset).toBe(1)
    expect(clearedMessages).toBe(true)
  })

  it('keeps the active session intact when persistence blocks the switch', () => {
    const resetSession = vi.fn()
    const setMessages = vi.fn()
    const ctx = fullContext({
      engine: {
        ...fullContext().engine,
        resetSession,
      } as CommandContext['engine'],
      conversationManager: {
        startNew: () => { throw new Error('disk full') },
      } as CommandContext['conversationManager'],
      setMessages,
    })

    const result = commandRegistry.execute('/clear', ctx)

    expect(result.text).toContain('/flow retry')
    expect(resetSession).not.toHaveBeenCalled()
    expect(setMessages).not.toHaveBeenCalled()
  })
})

describe('/flow', () => {
  it('reports feature and persistence health without starting model work', () => {
    const ctx = fullContext({
      flowFeatures: {
        flowUi: true,
        transcriptWindowing: false,
        notifications: true,
        streamScheduler: true,
        journalBatching: true,
      },
      conversationManager: {
        getPersistenceHealth: () => ({
          status: 'degraded',
          error: 'disk full',
          degradedAt: 1,
          pendingRecoveryEntries: 2,
          pendingStreamingEntries: 3,
        }),
      } as CommandContext['conversationManager'],
    })

    const result = commandRegistry.execute('/flow status', ctx)

    expect(result.text).toContain('Persistence: degraded')
    expect(result.text).toContain('transcriptWindowing=off')
    expect(result.text).toContain('disk full')
  })

  it('exposes retry and read-only export recovery actions', () => {
    const retryPersistence = vi.fn(() => ({
      status: 'healthy' as const,
      error: null,
      degradedAt: null,
      pendingRecoveryEntries: 0,
      pendingStreamingEntries: 0,
    }))
    const exportRecoveryBundle = vi.fn(() => 'C:\\safe\\recovery.json')
    const ctx = fullContext({
      conversationManager: {
        retryPersistence,
        exportRecoveryBundle,
      } as unknown as CommandContext['conversationManager'],
    })

    expect(commandRegistry.execute('/flow retry', ctx).text).toContain('recovered')
    expect(commandRegistry.execute('/flow export recovery.json', ctx).text).toContain('C:\\safe\\recovery.json')
    expect(retryPersistence).toHaveBeenCalledOnce()
    expect(exportRecoveryBundle).toHaveBeenCalledWith('recovery.json')
  })
})

describe('/config', () => {
  it('rejects unknown config keys', () => {
    const ctx = fullContext()

    const result = commandRegistry.execute('/config nope value', ctx)

    expect(result.type).toBe('text')
    expect(result.text).toContain('Config error: Unknown config key')
  })

  it('stores numeric config values as numbers', () => {
    let nextConfig: CommandContext['config'] | null = null
    const ctx = fullContext({
      setConfig: (config) => { nextConfig = config },
    })

    const result = commandRegistry.execute('/config maxTokens 8192', ctx)

    expect(result.type).toBe('text')
    expect(result.text).toContain('Set maxTokens = 8192')
    expect(nextConfig?.maxTokens).toBe(8192)
  })

  it('rejects invalid numeric config values', () => {
    let called = false
    const ctx = fullContext({
      setConfig: () => { called = true },
    })

    const result = commandRegistry.execute('/config contextWindow nope', ctx)

    expect(result.type).toBe('text')
    expect(result.text).toContain('contextWindow must be a positive integer')
    expect(called).toBe(false)
  })
})

describe('native effort and approval commands', () => {
  it('sets only effort values supported by the active model', () => {
    let nextConfig: CommandContext['config'] | null = null
    const ctx = fullContext({
      config: { ...fullContext().config, provider: 'openai', model: 'gpt-5.6' },
      setConfig: config => { nextConfig = config },
    })

    const result = commandRegistry.execute('/effort xhigh', ctx)

    expect(result.text).toContain('xhigh')
    expect(nextConfig?.reasoning?.effort).toBe('xhigh')
  })

  it('shows only the effort values supported by the active model', () => {
    const ctx = fullContext({
      config: { ...fullContext().config, provider: 'deepseek', model: 'deepseek-v4-pro' },
    })

    const result = commandRegistry.execute('/effort', ctx)

    expect(result.text).toContain('high/max')
    expect(result.text).not.toContain('xhigh')
  })

  it('accepts a direct token budget for budget-controlled Claude models', () => {
    let nextConfig: CommandContext['config'] | null = null
    const ctx = fullContext({
      config: { ...fullContext().config, provider: 'anthropic', model: 'claude-haiku-4-5' },
      setConfig: config => { nextConfig = config },
    })

    const result = commandRegistry.execute('/effort 12000', ctx)

    expect(result.text).toContain('12000t')
    expect(nextConfig?.reasoning?.budgetTokens).toBe(12_000)
  })

  it('persists the agent-decides approval policy', () => {
    let nextConfig: CommandContext['config'] | null = null
    const ctx = fullContext({
      setConfig: config => { nextConfig = config },
    })

    const result = commandRegistry.execute('/approval agent', ctx)

    expect(result.text).toContain('Approve low risk')
    expect(nextConfig?.approvalPolicy).toBe('agent')
  })

  it('enables complete runtime access for full approval', () => {
    let nextConfig: CommandContext['config'] | null = null
    const ctx = fullContext({
      setConfig: config => { nextConfig = config },
    })

    const result = commandRegistry.execute('/approval full', ctx)

    expect(result.text).toContain('Full access')
    expect(nextConfig).toMatchObject({
      approvalPolicy: 'full',
      capabilityProfile: 'danger-full-access',
    })
  })
})

describe('global command progress lifecycle', () => {
  it('marks waiting and mutating commands without animating read-only status commands', () => {
    expect(commandRegistry.getProgress('/resume')).toMatchObject({ name: 'resume' })
    expect(commandRegistry.getProgress('/conversations')).toMatchObject({ name: 'list' })
    expect(commandRegistry.getProgress('/flow retry')).toMatchObject({ name: 'flow' })
    expect(commandRegistry.getProgress('/git refresh')).toMatchObject({ name: 'git' })
    expect(commandRegistry.getProgress('/flow status')).toBeNull()
    expect(commandRegistry.getProgress('/context')).toBeNull()
  })

  it('uses asynchronous conversation listing for interactive command execution', async () => {
    const list = vi.fn(() => { throw new Error('sync list should not run') })
    const listAsync = vi.fn(async () => [{
      id: 'async-list',
      title: 'Async list',
      workspacePath: process.cwd(),
      createdAt: 1,
      updatedAt: 2,
      mode: 'vibe' as const,
      model: 'test-model',
      provider: 'custom' as const,
      turnCount: 2,
    }])
    const ctx = fullContext({
      conversationManager: {
        list,
        listAsync,
        getCurrentId: () => 'other',
      } as unknown as CommandContext['conversationManager'],
    })

    const result = await commandRegistry.executeAsync('/list', ctx)

    expect(result.text).toContain('Async list')
    expect(listAsync).toHaveBeenCalledOnce()
    expect(list).not.toHaveBeenCalled()
  })

  it('keeps compact activity pending until compaction completes', async () => {
    let release: (() => void) | undefined
    const compactContext = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const pending = commandRegistry.executeAsync('/compact', fullContext({
      engine: {
        compactContext,
        getContextUsage: () => ({ source: 'unknown' }),
        isRunning: () => false,
      } as CommandContext['engine'],
    }))
    let settled = false
    void pending.finally(() => { settled = true })

    await Promise.resolve()
    expect(compactContext).toHaveBeenCalledOnce()
    expect(settled).toBe(false)

    release?.()
    await expect(pending).resolves.toMatchObject({ type: 'text' })
  })
})
