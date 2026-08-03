import { describe, expect, it, vi } from 'vitest'
import { AgentFlowController } from './agentFlowController'

describe('AgentFlowController', () => {
  it('projects a complete approved tool run without invariant violations', () => {
    const bridge = new AgentFlowController('thread-1')
    bridge.handle({ type: 'run:state', state: { phase: 'thinking', updatedAt: 1 } })
    bridge.handle({ type: 'turn:start', turn: { id: 'turn-1', role: 'user', content: 'edit', timestamp: 2 } })
    bridge.handle({ type: 'tool:call', toolCall: { id: 'tool-1', name: 'write_file', arguments: { path: 'a.ts' } } })
    bridge.handle({ type: 'approval:state', requestId: 'tool-1', requestKind: 'permission', state: 'requested', question: 'Allow?', toolName: 'write_file' })
    bridge.handle({ type: 'ask:user', requestId: 'tool-1', question: 'Allow?', toolName: 'write_file' })
    bridge.presentApproval('tool-1')
    bridge.handle({ type: 'approval:state', requestId: 'tool-1', requestKind: 'permission', state: 'resolved', decision: 'allow-once', question: 'Allow?', toolName: 'write_file' })
    bridge.handle({ type: 'tool:result', toolResult: { toolCallId: 'tool-1', name: 'write_file', output: 'ok', isError: false } })
    bridge.handle({ type: 'stream:start' })
    bridge.handle({ type: 'stream:delta', text: 'done' })
    bridge.handle({ type: 'stream:end' })
    bridge.handle({ type: 'session:complete', session: { id: 'thread-1', mode: 'vibe', turns: [], currentTaskId: null, createdAt: 1, updatedAt: 2, totalTokens: { input: 0, output: 0 } } })

    const state = bridge.store.getThread('thread-1')!
    expect(state.run).toMatchObject({ phase: 'terminal', outcome: 'succeeded' })
    expect(state.approvals['tool-1']).toMatchObject({ status: 'resolved', decision: 'allow-once' })
    expect(state.tools['tool-1']).toMatchObject({ status: 'completed' })
    expect(state.streams.answer).toMatchObject({ status: 'ended', tail: 'done' })
    expect(state.violations).toEqual([])
  })

  it('keeps a terminal run stable when completed state arrives after session completion', () => {
    const bridge = new AgentFlowController('thread-1')
    bridge.startRun('finish request')

    bridge.handle({ type: 'session:complete', session: { id: 'thread-1', mode: 'vibe', turns: [], currentTaskId: null, createdAt: 1, updatedAt: 2, totalTokens: { input: 0, output: 0 } } })
    bridge.handle({ type: 'run:state', state: { phase: 'completed', detail: 'Run completed', updatedAt: 3 } })

    const state = bridge.store.getThread('thread-1')!
    expect(state.run).toMatchObject({
      phase: 'terminal',
      outcome: 'succeeded',
      agentState: { phase: 'completed' },
    })
    expect(state.violations).toEqual([])
  })

  it('owns queued input order and attachment payloads', () => {
    const bridge = new AgentFlowController('thread-1')
    bridge.enqueueInput({
      id: 'queue-1',
      prompt: 'next',
      attachments: [{ id: 'image1', type: 'image', path: 'a.png', mime: 'image/png', filename: 'a.png', size: 10 }],
    })

    expect(bridge.getQueuedInputs()).toEqual([expect.objectContaining({
      id: 'queue-1',
      prompt: 'next',
      attachments: [expect.objectContaining({ id: 'image1', path: 'a.png' })],
    })])
  })

  it('keeps queued work runnable after a failed foreground run', () => {
    const bridge = new AgentFlowController('thread-1')
    bridge.startRun('first')
    bridge.enqueueInput({ id: 'queue-1', prompt: 'second' })
    bridge.enqueueInput({ id: 'queue-2', prompt: 'third' })

    bridge.handle({ type: 'error', error: 'first run failed' })

    expect(bridge.isForegroundBusy()).toBe(false)
    expect(bridge.takeNextQueuedInput()).toMatchObject({ id: 'queue-1', prompt: 'second' })
    expect(bridge.getQueuedInputs()).toEqual([expect.objectContaining({ id: 'queue-2' })])
    expect(bridge.store.getThread('thread-1')?.run).toMatchObject({
      phase: 'terminal',
      outcome: 'failed',
      error: 'first run failed',
    })
    expect(bridge.store.getThread('thread-1')?.violations).toEqual([])
  })

  it('uses detailed engine phases as the authoritative run state', () => {
    const bridge = new AgentFlowController('thread-1')
    bridge.startRun('inspect project')
    bridge.handle({
      type: 'run:state',
      state: {
        phase: 'tool_running',
        activeTool: 'list_directory',
        detail: 'Inspecting workspace',
        startedAt: 10,
        updatedAt: 20,
      },
    })

    expect(bridge.store.getThread('thread-1')?.run).toMatchObject({
      phase: 'active',
      objective: 'inspect project',
      agentState: {
        phase: 'tool_running',
        activeTool: 'list_directory',
        detail: 'Inspecting workspace',
      },
    })
  })

  it('samples each stream once instead of updating Flow state for every token', () => {
    const bridge = new AgentFlowController('thread-1')
    bridge.handle({ type: 'stream:start' })

    const first = bridge.handle({ type: 'stream:delta', text: 'first' })
    const second = bridge.handle({ type: 'stream:delta', text: 'second' })

    expect(first.map(event => event.type)).toEqual(['stream.delta'])
    expect(second).toEqual([])
    expect(bridge.store.getThread('thread-1')?.streams.answer.tail).toBe('first')
  })

  it('owns mode, usage, task, and tool draft state', () => {
    const bridge = new AgentFlowController('thread-1')
    bridge.startRun('build feature')
    bridge.handle({ type: 'mode:change', from: 'vibe', to: 'plan' })
    bridge.handle({ type: 'stream:usage', usage: { input: 120, output: 30, total: 150, source: 'provider' } })
    bridge.handle({
      type: 'active:task',
      context: {
        taskId: 'task-1',
        title: 'Build feature',
        priority: 'major',
        progress: 40,
        toolCalls: [{ toolCallId: 'tool-1', toolName: 'write_file', status: 'running' }],
        startedAt: 10,
      },
    })
    bridge.handle({
      type: 'stream:tool_call_delta',
      toolCallId: 'tool-1',
      toolName: 'write_file',
      partialJson: '{"path":"src/app.ts"',
    })
    const state = bridge.store.getThread('thread-1')!
    expect(state.mode).toBe('plan')
    expect(state.tokenUsage).toMatchObject({ input: 120, output: 30, source: 'provider' })
    expect(state.activeTask).toMatchObject({ taskId: 'task-1', progress: 40 })
    expect(state.toolDraft).toMatchObject({ id: 'tool-1', name: 'write_file' })
    expect(state.violations).toEqual([])
  })

  it('promotes a dequeued input to a committed turn without cancelling it', () => {
    const bridge = new AgentFlowController('thread-1')
    bridge.syncQueue([{ id: 'queue-1', prompt: 'next' }])
    bridge.syncQueue([])
    bridge.handle({ type: 'turn:start', turn: { id: 'queue-1', role: 'user', content: 'next', timestamp: 2 } })

    const state = bridge.store.getThread('thread-1')!
    expect(state.inputs['queue-1']).toMatchObject({ intent: 'queued-turn', status: 'committed', text: '', attachments: [] })
    expect(state.inputQueue).toEqual([])
    expect(state.violations).toEqual([])
  })

  it('isolates state after switching threads', () => {
    const bridge = new AgentFlowController('thread-1')
    bridge.syncQueue([{ id: 'queue-1', prompt: 'first' }])
    bridge.activateThread('thread-2')

    expect(bridge.store.getThread('thread-1')?.inputQueue).toEqual(['queue-1'])
    expect(bridge.store.getThread('thread-2')?.inputQueue).toEqual([])
  })

  it('resets event sequencing when a thread was evicted from the flow history', () => {
    const bridge = new AgentFlowController('thread-1')
    for (let index = 2; index <= 9; index += 1) bridge.activateThread(`thread-${index}`)

    bridge.activateThread('thread-1')
    bridge.handle({ type: 'run:state', state: { phase: 'thinking', updatedAt: 10 } })

    expect(bridge.store.getThread('thread-1')?.violations).toEqual([])
  })

  it('projects journal degradation and recovery into visible Flow state', () => {
    const bridge = new AgentFlowController('thread-1')
    bridge.setPersistenceStatus(new Error('disk unavailable'))
    expect(bridge.store.getThread('thread-1')?.persistence).toMatchObject({
      phase: 'degraded',
      error: 'disk unavailable',
    })

    bridge.setPersistenceStatus(null)
    expect(bridge.store.getThread('thread-1')?.persistence).toMatchObject({ phase: 'clean' })
  })

  it('projects subagents and terminal sessions as background runtime facts', () => {
    const bridge = new AgentFlowController('thread-1')
    bridge.handle({
      type: 'subagent:start',
      agentId: 'agent-1',
      agentType: 'reviewer',
      label: 'Reviewing changes',
      objective: 'Review the patch',
    })
    bridge.handle({
      type: 'terminal:sessions',
      sessions: [{
        id: 'term-1',
        pid: 123,
        shell: 'pwsh',
        shellId: 'pwsh',
        shellLabel: 'PowerShell',
        cwd: 'C:\\workspace',
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
        isAgentSession: true,
        title: 'npm test',
      }],
    })

    expect(Object.values(bridge.store.getThread('thread-1')!.runtimes).filter(item => item.status === 'running')).toHaveLength(2)

    bridge.handle({ type: 'subagent:end', agentId: 'agent-1', agentType: 'reviewer', ok: true, elapsedMs: 10 })
    bridge.handle({
      type: 'runtime-task:finished',
      task: {
        id: 'task-1',
        kind: 'terminal',
        status: 'completed',
        command: 'npm test',
        createdAt: 1,
        startedAt: 1,
        updatedAt: 2,
        endedAt: 2,
        metadata: { sessionId: 'term-1' },
      },
    })

    expect(Object.values(bridge.store.getThread('thread-1')!.runtimes).filter(item => item.status === 'running')).toHaveLength(0)
    expect(bridge.store.getThread('thread-1')!.violations).toEqual([])
  })

  it('keeps same-timestamp notifications as distinct items', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const bridge = new AgentFlowController('thread-1')
      bridge.handle({ type: 'notification', message: 'first', level: 'info' })
      bridge.handle({ type: 'notification', message: 'second', level: 'info' })

      expect(Object.keys(bridge.store.getThread('thread-1')!.notifications)).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds terminal Flow history while retaining live queue and runtime items', () => {
    const bridge = new AgentFlowController('thread-1')
    for (let index = 0; index < 180; index += 1) {
      bridge.handle({
        type: 'turn:start',
        turn: { id: `input-${index}`, role: 'user', content: `prompt ${index}`, timestamp: index },
      })
      bridge.handle({
        type: 'runtime-task:finished',
        task: {
          id: `runtime-${index}`,
          kind: 'shell',
          status: 'completed',
          startedAt: index,
          updatedAt: index + 1,
          endedAt: index + 1,
          interactive: false,
          restartPolicy: 'never',
        },
      })
    }

    const state = bridge.store.getThread('thread-1')!
    expect(Object.keys(state.inputs).length).toBeLessThanOrEqual(129)
    expect(Object.keys(state.runtimes).length).toBeLessThanOrEqual(128)
  })
})
