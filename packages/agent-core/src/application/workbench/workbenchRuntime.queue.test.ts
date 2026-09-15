import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEventType } from '../../core/agentEngine'
import type { TurboFluxConfig } from '../../core/config'
import type { ConversationQueuedInput } from '../conversations/types'
import { loadConversation } from '../conversations/store'
import { WorkbenchRuntime } from './workbenchRuntime'

const directories: string[] = []
const runtimes: WorkbenchRuntime[] = []
const releasePendingRuns: Array<() => void> = []
let previousConversationsDirectory: string | undefined

function createConfig(configured = true): TurboFluxConfig {
  return {
    provider: 'custom',
    apiKey: configured ? 'test-key' : '',
    baseUrl: configured ? 'https://example.test/v1' : '',
    model: configured ? 'test-model' : '',
    contextWindow: 200_000,
    maxTokens: 16_384,
    approvalPolicy: 'ask',
    capabilityProfile: 'workspace-write',
    gitEnabled: true,
    apiConfigs: [],
  }
}

function createWorkspace(): string {
  const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-queue-'))
  directories.push(workspacePath)
  process.env.TURBOFLUX_CONVERSATIONS_DIR = join(workspacePath, 'conversations')
  return workspacePath
}

function createRuntime(workspacePath: string, configured = true): WorkbenchRuntime {
  const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig(configured) })
  runtimes.push(runtime)
  return runtime
}

function handleUserTurn(runtime: WorkbenchRuntime, prompt: string, inputId: string | undefined): void {
  const handleAgentEvent = (runtime as unknown as {
    handleAgentEvent(event: AgentEventType): void
  }).handleAgentEvent.bind(runtime)
  handleAgentEvent({
    type: 'turn:start',
    turn: {
      id: inputId || `user-${prompt}`,
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
      metadata: { workRunId: inputId },
    },
  })
}

function activeRun(runtime: WorkbenchRuntime): Promise<void> | null {
  return (runtime as unknown as {
    activeConversationRuntime: { activeRun: Promise<void> | null }
  }).activeConversationRuntime.activeRun
}

beforeEach(() => {
  previousConversationsDirectory = process.env.TURBOFLUX_CONVERSATIONS_DIR
})

