import { describe, expect, it, vi } from 'vitest'
import type { AgentTurn } from '@turboflux/contracts/agentTypes'
import type { ToolExecutor } from '@turboflux/contracts/toolExecutor'
import { AgentEngine, type AgentEventType } from './agentEngine'
import { DefaultAgentStateProvider } from './runtime/stateProvider'

function createEngine() {
  const workspacePath = process.cwd()
  const engine = new AgentEngine({
    mode: 'vibe', approvalPolicy: 'full', workspacePath, gitEnabled: false,
  }, {} as ToolExecutor, new DefaultAgentStateProvider({
    provider: 'custom', apiKey: 'test', baseUrl: 'http://example.test', model: 'test-model',
    contextWindow: 100_000, maxTokens: 4096,
  }, workspacePath))
  const internals = engine as unknown as {
    callModel(): Promise<AgentTurn>
    prepareContextWindow(): Promise<void>
  }
  vi.spyOn(internals, 'prepareContextWindow').mockResolvedValue()
  const callModel = vi.spyOn(internals, 'callModel').mockResolvedValue({
    id: 'answer', role: 'assistant', content: 'done', timestamp: 1,
  })
  return { engine, callModel }
}

describe('AgentEngine run ownership', () => {
  it('owns the run before publishing startup events and rejects reentrant runs without changing it', async () => {
    const { engine } = createEngine()
    let runningAtStartup = false
    let nested: Promise<unknown> | undefined
    engine.subscribe(event => {
      if (event.type !== 'run:state' || event.state.phase !== 'thinking' || nested) return
      runningAtStartup = engine.isRunning()
      nested = engine.run('nested request').catch(error => error)
    })

    try {
      await expect(engine.run('original request')).resolves.toContainEqual(expect.objectContaining({ content: 'done' }))
      expect(runningAtStartup).toBe(true)
      await expect(nested).resolves.toMatchObject({ message: expect.stringContaining('previous run') })
      expect(engine.getSession().turns.filter(turn => turn.role === 'user').map(turn => turn.content)).toEqual(['original request'])
      expect(engine.getRunState().phase).toBe('completed')
      expect(engine.isRunning()).toBe(false)
      expect(engine.getRunControlSnapshot().active).toBe(false)
    } finally {
      engine.destroy()
    }
  })

  it('keeps an interrupted run owned until it settles after destruction', async () => {
    const { engine, callModel } = createEngine()
    vi.spyOn(engine, 'initializeGit').mockImplementation(() => new Promise(() => undefined))
    const run = engine.run('stop during preparation').catch(error => error)

    engine.destroy()

    expect(engine.isRunning()).toBe(true)
    await engine.waitUntilIdle()
    await expect(run).resolves.toMatchObject({ aborted: true })
    expect(engine.isRunning()).toBe(false)
    expect(callModel).not.toHaveBeenCalled()
    await expect(engine.run('too late')).rejects.toThrow(/shut|destroy/i)
  })

  it('cancels work even when a cancellation event listener fails', async () => {
    const { engine } = createEngine()
    vi.spyOn(engine, 'initializeGit').mockImplementation(() => new Promise(() => undefined))
    const run = engine.run('stop safely').catch(error => error)
    engine.subscribe(event => {
      if (event.type === 'run:state' && event.state.phase === 'aborting') throw new Error('observer failed')
    })

    try {
      expect(() => engine.abort()).toThrow('observer failed')
      expect(engine.getRunControlSnapshot().runAborted).toBe(true)
      await engine.waitUntilIdle()
      await expect(run).resolves.toMatchObject({ aborted: true })
    } finally {
      engine.destroy()
    }
  })

  it('finishes destruction even when rejecting pending guidance throws', async () => {
    const { engine } = createEngine()
    vi.spyOn(engine, 'initializeGit').mockImplementation(() => new Promise(() => undefined))
    const run = engine.run('pending work').catch(error => error)
    engine.submitSteeringMessage('pending guidance', 'guidance')
    const observer = vi.fn((event: AgentEventType) => {
      if (event.type === 'input:state' && event.state === 'rejected') throw new Error('guidance observer failed')
    })
    engine.subscribe(observer)

    expect(() => engine.destroy()).toThrow('Agent destruction failed')
    observer.mockClear()
    await engine.waitUntilIdle()
    await expect(run).resolves.toMatchObject({ aborted: true })
    expect(observer).not.toHaveBeenCalled()
    expect(() => engine.destroy()).not.toThrow()
  })
})
