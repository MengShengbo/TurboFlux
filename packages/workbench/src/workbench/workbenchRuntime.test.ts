import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEventType } from '@turboflux/agent-runtime/agentEngine'
import type { TurboFluxConfig } from '@turboflux/models/config'
import type { AutomationRuntimeBoundary, WorkbenchEvent } from './types'
import { saveProjectMcpSettings } from '@turboflux/extensions/mcp/settings'
import { WorkbenchRuntime } from './workbenchRuntime'
import { createProfileStorageLayout, ensureProfileStorageLayout } from '@turboflux/profiles/profileStorageLayout'
import type { AutomationClaim } from '@turboflux/automations/automationService'
import { ConversationRuntimeRepositoryV2 } from '@turboflux/conversations/conversations/conversationRuntimeRepositoryV2'
import { ConversationRepositoryV2 } from '@turboflux/conversations/conversations/conversationRepositoryV2'
import { saveConversation } from '@turboflux/conversations/conversations/store'
import { ConversationManager } from '@turboflux/conversations/conversations/manager'
import { WorkspaceBindingService } from '@turboflux/profiles/workspaceBindingService'
import type { PersistedConversation } from '@turboflux/conversations/conversations/types'

const directories: string[] = []

function createConfig(): TurboFluxConfig {
  return {
    provider: 'custom',
    apiKey: '',
    baseUrl: '',
    model: '',
    contextWindow: 200_000,
    maxTokens: 16_384,
    approvalPolicy: 'ask',
    capabilityProfile: 'workspace-write',
    gitEnabled: true,
    apiConfigs: [],
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('WorkbenchRuntime', () => {
  it('exposes exact persisted model usage after closing and reopening a profile conversation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-usage-workbench-'))
    const workspacePath = join(root, 'workspace'); mkdirSync(workspacePath)
    directories.push(root)
    const layout = createProfileStorageLayout(join(root, 'data'), join(root, 'device'), 'profile-usage')
    ensureProfileStorageLayout(layout)
    const options = { workspacePath, config: createConfig(), profileStorage: layout }
    const runtime = new WorkbenchRuntime(options)
    const id = runtime.getSnapshot().conversation.id
    const handle = (runtime as unknown as { handleAgentEvent(event: AgentEventType): void }).handleAgentEvent.bind(runtime)
    const userTurn = { id: 'user', role: 'user' as const, content: 'measure', timestamp: Date.now(), metadata: { workRunId: 'measured-run' } }
    runtime.runtime.engine.restoreFromTurns([userTurn], { emitRunState: false, emitRuntimeEvents: false })
    handle({ type: 'turn:start', turn: userTurn })
    handle({ type: 'model:request', request: {
      id: 'attempt-measured', requestId: 'request-measured', runId: 'measured-run', model: 'test', provider: 'custom', purpose: 'turn',
      status: 'completed', startedAt: 1, updatedAt: 2, usageFinal: true, usage: { input: 500, output: 20, cached: 400, source: 'provider' },
    } })
    const before = runtime.getSnapshot().context.modelUsage
    expect(before).toMatchObject({ attempts: 1, totals: { input: 500, output: 20, cached: 400 }, cacheHitRate: .8 })
    await runtime.destroy()
    const reopened = new WorkbenchRuntime(options)
    try {
      await reopened.switchConversation(id)
      expect(reopened.getSnapshot().context.modelUsage).toEqual(before)
    } finally { await reopened.destroy() }
  })

  it('isolates profile stores and workspace runtime overlays in one process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-profile-workbench-'))
    const workspacePath = join(root, 'workspace')
    mkdirSync(workspacePath)
    const firstLayout = createProfileStorageLayout(join(root, 'data'), join(root, 'device'), 'profile-a')
    const secondLayout = createProfileStorageLayout(join(root, 'data'), join(root, 'device'), 'profile-b')
    ensureProfileStorageLayout(firstLayout)
    ensureProfileStorageLayout(secondLayout)
    mkdirSync(join(firstLayout.userSkillsRoot, 'private-skill'), { recursive: true })
    writeFileSync(join(firstLayout.userSkillsRoot, 'private-skill', 'SKILL.md'), '---\nname: private-skill\ndescription: Profile A only\n---\n\nPrivate instructions.')
    directories.push(root)
    const first = new WorkbenchRuntime({ workspacePath, config: createConfig(), profileStorage: firstLayout })
    const second = new WorkbenchRuntime({ workspacePath, config: createConfig(), profileStorage: secondLayout })

    try {
      first.conversations.recordEvent({
        type: 'turn:start',
        turn: { id: 'profile-a-turn', role: 'user', content: 'Profile A only', timestamp: Date.now() },
      })
      first.conversations.flushJournal()
      first.createAutomation({ name: 'Profile A automation', prompt: 'Only A', schedule: { kind: 'manual' } })
      const attachmentPath = join(first.workspaceOverlayRoot!, 'attachments', 'profile-a.txt')
      mkdirSync(join(first.workspaceOverlayRoot!, 'attachments'), { recursive: true })
      writeFileSync(attachmentPath, 'profile a attachment')
      first.registerArtifact(attachmentPath, 'browser-download', { name: 'Profile A attachment' })
      const memoryPath = join(first.workspaceOverlayRoot!, 'memory', 'facts.jsonl')
      mkdirSync(join(first.workspaceOverlayRoot!, 'memory'), { recursive: true })
      writeFileSync(memoryPath, '{"id":"profile-a-memory","text":"Profile A only"}\n')
      mkdirSync(join(firstLayout.pluginsRoot, 'profile-a-plugin'), { recursive: true })
      writeFileSync(join(firstLayout.pluginsRoot, 'profile-a-plugin', 'marker.txt'), 'profile a plugin')

      expect(first.runtimeStoragePath).toBe(join(firstLayout.workspaceOverlaysRoot, first.workspaceBinding!.id, 'runtime'))
      expect(second.runtimeStoragePath).toBe(join(secondLayout.workspaceOverlaysRoot, second.workspaceBinding!.id, 'runtime'))
      expect(first.conversations.listAll().map(item => item.id)).toEqual([first.getSnapshot().conversation.id])
      expect(second.conversations.listAll()).toEqual([])
      expect(first.listAutomations().automations).toHaveLength(1)
      expect(second.listAutomations().automations).toEqual([])
      expect(first.listArtifacts().artifacts).toHaveLength(1)
      expect(second.listArtifacts().artifacts).toEqual([])
      expect(existsSync(memoryPath)).toBe(true)
      expect(existsSync(join(second.workspaceOverlayRoot!, 'memory', 'facts.jsonl'))).toBe(false)
      expect(existsSync(join(second.workspaceOverlayRoot!, 'attachments', 'profile-a.txt'))).toBe(false)
      expect(existsSync(join(secondLayout.pluginsRoot, 'profile-a-plugin', 'marker.txt'))).toBe(false)
      expect(first.getSnapshot().skills.some(skill => skill.id.includes('private-skill'))).toBe(true)
      expect(second.getSnapshot().skills.some(skill => skill.id.includes('private-skill'))).toBe(false)
      expect(existsSync(firstLayout.projectsPath)).toBe(true)
      expect(existsSync(secondLayout.projectsPath)).toBe(true)
      expect(workspacePath).not.toBe(first.runtimeStoragePath)
    } finally {
      await Promise.all([first.destroy(), second.destroy()])
    }
  })

  it('releases runtime subscriptions across 100 alternating profile lifecycles', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-profile-switch-cycle-'))
    const workspacePath = join(root, 'workspace')
    mkdirSync(workspacePath)
    directories.push(root)
    const layouts = [
      createProfileStorageLayout(join(root, 'data'), join(root, 'device'), 'profile-a'),
      createProfileStorageLayout(join(root, 'data'), join(root, 'device'), 'profile-b'),
    ]
    const processListeners = {
      uncaughtException: process.listenerCount('uncaughtException'),
      unhandledRejection: process.listenerCount('unhandledRejection'),
    }

    for (let index = 0; index < 100; index += 1) {
      const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig(), profileStorage: layouts[index % 2] })
      runtime.subscribe(() => undefined)
      runtime.subscribe(() => undefined)
      runtime.getSnapshot()
      await runtime.destroy()
      const internals = runtime as unknown as { listeners: Set<unknown>; conversationRuntimes: Map<string, unknown>; destroyed: boolean }
      expect(internals.listeners.size).toBe(0)
      expect(internals.conversationRuntimes.size).toBe(0)
      expect(internals.destroyed).toBe(true)
    }

    expect(process.listenerCount('uncaughtException')).toBe(processListeners.uncaughtException)
    expect(process.listenerCount('unhandledRejection')).toBe(processListeners.unhandledRejection)
  })

  it('broadcasts ordered canonical envelopes with stable conversation identity', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })
    const conversationId = runtime.getSnapshot().conversation.id
    const events: WorkbenchEvent[] = []
    const unsubscribe = runtime.subscribe(event => events.push(event))

    try {
      const handleAgentEvent = (runtime as unknown as { handleAgentEvent(event: AgentEventType): void }).handleAgentEvent.bind(runtime)
      handleAgentEvent({ type: 'stream:start' })
      handleAgentEvent({ type: 'stream:thinking_delta', text: '先检查任务边界' })
      handleAgentEvent({
        type: 'tool:call',
        toolCall: { id: 'read-1', name: 'read_file', arguments: { path: 'README.md' } },
      })
      handleAgentEvent({
        type: 'tool:result',
        toolResult: { toolCallId: 'read-1', name: 'read_file', output: 'ok', isError: false },
      })
      handleAgentEvent({ type: 'stream:end' })

      const conversationEvents = events.filter((event): event is Extract<WorkbenchEvent, { type: 'conversation-event' }> => event.type === 'conversation-event')
      expect(conversationEvents.length).toBeGreaterThan(5)
      expect(conversationEvents[0]?.event.seq).toBe(1)
      expect(conversationEvents.every(event => event.conversationId === conversationId)).toBe(true)
      expect(conversationEvents.every(event => event.event.conversationId === conversationId && event.event.threadId === conversationId)).toBe(true)
      expect(conversationEvents.map(event => event.event.seq)).toEqual(
        [...conversationEvents].map(event => event.event.seq).sort((left, right) => left - right),
      )
      expect(new Set(conversationEvents.map(event => event.event.eventId)).size).toBe(conversationEvents.length)
      const toolEvents = conversationEvents.filter(event => event.event.itemId === 'read-1')
      expect(toolEvents.map(event => event.event.type)).toEqual(expect.arrayContaining([
        'tool.proposed',
        'tool.completed',
      ]))
      expect(new Set(toolEvents.map(event => event.event.runId))).toEqual(new Set([expect.any(String)]))
    } finally {
      unsubscribe()
      await runtime.destroy()
    }
  })

  it('keeps background flow envelopes attached to their originating conversation', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })
    const firstConversationId = runtime.getSnapshot().conversation.id
    const firstSlot = (runtime as unknown as {
      conversationRuntimes: Map<string, unknown>
    }).conversationRuntimes.get(firstConversationId)
    const second = await runtime.newConversation()
    const events: WorkbenchEvent[] = []
    const unsubscribe = runtime.subscribe(event => events.push(event))

    try {
      const handleAgentEvent = (runtime as unknown as {
        handleAgentEvent(slot: unknown, event: AgentEventType): void
      }).handleAgentEvent.bind(runtime)
      handleAgentEvent(firstSlot, { type: 'stream:start' })
      handleAgentEvent(firstSlot, { type: 'stream:thinking_delta', text: '后台继续分析' })

      const conversationEvents = events.filter((event): event is Extract<WorkbenchEvent, { type: 'conversation-event' }> => event.type === 'conversation-event')
      expect(conversationEvents.length).toBeGreaterThan(0)
      expect(conversationEvents.every(event => event.conversationId === firstConversationId)).toBe(true)
      expect(conversationEvents.every(event => event.event.threadId === firstConversationId)).toBe(true)
      expect(conversationEvents.every(event => event.conversationId !== second.id)).toBe(true)
      expect(events.filter(event => event.type === 'snapshot')).toHaveLength(0)
    } finally {
      unsubscribe()
      await runtime.destroy()
    }
  })

  it('does not attach a full workbench snapshot to high-frequency canonical updates', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })
    const events: WorkbenchEvent[] = []
    const unsubscribe = runtime.subscribe(event => events.push(event))

    try {
      const handleAgentEvent = (runtime as unknown as { handleAgentEvent(event: AgentEventType): void }).handleAgentEvent.bind(runtime)
      for (let index = 1; index <= 500; index += 1) {
        handleAgentEvent({
          type: 'stream:tool_call_delta',
          toolCallId: 'write-1',
          toolName: 'write_file',
          partialJson: 'x'.repeat(Math.min(index, 2_048)),
        })
      }

      expect(events.filter(event => event.type === 'conversation-event')).toHaveLength(500)
      expect(events.filter(event => event.type === 'snapshot')).toHaveLength(0)
      expect(events.filter(event => event.type === 'conversation-event').every(event => event.type === 'conversation-event' && event.event.type === 'tool.delta')).toBe(true)
    } finally {
      unsubscribe()
      await runtime.destroy()
    }
  })

  it('forwards every streamed tool delta through the canonical spine', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })
    const events: WorkbenchEvent[] = []
    const unsubscribe = runtime.subscribe(event => events.push(event))

    try {
      const handleAgentEvent = (runtime as unknown as { handleAgentEvent(event: AgentEventType): void }).handleAgentEvent.bind(runtime)
      handleAgentEvent({ type: 'stream:start' })
      handleAgentEvent({ type: 'stream:tool_call_delta', toolCallId: 'read-1', toolName: 'read_file', partialJson: '{"path"' })
      handleAgentEvent({ type: 'stream:tool_call_delta', toolCallId: 'read-1', toolName: 'read_file', partialJson: '{"path":"a"}' })
      handleAgentEvent({ type: 'stream:tool_call_delta', toolCallId: 'write-1', toolName: 'write_file', partialJson: '{"path":"b"}' })
      handleAgentEvent({ type: 'stream:end' })
      handleAgentEvent({ type: 'stream:start' })
      handleAgentEvent({ type: 'stream:tool_call_delta', toolCallId: 'read-1', toolName: 'read_file', partialJson: '{"path":"c"}' })

      const intents = events
        .filter((event): event is Extract<WorkbenchEvent, { type: 'conversation-event' }> => event.type === 'conversation-event')
        .map(event => event.event)
        .filter((event): event is Extract<typeof event, { type: 'tool.delta' }> => event.type === 'tool.delta')
      expect(intents.map(event => event.payload.toolCallId)).toEqual(['read-1', 'read-1', 'write-1', 'read-1'])
      expect(intents.map(event => event.payload.partialJson)).toEqual(['{"path"', '{"path":"a"}', '{"path":"b"}', '{"path":"c"}'])
    } finally {
      unsubscribe()
      await runtime.destroy()
    }
  })

  it('shares one runtime load across concurrent first access', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-load-race-'))
    directories.push(workspacePath)
    const seed = new WorkbenchRuntime({ workspacePath, config: createConfig() })
    const created = seed.getSnapshot().conversation
    seed.conversations.recordEvent({
      type: 'turn:start',
      turn: { id: 'load-race-user', role: 'user', content: 'persisted', timestamp: Date.now() },
    })
    seed.conversations.flushJournal()
    await seed.destroy()
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })
    const internals = runtime as unknown as {
      conversationRuntimes: Map<string, unknown>
      ensureConversationRuntime: (id: string) => Promise<unknown>
      createConversationRuntime: (...args: unknown[]) => unknown
    }
    const create = vi.spyOn(internals, 'createConversationRuntime')

    try {
      const [first, second] = await Promise.all([
        internals.ensureConversationRuntime(created.id),
        internals.ensureConversationRuntime(created.id),
      ])
      expect(first).toBe(second)
      expect(create).toHaveBeenCalledOnce()
      expect(internals.conversationRuntimes.get(created.id)).toBe(first)
    } finally {
      await runtime.destroy()
    }
  })

  it('cleans up a runtime when deletion races its pending load', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-load-delete-'))
    directories.push(workspacePath)
    const seed = new WorkbenchRuntime({ workspacePath, config: createConfig() })
    const id = seed.getSnapshot().conversation.id
    seed.conversations.recordEvent({
      type: 'turn:start',
      turn: { id: 'load-delete-user', role: 'user', content: 'persisted', timestamp: Date.now() },
    })
    seed.conversations.flushJournal()
    await seed.destroy()
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })
    const internals = runtime as unknown as {
      conversationRuntimes: Map<string, unknown>
      ensureConversationRuntime: (id: string) => Promise<unknown>
    }
    const originalLoad = ConversationManager.prototype.loadCurrentAsync
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(ConversationManager.prototype, 'loadCurrentAsync').mockImplementation(async function () {
      await gate
      return originalLoad.call(this)
    })

    try {
      const loading = internals.ensureConversationRuntime(id).catch(error => error)
      await new Promise<void>(resolve => setImmediate(resolve))
      const deleting = runtime.deleteConversation(id)
      release()
      await expect(deleting).resolves.toBe(true)
      await expect(loading).resolves.toMatchObject({ message: 'Conversation is being deleted' })
      expect(internals.conversationRuntimes.has(id)).toBe(false)
    } finally {
      await runtime.destroy()
    }
  })


  it.each([false, true])('holds concurrent callers until platform initialization settles (fails=%s)', async fails => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-load-platform-'))
    directories.push(workspacePath)
    const config = { ...createConfig(), apiKey: 'test', baseUrl: 'http://model.test', model: 'test-model' }
    const seed = new WorkbenchRuntime({ workspacePath, config })
    const id = seed.getSnapshot().conversation.id
    seed.conversations.recordEvent({
      type: 'turn:start', turn: { id: 'stored', role: 'user', content: 'saved', timestamp: 1 },
    })
    seed.conversations.flushJournal()
    await seed.destroy()
    const runtime = new WorkbenchRuntime({ workspacePath, config })
    type Slot = { runtime: { engine: import('@turboflux/agent-runtime/agentEngine').AgentEngine } }
    const internals = runtime as unknown as {
      platformInitialized: boolean
      conversationRuntimes: Map<string, Slot>
      ensureConversationRuntime(id: string): Promise<Slot>
      initializeConversationRuntime(slot: Slot): Promise<void>
      destroyConversationRuntime(slot: Slot): Promise<void>
    }
    internals.platformInitialized = true
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const initializing = new Promise<void>(resolve => { entered = resolve })
    const run = vi.fn(async () => [])
    const initialize = vi.spyOn(internals, 'initializeConversationRuntime').mockImplementation(async slot => {
      vi.spyOn(slot.runtime.engine, 'run').mockImplementation(run)
      entered()
      await gate
      if (fails) throw new Error('platform fixture failure')
    })
    const destroy = vi.spyOn(internals, 'destroyConversationRuntime')
    try {
      const first = internals.ensureConversationRuntime(id).then(value => ({ value }), error => ({ error }))
      const submitted = runtime.submitPromptToConversation(id, 'next').then(value => ({ value }), error => ({ error }))
      await initializing
      expect(internals.conversationRuntimes.has(id)).toBe(false)
      expect(initialize).toHaveBeenCalledOnce()
      expect(run).not.toHaveBeenCalled()
      release()
      if (fails) {
        await expect(first).resolves.toMatchObject({ error: expect.objectContaining({ message: 'platform fixture failure' }) })
        await expect(submitted).resolves.toMatchObject({ error: expect.objectContaining({ message: 'platform fixture failure' }) })
        expect(destroy).toHaveBeenCalledOnce()
        expect(internals.conversationRuntimes.has(id)).toBe(false)
        initialize.mockResolvedValue()
        await expect(internals.ensureConversationRuntime(id)).resolves.toBeDefined()
        expect(initialize).toHaveBeenCalledTimes(2)
      } else {
        await expect(first).resolves.toHaveProperty('value')
        await expect(submitted).resolves.toMatchObject({ value: { status: 'started' } })
        expect(run).toHaveBeenCalledOnce()
      }
    } finally {
      release()
      await runtime.destroy()
    }
  })

  it('waits for pending runtime loads during shutdown', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-load-destroy-'))
    directories.push(workspacePath)
    const seed = new WorkbenchRuntime({ workspacePath, config: createConfig() })
    const id = seed.getSnapshot().conversation.id
    seed.conversations.recordEvent({
      type: 'turn:start',
      turn: { id: 'load-destroy-user', role: 'user', content: 'persisted', timestamp: Date.now() },
    })
    seed.conversations.flushJournal()
    await seed.destroy()
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })
    const internals = runtime as unknown as {
      conversationRuntimes: Map<string, unknown>
      ensureConversationRuntime: (id: string) => Promise<unknown>
    }
    const originalLoad = ConversationManager.prototype.loadCurrentAsync
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(ConversationManager.prototype, 'loadCurrentAsync').mockImplementation(async function () {
      await gate
      return originalLoad.call(this)
    })

    const loading = internals.ensureConversationRuntime(id).catch(() => undefined)
    await new Promise<void>(resolve => setImmediate(resolve))
    const destroying = runtime.destroy()
    release()
    await expect(destroying).resolves.toBeUndefined()
    await loading
    expect(internals.conversationRuntimes.size).toBe(0)
  })

  it('deletes an inactive conversation while another task is running', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })

    try {
      const inactiveId = runtime.getSnapshot().conversation.id
      runtime.conversations.recordEvent({
        type: 'turn:start',
        turn: { id: 'inactive-user', role: 'user', content: 'Persist this conversation', timestamp: Date.now() },
      })
      runtime.conversations.flushJournal()
      await runtime.newConversation()
      vi.spyOn(runtime.runtime.engine, 'isRunning').mockReturnValue(true)

      await expect(runtime.deleteConversation(inactiveId)).resolves.toBe(true)
      await expect(runtime.deleteConversation(runtime.getSnapshot().conversation.id)).rejects.toThrow('Cannot delete the active conversation while the agent is running')
    } finally {
      await runtime.destroy()
    }
  })

  it.each(['unopened', 'opened'] as const)('persists sidebar rename and deletion for %s v2 history', async state => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-sidebar-history-'))
    directories.push(root)
    const workspacePath = join(root, 'workspace')
    const otherWorkspacePath = join(root, 'other')
    mkdirSync(workspacePath)
    mkdirSync(otherWorkspacePath)
    const layout = createProfileStorageLayout(join(root, 'data'), join(root, 'device'), 'profile-a')
    ensureProfileStorageLayout(layout)
    const bindings = new WorkspaceBindingService(layout)
    const binding = bindings.ensureBound(workspacePath, 'Workspace')
    const history: PersistedConversation = {
      id: 'sidebar-history', title: 'Original title', workspacePath,
      createdAt: 10, updatedAt: 20, mode: 'vibe', model: '', provider: 'custom', turnCount: 1,
      turns: [{ id: 'history-user', role: 'user', content: 'Keep this history', timestamp: 10 }],
    }
    new ConversationRuntimeRepositoryV2(layout.conversationsV2Root, layout.profileId, binding.id, workspacePath).persist(history)
    // Migrated history can retain a legacy copy; native history has only v2 data.
    if (state === 'unopened') saveConversation(history, {}, layout.conversationsRoot)
    const options = {
      workspacePath: state === 'opened' ? workspacePath : otherWorkspacePath,
      config: createConfig(), profileStorage: layout, connectMcp: false,
    }
    const runtime = new WorkbenchRuntime(options)
    const repository = new ConversationRepositoryV2(layout.conversationsV2Root)
    try {
      if (state === 'opened') await runtime.switchConversation(history.id)
      const activeId = runtime.getSnapshot().conversation.id
      await expect(runtime.renameConversation(history.id, 'Renamed history')).resolves.toBe(true)
      expect(runtime.getSnapshot().conversation.id).toBe(activeId)
      expect(runtime.getSnapshot().conversationCatalog.find(item => item.id === history.id)).toMatchObject({ title: 'Renamed history', titleSource: 'custom' })
      expect(repository.projection(history.id).conversation?.title).toBe('Renamed history')

      await expect(runtime.deleteConversation(history.id)).resolves.toBe(true)
      expect(runtime.getSnapshot().conversationCatalog.some(item => item.id === history.id)).toBe(false)
      expect(repository.projection(history.id).conversation?.status).toBe('archived')
    } finally {
      await runtime.destroy()
    }
    const restarted = new WorkbenchRuntime(options)
    try {
      expect(restarted.getSnapshot().conversationCatalog.some(item => item.id === history.id)).toBe(false)
      await expect(restarted.renameConversation(history.id, 'Should stay deleted')).resolves.toBe(false)
    } finally {
      await restarted.destroy()
    }
  })

  it('projects the shared core without exposing provider credentials', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })

    try {
      const snapshot = runtime.getSnapshot()
      expect(snapshot.workspace.path).toBe(workspacePath)
      expect(snapshot.runtime).toMatchObject({
        status: 'ready',
        configured: false,
        provider: 'custom',
        approvalPolicy: 'ask',
      })
      expect(snapshot.runtime).not.toHaveProperty('apiKey')
      expect(() => runtime.submitPrompt('hello')).toThrow('No API key is configured')
    } finally {
      await runtime.destroy()
    }
  })

  it('does not project a stale paused run state when the run controller is inactive', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })

    try {
      vi.spyOn(runtime.runtime.engine, 'getRunState').mockReturnValue({ phase: 'paused' } as ReturnType<typeof runtime.runtime.engine.getRunState>)

      expect(runtime.getSnapshot().runtime.status).toBe('ready')
      expect(runtime.resume()).toBe(false)
    } finally {
      await runtime.destroy()
    }
  })

  it('projects subagent evidence and lets Desktop stop one child independently', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })
    let release: (() => void) | undefined
    const started = runtime.runtime.subAgentTaskManager.startTask({
      kind: 'agent',
      agentType: 'explorer',
      label: 'Explorer',
      objective: 'Inspect the workbench boundary',
      workspacePath,
      run: ({ signal, recordEvent }) => new Promise<{ ok: boolean; finalText?: string; evidence: never[]; turns: number; elapsedMs: number; truncated: boolean; error?: string }>(resolve => {
        recordEvent({ type: 'turn_start', turn: 1, maxTurns: 4 })
        recordEvent({ type: 'evidence', evidence: { path: 'src/example.ts', startLine: 3, endLine: 8, preview: 'runtime boundary', content: 'RAW_SOURCE', reason: 'Shared runtime ownership' } })
        const finish = () => resolve({ ok: false, evidence: [], turns: 1, elapsedMs: 10, truncated: false, error: 'Stopped' })
        release = finish
        if (signal.aborted) finish()
        else signal.addEventListener('abort', finish, { once: true })
      }),
      isSuccess: result => result.ok,
      getError: result => result.error,
    })

    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      const snapshot = runtime.getSnapshot()
      expect(snapshot.activity.subagents).toEqual([expect.objectContaining({
        id: started.task.id,
        label: 'Explorer',
        transcriptCount: 3,
        lastEvent: expect.stringContaining('找到关键证据'),
      })])
      const detail = runtime.readSubAgent(started.task.id, 0, 50)
      expect(detail.timeline).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'evidence', evidence: expect.objectContaining({ path: 'src/example.ts' }) }),
      ]))
      expect(JSON.stringify(detail)).not.toContain('RAW_SOURCE')

      const stopped = await runtime.stopSubAgent(started.task.id)
      expect(stopped.taskId).toBe(started.task.id)
      await started.promise
      expect(runtime.getSnapshot().activity.subagents[0]).toMatchObject({ status: 'stopped', retryable: true })
    } finally {
      release?.()
      await runtime.destroy()
    }
  })

  it('exposes secure desktop settings with native model controls', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const config: TurboFluxConfig = {
      ...createConfig(),
      provider: 'openai',
      apiKey: 'top-secret-key',
      baseUrl: '',
      model: 'gpt-5.6',
      reasoning: { enabled: true, effort: 'high' },
      activeApiConfigId: 'main',
      apiConfigs: [{
        id: 'main',
        name: 'Main',
        provider: 'openai',
        apiKey: 'top-secret-key',
        baseUrl: '',
        model: 'gpt-5.6',
        contextWindow: 1_050_000,
        maxTokens: 16_384,
        reasoning: { enabled: true, effort: 'high' },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    }
    const runtime = new WorkbenchRuntime({ workspacePath, config })

    try {
      const settings = await runtime.getSettings()
      expect(settings.apiProfiles[0]).toMatchObject({ id: 'main', hasApiKey: true })
      expect(JSON.stringify(settings)).not.toContain('top-secret-key')
      expect(settings.models.find(model => model.model === 'gpt-5.6')?.reasoningCapabilities?.efforts).toContain('max')
    } finally {
      await runtime.destroy()
    }
  })

  it('projects built-in system plugins without adding editable MCP config', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: createConfig(),
      registerSystemPlugins: client => client.registerLocalServer({
        name: 'browser',
        tools: [{ name: 'observe', description: 'Observe', inputSchema: { type: 'object', properties: {} } }],
        handler: async () => ({ ok: true }),
      }),
    })

    try {
      const settings = await runtime.getSettings()
      expect(settings.mcpServers).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'browser', system: true, enabled: true, status: 'connected' }),
      ]))
      expect(runtime.runtime.mcpClient.searchTools('browser').map(tool => tool.name)).toEqual(['browser__observe'])
    } finally {
      await runtime.destroy()
    }
  })

  it.each([200, 401])('returns cached settings immediately and publishes background discovery updates (HTTP %i)', async status => {
    let finishRequest!: () => void
    const pendingRequest = new Promise<void>(resolve => { finishRequest = resolve })
    const fetchMock = vi.fn(async () => {
      await pendingRequest
      return new Response(JSON.stringify({
        data: [{
          id: 'network-model',
          context_length: 128_000,
          top_provider: { max_completion_tokens: 16_384 },
          capabilities: { tools: true, reasoning: true },
        }],
      }), { status, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        provider: 'custom',
        apiKey: 'test-key',
        baseUrl: 'https://background-discovery.example/v1',
        model: 'network-model',
      },
    })
    const events: WorkbenchEvent[] = []
    const unsubscribe = runtime.subscribe(event => events.push(event))

    try {
      const cached = await runtime.getSettings(false)
      expect(['cache', 'fallback']).toContain(cached.modelDiscovery.source)
      expect(cached.modelDiscovery.refreshing).toBe(true)
      expect((await runtime.getSettings(false)).modelDiscovery.refreshing).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      finishRequest()
      await vi.waitFor(() => {
        const update = events.find(event => event.type === 'settings-updated')
        expect(update?.settings.modelDiscovery).toMatchObject({
          source: status === 200 ? 'network' : expect.stringMatching(/^(cache|fallback)$/),
          refreshing: false,
          ...(status === 401 ? { error: expect.stringContaining('401') } : {}),
        })
        expect(update?.settings.models).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'network-model' })]))
      })
      expect((await runtime.getSettings(false)).modelDiscovery.refreshing).toBe(false)
    } finally {
      finishRequest()
      unsubscribe()
      await runtime.destroy()
    }
  })

  it('creates, reviews, edits, pins, filters, and forgets memories through the shared writer', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })

    try {
      const created = await runtime.rememberMemory({
        text: 'Keep the renderer free of runtime truth.',
        kind: 'rule',
        scope: 'workspace_private',
        confidence: 'asserted',
        tags: ['desktop', 'architecture'],
        pinned: true,
      })
      expect(created.items).toEqual([
        expect.objectContaining({
          text: 'Keep the renderer free of runtime truth.',
          kind: 'rule',
          pinned: true,
          reviewState: 'user_approved',
          status: 'active',
        }),
      ])
      const id = created.items[0]!.id

      const updated = await runtime.updateMemory(id, { text: 'Keep runtime truth in WorkbenchRuntime.', pinned: false })
      expect(updated.items[0]).toMatchObject({ text: 'Keep runtime truth in WorkbenchRuntime.', pinned: false, reviewState: 'user_edited' })
      await expect(runtime.listMemories({ query: 'WorkbenchRuntime' })).resolves.toMatchObject({ items: [expect.objectContaining({ id })] })

      const forgotten = await runtime.forgetMemory(id, 'superseded')
      expect(forgotten.items[0]).toMatchObject({ id, status: 'rejected' })
      await expect(runtime.listMemories()).resolves.toMatchObject({ items: [] })
    } finally {
      await runtime.destroy()
    }
  })

  it('keeps connected system capabilities exposed and treats composer selection as emphasis', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: { ...createConfig(), apiKey: 'test-key', model: 'test-model' },
      registerSystemPlugins: client => client.registerLocalServer({
        name: 'computer',
        tools: [{ name: 'observe', description: 'Observe the desktop', inputSchema: { type: 'object', properties: {} } }],
        handler: async () => ({ ok: true }),
      }),
    })
    let emphasized = false
    vi.spyOn(runtime.runtime.engine, 'run').mockImplementation(async (_prompt, options) => {
      emphasized = options?.capabilities?.items.some(item => item.type === 'mcp' && item.id === 'computer') === true
      return []
    })

    try {
      expect(runtime.runtime.mcpClient.getAllTools().map(tool => tool.name)).not.toContain('capabilities__request')
      expect(runtime.runtime.mcpClient.getAllTools().map(tool => tool.name)).toContain('computer__observe')
      runtime.submitPrompt('Prepare the native presentation', undefined, {
        items: [{ type: 'mcp', id: 'computer', name: '电脑操控' }],
      })
      await new Promise<void>(resolve => setImmediate(resolve))

      expect(emphasized).toBe(true)
      expect(runtime.runtime.mcpClient.getAllTools().map(tool => tool.name)).toContain('computer__observe')
    } finally {
      await runtime.destroy()
    }
  })

  it('does not auto-present a workflow when a design plugin is mounted', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: { ...createConfig(), apiKey: 'test-key', baseUrl: 'https://example.test', model: 'test-model' },
    })
    await runtime.initializePlatform()
    await runtime.setPluginEnabled('turboflux.design-atlas', true)
    const workflows: Array<import('@turboflux/contracts/workflowSurfaceTypes').WorkflowRunContract | undefined> = []
    const run = vi.spyOn(runtime.runtime.engine, 'run').mockImplementation(async (_prompt, options) => {
      workflows.push(options?.workflow)
      if (workflows.length === 2) {
        for (const [stage, response] of [
          ['research-gate', 'quick-exploration'],
          ['direction-count', '3'],
          ['direction-gallery', '02'],
        ] as const) {
          options?.onWorkflowProgress?.({
            instanceId: options.workflow?.instanceId,
            workflow: 'design-atlas',
            stage,
            status: 'resolved',
            response,
          })
        }
      }
      return []
    })
    const presentWorkflow = vi.spyOn(runtime.runtime.engine, 'requestWorkflowSurface')

    try {
      expect(runtime.submitPrompt('只回复收到，不要启动设计工作流。', undefined, {
        items: [{ type: 'skill', id: 'design-atlas', name: '设计探索总监' }],
      })).toMatchObject({ status: 'started' })
      await vi.waitFor(() => expect(run).toHaveBeenCalled())
      expect(workflows[0]).toMatchObject({
        pluginId: 'turboflux.design-atlas',
        pluginVersion: '1.3.2',
        skillId: 'design-atlas',
        workflow: 'design-atlas',
        stages: ['research-gate', 'direction-count', 'direction-gallery'],
        checkpoints: [{ stage: 'direction-count' }],
      })
      expect(presentWorkflow).not.toHaveBeenCalled()
      expect(runtime.getSnapshot().runtime.pendingRequests).toEqual([])
      await vi.waitFor(() => expect(runtime.getSnapshot().runtime.status).toBe('ready'))
      const firstInstanceId = workflows[0]?.instanceId
      expect(runtime.conversations.getInteractionState().workflow).toMatchObject({
        instanceId: firstInstanceId,
        status: 'active',
      })

      expect(runtime.submitPrompt('继续上一次设计探索')).toMatchObject({ status: 'started' })
      await vi.waitFor(() => expect(workflows).toHaveLength(2))
      expect(workflows[1]).toMatchObject({ instanceId: firstInstanceId, completedStages: [] })
      await vi.waitFor(() => expect(runtime.getSnapshot().runtime.status).toBe('ready'))
      expect(runtime.conversations.getInteractionState().workflow).toMatchObject({
        instanceId: firstInstanceId,
        status: 'completed',
        completedStages: ['research-gate', 'direction-count', 'direction-gallery'],
      })

      expect(runtime.submitPrompt('选择 02', undefined, {
        items: [{ type: 'skill', id: 'design-atlas', name: '设计探索总监' }],
      })).toMatchObject({ status: 'started' })
      await vi.waitFor(() => expect(workflows).toHaveLength(3))
      expect(workflows[2]).toBeUndefined()
    } finally {
      await runtime.destroy()
    }
  })

  it('keeps raw computer payloads inside the core runtime instead of IPC snapshots and events', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })
    const toolCall = {
      id: 'computer-call-1',
      name: 'computer__type_text',
      arguments: {
        text: 'PRIVATE_TYPED_TEXT',
        keys: 'PRIVATE_KEYS',
        x: 321.25,
        y: 654.75,
        pid: 424242,
        ref: 'ax-private-ref',
        observation_id: 'observation-private',
      },
    }
    const toolResult = {
      toolCallId: toolCall.id,
      name: toolCall.name,
      output: 'PRIVATE_AX_VALUE /private/tmp/computer-frame.png',
      isError: false,
      attachments: [{
        id: 'computer-frame-1',
        type: 'image' as const,
        path: '/private/tmp/computer-frame.png',
        mime: 'image/png',
        filename: 'computer-frame.png',
        size: 123,
      }],
    }
    runtime.runtime.engine.restoreFromTurns([
      { id: 'assistant-1', role: 'assistant', content: '', timestamp: 101, toolCalls: [toolCall] },
      {
        id: 'result-1',
        role: 'tool_result',
        content: `computer__type_text: [ok] ${toolResult.output}`,
        timestamp: 102,
        toolResults: [toolResult],
      },
    ])
    const events: WorkbenchEvent[] = []
    const unsubscribe = runtime.subscribe(event => events.push(event))

    try {
      const handleAgentEvent = (runtime as unknown as { handleAgentEvent(event: AgentEventType): void }).handleAgentEvent.bind(runtime)
      handleAgentEvent({ type: 'tool:call', toolCall })
      handleAgentEvent({ type: 'tool:result', toolResult })
      handleAgentEvent({
        type: 'stream:tool_call_delta',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        partialJson: JSON.stringify(toolCall.arguments),
      })

      const serialized = JSON.stringify({ snapshot: runtime.getSnapshot(), events })
      for (const sensitive of [
        'PRIVATE_TYPED_TEXT',
        'PRIVATE_KEYS',
        'PRIVATE_AX_VALUE',
        '/private/tmp/computer-frame.png',
        'observation-private',
        'ax-private-ref',
        '424242',
        '321.25',
        '654.75',
      ]) expect(serialized).not.toContain(sensitive)
      expect(runtime.getSnapshot().conversation.turns[0]?.toolCalls?.[0]?.arguments).toEqual({})
      expect(toolCall.arguments.text).toBe('PRIVATE_TYPED_TEXT')
      expect(toolResult.attachments[0]?.path).toBe('/private/tmp/computer-frame.png')
    } finally {
      unsubscribe()
      await runtime.destroy()
    }
  })

  it('keeps a built-in plugin authoritative over a same-name editable MCP entry', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    saveProjectMcpSettings(workspacePath, {
      mcpServers: { browser: { enabled: true, command: '/usr/bin/false' } },
    })
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: createConfig(),
      registerSystemPlugins: client => client.registerLocalServer({
        name: 'browser',
        tools: [{ name: 'observe', description: 'Observe', inputSchema: { type: 'object', properties: {} } }],
        handler: async () => ({ ok: true }),
      }),
    })

    try {
      const matches = (await runtime.getSettings()).mcpServers.filter(server => server.name === 'browser')
      expect(matches).toHaveLength(1)
      expect(matches[0]).toMatchObject({ system: true, enabled: true, status: 'connected' })
      expect(matches[0]?.command).toBeUndefined()
    } finally {
      await runtime.destroy()
    }
  })

  it('shares mode and conversation lifecycle with the agent runtime', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })

    try {
      expect(runtime.setMode('plan').runtime.mode).toBe('plan')
      const previousId = runtime.getSnapshot().conversation.id
      const next = await runtime.newConversation()
      expect(next.id).not.toBe(previousId)
      expect(next.snapshot.conversation.turns).toEqual([])
      expect(next.snapshot.runtime.mode).toBe('plan')
    } finally {
      await runtime.destroy()
    }
  })

  it('runs independent main agents in separate conversations', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        baseUrl: 'https://example.invalid',
        model: 'test-model',
      },
    })
    let finishFirst!: () => void
    let finishSecond!: () => void
    const firstRun = new Promise<[]>(resolve => { finishFirst = () => resolve([]) })
    const secondRun = new Promise<[]>(resolve => { finishSecond = () => resolve([]) })
    const lifecycleEvents: Array<{ conversationId: string; status: string }> = []
    runtime.subscribe(event => {
      if (event.type === 'conversation-run') lifecycleEvents.push(event)
    })

    try {
      const firstEngine = runtime.runtime.engine
      const firstConversationId = runtime.getSnapshot().conversation.id
      const firstRunSpy = vi.spyOn(firstEngine, 'run').mockReturnValue(firstRun)
      expect(runtime.submitPrompt('first task').status).toBe('started')

      const second = await runtime.newConversation()
      const secondEngine = runtime.runtime.engine
      const secondRunSpy = vi.spyOn(secondEngine, 'run').mockReturnValue(secondRun)
      expect(secondEngine).not.toBe(firstEngine)
      expect(runtime.submitPrompt('second task').status).toBe('started')

      expect(firstRunSpy).toHaveBeenCalledOnce()
      expect(secondRunSpy).toHaveBeenCalledOnce()
      const firstPause = vi.spyOn(firstEngine, 'pause').mockReturnValue(true)
      const secondPause = vi.spyOn(secondEngine, 'pause')
      const firstResume = vi.spyOn(firstEngine, 'resume').mockReturnValue(true)
      const secondResume = vi.spyOn(secondEngine, 'resume')
      const firstAbort = vi.spyOn(firstEngine, 'abort')
      const secondAbort = vi.spyOn(secondEngine, 'abort')
      vi.spyOn(firstEngine, 'isRunning').mockReturnValue(true)
      vi.spyOn(secondEngine, 'isRunning').mockReturnValue(true)
      expect(runtime.pauseConversation(firstConversationId)).toBe(true)
      expect(firstPause).toHaveBeenCalledOnce()
      expect(secondPause).not.toHaveBeenCalled()
      vi.spyOn(firstEngine, 'getRunState').mockReturnValue({ phase: 'paused' } as ReturnType<typeof firstEngine.getRunState>)
      expect(runtime.resumeConversation(firstConversationId)).toBe(true)
      expect(firstResume).toHaveBeenCalledOnce()
      expect(secondResume).not.toHaveBeenCalled()
      expect(runtime.stopConversation(firstConversationId)).toBe(true)
      expect(firstAbort).toHaveBeenCalledOnce()
      expect(secondAbort).not.toHaveBeenCalled()
      expect(second.snapshot.conversationRuntimes).toEqual(expect.arrayContaining([
        expect.objectContaining({ conversationId: expect.any(String) }),
        expect.objectContaining({ conversationId: second.id }),
      ]))
      finishFirst()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(runtime.getSnapshot().conversation.id).toBe(second.id)
      expect(lifecycleEvents).toContainEqual(expect.objectContaining({ conversationId: firstConversationId, status: 'completed' }))
    } finally {
      finishFirst()
      finishSecond()
      await new Promise(resolve => setTimeout(resolve, 0))
      await runtime.destroy()
    }
  })

  it('publishes partial task settlement without reporting false completion', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: { ...createConfig(), apiKey: 'test-key', model: 'test-model' },
    })
    const engine = runtime.runtime.engine
    const conversationId = runtime.getSnapshot().conversation.id
    let runId = ''
    vi.spyOn(engine, 'run').mockImplementation(async (_prompt, options) => {
      runId = options?.userTurnId || ''
      return [{
        id: 'partial-delivery',
        role: 'assistant',
        content: '已完成可交付部分，剩余事项已保留。',
        timestamp: Date.now(),
        metadata: { workRunId: runId },
      }]
    })
    vi.spyOn(engine, 'getWorkExecutionSnapshot').mockImplementation(() => ({
      schemaVersion: 1,
      currentRunId: null,
      runs: runId ? [{
        id: runId,
        conversationId,
        objective: '执行任务',
        presentation: 'work',
        status: 'partial',
        phase: 'partial',
        rootStepIds: [],
        steps: {},
        activities: {},
        startedAt: 1,
        updatedAt: 2,
        completedAt: 2,
      }] : [],
    }))
    const events: WorkbenchEvent[] = []
    runtime.subscribe(event => events.push(event))

    try {
      runtime.submitPrompt('执行任务')
      await new Promise<void>(resolve => setImmediate(resolve))

      expect(events).toContainEqual(expect.objectContaining({
        type: 'conversation-run',
        status: 'partial',
        resultSummary: '已完成可交付部分，剩余事项已保留。',
      }))
      expect(events).toContainEqual(expect.objectContaining({
        type: 'conversation-event',
        event: expect.objectContaining({ type: 'run.completed', payload: expect.objectContaining({ outcome: 'partial', run: expect.objectContaining({ status: 'partial' }) }) }),
      }))
    } finally {
      await runtime.destroy()
    }
  })

  it('exposes shared commands and preserves complete desktop drafts', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })

    try {
      expect(runtime.listCommands()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'mode.plan', slash: '/plan' }),
        expect.objectContaining({ id: 'context.compact', slash: '/compact' }),
        expect.objectContaining({ id: 'mcp.open', slash: '/mcp' }),
      ]))
      await expect(runtime.executeCommand('mode.plan')).resolves.toMatchObject({ snapshot: { runtime: { mode: 'plan' } } })

      runtime.recordDraft({
        text: 'continue later',
        attachments: [{ id: 'image-1', type: 'image', path: '/tmp/image.png', mime: 'image/png', filename: 'image.png', size: 12 }],
        files: [{ id: 'file-1', type: 'file', path: '/tmp/spec.pdf', mime: 'application/pdf', filename: 'spec.pdf', size: 34 }],
        pendingPastes: [{ placeholder: '【paste】', text: 'long text' }],
        capabilities: { items: [{ type: 'mcp', id: 'documents', name: 'Documents' }] },
      })
      expect(runtime.getSnapshot().draft).toMatchObject({
        text: 'continue later',
        attachments: [{ id: 'image-1' }],
        files: [{ id: 'file-1' }],
        pendingPastes: [{ placeholder: '【paste】', text: 'long text' }],
        capabilities: { items: [{ type: 'mcp', id: 'documents', name: 'Documents' }] },
      })
    } finally {
      await runtime.destroy()
    }
  })

  it('keeps a draft-selected Computer capability across consecutive submissions', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        model: 'test-model',
      },
      registerSystemPlugins: client => client.registerLocalServer({
        name: 'computer',
        requiresSelection: true,
        tools: [{ name: 'observe', description: 'Observe the desktop', inputSchema: { type: 'object', properties: {} } }],
        handler: async () => ({ ok: true }),
      }),
    })
    const capabilities = { items: [{ type: 'mcp' as const, id: 'computer', name: '电脑操控' }] }
    runtime.recordDraft({
      text: '',
      attachments: [],
      files: [],
      pendingPastes: [],
      capabilities,
    })
    const run = vi.spyOn(runtime.runtime.engine, 'run').mockResolvedValue()

    try {
      expect(runtime.submitPrompt('first native task')).toMatchObject({ status: 'started' })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(runtime.submitPrompt('continue the native task')).toMatchObject({ status: 'started' })
      await new Promise<void>(resolve => setImmediate(resolve))

      expect(run).toHaveBeenCalledTimes(2)
      expect(run.mock.calls.map(([, options]) => options?.capabilities)).toEqual([
        capabilities,
        capabilities,
      ])
      expect(runtime.getSnapshot().draft.capabilities).toEqual(capabilities)
    } finally {
      await runtime.destroy()
    }
  })

  it('steers only when an active run keeps the same capability selection', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        model: 'test-model',
      },
      registerSystemPlugins: client => {
        client.registerLocalServer({
          name: 'computer',
          requiresSelection: true,
          tools: [{ name: 'observe', description: 'Observe the desktop', inputSchema: { type: 'object', properties: {} } }],
          handler: async () => ({ ok: true }),
        })
        client.registerLocalServer({
          name: 'browser',
          tools: [{ name: 'observe', description: 'Observe a page', inputSchema: { type: 'object', properties: {} } }],
          handler: async () => ({ ok: true }),
        })
      },
    })
    const computer = { items: [{ type: 'mcp' as const, id: 'computer', name: '电脑操控' }] }
    const browser = { items: [{ type: 'mcp' as const, id: 'browser', name: '内置浏览器' }] }
    let releaseRun!: () => void
    const activeRun = new Promise<void>(resolve => {
      releaseRun = resolve
    })
    let running = false
    vi.spyOn(runtime.runtime.engine, 'isRunning').mockImplementation(() => running)
    vi.spyOn(runtime.runtime.engine, 'run').mockImplementation(async () => {
      running = true
      await activeRun
      running = false
      return []
    })
    const submitSteeringMessage = vi.spyOn(runtime.runtime.engine, 'submitSteeringMessage').mockReturnValue(true)

    try {
      expect(runtime.submitPrompt('start native task', undefined, computer)).toMatchObject({ status: 'started' })
      expect(runtime.submitPrompt('same native task guidance', undefined, computer)).toMatchObject({ status: 'steering' })

      const changed = runtime.submitPrompt('switch to browser work', undefined, browser)
      expect(changed).toMatchObject({ status: 'queued' })
      expect(submitSteeringMessage).toHaveBeenCalledTimes(1)
      expect(runtime.conversations.getInteractionState().queuedInputs).toEqual([
        expect.objectContaining({
          id: changed.inputId,
          prompt: 'switch to browser work',
          capabilities: browser,
        }),
      ])
    } finally {
      releaseRun()
      await new Promise<void>(resolve => setImmediate(resolve))
      await runtime.destroy()
    }
  })

  it('hands queued inputs directly to the next foreground run without overlap', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        model: 'test-model',
      },
    })
    const gates = new Map<string, () => void>()
    let activeRuns = 0
    let maximumActiveRuns = 0
    const handleAgentEvent = (runtime as unknown as {
      handleAgentEvent(event: AgentEventType): void
    }).handleAgentEvent.bind(runtime)
    const run = vi.spyOn(runtime.runtime.engine, 'run').mockImplementation(async (prompt, options) => {
      handleAgentEvent({
        type: 'turn:start',
        turn: {
          id: options?.userTurnId || `user-${prompt}`,
          role: 'user',
          content: prompt,
          timestamp: Date.now(),
          metadata: { workRunId: options?.userTurnId },
        },
      })
      activeRuns += 1
      maximumActiveRuns = Math.max(maximumActiveRuns, activeRuns)
      await new Promise<void>(resolve => gates.set(prompt, resolve))
      activeRuns -= 1
      return []
    })

    try {
      expect(runtime.submitPrompt('first task')).toMatchObject({ status: 'started' })
      const queued = runtime.submitPrompt('second task')
      expect(queued).toMatchObject({ status: 'queued' })
      expect(runtime.conversations.getInteractionState().queuedInputs).toEqual([
        expect.objectContaining({ id: queued.inputId, prompt: 'second task' }),
      ])

      gates.get('first task')?.()
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))

      expect(maximumActiveRuns).toBe(1)
      expect(run).toHaveBeenNthCalledWith(2, 'second task', expect.objectContaining({ userTurnId: queued.inputId }))
      expect(runtime.conversations.getInteractionState().queuedInputs).toEqual([])
    } finally {
      gates.get('first task')?.()
      gates.get('second task')?.()
      await new Promise<void>(resolve => setImmediate(resolve))
      await runtime.destroy()
    }
  })

  it('restores durable queued input and drains it after context compaction', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        model: 'test-model',
      },
    })
    const queuedInput = { id: 'queued-after-restart', prompt: 'continue after compaction' }
    runtime.conversations.recordQueueState([queuedInput])
    const slot = (runtime as unknown as {
      activeConversationRuntime: unknown
      restorePersistedQueue(slot: unknown): void
    }).activeConversationRuntime
    ;(runtime as unknown as { restorePersistedQueue(slot: unknown): void }).restorePersistedQueue(slot)
    const compactContext = vi.spyOn(runtime.runtime.engine, 'compactContext').mockResolvedValue(true)
    const handleAgentEvent = (runtime as unknown as {
      handleAgentEvent(event: AgentEventType): void
    }).handleAgentEvent.bind(runtime)
    const run = vi.spyOn(runtime.runtime.engine, 'run').mockImplementation(async (prompt, options) => {
      handleAgentEvent({
        type: 'turn:start',
        turn: {
          id: options?.userTurnId || 'restored-user',
          role: 'user',
          content: prompt,
          timestamp: Date.now(),
          metadata: { workRunId: options?.userTurnId },
        },
      })
      return []
    })

    try {
      expect(runtime.conversations.getInteractionState().queuedInputs).toEqual([queuedInput])
      await runtime.compactContext()
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())

      expect(compactContext).toHaveBeenCalledOnce()
      expect(run).toHaveBeenCalledWith('continue after compaction', expect.objectContaining({
        userTurnId: 'queued-after-restart',
      }))
      expect(runtime.conversations.getInteractionState().queuedInputs).toEqual([])
      expect(runtime.conversations.getInteractionState().queuedInputs).toEqual([])
    } finally {
      await new Promise<void>(resolve => setImmediate(resolve))
      await runtime.destroy()
    }
  })

  it('rejects an explicitly selected plugin when it is unavailable', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        model: 'test-model',
      },
    })
    const run = vi.spyOn(runtime.runtime.engine, 'run').mockResolvedValue()

    try {
      expect(() => runtime.submitPrompt('control the desktop', undefined, {
        items: [{ type: 'mcp', id: 'computer', name: '电脑操控' }],
      })).toThrow('电脑操控 已不在当前工作区，请从输入框重新选择')
      expect(() => runtime.submitPrompt('use the missing skill', undefined, {
        items: [{ type: 'skill', id: 'missing-skill', name: '已停用插件能力' }],
      })).toThrow('已停用插件能力 已不在当前工作区，请从输入框重新选择')
      expect(run).not.toHaveBeenCalled()
    } finally {
      await runtime.destroy()
    }
  })

  it('starts one fresh execution segment on first send and each edited resend', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-timing-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: { ...createConfig(), apiKey: 'test-key', baseUrl: 'https://example.test/v1', model: 'test-model', gitEnabled: false },
    })
    const engine = runtime.runtime.engine
    vi.spyOn(engine as any, 'prepareContextWindow').mockResolvedValue(undefined)
    const callModel = vi.spyOn(engine as any, 'callModel')
    const events: WorkbenchEvent[] = []
    const unsubscribe = runtime.subscribe(event => events.push(event))
    let inputId = ''

    try {
      for (const [index, mode] of (['task', 'task', 'chat'] as const).entries()) {
        const prompt = `Request ${index}`
        let answerStarted!: () => void
        const answering = new Promise<void>(resolve => { answerStarted = resolve })
        let finishAnswer!: () => void
        const answer = new Promise<void>(resolve => { finishAnswer = resolve })
        callModel.mockResolvedValueOnce({
          id: `mode-${index}`, role: 'assistant', content: '', timestamp: Date.now(),
          toolCalls: [{ id: `mode-call-${index}`, name: 'set_response_mode', arguments: { mode } }],
        }).mockImplementationOnce(async () => {
          answerStarted()
          await answer
          return { id: `answer-${index}`, role: 'assistant', content: `Answer ${index}`, timestamp: Date.now() }
        })
        const startedAt = Date.now()
        if (index === 0) inputId = runtime.submitPrompt(prompt).inputId
        else await runtime.resendFromTurn(inputId, prompt)
        await answering
        try {
          const run = engine.getWorkExecutionSnapshot().runs.at(-1)!
          expect(run.responseMode).toBe(mode)
          expect(run.status).toBe('running')
          expect(run.startedAt).toBeGreaterThanOrEqual(startedAt)
          expect(run.executionSegments).toEqual([{ startedAt: run.startedAt }])
          expect(run.recoveredFromPersistence).toBeUndefined()
        } finally {
          finishAnswer()
          await engine.waitUntilIdle()
          await new Promise<void>(resolve => setImmediate(resolve))
        }
        const snapshot = runtime.getSnapshot()
        expect(snapshot.activity.execution.runs).toHaveLength(1)
        expect(snapshot.activity.execution.runs[0].executionSegments).toHaveLength(1)
        expect(snapshot.conversation.turns.filter(turn => turn.role === 'user').map(turn => turn.content)).toEqual([prompt])
      }
      const taskSnapshots = events
        .filter((event): event is Extract<WorkbenchEvent, { type: 'snapshot' }> => event.type === 'snapshot')
        .flatMap(event => event.snapshot.activity.execution.runs)
        .filter(run => run.responseMode === 'task')
      expect(taskSnapshots.length).toBeGreaterThan(0)
      expect(taskSnapshots.every(run => run.executionSegments?.length === 1)).toBe(true)
    } finally {
      unsubscribe()
      await runtime.destroy()
    }
  })

  it('rewinds conversation history before resending an edited user message', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        baseUrl: 'https://example.test/v1',
        model: 'test-model',
      },
    })
    const attachment = { id: 'image-1', type: 'image' as const, path: '/tmp/image.png', mime: 'image/png', filename: 'image.png', size: 12 }
    runtime.runtime.engine.restoreFromTurns([
      { id: 'user-1', role: 'user', content: 'first question', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'first answer', timestamp: 2 },
      { id: 'user-2', role: 'user', content: 'old question', timestamp: 3, metadata: { attachments: [attachment] } },
      { id: 'assistant-2', role: 'assistant', content: 'old answer', timestamp: 4 },
    ])
    const run = vi.spyOn(runtime.runtime.engine, 'run').mockImplementation(async (prompt, options) => {
      runtime.runtime.engine.restoreFromTurns([
        { id: 'user-1', role: 'user', content: 'first question', timestamp: 1 },
        { id: 'assistant-1', role: 'assistant', content: 'first answer', timestamp: 2 },
        {
          id: options?.userTurnId || 'generated-user',
          role: 'user',
          content: prompt,
          timestamp: 5,
          metadata: { attachments: options?.attachments, workRunId: options?.userTurnId },
        },
      ])
      return []
    })

    try {
      await expect(runtime.resendFromTurn('user-2', 'edited question')).resolves.toEqual({ status: 'started', inputId: 'user-2' })
      expect(runtime.runtime.engine.getFullConversationTurns().filter(turn => turn.role !== 'system')).toEqual([
        expect.objectContaining({ id: 'user-1', content: 'first question' }),
        expect.objectContaining({ id: 'assistant-1', content: 'first answer' }),
        expect.objectContaining({ id: 'user-2', content: 'edited question' }),
      ])
      expect(run).toHaveBeenCalledWith('edited question', {
        attachments: [attachment],
        capabilities: undefined,
        reuseLastUserTurn: true,
        userTurnId: 'user-2',
      })
      await new Promise<void>(resolve => setImmediate(resolve))
    } finally {
      await runtime.destroy()
    }
  })

  it('does not emit a false idle state between history rewrite and the restarted run', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        baseUrl: 'https://example.test/v1',
        model: 'test-model',
        gitEnabled: false,
      },
    })
    runtime.runtime.engine.restoreFromTurns([
      { id: 'user-1', role: 'user', content: 'first question', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'first answer', timestamp: 2 },
      { id: 'user-2', role: 'user', content: 'old question', timestamp: 3 },
      { id: 'assistant-2', role: 'assistant', content: 'old answer', timestamp: 4 },
    ])
    const events: WorkbenchEvent[] = []
    const unsubscribe = runtime.subscribe(event => events.push(event))
    vi.spyOn(runtime.runtime.engine as any, 'initializeGit').mockResolvedValue(true)
    vi.spyOn(runtime.runtime.engine as any, 'prepareContextWindow').mockResolvedValue(undefined)
    vi.spyOn(runtime.runtime.engine as any, 'callModel').mockResolvedValue({
      id: 'assistant-edited',
      role: 'assistant',
      content: 'edited answer',
      timestamp: 5,
    })

    try {
      await expect(runtime.resendFromTurn('user-2', 'edited question')).resolves.toEqual({ status: 'started', inputId: 'user-2' })
      await runtime.runtime.engine.waitUntilIdle()
      await new Promise<void>(resolve => setImmediate(resolve))

      const conversationEvents = events
        .filter((event): event is Extract<WorkbenchEvent, { type: 'conversation-event' }> => event.type === 'conversation-event')
        .map(event => event.event)
      const phases = conversationEvents
        .filter(event => event.type === 'run.state_changed')
        .map(event => event.payload.state.phase)
      expect(phases[0]).toBe('thinking')
      expect(phases).not.toContain('idle')
      const completions = conversationEvents.filter(event => event.type === 'run.completed')
      expect(completions).toHaveLength(1)
      expect(completions[0].payload).toMatchObject({ outcome: 'completed', state: { phase: 'completed' } })
      const completionIndex = events.findIndex(event => event.type === 'conversation-event' && event.event.type === 'run.completed')
      const snapshotsAfterCompletion = events.slice(completionIndex + 1).filter(event => event.type === 'snapshot')
      expect(snapshotsAfterCompletion.length).toBeGreaterThan(0)
      expect(snapshotsAfterCompletion.every(event => event.snapshot.runtime.status === 'ready')).toBe(true)
      expect(runtime.getSnapshot().work.projection.nodes['input:user-2']).toMatchObject({
        content: 'edited question',
        status: 'completed',
      })
    } finally {
      unsubscribe()
      await runtime.destroy()
    }
  })

  it('fully stops an active run before rewinding and resending an edited message', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        baseUrl: 'https://example.test/v1',
        model: 'test-model',
      },
    })
    runtime.runtime.engine.restoreFromTurns([
      { id: 'user-1', role: 'user', content: 'first question', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'first answer', timestamp: 2 },
      { id: 'user-2', role: 'user', content: 'old task', timestamp: 3 },
      { id: 'assistant-2', role: 'assistant', content: 'old progress', timestamp: 4 },
    ])
    let stopActiveRun!: () => void
    const run = vi.spyOn(runtime.runtime.engine, 'run')
      .mockImplementationOnce(() => new Promise(resolve => { stopActiveRun = () => resolve([]) }))
      .mockImplementationOnce(async (prompt, options) => {
        runtime.runtime.engine.restoreFromTurns([
          { id: 'user-1', role: 'user', content: 'first question', timestamp: 1 },
          { id: 'assistant-1', role: 'assistant', content: 'first answer', timestamp: 2 },
          {
            id: options?.userTurnId || 'generated-user',
            role: 'user',
            content: prompt,
            timestamp: 5,
            metadata: { workRunId: options?.userTurnId },
          },
        ])
        return []
      })
    const abort = vi.spyOn(runtime.runtime.engine, 'abort').mockImplementation(() => stopActiveRun())

    try {
      runtime.submitPrompt('currently running')
      await new Promise<void>(resolve => setImmediate(resolve))
      await expect(runtime.resendFromTurn('user-2', 'edited task')).resolves.toEqual({ status: 'started', inputId: 'user-2' })

      expect(abort).toHaveBeenCalledTimes(1)
      expect(run).toHaveBeenNthCalledWith(2, 'edited task', {
        attachments: undefined,
        capabilities: undefined,
        reuseLastUserTurn: true,
        userTurnId: 'user-2',
      })
      expect(runtime.runtime.engine.getFullConversationTurns().filter(turn => turn.role !== 'system')).toEqual([
        expect.objectContaining({ id: 'user-1', content: 'first question' }),
        expect.objectContaining({ id: 'assistant-1', content: 'first answer' }),
        expect.objectContaining({ id: 'user-2', content: 'edited task' }),
      ])
      expect(runtime.getSnapshot().work.projection.nodes['input:user-2']).toMatchObject({
        content: 'edited task',
        status: 'completed',
      })
    } finally {
      await new Promise<void>(resolve => setImmediate(resolve))
      await runtime.destroy()
    }
  })

  it('restores the original branch when an edited message cannot launch', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        baseUrl: 'https://example.test/v1',
        model: 'test-model',
      },
    })
    const originalTurns = [
      { id: 'user-1', role: 'user' as const, content: 'first question', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant' as const, content: 'first answer', timestamp: 2 },
      { id: 'user-2', role: 'user' as const, content: 'old question', timestamp: 3 },
      { id: 'assistant-2', role: 'assistant' as const, content: 'old answer', timestamp: 4 },
    ]
    runtime.runtime.engine.restoreFromTurns(originalTurns)
    vi.spyOn(runtime as unknown as { startPrompt: (...args: unknown[]) => void }, 'startPrompt')
      .mockImplementation(() => { throw new Error('run launch failed') })

    try {
      await expect(runtime.resendFromTurn('user-2', 'edited question')).rejects.toThrow('run launch failed')
      expect(runtime.runtime.engine.getFullConversationTurns().filter(turn => turn.role !== 'system')).toEqual([
        expect.objectContaining({ id: 'user-1', content: 'first question' }),
        expect.objectContaining({ id: 'assistant-1', content: 'first answer' }),
        expect.objectContaining({ id: 'user-2', content: 'old question' }),
        expect.objectContaining({ id: 'assistant-2', content: 'old answer' }),
      ])
    } finally {
      await runtime.destroy()
    }
  })

  it('runs automations with their own approval policy and records completion', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: {
        ...createConfig(),
        apiKey: 'test-key',
        model: 'test-model',
      },
    })
    let releaseRun!: () => void
    const engineRun = vi.spyOn(Object.getPrototypeOf(runtime.runtime.engine), 'run').mockImplementation(() => new Promise(resolve => {
      releaseRun = () => resolve([])
    }))
    const automation = runtime.createAutomation({
      name: 'Review',
      prompt: 'Review the latest outputs',
      objective: { successCriteria: ['Record a review result'] },
      schedule: { kind: 'manual' },
      mode: 'continuation',
      approvalPolicy: 'agent',
      capabilityPolicy: { deniedTools: ['git_push'] },
    }).automations[0]

    try {
      const foregroundConversationId = runtime.getSnapshot().conversation.id
      const result = await runtime.runAutomation(automation.id)
      expect(result.status).toBe('started')
      expect(result.conversationId).not.toBe(foregroundConversationId)
      expect(runtime.getSnapshot().conversation.id).toBe(foregroundConversationId)
      const slots = (runtime as unknown as { conversationRuntimes: Map<string, { runtime: WorkbenchRuntime['runtime'] }> }).conversationRuntimes
      expect(slots.get(result.conversationId)?.runtime.engine.getApprovalPolicy()).toBe('agent')
      expect(slots.get(result.conversationId)?.runtime.engine.getDisabledTools()).toContain('git_push')
      expect(engineRun.mock.calls[0]?.[0]).toContain('<automation_objective>')
      expect(engineRun.mock.calls[0]?.[0]).toContain('Record a review result')
      expect(runtime.automations.get(automation.id)).toMatchObject({
        lastStatus: 'running',
        conversationId: result.conversationId,
        history: [expect.objectContaining({ inputId: result.inputId, conversationId: result.conversationId, status: 'running' })],
      })
      releaseRun()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(slots.get(result.conversationId)?.runtime.engine.getApprovalPolicy()).toBe('ask')
      expect(slots.get(result.conversationId)?.runtime.engine.getDisabledTools()).not.toContain('git_push')
      expect(runtime.automations.get(automation.id)).toMatchObject({
        lastStatus: 'completed',
        history: [expect.objectContaining({
          inputId: result.inputId,
          status: 'completed',
          result: expect.objectContaining({ outcome: 'success', successCriteria: [{ criterion: 'Record a review result', status: 'unknown' }] }),
        })],
      })
    } finally {
      releaseRun?.()
      await runtime.destroy()
    }
  })

  it('emits synchronous automation boundaries before and after tool effects', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-boundary-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })
    const automation = runtime.createAutomation({
      name: 'Checkpoint boundaries',
      prompt: 'Write the report safely',
      schedule: { kind: 'manual' },
    }).automations[0]!
    const claim = runtime.automations.claimManual(automation.id)
    const slot = await (runtime as unknown as {
      ensureAutomationConversation(input: AutomationClaim): Promise<{
        id: string
        activeAutomationRun: { automationId: string; runId: string } | null
      }>
    }).ensureAutomationConversation(claim)
    slot.activeAutomationRun = { automationId: automation.id, runId: claim.run.id }
    runtime.automations.markRunStatus(automation.id, claim.run.id, 'running', { conversationId: slot.id })
    const boundaries: AutomationRuntimeBoundary[] = []
    runtime.setAutomationRuntimeBoundaryHandler(boundary => boundaries.push(boundary))
    const reportPath = join(workspacePath, 'report.md')
    writeFileSync(reportPath, 'completed\n')
    const handle = (event: AgentEventType) => (runtime as unknown as {
      handleAgentEvent(target: unknown, input: AgentEventType): void
    }).handleAgentEvent(slot, event)

    try {
      handle({ type: 'tool:call', toolCall: { id: 'tool-write-1', name: 'write_file', arguments: { path: reportPath, content: 'completed\n' } } })
      const proposed = boundaries.find(boundary => boundary.kind === 'tool_proposed')
      expect(boundaries.find(boundary => boundary.kind === 'budget')).toMatchObject({ kind: 'budget', source: 'main', toolCalls: 1 })
      expect(proposed).toMatchObject({
        kind: 'tool_proposed',
        effect: {
          toolCallId: 'tool-write-1',
          classification: 'idempotent_write',
          targetSummary: reportPath,
          status: 'proposed',
        },
      })
      handle({
        type: 'tool:result',
        toolResult: {
          toolCallId: 'tool-write-1',
          name: 'write_file',
          output: 'saved',
          isError: false,
          changeSummary: { path: 'report.md', operation: 'write' },
        },
      })
      const completed = boundaries.find(boundary => boundary.kind === 'tool_completed')
      expect(completed).toMatchObject({
        kind: 'tool_completed',
        toolCallId: 'tool-write-1',
        outcome: 'completed',
        artifactIds: [expect.any(String)],
      })
      expect(completed!.canonicalEventSequence).toBeGreaterThan(proposed!.canonicalEventSequence)
      handle({
        type: 'subagent:progress',
        agentId: 'agent-1',
        agentType: 'worker',
        label: 'Worker',
        event: { type: 'tool_call', toolCallId: 'child-write-1', tool: 'write_file', args: { path: reportPath, content: 'child\n' }, turn: 1 },
      })
      const childProposed = boundaries.find(boundary => boundary.kind === 'tool_proposed' && boundary.effect.toolCallId === 'subagent:agent-1:child-write-1')
      expect(childProposed).toMatchObject({
        kind: 'tool_proposed',
        effect: { toolName: 'write_file', classification: 'idempotent_write', targetSummary: reportPath },
      })
      handle({
        type: 'subagent:progress',
        agentId: 'agent-1',
        agentType: 'worker',
        label: 'Worker',
        event: { type: 'tool_result', toolCallId: 'child-write-1', tool: 'write_file', ok: true, summary: 'saved', turn: 1 },
      })
      const childCompleted = boundaries.find(boundary => boundary.kind === 'tool_completed' && boundary.toolCallId === 'subagent:agent-1:child-write-1')
      expect(childCompleted).toMatchObject({ kind: 'tool_completed', toolName: 'write_file', outcome: 'completed' })
      expect(childCompleted!.canonicalEventSequence).toBeGreaterThan(childProposed!.canonicalEventSequence)
    } finally {
      runtime.setAutomationRuntimeBoundaryHandler(null)
      await runtime.destroy()
    }
  })

  it('runs dry tests with frozen ask approval and marks their result separately', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: { ...createConfig(), apiKey: 'test-key', model: 'test-model' },
    })
    vi.spyOn(Object.getPrototypeOf(runtime.runtime.engine), 'run').mockResolvedValue([{
      id: 'dry-run-result',
      role: 'assistant',
      content: 'Dry run completed.',
      timestamp: Date.now(),
    }])
    const automation = runtime.createAutomation({
      name: 'Dry test',
      prompt: 'Test the automation safely',
      schedule: { kind: 'manual' },
      approvalPolicy: 'full',
    }).automations[0]

    try {
      const started = await runtime.testAutomation(automation.id)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(runtime.automations.getRun(automation.id, started.automationRunId)).toMatchObject({
        dryRun: true,
        permissionSnapshot: { approvalPolicy: 'ask' },
        result: { outcome: 'success', summary: 'Dry run completed.' },
      })
    } finally {
      await runtime.destroy()
    }
  })

  it('keeps persisted activity time when restoring an automation conversation', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    const conversationsPath = mkdtempSync(join(tmpdir(), 'turboflux-conversations-'))
    directories.push(workspacePath, conversationsPath)
    const previousConversationsPath = process.env.TURBOFLUX_CONVERSATIONS_DIR
    process.env.TURBOFLUX_CONVERSATIONS_DIR = conversationsPath
    let now = Date.parse('2026-08-20T08:00:00.000Z')
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const firstRuntime = new WorkbenchRuntime({ workspacePath, config: createConfig() })

    try {
      const automation = firstRuntime.createAutomation({
        name: 'Persisted',
        prompt: 'Review persisted work',
        schedule: { kind: 'manual' },
        mode: 'continuation',
      }).automations[0]
      const firstClaim = (firstRuntime.automations as unknown as {
        claimManual(id: string): unknown
      }).claimManual(automation.id)
      const firstSlot = await (firstRuntime as unknown as {
        ensureAutomationConversation(claim: unknown): Promise<{
          id: string
          updatedAt: number
          conversations: WorkbenchRuntime['conversations']
        }>
      }).ensureAutomationConversation(firstClaim)
      firstSlot.conversations.recordEvent({
        type: 'turn:start',
        turn: { id: 'automation-user', role: 'user', content: 'Persist this run', timestamp: now },
      })
      firstSlot.conversations.persist(true)
      const persistedUpdatedAt = firstSlot.updatedAt
      await firstRuntime.destroy()

      now += 4 * 24 * 60 * 60 * 1_000
      const restoredRuntime = new WorkbenchRuntime({ workspacePath, config: createConfig() })
      try {
        const restoredAutomation = restoredRuntime.automations.list(workspacePath).automations[0]
        const restoredClaim = (restoredRuntime.automations as unknown as {
          claimManual(id: string): unknown
        }).claimManual(restoredAutomation.id)
        const restoredSlot = await (restoredRuntime as unknown as {
          ensureAutomationConversation(claim: unknown): Promise<{ id: string; updatedAt: number }>
        }).ensureAutomationConversation(restoredClaim)

        expect(restoredSlot.id).toBe(firstSlot.id)
        expect(restoredSlot.updatedAt).toBe(persistedUpdatedAt)
        expect(restoredSlot.updatedAt).not.toBe(now)
      } finally {
        await restoredRuntime.destroy()
      }
    } finally {
      await firstRuntime.destroy()
      if (previousConversationsPath === undefined) delete process.env.TURBOFLUX_CONVERSATIONS_DIR
      else process.env.TURBOFLUX_CONVERSATIONS_DIR = previousConversationsPath
    }
  })

  it('reuses an automation conversation and records a concise result summary', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: { ...createConfig(), apiKey: 'test-key', model: 'test-model' },
    })
    vi.spyOn(Object.getPrototypeOf(runtime.runtime.engine), 'run').mockResolvedValue([{
      id: 'automation-result',
      role: 'assistant',
      content: 'Automation finished successfully.\n\nThe report is ready.',
      timestamp: Date.now(),
    }])
    const completionEvents: WorkbenchEvent[] = []
    runtime.subscribe(event => {
      if (event.type === 'conversation-run') completionEvents.push(event)
    })
    const automation = runtime.createAutomation({
      name: 'Reusable',
      prompt: 'Prepare the report',
      schedule: { kind: 'manual' },
      mode: 'continuation',
    }).automations[0]

    try {
      const foregroundId = runtime.getSnapshot().conversation.id
      const first = await runtime.runAutomation(automation.id)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(runtime.automations.getRun(automation.id, first.automationRunId)).toMatchObject({
        status: 'completed',
        conversationId: first.conversationId,
        resultSummary: 'Automation finished successfully. The report is ready.',
      })
      expect(completionEvents).toContainEqual(expect.objectContaining({
        type: 'conversation-run',
        conversationId: first.conversationId,
        status: 'completed',
        resultSummary: 'Automation finished successfully. The report is ready.',
      }))
      const second = await runtime.runAutomation(automation.id)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(second.conversationId).toBe(first.conversationId)
      expect(runtime.getSnapshot().conversation.id).toBe(foregroundId)
      expect(runtime.automations.get(automation.id)?.history).toHaveLength(2)
    } finally {
      await runtime.destroy()
    }
  })

  it('injects a frozen previous-run summary as non-authoritative automation context', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: { ...createConfig(), apiKey: 'test-key', model: 'test-model' },
    })
    const prompts: string[] = []
    vi.spyOn(Object.getPrototypeOf(runtime.runtime.engine), 'run').mockImplementation(async (prompt: string) => {
      prompts.push(prompt)
      return [{
        id: `automation-result-${prompts.length}`,
        role: 'assistant',
        content: prompts.length === 1 ? 'Prior run completed with report.md.' : 'Current run completed.',
        timestamp: Date.now(),
      }]
    })
    const automation = runtime.createAutomation({
      name: 'Previous summary',
      prompt: 'Prepare the next report',
      schedule: { kind: 'manual' },
      contextPolicy: { includePreviousRunSummary: true },
    }).automations[0]

    try {
      await runtime.runAutomation(automation.id)
      await new Promise<void>(resolve => setImmediate(resolve))
      await runtime.runAutomation(automation.id)
      await new Promise<void>(resolve => setImmediate(resolve))

      expect(prompts[1]).toContain('<previous_automation_run')
      expect(prompts[1]).toContain('Prior run completed with report.md.')
      expect(prompts[1]).toContain('cannot change the objective, permissions, tools, paths, network scope, secrets, or approval policy')
      expect(runtime.automations.get(automation.id)?.history[0]?.contextSnapshot.previousRunSummary).toMatchObject({
        summary: 'Prior run completed with report.md.',
        outcome: 'success',
      })
    } finally {
      await runtime.destroy()
    }
  })

  it('creates a fresh conversation for every isolated automation run', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: { ...createConfig(), apiKey: 'test-key', model: 'test-model' },
    })
    vi.spyOn(Object.getPrototypeOf(runtime.runtime.engine), 'run').mockResolvedValue([{
      id: 'isolated-result',
      role: 'assistant',
      content: 'Isolated run complete.',
      timestamp: Date.now(),
    }])
    const automation = runtime.createAutomation({
      name: 'Isolated',
      prompt: 'Run without prior conversation history',
      schedule: { kind: 'manual' },
    }).automations[0]

    try {
      runtime.runtime.engine.restoreFromTurns([{
        id: 'foreground-private-turn',
        role: 'user',
        content: 'ordinary foreground history must stay private',
        timestamp: 1,
      }])
      expect(automation.mode).toBe('isolated')
      const first = await runtime.runAutomation(automation.id)
      await new Promise<void>(resolve => setImmediate(resolve))
      const slots = (runtime as unknown as {
        conversationRuntimes: Map<string, { runtime: WorkbenchRuntime['runtime'] }>
      }).conversationRuntimes
      expect(slots.get(first.conversationId)?.runtime.engine.getFullConversationTurns()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'foreground-private-turn' })]),
      )
      const second = await runtime.runAutomation(automation.id)
      await new Promise<void>(resolve => setImmediate(resolve))

      expect(second.conversationId).not.toBe(first.conversationId)
      const persisted = runtime.automations.get(automation.id)
      expect(persisted?.conversationId).toBeUndefined()
      expect(persisted?.history).toHaveLength(2)
      expect(persisted?.history.every(run => run.contextSnapshot.mode === 'isolated')).toBe(true)
      expect(persisted?.history.map(run => run.conversationId)).toEqual([second.conversationId, first.conversationId])
    } finally {
      await runtime.destroy()
    }
  })

  it('keeps isolated automation runs separate across a runtime restart', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    const conversationsPath = mkdtempSync(join(tmpdir(), 'turboflux-conversations-'))
    directories.push(workspacePath, conversationsPath)
    const previousConversationsPath = process.env.TURBOFLUX_CONVERSATIONS_DIR
    process.env.TURBOFLUX_CONVERSATIONS_DIR = conversationsPath
    const config = { ...createConfig(), apiKey: 'test-key', model: 'test-model' }
    const firstRuntime = new WorkbenchRuntime({ workspacePath, config })
    vi.spyOn(Object.getPrototypeOf(firstRuntime.runtime.engine), 'run').mockResolvedValue([{
      id: 'isolated-restart-result',
      role: 'assistant',
      content: 'Restart-safe isolated result.',
      timestamp: Date.now(),
    }])
    try {
      const automation = firstRuntime.createAutomation({
        name: 'Restart isolated',
        prompt: 'Remain isolated after restart',
        schedule: { kind: 'manual' },
      }).automations[0]
      const first = await firstRuntime.runAutomation(automation.id)
      await new Promise<void>(resolve => setImmediate(resolve))
      await firstRuntime.destroy()

      const restoredRuntime = new WorkbenchRuntime({ workspacePath, config })
      try {
        const restoredAutomation = restoredRuntime.automations.list(workspacePath).automations[0]!
        const second = await restoredRuntime.runAutomation(restoredAutomation.id)
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(restoredAutomation.mode).toBe('isolated')
        expect(second.conversationId).not.toBe(first.conversationId)
        expect(restoredRuntime.automations.get(restoredAutomation.id)?.conversationId).toBeUndefined()
      } finally {
        await restoredRuntime.destroy()
      }
    } finally {
      await firstRuntime.destroy()
      if (previousConversationsPath === undefined) delete process.env.TURBOFLUX_CONVERSATIONS_DIR
      else process.env.TURBOFLUX_CONVERSATIONS_DIR = previousConversationsPath
    }
  })

  it('restores a compacted continuation automation after a runtime restart', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    const conversationsPath = mkdtempSync(join(tmpdir(), 'turboflux-conversations-'))
    directories.push(workspacePath, conversationsPath)
    const previousConversationsPath = process.env.TURBOFLUX_CONVERSATIONS_DIR
    process.env.TURBOFLUX_CONVERSATIONS_DIR = conversationsPath
    const config = createConfig()
    const firstRuntime = new WorkbenchRuntime({ workspacePath, config })

    try {
      const automation = firstRuntime.createAutomation({
        name: 'Compacted continuation',
        prompt: 'Continue the long-running report',
        schedule: { kind: 'manual' },
        mode: 'continuation',
      }).automations[0]
      const firstClaim = (firstRuntime.automations as unknown as {
        claimManual(id: string): unknown
      }).claimManual(automation.id)
      const firstSlot = await (firstRuntime as unknown as {
        ensureAutomationConversation(claim: unknown): Promise<{
          id: string
          runtime: WorkbenchRuntime['runtime']
          conversations: WorkbenchRuntime['conversations']
        }>
      }).ensureAutomationConversation(firstClaim)
      const originalTurns = Array.from({ length: 16 }, (_, index) => ({
        id: `continuation-turn-${index}`,
        role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: index === 0 ? 'Preserve the original report objective.' : `Continuation evidence ${index}`,
        timestamp: index + 1,
      }))
      firstSlot.runtime.engine.restoreFromTurns(originalTurns)
      await firstSlot.runtime.engine.compactContext()
      firstSlot.conversations.persist(true)
      const compactedSegment = firstSlot.runtime.engine.getContextSegments()[0]!

      expect(compactedSegment.summary).toContain('<continuation_summary>')
      expect(firstSlot.runtime.engine.getFullConversationTurns()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'continuation-turn-0' })]),
      )
      await firstRuntime.destroy()

      const restoredRuntime = new WorkbenchRuntime({ workspacePath, config })
      try {
        const restoredAutomation = restoredRuntime.automations.list(workspacePath).automations[0]!
        const restoredClaim = (restoredRuntime.automations as unknown as {
          claimManual(id: string): unknown
        }).claimManual(restoredAutomation.id)
        const restoredSlot = await (restoredRuntime as unknown as {
          ensureAutomationConversation(claim: unknown): Promise<{
            id: string
            runtime: WorkbenchRuntime['runtime']
          }>
        }).ensureAutomationConversation(restoredClaim)

        expect(restoredAutomation.mode).toBe('continuation')
        expect(restoredSlot.id).toBe(firstSlot.id)
        expect(restoredSlot.runtime.engine.getContextSegments()).toEqual([
          expect.objectContaining({
            startMessageId: compactedSegment.startMessageId,
            endMessageId: compactedSegment.endMessageId,
            summary: compactedSegment.summary,
            handoff: expect.objectContaining({ compactDocument: expect.any(String) }),
          }),
        ])
        expect(restoredSlot.runtime.engine.getFullConversationTurns()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: 'continuation-turn-0', content: 'Preserve the original report objective.' }),
            expect.objectContaining({ id: 'continuation-turn-15' }),
          ]),
        )
      } finally {
        await restoredRuntime.destroy()
      }
    } finally {
      await firstRuntime.destroy()
      if (previousConversationsPath === undefined) delete process.env.TURBOFLUX_CONVERSATIONS_DIR
      else process.env.TURBOFLUX_CONVERSATIONS_DIR = previousConversationsPath
    }
  })

  it('cancels a background automation without overwriting its terminal state', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: { ...createConfig(), apiKey: 'test-key', model: 'test-model' },
    })
    let releaseRun!: () => void
    vi.spyOn(Object.getPrototypeOf(runtime.runtime.engine), 'run').mockImplementation(() => new Promise(resolve => {
      releaseRun = () => resolve([])
    }))
    const automation = runtime.createAutomation({
      name: 'Cancelable',
      prompt: 'Wait for cancellation',
      schedule: { kind: 'manual' },
    }).automations[0]

    try {
      const started = await runtime.runAutomation(automation.id)
      await runtime.cancelAutomationRun(automation.id)
      expect(runtime.automations.getRun(automation.id, started.automationRunId)).toMatchObject({ status: 'canceled' })
      expect((runtime as unknown as { automationRunTimers: Map<string, unknown> }).automationRunTimers.size).toBe(0)
      releaseRun()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(runtime.automations.getRun(automation.id, started.automationRunId)).toMatchObject({ status: 'canceled' })
    } finally {
      releaseRun?.()
      await runtime.destroy()
    }
  })

  it('does not overwrite an explicit host-exit interruption during asynchronous shutdown', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(workspacePath)
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config: { ...createConfig(), apiKey: 'test-key', model: 'test-model' },
    })
    let releaseRun!: () => void
    vi.spyOn(Object.getPrototypeOf(runtime.runtime.engine), 'run').mockImplementation(() => new Promise(resolve => {
      releaseRun = () => resolve([])
    }))
    const automation = runtime.createAutomation({
      name: 'Host exit recovery',
      prompt: 'Wait for graceful shutdown',
      schedule: { kind: 'manual' },
      retryPolicy: { maxRetries: 2, backoffMinutes: 1 },
    }).automations[0]!

    try {
      const started = await runtime.runAutomation(automation.id)
      runtime.automations.markRunStatus(automation.id, started.automationRunId, 'interrupted', {
        error: 'Host exited after saving a checkpoint.',
        suppressRetry: true,
      })
      releaseRun()
      await new Promise<void>(resolve => setImmediate(resolve))

      expect(runtime.automations.getRun(automation.id, started.automationRunId)).toMatchObject({
        status: 'interrupted',
        retryAt: undefined,
        error: 'Host exited after saving a checkpoint.',
      })
    } finally {
      releaseRun?.()
      await runtime.destroy()
    }
  })
})
