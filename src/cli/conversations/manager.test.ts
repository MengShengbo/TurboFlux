import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentTurn } from '../../shared/agentTypes'
import type { AgentEngine } from '../../core/agentEngine'
import type { TurboFluxConfig } from '../../core/config'
import { ConversationManager } from './manager'
import { loadConversation, saveConversation } from './store'

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
    manager.flushJournal()

    const recovered = loadConversation(manager.getCurrentId())

    expect(recovered?.title).toBe('hello')
    expect(recovered?.turns.map(turn => turn.content)).toEqual(['hello', 'partial'])
    expect(recovered?.recovery?.interrupted).toBe(true)
    expect(manager.getJournalStats().streamingBatchesWritten).toBe(1)
  })

  it('does not materialize an empty startup conversation before the first user turn', () => {
    const turns: AgentTurn[] = []
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100 }),
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
    } as unknown as AgentEngine
    const manager = new ConversationManager(
      engine,
      { model: 'test-model', provider: 'custom' } as TurboFluxConfig,
      process.cwd(),
    )

    manager.recordEvent({ type: 'run:state', state: { phase: 'idle', updatedAt: 100 } })
    manager.recordEvent({ type: 'mode:change', from: 'vibe', to: 'plan' })
    expect(manager.recordQueueState([])).toBe(true)
    expect(manager.recordDraftState({ text: '', attachments: [] })).toBe(true)
    manager.flushJournal()

    expect(readdirSync(directory).filter(file => file.endsWith('.jsonl'))).toEqual([])
    expect(loadConversation(manager.getCurrentId())).toBeNull()

    const userTurn: AgentTurn = { id: 'user-1', role: 'user', content: 'first real prompt', timestamp: 101 }
    turns.push(userTurn)
    manager.recordEvent({ type: 'turn:start', turn: userTurn })
    manager.flushJournal()

    expect(loadConversation(manager.getCurrentId())).toMatchObject({ title: 'first real prompt', turnCount: 2 })
  })

  it('replaces a provisional draft title with the first persisted user prompt', () => {
    const turns: AgentTurn[] = []
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100 }),
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
    } as unknown as AgentEngine
    const manager = new ConversationManager(
      engine,
      { model: 'test-model', provider: 'custom' } as TurboFluxConfig,
      process.cwd(),
    )

    manager.recordDraftState({ text: 'f' })
    manager.flushJournal()
    expect(loadConversation(manager.getCurrentId())?.title).toBe('f')

    const userTurn: AgentTurn = {
      id: 'user-1',
      role: 'user',
      content: 'full prompt after typing',
      timestamp: 101,
    }
    turns.push(userTurn)
    manager.recordEvent({ type: 'turn:start', turn: userTurn })
    manager.flushJournal()

    expect(loadConversation(manager.getCurrentId())?.title).toBe('full prompt after typing')
  })

  it('omits redundant active turns and retains only a snapshot hash', () => {
    const turns: AgentTurn[] = [{ id: 'user-1', role: 'user', content: 'hello', timestamp: 101 }]
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100, updatedAt: 101 }),
      getFullConversationTurns: () => [...turns],
      getContextSegments: () => [],
      getContextReservoir: () => [],
    } as unknown as AgentEngine
    const manager = new ConversationManager(
      engine,
      { model: 'test-model', provider: 'custom' } as TurboFluxConfig,
      process.cwd(),
    )

    manager.persist(true)

    const record = JSON.parse(readFileSync(join(directory, `${manager.getCurrentId()}.jsonl`), 'utf8'))
    expect(record.conversation.activeTurns).toBeUndefined()
    expect((manager as any).lastPersistedSnapshotHash).toMatch(/^[a-f0-9]{64}$/)
    expect((manager as any).lastPersistedSnapshotHash).not.toContain('hello')
  })

  it('compacts an unchanged conversation instead of leaving journal history behind', () => {
    const turns: AgentTurn[] = [{ id: 'user-1', role: 'user', content: 'stable', timestamp: 101 }]
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100, updatedAt: 101 }),
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
    } as unknown as AgentEngine
    const manager = new ConversationManager(
      engine,
      { model: 'test-model', provider: 'custom' } as TurboFluxConfig,
      process.cwd(),
    )

    manager.persist()
    const journalPath = join(directory, `${manager.getCurrentId()}.jsonl`)
    expect(readFileSync(journalPath, 'utf8').trim().split(/\r?\n/).length).toBeGreaterThan(1)

    manager.persist(true)

    const records = readFileSync(journalPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ type: 'snapshot', conversation: { turnCount: 1 } })
  })

  it('reports journal persistence failures instead of silently losing recovery data', () => {
    const turns: AgentTurn[] = [{ id: 'user-1', role: 'user', content: 'hello', timestamp: 101 }]
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100 }),
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
    } as unknown as AgentEngine
    const statuses: Array<Error | null> = []
    rmSync(directory, { recursive: true, force: true })
    writeFileSync(directory, 'not a directory', 'utf-8')
    const manager = new ConversationManager(
      engine,
      { model: 'test-model', provider: 'custom' } as TurboFluxConfig,
      process.cwd(),
      status => statuses.push(status),
    )

    expect(() => manager.recordEvent({ type: 'turn:start', turn: turns[0]! })).toThrow()

    expect(statuses).toHaveLength(1)
    expect(statuses[0]).toBeInstanceOf(Error)
  })

  it('gates new work until explicit retry succeeds and can export a redacted bundle', () => {
    const turns: AgentTurn[] = [{ id: 'user-1', role: 'user', content: 'token sk-abcdefghijklmnop', timestamp: 101 }]
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100, updatedAt: 101 }),
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
    } as unknown as AgentEngine
    rmSync(directory, { recursive: true, force: true })
    writeFileSync(directory, 'not a directory', 'utf8')
    const manager = new ConversationManager(
      engine,
      { model: 'test-model', provider: 'custom' } as TurboFluxConfig,
      process.cwd(),
    )

    expect(() => manager.recordEvent({ type: 'turn:start', turn: turns[0]! })).toThrow()
    expect(manager.isPersistenceHealthy()).toBe(false)
    expect(() => manager.startNew()).toThrow(/degraded/)

    const exportRoot = mkdtempSync(join(tmpdir(), 'turboflux-conversation-export-'))
    const exportPath = join(exportRoot, 'recovery.json')
    try {
      manager.exportRecoveryBundle(exportPath)
      expect(readFileSync(exportPath, 'utf8')).not.toContain('sk-abcdefghijklmnop')
    } finally {
      rmSync(exportRoot, { recursive: true, force: true })
    }

    rmSync(directory, { force: true })
    mkdirSync(directory)
    expect(manager.retryPersistence().status).toBe('healthy')
    expect(manager.isPersistenceHealthy()).toBe(true)
  })

  it('does not switch sessions when persistence fails during the pre-switch compact', () => {
    const turns: AgentTurn[] = [{ id: 'user-1', role: 'user', content: 'keep me', timestamp: 101 }]
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100, updatedAt: 101 }),
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
    } as unknown as AgentEngine
    rmSync(directory, { recursive: true, force: true })
    writeFileSync(directory, 'not a directory', 'utf8')
    const manager = new ConversationManager(
      engine,
      { model: 'test-model', provider: 'custom' } as TurboFluxConfig,
      process.cwd(),
    )
    const currentId = manager.getCurrentId()

    expect(() => manager.startNew()).toThrow(/degraded while saving/)
    expect(manager.getCurrentId()).toBe(currentId)
  })

  it('persists interaction lifecycle state without losing pending user intent', () => {
    const turns: AgentTurn[] = []
    const engine = {
      getSession: () => ({ id: 'session-1', mode: 'vibe', turns, createdAt: 100 }),
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
    } as unknown as AgentEngine
    const manager = new ConversationManager(
      engine,
      { model: 'test-model', provider: 'custom' } as TurboFluxConfig,
      process.cwd(),
    )

    manager.recordQueueState([{ id: 'queue-1', prompt: 'next task' }])
    manager.recordDraftState({ text: 'unfinished' })
    manager.recordEvent({ type: 'input:state', inputId: 'steer-1', intent: 'steer', state: 'accepted', text: 'change direction' })
    manager.recordEvent({
      type: 'approval:state',
      requestId: 'approval-1',
      requestKind: 'permission',
      state: 'requested',
      question: 'Allow write?',
      toolName: 'write_file',
    })
    manager.flushJournal()

    expect(loadConversation(manager.getCurrentId())?.interactionState).toMatchObject({
      queuedInputs: [{ id: 'queue-1', prompt: 'next task' }],
      draft: { text: 'unfinished' },
      pendingSteering: [{ id: 'steer-1', text: 'change direction' }],
      pendingApprovals: [{ requestId: 'approval-1', toolName: 'write_file' }],
    })
  })

  it('lists, switches, and deletes saved conversations asynchronously', async () => {
    const turns: AgentTurn[] = []
    const session = { id: 'session-1', mode: 'vibe' as const, turns, createdAt: 500, updatedAt: 500 }
    let contextSegments: ReturnType<AgentEngine['getContextSegments']> = []
    let contextReservoir: ReturnType<AgentEngine['getContextReservoir']> = []
    const engine = {
      getSession: () => session,
      getFullConversationTurns: () => turns,
      getContextSegments: () => contextSegments,
      getContextReservoir: () => contextReservoir,
      restoreFromTurns: (restored: AgentTurn[]) => {
        turns.splice(0, turns.length, ...restored)
        session.createdAt = restored[0]?.timestamp ?? 500
        session.updatedAt = restored.at(-1)?.timestamp ?? 500
      },
      setContextSegments: (segments: typeof contextSegments) => { contextSegments = segments },
      setContextReservoir: (entries: typeof contextReservoir) => { contextReservoir = entries },
      getMode: () => session.mode,
      setMode: (mode: 'vibe' | 'plan') => { (session as { mode: 'vibe' | 'plan' }).mode = mode },
    } as unknown as AgentEngine
    const manager = new ConversationManager(
      engine,
      { model: 'test-model', provider: 'custom' } as TurboFluxConfig,
      process.cwd(),
    )
    saveConversation({
      id: 'saved-async',
      title: 'Saved async conversation',
      workspacePath: process.cwd(),
      createdAt: 50,
      updatedAt: 200,
      mode: 'plan',
      model: 'test-model',
      provider: 'custom',
      turnCount: 2,
      turns: [
        { id: 'user-1', role: 'user', content: 'hello', timestamp: 100 },
        { id: 'assistant-1', role: 'assistant', content: 'hi', timestamp: 101 },
      ],
    })

    await expect(manager.listAsync()).resolves.toEqual([
      expect.objectContaining({ id: 'saved-async' }),
    ])
    await expect(manager.switchToAsync('saved-async')).resolves.toMatchObject({ id: 'saved-async' })
    expect(manager.getCurrentId()).toBe('saved-async')
    expect(session).toMatchObject({ mode: 'plan', createdAt: 50 })
    expect(turns.map(turn => turn.content)).toEqual(['hello', 'hi'])

    manager.recordDraftState({ text: 'transient render effect' })
    manager.flushJournal()
    expect(loadConversation('saved-async')).toMatchObject({ createdAt: 50, mode: 'plan', title: 'hello' })

    await expect(manager.deleteAsync('saved-async')).resolves.toBe(false)
    expect(loadConversation('saved-async')).not.toBeNull()

    manager.startNew()
    await expect(manager.deleteAsync('saved-async')).resolves.toBe(true)
    manager.destroy()
  })
})
