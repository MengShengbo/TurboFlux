import { describe, expect, it } from 'vitest'
import type { AgentEventType } from './agentEngine'
import { AgentEngine } from './agentEngine'
import { DefaultAgentStateProvider } from './runtime/stateProvider'
import type { AgentTurn } from '../shared/agentTypes'
import type { ToolExecutor } from '../tools/executor'

function createEngine() {
  const workspace = process.cwd()
  return new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', workspacePath: workspace }, {} as ToolExecutor, new DefaultAgentStateProvider({
    provider: 'custom',
    apiKey: 'test',
    baseUrl: 'http://example.test',
    model: 'test-model',
    contextWindow: 100_000,
    maxTokens: 4096,
  }, workspace))
}

describe('AgentEngine steering lifecycle', () => {
  it('records an event before publishing it to UI listeners', () => {
    const engine = createEngine()
    const order: string[] = []
    engine.setEventRecorder(() => order.push('record'))
    engine.subscribe(() => order.push('publish'))
    const internals = engine as unknown as { currentRunPromise: Promise<AgentTurn[]> | null; steeringOpen: boolean }
    internals.currentRunPromise = Promise.resolve([])
    internals.steeringOpen = true

    try {
      engine.submitSteeringMessage('persist first', 'input-0')
      expect(order.length).toBeGreaterThanOrEqual(2)
      for (let index = 0; index < order.length; index += 2) {
        expect(order.slice(index, index + 2)).toEqual(['record', 'publish'])
      }
    } finally {
      internals.currentRunPromise = null
      engine.destroy()
    }
  })

  it('emits accepted and committed states with a stable input id', () => {
    const engine = createEngine()
    const events: AgentEventType[] = []
    engine.subscribe(event => events.push(event))
    const internals = engine as unknown as {
      currentRunPromise: Promise<AgentTurn[]> | null
      steeringOpen: boolean
      consumeSteeringMessages: (turns: AgentTurn[]) => boolean
    }
    internals.currentRunPromise = Promise.resolve([])
    internals.steeringOpen = true

    try {
      expect(engine.submitSteeringMessage('add a test', 'input-1')).toBe(true)
      const turns: AgentTurn[] = []
      expect(internals.consumeSteeringMessages(turns)).toBe(true)
      expect(turns[0]).toMatchObject({ id: 'input-1', role: 'user', content: 'add a test' })
      expect(events).toContainEqual(expect.objectContaining({ type: 'input:state', inputId: 'input-1', state: 'accepted' }))
      expect(events).toContainEqual(expect.objectContaining({ type: 'input:state', inputId: 'input-1', state: 'committed' }))
    } finally {
      internals.currentRunPromise = null
      engine.destroy()
    }
  })

  it('keeps separately submitted guidance as separately identifiable user turns', () => {
    const engine = createEngine()
    const internals = engine as unknown as {
      currentRunPromise: Promise<AgentTurn[]> | null
      steeringOpen: boolean
      consumeSteeringMessages: (turns: AgentTurn[]) => boolean
    }
    internals.currentRunPromise = Promise.resolve([])
    internals.steeringOpen = true

    try {
      expect(engine.submitSteeringMessage('first guidance', 'input-a')).toBe(true)
      expect(engine.submitSteeringMessage('second guidance', 'input-b')).toBe(true)
      const turns: AgentTurn[] = []
      expect(internals.consumeSteeringMessages(turns)).toBe(true)
      expect(turns.map(turn => ({ id: turn.id, content: turn.content }))).toEqual([
        { id: 'input-a', content: 'first guidance' },
        { id: 'input-b', content: 'second guidance' },
      ])
    } finally {
      internals.currentRunPromise = null
      engine.destroy()
    }
  })

  it('rejects uncommitted guidance on abort and closes the steering gate', () => {
    const engine = createEngine()
    const events: AgentEventType[] = []
    engine.subscribe(event => events.push(event))
    const internals = engine as unknown as {
      currentRunPromise: Promise<AgentTurn[]> | null
      steeringOpen: boolean
    }
    internals.currentRunPromise = Promise.resolve([])
    internals.steeringOpen = true

    try {
      expect(engine.submitSteeringMessage('keep this', 'input-2')).toBe(true)
      engine.abort()
      expect(internals.steeringOpen).toBe(false)
      expect(events).toContainEqual(expect.objectContaining({ type: 'input:state', inputId: 'input-2', state: 'rejected' }))
      expect(engine.submitSteeringMessage('too late', 'input-3')).toBe(false)
    } finally {
      internals.currentRunPromise = null
      engine.destroy()
    }
  })
})
