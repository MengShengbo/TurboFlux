import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentTurn } from '../../shared/agentTypes'
import type { AgentEngine } from '../../core/agentEngine'
import type { TurboFluxConfig } from '../../core/config'
import { ConversationManager } from './manager'
import { loadConversation } from './store'

describe.sequential('ConversationManager journal integration', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'turboflux-conversation-manager-'))
    process.env.TURBOFLUX_CONVERSATIONS_DIR = directory
  })

  afterEach(() => {
    delete process.env.TURBOFLUX_CONVERSATIONS_DIR
    rmSync(directory, { recursive: true, force: true })
  })

  it('records user turns and stream deltas before the debounced snapshot', () => {
    const turns: AgentTurn[] = []
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100 }),
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
    } as unknown as AgentEngine
    const config = { model: 'test-model', provider: 'custom' } as TurboFluxConfig
    const manager = new ConversationManager(engine, config, process.cwd())
    const userTurn: AgentTurn = { id: 'user-1', role: 'user', content: 'hello', timestamp: 101 }
    turns.push(userTurn)

    manager.recordEvent({ type: 'turn:start', turn: userTurn })
    manager.recordEvent({ type: 'stream:start' })
    manager.recordEvent({ type: 'stream:delta', text: 'partial' })

    const recovered = loadConversation(manager.getCurrentId())

    expect(recovered?.title).toBe('hello')
    expect(recovered?.turns.map(turn => turn.content)).toEqual(['hello', 'partial'])
    expect(recovered?.recovery?.interrupted).toBe(true)
  })
})
