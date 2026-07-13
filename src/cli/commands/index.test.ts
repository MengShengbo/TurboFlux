import { describe, expect, it } from 'vitest'
import { commandRegistry } from './index'
import type { CommandContext } from './types'

function contextWithUsage(usage: { input?: number; output?: number; source?: 'provider' | 'unknown' }): CommandContext {
  return {
    engine: {
      getContextUsage: () => usage,
      isRunning: () => false,
      isFastContextRunning: () => false,
      runStandaloneFastContextObjective: () => Promise.resolve(null),
    } as CommandContext['engine'],
    config: {
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'https://api.example.com/v1',
      model: 'test-model',
      contextWindow: 1_000_000,
      maxTokens: 16_384,
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
      isFastContextRunning: () => false,
      runStandaloneFastContextObjective: () => Promise.resolve(null),
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

describe('/fastcontext', () => {
  it('is no longer exposed as a manual command', () => {
    const result = commandRegistry.execute('/fastcontext', contextWithUsage({ source: 'unknown' }))

    expect(result.type).toBe('text')
    expect(result.text).toContain('Unknown command: /fastcontext')
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
