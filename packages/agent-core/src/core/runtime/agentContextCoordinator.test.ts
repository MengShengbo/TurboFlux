import { describe, expect, it, vi } from 'vitest'
import { ModelSurface } from '../modelSurface'
import { DefaultAgentStateProvider } from './stateProvider'
import { AgentContextCoordinator } from './agentContextCoordinator'

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

  it('aborts compaction resources and clears transient ownership on destroy', () => {
    vi.useFakeTimers()
    const { coordinator } = createCoordinator()
    const controller = new AbortController()
    coordinator.contextCompactionAbortController = controller
    coordinator.contextCompactionHeartbeat = setInterval(() => undefined, 1_000)
    coordinator.contextCompactionPromise = Promise.resolve(true)

    coordinator.destroy()

    expect(controller.signal.aborted).toBe(true)
    expect(coordinator.contextCompactionAbortController).toBeNull()
    expect(coordinator.contextCompactionHeartbeat).toBeNull()
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