afterEach(async () => {
  for (const release of releasePendingRuns.splice(0)) release()
  for (const runtime of runtimes.splice(0)) await runtime.destroy()
  vi.restoreAllMocks()
  if (previousConversationsDirectory === undefined) delete process.env.TURBOFLUX_CONVERSATIONS_DIR
  else process.env.TURBOFLUX_CONVERSATIONS_DIR = previousConversationsDirectory
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('WorkbenchRuntime durable queue and resend recovery', () => {
  it('keeps a pre-commit failed head queued and retries it before later submissions', async () => {
    const runtime = createRuntime(createWorkspace())
    let releaseForeground = () => {}
    let releaseHeadRetry = () => {}
    releasePendingRuns.push(() => releaseForeground(), () => releaseHeadRetry())
    let headAttempts = 0
    const run = vi.spyOn(runtime.runtime.engine, 'run').mockImplementation(async (prompt, options) => {
      if (prompt === 'foreground') {
        handleUserTurn(runtime, prompt, options?.userTurnId)
        await new Promise<void>(resolve => { releaseForeground = resolve })
        return []
      }
      if (prompt === 'queued head') {
        headAttempts += 1
        if (headAttempts === 1) throw new Error('head failed before turn:start')
        handleUserTurn(runtime, prompt, options?.userTurnId)
        await new Promise<void>(resolve => { releaseHeadRetry = resolve })
        return []
      }
      if (prompt === 'queued tail') {
        handleUserTurn(runtime, prompt, options?.userTurnId)
        return []
      }
      throw new Error(`Unexpected prompt: ${prompt}`)
    })

    expect(runtime.submitPrompt('foreground')).toMatchObject({ status: 'started' })
    const head = runtime.submitPrompt('queued head')
    expect(head).toMatchObject({ status: 'queued' })

    releaseForeground()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(activeRun(runtime)).toBeNull())
    expect(runtime.conversations.getInteractionState().queuedInputs).toEqual([
      expect.objectContaining({ id: head.inputId, prompt: 'queued head' }),
    ])
    expect(runtime.conversations.getInteractionState().queuedInputs).toEqual([
      expect.objectContaining({ id: head.inputId, prompt: 'queued head' }),
    ])

    const tail = runtime.submitPrompt('queued tail')
    expect(tail).toMatchObject({ status: 'queued' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3))
    expect(run.mock.calls.map(([prompt]) => prompt)).toEqual([
      'foreground',
      'queued head',
      'queued head',
    ])
    expect(runtime.conversations.getInteractionState().queuedInputs).toEqual([
      expect.objectContaining({ id: tail.inputId, prompt: 'queued tail' }),
    ])
    expect(runtime.conversations.getInteractionState().queuedInputs).toEqual([
      expect.objectContaining({ id: tail.inputId, prompt: 'queued tail' }),
    ])

    releaseHeadRetry()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(4))
    await vi.waitFor(() => expect(activeRun(runtime)).toBeNull())
    expect(run.mock.calls.map(([prompt]) => prompt)).toEqual([
      'foreground',
      'queued head',
      'queued head',
      'queued tail',
    ])
    expect(runtime.conversations.getInteractionState().queuedInputs).toEqual([])
    expect(runtime.conversations.getInteractionState().queuedInputs).toEqual([])
  })

  it('restores a durable queue from a previous runtime instance', async () => {
    const workspacePath = createWorkspace()
    const firstRuntime = createRuntime(workspacePath, false)
    const conversationId = firstRuntime.getSnapshot().conversation.id
    const queuedInput: ConversationQueuedInput = {
      id: 'restart-queued-input',
      prompt: 'resume after restart',
    }

    expect(firstRuntime.conversations.recordQueueState([queuedInput])).toBe(true)
    firstRuntime.conversations.persist(true)
    expect(loadConversation(conversationId)?.interactionState?.queuedInputs).toEqual([queuedInput])
    await firstRuntime.destroy()

    const secondRuntime = createRuntime(workspacePath, false)
    await secondRuntime.switchConversation(conversationId)

    expect(secondRuntime.getSnapshot().conversation.id).toBe(conversationId)
    expect(secondRuntime.conversations.getInteractionState().queuedInputs).toEqual([queuedInput])
    expect(secondRuntime.conversations.getInteractionState().queuedInputs).toEqual([queuedInput])
  })

  it('drains a restored queue even when context compaction fails', async () => {
    const runtime = createRuntime(createWorkspace())
    const queuedInput: ConversationQueuedInput = {
      id: 'queued-after-failed-compaction',
      prompt: 'continue despite compaction failure',
    }
    expect(runtime.conversations.recordQueueState([queuedInput])).toBe(true)
    const slot = (runtime as unknown as {
      activeConversationRuntime: unknown
      restorePersistedQueue(slot: unknown): void
    }).activeConversationRuntime
    ;(runtime as unknown as { restorePersistedQueue(slot: unknown): void }).restorePersistedQueue(slot)
    vi.spyOn(runtime.runtime.engine, 'compactContext').mockRejectedValue(new Error('compaction failed'))
    const run = vi.spyOn(runtime.runtime.engine, 'run').mockImplementation(async (prompt, options) => {
      handleUserTurn(runtime, prompt, options?.userTurnId)
      return []
    })

    await expect(runtime.compactContext()).rejects.toThrow('compaction failed')
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(activeRun(runtime)).toBeNull())
    expect(run).toHaveBeenCalledWith(queuedInput.prompt, expect.objectContaining({
      userTurnId: queuedInput.id,
    }))
    expect(runtime.conversations.getInteractionState().queuedInputs).toEqual([])
    expect(runtime.conversations.getInteractionState().queuedInputs).toEqual([])
  })

  it('commits an edited branch before launch and keeps it after async launch failure', async () => {
    const runtime = createRuntime(createWorkspace())
    const originalTurns = [
      { id: 'user-1', role: 'user' as const, content: 'first question', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant' as const, content: 'first answer', timestamp: 2 },
      { id: 'user-2', role: 'user' as const, content: 'old question', timestamp: 3 },
      { id: 'assistant-2', role: 'assistant' as const, content: 'old answer', timestamp: 4 },
    ]
    runtime.runtime.engine.restoreFromTurns(originalTurns)
    const conversationId = runtime.conversations.getCurrentId()
    const order: string[] = []
    let persistedAtLaunch: ReturnType<typeof loadConversation>
    const originalRewrite = runtime.conversations.rewriteCurrentSnapshot.bind(runtime.conversations)
    const rewrite = vi.spyOn(runtime.conversations, 'rewriteCurrentSnapshot').mockImplementation(() => {
      order.push('rewrite')
      originalRewrite()
    })
    const run = vi.spyOn(runtime.runtime.engine, 'run').mockImplementation(async () => {
      order.push('run')
      persistedAtLaunch = loadConversation(conversationId)
      throw new Error('provider startup failed')
    })

    await expect(runtime.resendFromTurn('user-2', 'edited question')).resolves.toEqual({
      status: 'started',
      inputId: 'user-2',
    })
    await vi.waitFor(() => expect(activeRun(runtime)).toBeNull())

    expect(order.slice(0, 2)).toEqual(['rewrite', 'run'])
    expect(rewrite).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith('edited question', {
      attachments: undefined,
      capabilities: undefined,
      reuseLastUserTurn: true,
      userTurnId: 'user-2',
    })
    expect(persistedAtLaunch?.turns.filter(turn => turn.role !== 'system')).toEqual([
      expect.objectContaining({ id: 'user-1', content: 'first question' }),
      expect.objectContaining({ id: 'assistant-1', content: 'first answer' }),
      expect.objectContaining({ id: 'user-2', content: 'edited question' }),
    ])
    expect(runtime.runtime.engine.getFullConversationTurns().filter(turn => turn.role !== 'system')).toEqual([
      expect.objectContaining({ id: 'user-1', content: 'first question' }),
      expect.objectContaining({ id: 'assistant-1', content: 'first answer' }),
      expect.objectContaining({ id: 'user-2', content: 'edited question' }),
    ])
    expect(loadConversation(conversationId)?.turns.filter(turn => turn.role !== 'system')).toEqual([
      expect.objectContaining({ id: 'user-1', content: 'first question' }),
      expect.objectContaining({ id: 'assistant-1', content: 'first answer' }),
      expect.objectContaining({ id: 'user-2', content: 'edited question' }),
    ])
  })

  it('compact-persists failed and stopped runs without duplicating successful persistence', async () => {
    const runtime = createRuntime(createWorkspace())
    const persist = vi.spyOn(runtime.conversations, 'persist')
    const run = vi.spyOn(runtime.runtime.engine, 'run')

    run.mockResolvedValueOnce([])
    expect(runtime.submitPrompt('successful run')).toMatchObject({ status: 'started' })
    await vi.waitFor(() => expect(activeRun(runtime)).toBeNull())
    expect(persist).not.toHaveBeenCalled()

    run.mockRejectedValueOnce(new Error('failed run'))
    expect(runtime.submitPrompt('failed run')).toMatchObject({ status: 'started' })
    await vi.waitFor(() => expect(activeRun(runtime)).toBeNull())
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenLastCalledWith(true)
    persist.mockClear()

    let rejectStoppedRun: (error: Error & { aborted?: boolean }) => void = () => {}
    let engineRunning = false
    vi.spyOn(runtime.runtime.engine, 'isRunning').mockImplementation(() => engineRunning)
    vi.spyOn(runtime.runtime.engine, 'abort').mockImplementation(() => {
      engineRunning = false
      const error = Object.assign(new Error('run aborted'), { aborted: true })
      rejectStoppedRun(error)
    })
    run.mockImplementationOnce(() => {
      engineRunning = true
      return new Promise((_, reject) => { rejectStoppedRun = reject })
    })

    expect(runtime.submitPrompt('stopped run')).toMatchObject({ status: 'started' })
    expect(runtime.stop()).toBe(true)
    await vi.waitFor(() => expect(activeRun(runtime)).toBeNull())
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenLastCalledWith(true)
  })
})
