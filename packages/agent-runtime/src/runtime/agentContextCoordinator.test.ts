import { describe, expect, it, vi } from 'vitest'
import { ModelSurface } from '@turboflux/models/modelSurface'
import { DefaultAgentStateProvider } from './stateProvider'
import { AgentContextCoordinator } from './agentContextCoordinator'
import type { AgentTurn } from '@turboflux/contracts/agentTypes'

function createCoordinator() {
  const provider = new DefaultAgentStateProvider({
    provider: 'custom',
    apiKey: 'test',
    baseUrl: 'http://example.test',
    model: 'test-model',
    contextWindow: 100_000,
    maxTokens: 4096,
  }, process.cwd())
  return { provider, coordinator: new AgentContextCoordinator(provider) }
}

describe('AgentContextCoordinator', () => {
  it('preserves the wire prefix and full tool evidence when a follow-up fits the context window', () => {
    const { coordinator } = createCoordinator()
    const surface = new ModelSurface()
    const evidence = 'verified source line\n'.repeat(400)
    const turns: AgentTurn[] = [
      { id: 'u1', role: 'user', content: 'inspect source', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '', timestamp: 2, toolCalls: [{ id: 'read-1', name: 'read_file', arguments: { path: 'a.ts' } }] },
      { id: 'r1', role: 'tool_result', content: '', timestamp: 3, toolResults: [{ toolCallId: 'read-1', name: 'read_file', output: evidence, isError: false }] },
      { id: 'a2', role: 'assistant', content: 'The evidence is available.', timestamp: 4 },
    ]
    const options = { modelSurface: surface, candidateTurns: turns, workExecutionContext: '', supportsVision: false }
    const first = coordinator.prepareModelSurface(options)
    const before = coordinator.manager.buildMessages(first.turns, 'stable instructions', 100_000, 'openai', 4096)
    const next = coordinator.prepareModelSurface({
      ...options,
      candidateTurns: [...turns, { id: 'u2', role: 'user', content: 'explain the evidence', timestamp: 5 }],
    })
    const after = coordinator.manager.buildMessages(next.turns, 'stable instructions', 100_000, 'openai', 4096)

    expect(next.turns[2]?.toolResults?.[0]?.output).toBe(evidence)
    expect(after.slice(0, before.length)).toEqual(before)
    expect(surface.getState().generation).toBe(first.state.generation)
  })

  it('owns compaction activity and clones persisted state at the boundary', () => {
    const { coordinator } = createCoordinator()
    coordinator.setCompactionState({ phase: 'interrupted', startedAt: 1, updatedAt: 2, recoverable: true })

    const state = coordinator.getCompactionState()!
    state.phase = 'completed'

    expect(coordinator.getCompactionState()).toMatchObject({ phase: 'interrupted', recoverable: true })
    expect(coordinator.forceContextCompactionBeforeNextCall).toBe(true)
    expect(coordinator.isCompacting()).toBe(false)

    coordinator.setCompactionState({ phase: 'summarizing', startedAt: 3, updatedAt: 4 })
    expect(coordinator.isCompacting()).toBe(true)
  })

  it('owns segments, reservoir, preserved files, and preparation counters', () => {
    const { coordinator } = createCoordinator()
    coordinator.setSegments([{ id: 'segment-1', summary: 'summary', startMessageId: 'a', endMessageId: 'b', createdAt: 1 }])
    coordinator.setReservoir([{ id: 'entry-1', startMessageId: 'a', endMessageId: 'b', turns: [], source: 'compact', originalCharCount: 0 }])
    coordinator.preservedFiles = [{ path: 'README.md', content: 'content' }]
    coordinator.compressionPreparedTurnCount = 4

    expect(coordinator.getSegments()).toHaveLength(1)
    expect(coordinator.getReservoir()).toHaveLength(1)
    expect(coordinator.preservedFiles).toEqual([{ path: 'README.md', content: 'content' }])
    expect(coordinator.compressionPreparedTurnCount).toBe(4)
  })

  it('aborts compaction resources and retains ownership until cancellation settles', async () => {
    vi.useFakeTimers()
    const { coordinator } = createCoordinator()
    const controller = new AbortController()
    coordinator.contextCompactionAbortController = controller
    coordinator.contextCompactionHeartbeat = setInterval(() => undefined, 1_000)
    let release!: (value: boolean) => void
    const pending = coordinator.runCompaction(() => new Promise<boolean>(resolve => { release = resolve }))

    coordinator.destroy()

    expect(controller.signal.aborted).toBe(true)
    expect(coordinator.contextCompactionAbortController).toBeNull()
    expect(coordinator.contextCompactionHeartbeat).toBeNull()
    expect(coordinator.contextCompactionPromise).not.toBeNull()
    release(false)
    await pending
    expect(coordinator.contextCompactionPromise).toBeNull()
    vi.useRealTimers()
  })

  it('captures recent read results and owns bounded reservoir insertion', () => {
    const { coordinator } = createCoordinator()
    const turns = [
      {
        id: 'assistant-1',
        role: 'assistant' as const,
        content: '',
        timestamp: 1,
        toolCalls: [{ id: 'read-1', name: 'read_file', arguments: { path: 'README.md' } }],
      },
      {
        id: 'result-1',
        role: 'tool_result' as const,
        content: 'ok',
        timestamp: 2,
        toolResults: [{ toolCallId: 'read-1', name: 'read_file', output: 'project', isError: false }],
      },
    ]

    expect(coordinator.collectPreservedFiles(turns)).toEqual([{ path: 'README.md', content: 'project' }])
    coordinator.addReservoirEntry('assistant-1', 'result-1', turns, 'compact', turn => turn.content.length)
    expect(coordinator.getReservoir()).toEqual([
      expect.objectContaining({
        id: 'reservoir-assistant-1-result-1',
        startMessageId: 'assistant-1',
        endMessageId: 'result-1',
      }),
    ])
  })

  it('appends independent skill snapshots and clears deactivated skills', () => {
    const { coordinator } = createCoordinator()
    const surface = new ModelSurface()
    const baseOptions = {
      modelSurface: surface,
      candidateTurns: [],
      workExecutionContext: '',
      supportsVision: false,
    }

    coordinator.prepareModelSurface({
      ...baseOptions,
      activatedSkills: [
        { id: 'office', content: '<office-skill />' },
        { id: 'slides', content: '<slides-skill />' },
      ],
    })
    coordinator.prepareModelSurface({
      ...baseOptions,
      activatedSkills: [{ id: 'slides', content: '<slides-skill />' }],
    })

    const skillEvents = surface.getState().events.filter(event => (
      event.kind === 'snapshot' && event.source.startsWith('activated_skill:')
    ))
    expect(skillEvents).toMatchObject([
      { source: 'activated_skill:office', revision: 1, cleared: false },
      { source: 'activated_skill:slides', revision: 1, cleared: false },
      { source: 'activated_skill:office', revision: 2, cleared: true },
    ])
    expect(surface.projectTurns().at(-1)?.content).toContain('state="cleared"')
  })
})
