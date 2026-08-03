import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentTurn, ToolCall, ToolResult } from '../shared/agentTypes'
import type { ToolExecutor } from '../tools/executor'
import type { McpClient } from './mcp/client'
import { AgentEngine, appendRuntimeContextToLatestUserMessage, countTurnContextChars, downgradeReasoningEffort, extractResponsesReasoningEventDelta, extractResponsesReasoningSummary, normalizeAnthropicToolMessages, splitTurnsForCompaction, type AgentEventType } from './agentEngine'
import { NodeToolExecutor } from './runtime/nodeToolExecutor'
import { DefaultAgentStateProvider } from './runtime/stateProvider'

describe('appendRuntimeContextToLatestUserMessage', () => {
  it('does not create a synthetic user turn after tool results', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'build the app' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc1' }] },
      { role: 'tool', tool_call_id: 'tc1', content: 'done' },
    ]

    const appended = appendRuntimeContextToLatestUserMessage(messages, '<runtime_context>internal</runtime_context>', 'openai')

    expect(appended).toBe(true)
    expect(messages).toHaveLength(4)
    expect(messages[1]?.content).toContain('build the app')
    expect(messages[1]?.content).toContain('<runtime_context>internal</runtime_context>')
    expect(messages.at(-1)).toMatchObject({ role: 'tool' })
  })

  it('appends to anthropic user content blocks', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: 'system' },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]

    const appended = appendRuntimeContextToLatestUserMessage(messages, '<runtime_context>internal</runtime_context>', 'anthropic')

    expect(appended).toBe(true)
    expect(messages).toHaveLength(3)
    expect(messages[1]?.content).toEqual([
      { type: 'text', text: 'continue' },
      { type: 'text', text: '<runtime_context>internal</runtime_context>' },
    ])
  })
})

describe('reasoning effort compatibility', () => {
  it('downgrades chat, responses, and Anthropic effort fields independently', () => {
    const chat = { reasoning_effort: 'max' }
    const responses = { reasoning: { effort: 'xhigh' } }
    const anthropic = { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }

    expect(downgradeReasoningEffort(chat)).toEqual({ from: 'max', to: 'xhigh' })
    expect(chat).toEqual({ reasoning_effort: 'xhigh' })
    expect(downgradeReasoningEffort(responses)).toEqual({ from: 'xhigh', to: 'high' })
    expect(responses).toEqual({ reasoning: { effort: 'high' } })
    expect(downgradeReasoningEffort(anthropic)).toEqual({ from: 'high', to: 'medium' })
    expect(anthropic).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } })
  })
})

describe('Responses reasoning summaries', () => {
  it('extracts completed summary blocks from Responses output', () => {
    expect(extractResponsesReasoningSummary([
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Inspecting the failure path.' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'Done.' }] },
    ])).toBe('Inspecting the failure path.')
  })

  it.each([
    'response.reasoning_summary_text.delta',
    'response.reasoning_text.delta',
    'response.reasoning.delta',
    'response.reasoning_summary.delta',
    'response.thinking.delta',
    'response.analysis.delta',
  ])('accepts streaming reasoning event variant %s', type => {
    expect(extractResponsesReasoningEventDelta({ type, delta: 'Inspecting now.' })).toBe('Inspecting now.')
  })

  it('accepts object-shaped reasoning deltas without classifying answer text', () => {
    expect(extractResponsesReasoningEventDelta({ type: 'response.reasoning.delta', delta: { text: 'Next step.' } })).toBe('Next step.')
    expect(extractResponsesReasoningEventDelta({ type: 'response.output_text.delta', delta: 'Visible answer.' })).toBe('')
  })
})

describe('normalizeAnthropicToolMessages', () => {
  it('combines matching results and synthesizes missing results immediately after tool use', () => {
    const messages = normalizeAnthropicToolMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'tc1', name: 'read_file', input: { path: 'a.ts' } },
          { type: 'tool_use', id: 'tc2', name: 'read_file', input: { path: 'b.ts' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'a' }] },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ])

    expect(messages).toHaveLength(3)
    expect(messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tc1', content: 'a' },
        {
          type: 'tool_result',
          tool_use_id: 'tc2',
          content: 'Cancelled before the tool completed.',
          is_error: true,
        },
        { type: 'text', text: 'continue' },
      ],
    })
  })

  it('drops orphan and duplicate tool results', () => {
    const messages = normalizeAnthropicToolMessages([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'bad' }, { type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tc1', name: 'read_file', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'first' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'duplicate' }] },
    ])

    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'hello' }] })
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'first' }],
    })
  })
})

describe('AgentEngine MCP dispatch', () => {
  it('executes connected MCP tools instead of rejecting them as unknown', async () => {
    const workspace = process.cwd()
    const runtimeConfig = {
      provider: 'custom' as const,
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }
    const stateProvider = new DefaultAgentStateProvider(runtimeConfig, workspace)
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      temperature: 0,
      maxTokens: 4096,
      maxTurns: 2,
      workspacePath: workspace,
    }, new NodeToolExecutor(workspace), stateProvider)
    const callTool = vi.fn(async () => ({ content: 'mcp result', isError: false }))
    engine.setMcpClient({
      getAllTools: () => [{
        name: 'files__replace',
        serverName: 'files',
        description: 'replace',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        annotations: { readOnlyHint: false, destructiveHint: true },
      }],
      searchTools: () => [{
        name: 'files__replace',
        serverName: 'files',
        description: 'replace',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }],
      callTool,
    } as unknown as McpClient)
    const executeSingleTool = (engine as unknown as {
      executeSingleTool: (toolCall: ToolCall) => Promise<ToolResult>
    }).executeSingleTool.bind(engine)

    const result = await executeSingleTool({ id: 'mcp-1', name: 'files__replace', arguments: { path: 'a.ts' } })

    expect(result).toMatchObject({ isError: false, output: 'mcp result' })
    expect(callTool).toHaveBeenCalledWith('files', 'replace', { path: 'a.ts' })

    const dispatchTool = (engine as unknown as {
      dispatchTool: (name: string, args: Record<string, unknown>, toolCallId: string) => Promise<string>
    }).dispatchTool.bind(engine)
    await expect(dispatchTool('tool_search', { query: 'replace' }, 'mcp-search-1')).resolves.toContain('files__replace')
    engine.destroy()
  })
})

describe('AgentEngine structured patch dispatch', () => {
  it('preflights and applies multiple patch operations with conflict checks', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'turboflux-apply-patch-'))
    const sourcePath = join(workspace, 'sample.txt')
    writeFileSync(sourcePath, 'before\n')
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      temperature: 0,
      maxTokens: 4096,
      maxTurns: 2,
      workspacePath: workspace,
    }, new NodeToolExecutor(workspace), stateProvider)
    const dispatchTool = (engine as unknown as {
      dispatchTool: (name: string, args: Record<string, unknown>, toolCallId: string) => Promise<string>
    }).dispatchTool.bind(engine)

    const patch = `*** Begin Patch
*** Update File: sample.txt
@@
-before
+after
*** Add File: added.txt
+created
*** End Patch`
    await expect(dispatchTool('apply_patch', { patch }, 'patch-1')).resolves.toContain('Patch applied')
    expect(readFileSync(sourcePath, 'utf8')).toBe('after\n')
    expect(readFileSync(join(workspace, 'added.txt'), 'utf8')).toBe('created\n')

    const movePatch = `*** Begin Patch
*** Update File: sample.txt
*** Move to: moved.txt
@@
-after
+after
*** End Patch`
    await expect(dispatchTool('apply_patch', { patch: movePatch }, 'patch-move')).resolves.toContain('M moved.txt')
    expect(readFileSync(join(workspace, 'moved.txt'), 'utf8')).toBe('after\n')

    await expect(dispatchTool('apply_patch', { patch }, 'patch-2')).resolves.toMatch(/Error: (Failed to find expected lines|Write conflict|.*requires an existing file)/)
    const executeSingleTool = (engine as unknown as {
      executeSingleTool: (toolCall: ToolCall) => Promise<ToolResult>
    }).executeSingleTool.bind(engine)
    await expect(executeSingleTool({ id: 'patch-invalid', name: 'apply_patch', arguments: { patch: 'not a patch' } })).resolves.toMatchObject({
      isError: true,
      errorKind: 'validation',
    })
    engine.destroy()
    rmSync(workspace, { recursive: true, force: true })
  })
})

describe('AgentEngine user-controlled run length', () => {
  it('honors abort while initial Git preparation is pending', async () => {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      workspacePath: workspace,
    }, {} as ToolExecutor, stateProvider)
    let releasePreparation!: () => void
    vi.spyOn(engine as any, 'initializeGit').mockImplementation(() => new Promise<boolean>(resolve => {
      releasePreparation = () => resolve(false)
    }))
    const callModel = vi.spyOn(engine as any, 'callModel')
    const events: AgentEventType[] = []
    engine.subscribe(event => events.push(event))

    try {
      const pending = engine.run('abort before preparation finishes')
      await Promise.resolve()
      engine.abort()
      releasePreparation()

      await expect(pending).rejects.toMatchObject({ aborted: true })
      expect(callModel).not.toHaveBeenCalled()
      expect(engine.getSession().turns).toHaveLength(0)
      expect(events.some(event => event.type === 'session:complete')).toBe(false)
      expect(events.some(event => event.type === 'run:state' && event.state.phase === 'completed')).toBe(false)
    } finally {
      engine.destroy()
    }
  })

  it('keeps the run active until final context preparation settles', async () => {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', workspacePath: workspace }, {} as ToolExecutor, stateProvider)
    vi.spyOn(engine as any, 'initializeGit').mockResolvedValue(false)
    let prepareCalls = 0
    let releaseFinalPreparation!: () => void
    let finalPreparationStarted!: () => void
    const finalPreparation = new Promise<void>(resolve => { finalPreparationStarted = resolve })
    const finalPreparationGate = new Promise<void>(resolve => { releaseFinalPreparation = resolve })
    vi.spyOn(engine as any, 'prepareContextWindow').mockImplementation(async () => {
      prepareCalls += 1
      if (prepareCalls === 2) {
        finalPreparationStarted()
        await finalPreparationGate
      }
    })
    vi.spyOn(engine as any, 'callModel').mockResolvedValue({
      id: 'final-before-persist',
      role: 'assistant',
      content: 'Done.',
      timestamp: Date.now(),
    } satisfies AgentTurn)
    const events: AgentEventType[] = []
    engine.subscribe(event => events.push(event))

    try {
      const pending = engine.run('finish after final preparation')
      await finalPreparation
      expect(engine.isRunning()).toBe(true)
      expect(events.some(event => event.type === 'session:complete')).toBe(false)
      releaseFinalPreparation()
      await expect(pending).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', content: 'Done.' }),
      ]))
      const completeIndex = events.findIndex(event => event.type === 'session:complete')
      const finalStateIndex = events.findIndex(event => event.type === 'run:state' && event.state.phase === 'completed')
      expect(completeIndex).toBeGreaterThan(-1)
      expect(finalStateIndex).toBeGreaterThan(completeIndex)
    } finally {
      engine.destroy()
    }
  })

  it('rejects a model failure without emitting a successful completion event', async () => {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', workspacePath: workspace }, {} as ToolExecutor, stateProvider)
    vi.spyOn(engine as any, 'initializeGit').mockResolvedValue(false)
    vi.spyOn(engine as any, 'callModel').mockRejectedValue(new Error('upstream disconnected'))
    const events: AgentEventType[] = []
    engine.subscribe(event => events.push(event))

    try {
      await expect(engine.run('fail this request')).rejects.toThrow('upstream disconnected')
      expect(events).toContainEqual({ type: 'error', error: 'upstream disconnected' })
      expect(events).toContainEqual(expect.objectContaining({
        type: 'run:state',
        state: expect.objectContaining({ phase: 'recoverable_error', detail: 'upstream disconnected' }),
      }))
      expect(events.some(event => event.type === 'session:complete')).toBe(false)
      expect(events.some(event => event.type === 'run:state' && event.state.phase === 'completed')).toBe(false)
    } finally {
      engine.destroy()
    }
  })

  it('ignores legacy maxTurns values and continues until the model finishes', async () => {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      temperature: 0,
      maxTokens: 4096,
      maxTurns: 2,
      workspacePath: workspace,
    }, new NodeToolExecutor(workspace), stateProvider)
    let modelTurn = 0
    const callModel = vi.spyOn(engine as any, 'callModel').mockImplementation(async () => {
      modelTurn++
      if (modelTurn <= 3) {
        return {
          id: `assistant-${modelTurn}`,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          toolCalls: [{
            id: `tool-${modelTurn}`,
            name: 'read_file',
            arguments: { path: `src/file-${modelTurn}.ts` },
          }],
        } satisfies AgentTurn
      }
      return {
        id: 'assistant-final',
        role: 'assistant',
        content: 'Task complete.',
        timestamp: Date.now(),
      } satisfies AgentTurn
    })
    vi.spyOn(engine as any, 'executeToolCalls').mockImplementation(async (calls: ToolCall[]) => (
      calls.map(call => ({ toolCallId: call.id, output: 'ok', isError: false }))
    ))
    const notifications: string[] = []
    engine.subscribe(event => {
      if (event.type === 'notification') notifications.push(event.message)
    })

    try {
      const turns = await engine.run('inspect and finish the task')

      expect(callModel).toHaveBeenCalledTimes(4)
      expect(turns.some(turn => turn.role === 'assistant' && turn.content === 'Task complete.')).toBe(true)
      expect(notifications.some(message => /turn|budget/i.test(message))).toBe(false)
    } finally {
      engine.destroy()
    }
  })

  it('treats a no-tool response as the model final even when task metadata remains open', async () => {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      temperature: 0,
      maxTokens: 4096,
      workspacePath: workspace,
    }, new NodeToolExecutor(workspace), stateProvider)
    engine.getTaskManager().createTask({
      title: 'stale task metadata',
      description: 'must not force another model request',
      priority: 'M',
    })
    const callModel = vi.spyOn(engine as any, 'callModel').mockResolvedValue({
      id: 'assistant-final',
      role: 'assistant',
      content: 'Done.',
      timestamp: Date.now(),
    } satisfies AgentTurn)

    try {
      const turns = await engine.run('finish naturally')

      expect(callModel).toHaveBeenCalledTimes(1)
      expect(turns.at(-1)?.content).toBe('Done.')
    } finally {
      engine.destroy()
    }
  })
})

describe('AgentEngine read bandwidth', () => {
  it('returns up to 2,000 lines by default instead of paging normal files', async () => {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const executor = new NodeToolExecutor(workspace)
    const readFileRange = vi.spyOn(executor, 'readFileRange').mockResolvedValue({
      success: true,
      data: {
        content: Array.from({ length: 2_000 }, (_, index) => `line ${index + 1}`).join('\n'),
        startLine: 1,
        endLine: 2_000,
        truncated: true,
        bytesRead: 18_893,
      },
    })
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      temperature: 0,
      maxTokens: 4096,
      workspacePath: workspace,
    }, executor, stateProvider)
    const dispatchTool = (engine as unknown as {
      dispatchTool: (name: string, args: Record<string, unknown>) => Promise<string>
    }).dispatchTool.bind(engine)

    try {
      const output = await dispatchTool('read_file', { path: 'src/example.ts' })

      expect(output).toContain('[lines 1-2000; bounded to 2000 lines / 48 KiB;')
      expect(output).toContain('2000→line 2000')
      expect(output).not.toContain('2001→line 2001')
      expect(readFileRange).toHaveBeenCalledWith(expect.any(String), 0, 2_000, 48 * 1024)
    } finally {
      engine.destroy()
    }
  })

  it('does not offer a false line offset after truncating a giant single line', async () => {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      workspacePath: workspace,
    }, {
      readFileRange: vi.fn(async () => ({
        success: true,
        data: {
          content: 'x'.repeat(48 * 1024),
          startLine: 1,
          endLine: 1,
          truncated: true,
          bytesRead: 48 * 1024,
          partialLine: true,
        },
      })),
    } as unknown as ToolExecutor, stateProvider)
    const dispatchTool = (engine as unknown as {
      dispatchTool: (name: string, args: Record<string, unknown>) => Promise<string>
    }).dispatchTool.bind(engine)

    try {
      const output = await dispatchTool('read_file', { path: 'conversation.jsonl', limit: 50 })

      expect(output).toContain('showing a bounded preview only')
      expect(output).toContain('structured log/task reader')
      expect(output).not.toContain('offset=2')
    } finally {
      engine.destroy()
    }
  })
})

describe('AgentEngine aborted tool execution', () => {
  it('returns cancellation results for every tool that did not run', async () => {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      workspacePath: workspace,
    }, {} as ToolExecutor, stateProvider)
    ;(engine as unknown as { abortController: AbortController }).abortController = new AbortController()
    engine.abort()

    try {
      const results = await (engine as unknown as {
        executeToolCalls: (toolCalls: ToolCall[]) => Promise<ToolResult[]>
      }).executeToolCalls([
        { id: 'tc1', name: 'read_file', arguments: { path: 'a.ts' } },
        { id: 'tc2', name: 'read_file', arguments: { path: 'b.ts' } },
      ])

      expect(results).toEqual([
        expect.objectContaining({ toolCallId: 'tc1', isError: true, errorKind: 'abort' }),
        expect.objectContaining({ toolCallId: 'tc2', isError: true, errorKind: 'abort' }),
      ])
    } finally {
      engine.destroy()
    }
  })
})

describe('AgentEngine tool scheduling and task contracts', () => {
  function createEngine(): AgentEngine {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    return new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', workspacePath: workspace }, {} as ToolExecutor, stateProvider)
  }

  it('uses dynamic concurrency metadata for command reads', () => {
    const engine = createEngine()
    const partitionToolCalls = (engine as unknown as {
      partitionToolCalls: (calls: ToolCall[]) => Array<{ isConcurrencySafe: boolean; toolCalls: ToolCall[] }>
    }).partitionToolCalls.bind(engine)

    try {
      const batches = partitionToolCalls([
        { id: 'read-command', name: 'run_command', arguments: { command: 'git status --short' } },
        { id: 'write-command', name: 'run_command', arguments: { command: 'npm run build' } },
      ])

      expect(batches.map(batch => batch.isConcurrencySafe)).toEqual([true, false])
      expect(batches[0]?.toolCalls[0]?.id).toBe('read-command')
    } finally {
      engine.destroy()
    }
  })

  it('applies parent and status task filters together', async () => {
    const engine = createEngine()
    const dispatchTool = (engine as unknown as {
      dispatchTool: (name: string, args: Record<string, unknown>, toolCallId: string) => Promise<string>
    }).dispatchTool.bind(engine)

    try {
      const root = JSON.parse(await dispatchTool('create_task', {
        title: 'Root', description: 'Root task', priority: 'major',
      }, 'create-root')) as { id: string }
      const child = JSON.parse(await dispatchTool('create_task', {
        title: 'Child', description: 'Child task', priority: 'medium', parent_id: root.id,
      }, 'create-child')) as { id: string }
      await dispatchTool('update_task', { task_id: child.id, status: 'completed' }, 'complete-child')

      const filtered = JSON.parse(await dispatchTool('list_tasks', {
        parent_id: root.id,
        status: 'completed',
      }, 'list-filtered')) as Array<{ id: string }>
      const all = JSON.parse(await dispatchTool('list_tasks', {}, 'list-all')) as Array<{ id: string }>

      expect(filtered.map(task => task.id)).toEqual([child.id])
      expect(all.map(task => task.id)).toEqual(expect.arrayContaining([root.id, child.id]))
    } finally {
      engine.destroy()
    }
  })

  it('blocks ask_user dispatch until a response is submitted', async () => {
    const engine = createEngine()
    const dispatchTool = (engine as unknown as {
      dispatchTool: (name: string, args: Record<string, unknown>, toolCallId: string) => Promise<string>
    }).dispatchTool.bind(engine)
    let settled = false
    const pending = dispatchTool('ask_user', { question: 'Continue?' }, 'ask-blocking')
      .then(output => { settled = true; return output })

    try {
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(settled).toBe(false)
      expect(engine.submitAskUserResponse('yes', 'ask-blocking')).toBe(true)
      await expect(pending).resolves.toBe('[User response] yes')
      expect(settled).toBe(true)
    } finally {
      engine.destroy()
    }
  })
})

describe('AgentEngine command output', () => {
  function createHarness(result: Awaited<ReturnType<ToolExecutor['runCommand']>>) {
    const workspace = process.cwd()
    const runtimeConfig = {
      provider: 'custom' as const,
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }
    const stateProvider = new DefaultAgentStateProvider(runtimeConfig, workspace)
    const executor = {
      runCommand: vi.fn(async () => result),
    } as unknown as ToolExecutor
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      workspacePath: workspace,
    }, executor, stateProvider)
    const executeSingleTool = (engine as unknown as {
      executeSingleTool: (toolCall: ToolCall) => Promise<ToolResult>
    }).executeSingleTool.bind(engine)
    return { engine, executeSingleTool }
  }

  it('shows stdout and stderr for successful commands', async () => {
    const { engine, executeSingleTool } = createHarness({
      success: true,
      data: { stdout: 'build output', stderr: 'build warning', exitCode: 0 },
    })
    try {
      const result = await executeSingleTool({
        id: 'command-success-1',
        name: 'run_command',
        arguments: { command: 'build' },
      })

      expect(result.output).toContain('stdout:\nbuild output')
      expect(result.output).toContain('stderr:\nbuild warning')
    } finally {
      engine.destroy()
    }
  })

  it('returns non-zero exits as command results instead of tool errors', async () => {
    const { engine, executeSingleTool } = createHarness({
      success: true,
      data: { stdout: 'partial output', stderr: 'build failed', exitCode: 2 },
    })
    try {
      const result = await executeSingleTool({
        id: 'command-failure-1',
        name: 'run_command',
        arguments: { command: 'build' },
      })

      expect(result.output).toContain('Process exited with code 2')
      expect(result.output).toContain('stdout:\npartial output')
      expect(result.output).toContain('stderr:\nbuild failed')
      expect(result.isError).toBe(false)
    } finally {
      engine.destroy()
    }
  })

  it('keeps an empty query-style exit code 1 model-visible', async () => {
    const { engine, executeSingleTool } = createHarness({
      success: true,
      data: { stdout: '', stderr: '', exitCode: 1 },
    })
    try {
      const result = await executeSingleTool({
        id: 'command-query-miss-1',
        name: 'run_command',
        arguments: { command: 'git config --get missing.key' },
      })

      expect(result.output).toBe('Process exited with code 1\nNo output')
      expect(result.isError).toBe(false)
    } finally {
      engine.destroy()
    }
  })

  it('keeps executor failures as tool errors', async () => {
    const { engine, executeSingleTool } = createHarness({
      success: false,
      error: 'spawn failed',
      data: { stdout: '', stderr: 'spawn failed', exitCode: 1 },
    })
    try {
      const result = await executeSingleTool({
        id: 'command-execution-error-1',
        name: 'run_command',
        arguments: { command: 'missing-command' },
      })

      expect(result.output).toMatch(/^Error \(code 1\): spawn failed/)
      expect(result.isError).toBe(true)
    } finally {
      engine.destroy()
    }
  })

  it('writes raw stdin to a running terminal', async () => {
    const workspace = process.cwd()
    const ptyWrite = vi.fn(async () => ({ success: true }))
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      workspacePath: workspace,
    }, { ptyWrite } as unknown as ToolExecutor, stateProvider)
    const executeSingleTool = (engine as unknown as {
      executeSingleTool: (toolCall: ToolCall) => Promise<ToolResult>
    }).executeSingleTool.bind(engine)

    try {
      const result = await executeSingleTool({
        id: 'terminal-write-1',
        name: 'write_terminal',
        arguments: { session_id: 'term-1', data: 'yes\n' },
      })

      expect(result.isError).toBe(false)
      expect(result.output).toContain('Wrote 4 byte(s)')
      expect(ptyWrite).toHaveBeenCalledWith('term-1', 'yes\n')
    } finally {
      engine.destroy()
    }
  })

  it('reports the persistent log path for background commands', async () => {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const executor = {
      validateCommand: vi.fn(async () => ({ success: true })),
      ptyCreate: vi.fn(async () => ({
        success: true,
        data: { sessionId: 'term-1', session: { logPath: 'C:/logs/term-1.jsonl' } },
      })),
      ptyWrite: vi.fn(async () => ({ success: true })),
    } as unknown as ToolExecutor
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      workspacePath: workspace,
    }, executor, stateProvider)
    const executeSingleTool = (engine as unknown as {
      executeSingleTool: (toolCall: ToolCall) => Promise<ToolResult>
    }).executeSingleTool.bind(engine)

    try {
      const result = await executeSingleTool({
        id: 'background-command-1',
        name: 'run_command',
        arguments: { command: 'npm test', run_in_background: true },
      })

      expect(result.output).toContain('Log: C:/logs/term-1.jsonl')
    } finally {
      engine.destroy()
    }
  })

  it('automatically backgrounds dependency installs unless foreground is explicit', async () => {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const startBackgroundCommand = vi.fn(async () => ({
      success: true,
      data: { sessionId: 'term-install', session: { logPath: 'C:/logs/install.jsonl' } },
    }))
    const runCommand = vi.fn(async () => ({
      success: true,
      data: { stdout: 'installed', stderr: '', exitCode: 0 },
    }))
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      workspacePath: workspace,
    }, { startBackgroundCommand, runCommand } as unknown as ToolExecutor, stateProvider)
    const executeSingleTool = (engine as unknown as {
      executeSingleTool: (toolCall: ToolCall) => Promise<ToolResult>
    }).executeSingleTool.bind(engine)

    try {
      const background = await executeSingleTool({
        id: 'install-background-1',
        name: 'run_command',
        arguments: { command: 'npm install' },
      })
      const foreground = await executeSingleTool({
        id: 'install-foreground-1',
        name: 'run_command',
        arguments: { command: 'npm install --ignore-scripts', run_in_background: false },
      })

      expect(background.output).toContain('automatically moved to the background')
      expect(background.output).toContain('term-install')
      expect(startBackgroundCommand).toHaveBeenCalledOnce()
      expect(foreground.output).toContain('Process exited with code 0')
      expect(runCommand).toHaveBeenCalledOnce()
    } finally {
      engine.destroy()
    }
  })
})

describe('AgentEngine filesystem tool output', () => {
  function createFilesystemHarness(executor: ToolExecutor) {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      workspacePath: workspace,
    }, executor, stateProvider)
    const executeSingleTool = (engine as unknown as {
      executeSingleTool: (toolCall: ToolCall) => Promise<ToolResult>
    }).executeSingleTool.bind(engine)
    return { engine, executeSingleTool }
  }

  it('labels directory nodes as directories', async () => {
    const { engine, executeSingleTool } = createFilesystemHarness({
      listTree: vi.fn(async () => ({
        success: true,
        data: {
          name: 'workspace',
          type: 'directory',
          children: [{ name: '.workspace', type: 'directory', children: [] }],
        },
      })),
    } as unknown as ToolExecutor)

    try {
      const result = await executeSingleTool({
        id: 'list-directory-1',
        name: 'list_directory',
        arguments: { path: '.', recursive: false },
      })

      expect(result.isError).toBe(false)
      expect(result.output).toContain('[DIR] workspace')
      expect(result.output).toContain('[DIR] .workspace')
    } finally {
      engine.destroy()
    }
  })

  it('preserves the executor reason when read_file fails', async () => {
    const { engine, executeSingleTool } = createFilesystemHarness({
      readFile: vi.fn(async () => ({ success: false, error: 'Path is not a file' })),
    } as unknown as ToolExecutor)

    try {
      const result = await executeSingleTool({
        id: 'read-directory-1',
        name: 'read_file',
        arguments: { path: '.workspace' },
      })

      expect(result.isError).toBe(true)
      expect(result.output).toContain('Path is not a file')
      expect(result.output).toContain('resolved path: .workspace')
    } finally {
      engine.destroy()
    }
  })

  it('does not execute an identical read twice in one agent run', async () => {
    const readFile = vi.fn(async () => ({ success: true, data: 'const value = 1' }))
    const { engine, executeSingleTool } = createFilesystemHarness({ readFile } as unknown as ToolExecutor)

    try {
      const first = await executeSingleTool({
        id: 'read-once-1',
        name: 'read_file',
        arguments: { path: 'src/value.ts' },
      })
      const second = await executeSingleTool({
        id: 'read-once-2',
        name: 'read_file',
        arguments: { path: 'src/value.ts' },
      })

      expect(first.output).toContain('const value = 1')
      expect(second.output).toContain('reused')
      expect(readFile).toHaveBeenCalledTimes(1)
    } finally {
      engine.destroy()
    }
  })

  it('classifies unexpected tool parameters as validation failures', async () => {
    const { engine, executeSingleTool } = createFilesystemHarness({} as ToolExecutor)

    try {
      const result = await executeSingleTool({
        id: 'invalid-read-1',
        name: 'read_file',
        arguments: { file_path: 'src/value.ts' },
      })

      expect(result).toMatchObject({
        isError: true,
        errorKind: 'validation',
        output: expect.stringContaining('Unexpected parameter: file_path'),
      })
    } finally {
      engine.destroy()
    }
  })
})

describe('AgentEngine repeated tool failure loop breaker', () => {
  it('ends the run with a visible explanation after three identical validation failures', async () => {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      workspacePath: workspace,
    }, {} as ToolExecutor, stateProvider)
    let iteration = 0
    const callModel = vi.spyOn(engine as any, 'callModel').mockImplementation(async () => {
      iteration += 1
      return {
        id: `assistant-${iteration}`,
        role: 'assistant',
        content: 'Retrying with the corrected parameter.',
        timestamp: 100 + iteration,
        toolCalls: [{
          id: `tool-${iteration}`,
          name: 'read_file',
          arguments: { file_path: 'src/value.ts' },
        }],
      } as AgentTurn
    })
    const executeToolCalls = vi.spyOn(engine as any, 'executeToolCalls').mockImplementation(async (calls: ToolCall[]) => (
      calls.map(call => ({
        toolCallId: call.id,
        name: call.name,
        output: 'Error: Unexpected parameter: file_path',
        isError: true,
        errorKind: 'validation' as const,
      }))
    ))
    vi.spyOn(engine as any, 'initializeGit').mockResolvedValue(undefined)
    vi.spyOn(engine as any, 'prepareContextWindow').mockResolvedValue(undefined)

    try {
      const turns = await engine.run('inspect the file')

      expect(callModel).toHaveBeenCalledTimes(3)
      expect(executeToolCalls).toHaveBeenCalledTimes(3)
      expect(turns.at(-1)).toMatchObject({
        role: 'assistant',
        content: expect.stringContaining('Stopped a repeated tool-call loop after 3 identical failures'),
        metadata: expect.objectContaining({ interrupted: true }),
      })
    } finally {
      engine.destroy()
    }
  })
})

describe('AgentEngine successful tool loop breaker', () => {
  it('ends a runaway successful loop with a visible resumable explanation', async () => {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      workspacePath: workspace,
      maxToolRounds: 2,
    }, {} as ToolExecutor, stateProvider)
    let iteration = 0
    const callModel = vi.spyOn(engine as any, 'callModel').mockImplementation(async () => {
      iteration += 1
      return {
        id: `assistant-success-${iteration}`,
        role: 'assistant',
        content: 'Continuing.',
        timestamp: 100 + iteration,
        toolCalls: [{ id: `tool-success-${iteration}`, name: 'read_file', arguments: { path: `file-${iteration}.ts` } }],
      } as AgentTurn
    })
    const executeToolCalls = vi.spyOn(engine as any, 'executeToolCalls').mockImplementation(async (calls: ToolCall[]) => (
      calls.map(call => ({ toolCallId: call.id, name: call.name, output: 'ok', isError: false }))
    ))
    vi.spyOn(engine as any, 'initializeGit').mockResolvedValue(undefined)
    vi.spyOn(engine as any, 'prepareContextWindow').mockResolvedValue(undefined)

    try {
      const turns = await engine.run('keep inspecting forever')

      expect(callModel).toHaveBeenCalledTimes(2)
      expect(executeToolCalls).toHaveBeenCalledTimes(2)
      expect(turns.at(-1)).toMatchObject({
        role: 'assistant',
        content: expect.stringContaining('Stopped after 2 tool rounds'),
        metadata: expect.objectContaining({ interrupted: true }),
      })
    } finally {
      engine.destroy()
    }
  })
})

describe('AgentEngine Git integration state', () => {
  function createEngine(runProcess: ToolExecutor['runProcess']) {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    return new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      temperature: 0,
      maxTokens: 4096,
      workspacePath: workspace,
      gitEnabled: true,
    }, { runProcess } as unknown as ToolExecutor, stateProvider)
  }

  it('emits one structured state through detection, readiness, and disablement', async () => {
    const runProcess = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === 'rev-parse') return { success: true, data: { stdout: 'true\n', stderr: '', exitCode: 0 } }
      if (args[0] === 'status') return { success: true, data: { stdout: '# branch.oid abc123\0# branch.head main\0', stderr: '', exitCode: 0 } }
      return { success: true, data: { stdout: '', stderr: '', exitCode: 0 } }
    })
    const engine = createEngine(runProcess)
    const states: string[] = []
    engine.subscribe(event => {
      if (event.type === 'git:state') states.push(event.state.phase)
    })

    try {
      await expect(engine.initializeGit(true)).resolves.toBe(true)
      expect(engine.getGitState()).toMatchObject({ enabled: true, phase: 'ready', snapshot: { branch: 'main', head: 'abc123' } })

      engine.setGitEnabled(false)

      expect(engine.getGitState()).toMatchObject({ enabled: false, phase: 'disabled', snapshot: null })
      expect(states).toEqual(expect.arrayContaining(['detecting', 'ready', 'disabled']))
    } finally {
      engine.destroy()
    }
  })

  it('keeps configured integration enabled while marking non-repositories unavailable', async () => {
    const runProcess = vi.fn(async () => ({ success: false, error: 'not a repository', data: { stdout: '', stderr: 'not a repository', exitCode: 128 } }))
    const engine = createEngine(runProcess)

    try {
      await expect(engine.initializeGit(true)).resolves.toBe(false)
      expect(engine.getGitState()).toMatchObject({ enabled: true, phase: 'unavailable', snapshot: null, error: undefined })

      await engine.refreshGitStatus()

      expect(engine.getGitState()).toMatchObject({ enabled: true, phase: 'unavailable', snapshot: null, error: undefined })
      expect(runProcess).toHaveBeenCalledOnce()
    } finally {
      engine.destroy()
    }
  })

  it('does not run Git when file tools modify the workspace', async () => {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const runProcess = vi.fn(async () => ({ success: true, data: { stdout: '', stderr: '', exitCode: 0 } }))
    const readFile = vi.fn(async () => ({ success: true, data: 'before\n' }))
    const writeFile = vi.fn(async () => ({ success: true }))
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      workspacePath: workspace,
      gitEnabled: true,
    }, { runProcess, readFile, writeFile } as unknown as ToolExecutor, stateProvider)
    const executeToolCalls = (engine as unknown as {
      executeToolCalls: (toolCalls: ToolCall[]) => Promise<ToolResult[]>
    }).executeToolCalls.bind(engine)

    try {
      const results = await executeToolCalls([{
        id: 'replace-without-commit',
        name: 'replace_file',
        arguments: { path: 'src/example.ts', content: 'after\n' },
      }])

      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({
        isError: false,
        changeSummary: { operation: 'edit', before: 'before\n', after: 'after\n' },
      })
      expect(writeFile).toHaveBeenCalledOnce()
      expect(runProcess).not.toHaveBeenCalled()
    } finally {
      engine.destroy()
    }
  })
})

describe('AgentEngine permission requests', () => {
  it('includes the concrete tool and target path without requiring a chat turn', async () => {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'ask',
      workspacePath: workspace,
    }, {} as ToolExecutor, stateProvider)
    const askEvents: AgentEventType[] = []
    engine.subscribe(event => {
      if (event.type !== 'ask:user') return
      askEvents.push(event)
      engine.submitAskUserResponse('allow-session')
    })
    const checkToolPermission = (engine as unknown as {
      checkToolPermission: (toolCall: ToolCall) => Promise<ToolResult | null>
    }).checkToolPermission.bind(engine)
    const toolCall: ToolCall = {
      id: 'write-approval-1',
      name: 'write_file',
      arguments: { path: 'src/example.ts', content: 'export const value = 1' },
    }

    try {
      await expect(checkToolPermission(toolCall)).resolves.toBeNull()
      await expect(checkToolPermission({
        ...toolCall,
        id: 'edit-approval-2',
        name: 'edit_file',
        arguments: { path: 'src/other.ts', old_string: 'before', new_string: 'after' },
      })).resolves.toBeNull()
      expect(askEvents).toEqual([expect.objectContaining({
        type: 'ask:user',
        requestId: 'write-approval-1',
        toolName: 'write_file',
        path: 'src/example.ts',
        options: ['allow-once', 'allow-run', 'allow-session', 'deny'],
      })])
      expect(engine.getSession().turns).toHaveLength(0)
    } finally {
      engine.destroy()
    }
  })
})

describe('AgentEngine interrupted streams', () => {
  function createHarness(provider: 'custom' | 'anthropic', streamLine?: string | string[], abortStream = true) {
    const workspace = process.cwd()
    const runtimeConfig = {
      provider,
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }
    const stateProvider = new DefaultAgentStateProvider(runtimeConfig, workspace)
    let engine!: AgentEngine
    const streamAbort = vi.fn(async () => {})
    const executor = {
      streamMessage: vi.fn(async (_url: string, _headers: Record<string, string>, _body: string, onLine: (line: string) => void) => {
        if (streamLine) {
          for (const line of Array.isArray(streamLine) ? streamLine : [streamLine]) onLine(line)
        }
        if (abortStream) {
          engine.abort()
          return { success: false, error: 'Request aborted' }
        }
        return { success: true, data: '' }
      }),
      streamAbort,
    } as unknown as ToolExecutor
    engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      temperature: 0,
      maxTokens: 4096,
      maxTurns: 2,
      workspacePath: workspace,
    }, executor, stateProvider)
    ;(engine as unknown as { abortController: AbortController }).abortController = new AbortController()
    const events: AgentEventType[] = []
    engine.subscribe(event => events.push(event))
    return { engine, stateProvider, events, streamAbort }
  }

  it('keeps partial OpenAI-compatible text and strips incomplete tool markup', async () => {
    const line = `data: ${JSON.stringify({
      choices: [{ delta: { content: 'Keep this answer.\n<tool_calls><invoke name="read_file">' }, finish_reason: null }],
    })}`
    const { engine, stateProvider, events, streamAbort } = createHarness('custom', line)
    const internal = engine as unknown as {
      callOpenAICompatibleAPI: (
        config: ReturnType<DefaultAgentStateProvider['getActiveConfig']>,
        model: ReturnType<DefaultAgentStateProvider['getActiveModel']>,
        messages: Array<Record<string, unknown>>,
        startTime: number,
      ) => Promise<AgentTurn>
    }

    try {
      const turn = await internal.callOpenAICompatibleAPI(
        stateProvider.getActiveConfig(),
        stateProvider.getActiveModel(),
        [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
        Date.now(),
      )

      expect(turn.content).toBe('Keep this answer.')
      expect(turn.metadata?.interrupted).toBe(true)
      expect(turn.toolCalls).toBeUndefined()
      expect(events).toContainEqual({ type: 'stream:end', interrupted: true })
      expect(streamAbort).toHaveBeenCalledOnce()
    } finally {
      engine.destroy()
    }
  })

  it('keeps partial Anthropic text as an interrupted assistant turn', async () => {
    const line = `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Anthropic partial response' },
    })}`
    const { engine, stateProvider, events } = createHarness('anthropic', line)
    const internal = engine as unknown as {
      callAnthropicAPI: (
        config: ReturnType<DefaultAgentStateProvider['getActiveConfig']>,
        model: ReturnType<DefaultAgentStateProvider['getActiveModel']>,
        systemPrompt: string,
        messages: Array<Record<string, unknown>>,
        startTime: number,
      ) => Promise<AgentTurn>
    }

    try {
      const turn = await internal.callAnthropicAPI(
        stateProvider.getActiveConfig(),
        stateProvider.getActiveModel(),
        'system',
        [{ role: 'user', content: 'hello' }],
        Date.now(),
      )

      expect(turn.content).toBe('Anthropic partial response')
      expect(turn.metadata?.interrupted).toBe(true)
      expect(events).toContainEqual({ type: 'stream:end', interrupted: true })
    } finally {
      engine.destroy()
    }
  })

  it('does not create an empty assistant turn when interrupted before output', async () => {
    const { engine, stateProvider, events } = createHarness('custom')
    const internal = engine as unknown as {
      callOpenAICompatibleAPI: (
        config: ReturnType<DefaultAgentStateProvider['getActiveConfig']>,
        model: ReturnType<DefaultAgentStateProvider['getActiveModel']>,
        messages: Array<Record<string, unknown>>,
        startTime: number,
      ) => Promise<AgentTurn>
    }

    try {
      await expect(internal.callOpenAICompatibleAPI(
        stateProvider.getActiveConfig(),
        stateProvider.getActiveModel(),
        [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
        Date.now(),
      )).rejects.toMatchObject({ message: 'aborted', aborted: true })
      expect(events).toContainEqual({ type: 'stream:end', interrupted: true })
    } finally {
      engine.destroy()
    }
  })

  it('keeps DeepSeek reasoning in thinking when interrupted before visible output', async () => {
    const line = `data: ${JSON.stringify({
      choices: [{
        delta: { reasoning_content: '先检查请求参数，再组织答案。' },
        finish_reason: null,
      }],
    })}`
    const { engine, stateProvider, events } = createHarness('custom', line)
    const internal = engine as unknown as {
      callOpenAICompatibleAPI: (
        config: ReturnType<DefaultAgentStateProvider['getActiveConfig']>,
        model: ReturnType<DefaultAgentStateProvider['getActiveModel']>,
        messages: Array<Record<string, unknown>>,
        startTime: number,
      ) => Promise<AgentTurn>
    }

    try {
      const turn = await internal.callOpenAICompatibleAPI(
        stateProvider.getActiveConfig(),
        stateProvider.getActiveModel(),
        [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
        Date.now(),
      )

      expect(turn.content).toBe('')
      expect(turn.metadata?.interrupted).toBe(true)
      expect(turn.metadata?.thinking?.content).toBe('先检查请求参数，再组织答案。')
      expect(events).toContainEqual({ type: 'stream:thinking_delta', text: '先检查请求参数，再组织答案。' })
      expect(events).not.toContainEqual({ type: 'stream:delta', text: '先检查请求参数，再组织答案。' })
    } finally {
      engine.destroy()
    }
  })

  it('accepts OpenAI-compatible text when the provider omits the terminal marker', async () => {
    const line = `data: ${JSON.stringify({
      choices: [{ delta: { content: 'Provider response without DONE.' }, finish_reason: null }],
    })}`
    const { engine, stateProvider, events } = createHarness('custom', line, false)
    const internal = engine as unknown as {
      callOpenAICompatibleAPI: (
        config: ReturnType<DefaultAgentStateProvider['getActiveConfig']>,
        model: ReturnType<DefaultAgentStateProvider['getActiveModel']>,
        messages: Array<Record<string, unknown>>,
        startTime: number,
      ) => Promise<AgentTurn>
    }

    try {
      const turn = await internal.callOpenAICompatibleAPI(
        stateProvider.getActiveConfig(),
        stateProvider.getActiveModel(),
        [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
        Date.now(),
      )

      expect(turn.content).toBe('Provider response without DONE.')
      expect(turn.metadata?.interrupted).not.toBe(true)
      expect(events).toContainEqual({ type: 'stream:end' })
    } finally {
      engine.destroy()
    }
  })

  it('accepts Anthropic text when message_stop is omitted', async () => {
    const line = `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Anthropic response without message_stop.' },
    })}`
    const { engine, stateProvider, events } = createHarness('anthropic', line, false)
    const internal = engine as unknown as {
      callAnthropicAPI: (
        config: ReturnType<DefaultAgentStateProvider['getActiveConfig']>,
        model: ReturnType<DefaultAgentStateProvider['getActiveModel']>,
        systemPrompt: string,
        messages: Array<Record<string, unknown>>,
        startTime: number,
      ) => Promise<AgentTurn>
    }

    try {
      const turn = await internal.callAnthropicAPI(
        stateProvider.getActiveConfig(),
        stateProvider.getActiveModel(),
        'system',
        [{ role: 'user', content: 'hello' }],
        Date.now(),
      )

      expect(turn.content).toBe('Anthropic response without message_stop.')
      expect(events).toContainEqual({ type: 'stream:end' })
    } finally {
      engine.destroy()
    }
  })

  it('accepts gateway streams with event-only types, initial text, and stop_reason', async () => {
    const lines = [
      'event: content_block_start',
      `data: ${JSON.stringify({ index: 0, content_block: { type: 'text', text: 'Gateway-compatible response.' } })}`,
      'event: message_delta',
      `data: ${JSON.stringify({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } })}`,
    ]
    const { engine, stateProvider, events } = createHarness('anthropic', lines, false)
    const internal = engine as unknown as {
      callAnthropicAPI: (
        config: ReturnType<DefaultAgentStateProvider['getActiveConfig']>,
        model: ReturnType<DefaultAgentStateProvider['getActiveModel']>,
        systemPrompt: string,
        messages: Array<Record<string, unknown>>,
        startTime: number,
      ) => Promise<AgentTurn>
    }

    try {
      const turn = await internal.callAnthropicAPI(
        stateProvider.getActiveConfig(),
        stateProvider.getActiveModel(),
        'system',
        [{ role: 'user', content: 'hello' }],
        Date.now(),
      )

      expect(turn.content).toBe('Gateway-compatible response.')
      expect(events).toContainEqual({ type: 'stream:end' })
    } finally {
      engine.destroy()
    }
  })

  it('keeps reasoning-only provider output out of the visible answer', () => {
    const { engine } = createHarness('custom', undefined, false)
    const internal = engine as unknown as {
      createAssistantTurn: (content: string, toolCalls: undefined, metadata: Record<string, unknown>) => AgentTurn
    }

    try {
      const turn = internal.createAssistantTurn('', undefined, {
        thinking: { content: '这是模型返回的唯一可见回答。', source: 'provider', status: 'complete' },
        rawReasoningPayload: { provider: 'openai-compatible', blocks: [], reasoningContent: '这是模型返回的唯一可见回答。' },
      })

      expect(turn.content).toBe('')
      expect(turn.metadata?.thinking?.content).toBe('这是模型返回的唯一可见回答。')
      expect(turn.metadata?.rawReasoningPayload?.reasoningContent).toBe('这是模型返回的唯一可见回答。')
    } finally {
      engine.destroy()
    }
  })

  it('marks reasoning-only Chat completion stopped by the output limit as interrupted', async () => {
    const lines = [
      `data: ${JSON.stringify({
        choices: [{ delta: { reasoning_content: '先规划实现，再调用写文件工具。' }, finish_reason: null }],
      })}`,
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'length' }],
        usage: { prompt_tokens: 12, completion_tokens: 4096 },
      })}`,
    ]
    const { engine, stateProvider, events } = createHarness('custom', lines, false)
    const internal = engine as unknown as {
      callOpenAICompatibleAPI: (
        config: ReturnType<DefaultAgentStateProvider['getActiveConfig']>,
        model: ReturnType<DefaultAgentStateProvider['getActiveModel']>,
        messages: Array<Record<string, unknown>>,
        startTime: number,
      ) => Promise<AgentTurn>
    }

    try {
      const turn = await internal.callOpenAICompatibleAPI(
        stateProvider.getActiveConfig(),
        stateProvider.getActiveModel(),
        [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
        Date.now(),
      )

      expect(turn).toMatchObject({
        content: '',
        metadata: {
          interrupted: true,
          thinking: { content: '先规划实现，再调用写文件工具。', status: 'interrupted' },
          rawReasoningPayload: { reasoningContent: '先规划实现，再调用写文件工具。' },
        },
      })
      expect(events).toContainEqual({ type: 'stream:end', interrupted: true })
      expect(events).not.toContainEqual({ type: 'stream:delta', text: '先规划实现，再调用写文件工具。' })
    } finally {
      engine.destroy()
    }
  })

  it('keeps reasoning separate while preserving a following OpenAI tool call', async () => {
    const lines = [
      `data: ${JSON.stringify({
        choices: [{ delta: { reasoning_content: '已完成规划，现在写入文件。' }, finish_reason: null }],
      })}`,
      `data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call-write',
              function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/example.ts', content: 'export const ok = true' }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      })}`,
    ]
    const { engine, stateProvider } = createHarness('custom', lines, false)
    const internal = engine as unknown as {
      callOpenAICompatibleAPI: (
        config: ReturnType<DefaultAgentStateProvider['getActiveConfig']>,
        model: ReturnType<DefaultAgentStateProvider['getActiveModel']>,
        messages: Array<Record<string, unknown>>,
        startTime: number,
      ) => Promise<AgentTurn>
    }

    try {
      const turn = await internal.callOpenAICompatibleAPI(
        stateProvider.getActiveConfig(),
        stateProvider.getActiveModel(),
        [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
        Date.now(),
      )

      expect(turn.content).toBe('')
      expect(turn.metadata?.thinking?.content).toBe('已完成规划，现在写入文件。')
      expect(turn.toolCalls).toEqual([{
        id: 'call-write',
        name: 'write_file',
        arguments: { path: 'src/example.ts', content: 'export const ok = true' },
      }])
    } finally {
      engine.destroy()
    }
  })

  it('rejects an unterminated stream that only contains an incomplete tool call', async () => {
    const line = `data: ${JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'partial-tool',
            function: { name: 'write_file', arguments: '{"path":' },
          }],
        },
        finish_reason: null,
      }],
    })}`
    const { engine, stateProvider } = createHarness('custom', line, false)
    const internal = engine as unknown as {
      callOpenAICompatibleAPI: (
        config: ReturnType<DefaultAgentStateProvider['getActiveConfig']>,
        model: ReturnType<DefaultAgentStateProvider['getActiveModel']>,
        messages: Array<Record<string, unknown>>,
        startTime: number,
      ) => Promise<AgentTurn>
    }

    try {
      await expect(internal.callOpenAICompatibleAPI(
        stateProvider.getActiveConfig(),
        stateProvider.getActiveModel(),
        [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
        Date.now(),
      )).rejects.toThrow('Model stream ended before a terminal event')
    } finally {
      engine.destroy()
    }
  })

  it('persists a partial assistant turn through the full run loop', async () => {
    const workspace = process.cwd()
    const runtimeConfig = {
      provider: 'custom' as const,
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }
    const stateProvider = new DefaultAgentStateProvider(runtimeConfig, workspace)
    const executor = new NodeToolExecutor(workspace)
    let engine!: AgentEngine
    const streamAbort = vi.spyOn(executor, 'streamAbort').mockResolvedValue()
    vi.spyOn(executor, 'streamMessage').mockImplementation(async (_url, _headers, _body, onLine) => {
      onLine(`data: ${JSON.stringify({
        choices: [{ delta: { content: 'Persist this partial reply.' }, finish_reason: null }],
      })}`)
      engine.abort()
      return { success: false, error: 'Request aborted' }
    })
    engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      temperature: 0,
      maxTokens: 4096,
      maxTurns: 2,
      workspacePath: workspace,
    }, executor, stateProvider)

    try {
      const turns = await engine.run('start a partial response')
      const assistantTurn = turns.find(turn => turn.role === 'assistant')

      expect(assistantTurn?.content).toBe('Persist this partial reply.')
      expect(assistantTurn?.metadata?.interrupted).toBe(true)
      expect(engine.getSession().turns.at(-1)).toMatchObject({
        role: 'assistant',
        content: 'Persist this partial reply.',
        metadata: expect.objectContaining({ interrupted: true }),
      })
      expect(streamAbort).toHaveBeenCalledOnce()
    } finally {
      engine.destroy()
    }
  })
})

describe('AgentEngine model protocol compatibility', () => {
  function createProtocolHarness(
    provider: 'custom' | 'anthropic',
    model: string,
    streamMessage: ToolExecutor['streamMessage'],
  ) {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider,
      apiKey: 'test-key',
      baseUrl: 'https://ai.zyyun.xyz/v1',
      model,
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const executor = {
      streamMessage: vi.fn(streamMessage),
      streamAbort: vi.fn(async () => {}),
      getCodeMap: vi.fn(async () => {
        throw new Error('main model calls must not auto-build a code map')
      }),
    } as unknown as ToolExecutor
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      temperature: 0,
      maxTokens: 4096,
      maxTurns: 2,
      workspacePath: workspace,
    }, executor, stateProvider)
    engine.restoreFromTurns([{
      id: 'user-protocol-test',
      role: 'user',
      content: 'hello',
      timestamp: Date.now(),
    }])
    ;(engine as unknown as { abortController: AbortController }).abortController = new AbortController()
    const events: AgentEventType[] = []
    engine.subscribe(event => events.push(event))
    const callModel = () => (engine as unknown as { callModel: () => Promise<AgentTurn> }).callModel()
    return { engine, executor, stateProvider, events, callModel }
  }

  it('uses /messages immediately after an Anthropic config is active', async () => {
    const harness = createProtocolHarness('anthropic', 'claude-fable-5', async (url, headers, body, onLine) => {
      expect(url).toBe('https://ai.zyyun.xyz/v1/messages')
      expect(headers['x-api-key']).toBe('test-key')
      expect(headers.Authorization).toBeUndefined()
      expect(JSON.parse(body)).toMatchObject({ model: 'claude-fable-5', stream: true })
      onLine(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'messages-ok' } })}`)
      onLine(`data: ${JSON.stringify({ type: 'message_stop' })}`)
      return { success: true, data: '' }
    })

    try {
      await expect(harness.callModel()).resolves.toMatchObject({ content: 'messages-ok' })
      expect(harness.executor.streamMessage).toHaveBeenCalledOnce()
    } finally {
      harness.engine.destroy()
    }
  })

  it('places Anthropic cache breakpoints on the two most recent messages', async () => {
    let requestBody: Record<string, any> | undefined
    const harness = createProtocolHarness('anthropic', 'claude-fable-5', async (_url, _headers, body, onLine) => {
      requestBody = JSON.parse(body)
      onLine(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'cached' } })}`)
      onLine(`data: ${JSON.stringify({ type: 'message_stop' })}`)
      return { success: true, data: '' }
    })
    harness.engine.restoreFromTurns([
      { id: 'u1', role: 'user', content: 'first', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'middle', timestamp: 2 },
      { id: 'u2', role: 'user', content: 'latest', timestamp: 3 },
    ])

    try {
      await harness.callModel()
      const cacheMarkedMessages = requestBody?.messages.filter((message: Record<string, any>) =>
        JSON.stringify(message.content).includes('cache_control'))
      expect(cacheMarkedMessages).toHaveLength(2)
      expect(JSON.stringify(cacheMarkedMessages[0])).toContain('middle')
      expect(JSON.stringify(cacheMarkedMessages[1])).toContain('latest')
    } finally {
      harness.engine.destroy()
    }
  })

  it('repairs incomplete historical tool use in the final Anthropic request', async () => {
    let requestBody: Record<string, any> | undefined
    const harness = createProtocolHarness('anthropic', 'claude-fable-5', async (_url, _headers, body, onLine) => {
      requestBody = JSON.parse(body)
      onLine(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'repaired' } })}`)
      onLine(`data: ${JSON.stringify({ type: 'message_stop' })}`)
      return { success: true, data: '' }
    })
    harness.engine.restoreFromTurns([
      { id: 'u1', role: 'user', content: 'inspect both', timestamp: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: 2,
        toolCalls: [
          { id: 'tc1', name: 'read_file', arguments: { path: 'a.ts' } },
          { id: 'tc2', name: 'read_file', arguments: { path: 'b.ts' } },
        ],
      },
      {
        id: 'tr1',
        role: 'tool_result',
        content: 'a',
        timestamp: 3,
        toolResults: [{ toolCallId: 'tc1', name: 'read_file', output: 'a', isError: false }],
      },
    ])

    try {
      await expect(harness.callModel()).resolves.toMatchObject({ content: 'repaired' })
      const assistantIndex = requestBody?.messages.findIndex((message: Record<string, any>) =>
        message.role === 'assistant'
        && message.content.some((block: Record<string, any>) => block.type === 'tool_use' && block.id === 'tc2'))
      expect(assistantIndex).toBeGreaterThanOrEqual(0)
      const repairedResultMessage = requestBody?.messages[assistantIndex + 1]
      expect(repairedResultMessage?.role).toBe('user')
      expect(repairedResultMessage?.content.slice(0, 2)).toEqual([
        expect.objectContaining({ type: 'tool_result', tool_use_id: 'tc1', content: 'a' }),
        expect.objectContaining({
          type: 'tool_result',
          tool_use_id: 'tc2',
          is_error: true,
        }),
      ])
    } finally {
      harness.engine.destroy()
    }
  })

  it('uses the newly active Anthropic config without retaining the old Chat route', async () => {
    const harness = createProtocolHarness('custom', 'generic-model', async (url, headers, _body, onLine) => {
      expect(url).toBe('https://ai.zyyun.xyz/v1/messages')
      expect(headers['x-api-key']).toBe('updated-key')
      onLine(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'updated-config-ok' } })}`)
      onLine(`data: ${JSON.stringify({ type: 'message_stop' })}`)
      return { success: true, data: '' }
    })
    harness.stateProvider.updateConfig({
      provider: 'anthropic',
      apiKey: 'updated-key',
      baseUrl: 'https://ai.zyyun.xyz/v1',
      model: 'claude-fable-5',
      contextWindow: 100_000,
      maxTokens: 4096,
    })

    try {
      await expect(harness.callModel()).resolves.toMatchObject({ content: 'updated-config-ok' })
      expect(harness.executor.streamMessage).toHaveBeenCalledOnce()
    } finally {
      harness.engine.destroy()
    }
  })

  it('retries /messages without an unsupported optional feature before changing protocols', async () => {
    const requestBodies: Array<Record<string, any>> = []
    const harness = createProtocolHarness('anthropic', 'claude-fable-5', async (_url, _headers, body, onLine) => {
      requestBodies.push(JSON.parse(body))
      if (requestBodies.length === 1) {
        return { success: false, status: 400, error: 'HTTP 400: unknown parameter: cache_control' }
      }
      onLine(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'messages-downgrade-ok' } })}`)
      onLine(`data: ${JSON.stringify({ type: 'message_stop' })}`)
      return { success: true, data: '' }
    })

    try {
      await expect(harness.callModel()).resolves.toMatchObject({ content: 'messages-downgrade-ok' })
      expect(JSON.stringify(requestBodies[0])).toContain('cache_control')
      expect(JSON.stringify(requestBodies[1])).not.toContain('cache_control')
      expect(vi.mocked(harness.executor.streamMessage).mock.calls.map(call => call[0])).toEqual([
        'https://ai.zyyun.xyz/v1/messages',
        'https://ai.zyyun.xyz/v1/messages',
      ])
      expect(harness.events.filter(event => event.type === 'model:protocol' && event.phase === 'fallback')).toHaveLength(0)
    } finally {
      harness.engine.destroy()
    }
  })

  it('reconnects the same protocol after a pre-stream 429 and honors Retry-After', async () => {
    vi.useFakeTimers()
    let calls = 0
    const harness = createProtocolHarness('anthropic', 'claude-fable-5', async (_url, _headers, _body, onLine) => {
      calls += 1
      if (calls === 1) {
        return {
          success: false,
          status: 429,
          retryAfterMs: 2_500,
          error: 'HTTP 429: rate limited',
        }
      }
      onLine(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'reconnected' } })}`)
      onLine(`data: ${JSON.stringify({ type: 'message_stop' })}`)
      return { success: true, data: '' }
    })

    try {
      const pending = harness.callModel()
      await vi.advanceTimersByTimeAsync(2_499)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).resolves.toMatchObject({ content: 'reconnected' })
      expect(calls).toBe(2)
      expect(harness.executor.streamMessage).toHaveBeenCalledTimes(2)
      expect(harness.events.filter(event => event.type === 'model:protocol' && event.phase === 'fallback')).toHaveLength(0)
      expect(harness.events.filter(event => event.type === 'notification' && event.level === 'warning')).toContainEqual(expect.objectContaining({
        message: expect.stringContaining('retrying the same protocol in 3s'),
      }))
    } finally {
      harness.engine.destroy()
      vi.useRealTimers()
    }
  })

  it.each([408, 425, 500, 503, 529])('reconnects the same protocol for transient HTTP %s', async status => {
    vi.useFakeTimers()
    let calls = 0
    const harness = createProtocolHarness('anthropic', 'claude-fable-5', async (_url, _headers, _body, onLine) => {
      calls += 1
      if (calls === 1) return { success: false, status, error: `HTTP ${status}: temporary provider failure` }
      onLine(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `reconnected-${status}` } })}`)
      onLine(`data: ${JSON.stringify({ type: 'message_stop' })}`)
      return { success: true, data: '' }
    })

    try {
      const pending = harness.callModel()
      await vi.runAllTimersAsync()
      await expect(pending).resolves.toMatchObject({ content: `reconnected-${status}` })
      expect(calls).toBe(2)
      expect(harness.events.filter(event => event.type === 'model:protocol' && event.phase === 'fallback')).toHaveLength(0)
    } finally {
      harness.engine.destroy()
      vi.useRealTimers()
    }
  })

  it('reconnects the same protocol after a pre-stream network failure', async () => {
    vi.useFakeTimers()
    let calls = 0
    const harness = createProtocolHarness('anthropic', 'claude-fable-5', async (_url, _headers, _body, onLine) => {
      calls += 1
      if (calls === 1) return { success: false, error: 'fetch failed', receivedStreamData: false }
      onLine(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'network-reconnected' } })}`)
      onLine(`data: ${JSON.stringify({ type: 'message_stop' })}`)
      return { success: true, data: '' }
    })

    try {
      const pending = harness.callModel()
      await vi.runAllTimersAsync()
      await expect(pending).resolves.toMatchObject({ content: 'network-reconnected' })
      expect(calls).toBe(2)
    } finally {
      harness.engine.destroy()
      vi.useRealTimers()
    }
  })

  it('cancels a rate-limit wait without issuing another request', async () => {
    vi.useFakeTimers()
    let calls = 0
    const harness = createProtocolHarness('anthropic', 'claude-fable-5', async () => {
      calls += 1
      return {
        success: false,
        status: 429,
        retryAfterMs: 10_000,
        error: 'HTTP 429: rate limited',
      }
    })

    try {
      const pending = harness.callModel()
      await vi.advanceTimersByTimeAsync(500)
      harness.engine.abort()
      await expect(pending).rejects.toMatchObject({ aborted: true })
      expect(calls).toBe(1)
    } finally {
      harness.engine.destroy()
      vi.useRealTimers()
    }
  })

  it('stops after the bounded same-protocol rate-limit retry budget', async () => {
    vi.useFakeTimers()
    let calls = 0
    const harness = createProtocolHarness('anthropic', 'claude-fable-5', async () => {
      calls += 1
      return {
        success: false,
        status: 429,
        error: 'HTTP 429: rate limited',
      }
    })

    try {
      const pending = harness.callModel()
      await vi.runAllTimersAsync()
      const turn = await pending
      expect(turn.content).toContain('All compatible model protocols failed')
      expect(calls).toBe(4)
      expect(harness.executor.streamMessage).toHaveBeenCalledTimes(4)
      expect(harness.events.filter(event => event.type === 'model:protocol' && event.phase === 'fallback')).toHaveLength(0)
    } finally {
      harness.engine.destroy()
      vi.useRealTimers()
    }
  })

  it('does not replay a 429 after stream bytes have arrived', async () => {
    let calls = 0
    const harness = createProtocolHarness('anthropic', 'claude-fable-5', async (_url, _headers, _body, onLine) => {
      calls += 1
      onLine('event: message_start')
      return {
        success: false,
        status: 429,
        error: 'HTTP 429: rate limited after stream start',
      }
    })

    try {
      const turn = await harness.callModel()
      expect(turn.content).toContain('All compatible model protocols failed')
      expect(calls).toBe(1)
      expect(harness.executor.streamMessage).toHaveBeenCalledOnce()
    } finally {
      harness.engine.destroy()
    }
  })

  it('does not replay a transient HTTP error after the transport reports stream bytes', async () => {
    let calls = 0
    const harness = createProtocolHarness('anthropic', 'claude-fable-5', async () => {
      calls += 1
      return {
        success: false,
        status: 503,
        error: 'HTTP 503: connection ended after response bytes',
        receivedStreamData: true,
      }
    })

    try {
      const turn = await harness.callModel()
      expect(turn.content).toContain('All compatible model protocols failed')
      expect(calls).toBe(1)
    } finally {
      harness.engine.destroy()
    }
  })

  it('uses a Claude model hint and falls back from Messages to Chat on a route mismatch', async () => {
    const harness = createProtocolHarness('custom', 'vendor/claude-fable-5', async (url, headers, _body, onLine) => {
      if (url.endsWith('/messages')) {
        expect(headers.Authorization).toBe('Bearer test-key')
      }
      if (url.endsWith('/messages')) return { success: false, status: 404, error: 'HTTP 404: route not found' }
      onLine(`data: ${JSON.stringify({ choices: [{ delta: { content: 'chat-fallback-ok' }, finish_reason: 'stop' }] })}`)
      onLine('data: [DONE]')
      return { success: true, data: '' }
    })

    try {
      await expect(harness.callModel()).resolves.toMatchObject({ content: 'chat-fallback-ok' })
      expect(vi.mocked(harness.executor.streamMessage).mock.calls.map(call => call[0])).toEqual([
        'https://ai.zyyun.xyz/v1/messages',
        'https://ai.zyyun.xyz/v1/chat/completions',
      ])
      expect(harness.events).toContainEqual(expect.objectContaining({
        type: 'model:protocol',
        phase: 'fallback',
        protocol: 'openai_chat',
      }))
    } finally {
      harness.engine.destroy()
    }
  })

  it('does not cross protocols for authentication failures or after stream bytes arrive', async () => {
    for (const emitBytes of [false, true]) {
      const harness = createProtocolHarness('anthropic', 'claude-fable-5', async (_url, _headers, _body, onLine) => {
        if (emitBytes) onLine('event: message_start')
        return {
          success: false,
          status: emitBytes ? 404 : 401,
          error: emitBytes ? 'HTTP 404: route not found' : 'HTTP 401: invalid API key',
        }
      })
      try {
        const turn = await harness.callModel()
        expect(turn.content).toContain('All compatible model protocols failed')
        expect(harness.executor.streamMessage).toHaveBeenCalledOnce()
      } finally {
        harness.engine.destroy()
      }
    }
  })

  it('falls back to Responses and parses typed function-call streaming events', async () => {
    let responseRequest: Record<string, any> | undefined
    const harness = createProtocolHarness('custom', 'gpt-compatible-model', async (url, _headers, body, onLine) => {
      if (url.endsWith('/chat/completions')) return { success: false, status: 404, error: 'HTTP 404: endpoint not found' }
      expect(url).toBe('https://ai.zyyun.xyz/v1/responses')
      responseRequest = JSON.parse(body)
      onLine(`data: ${JSON.stringify({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'read_file', arguments: '' },
      })}`)
      onLine(`data: ${JSON.stringify({
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        item_id: 'item_1',
        delta: '{"path":"README.md"}',
      })}`)
      onLine(`data: ${JSON.stringify({
        type: 'response.completed',
        response: { usage: { input_tokens: 100, output_tokens: 12, input_tokens_details: { cached_tokens: 20 } }, output: [] },
      })}`)
      return { success: true, data: '' }
    })

    try {
      const turn = await harness.callModel()
      expect(responseRequest?.messages).toBeUndefined()
      expect(responseRequest?.input).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: expect.stringContaining('hello') }),
      ]))
      expect(responseRequest?.tools[0]).toMatchObject({ type: 'function', name: expect.any(String) })
      expect(turn.toolCalls).toEqual([{
        id: 'call_1',
        name: 'read_file',
        arguments: { path: 'README.md' },
      }])
      expect(turn.metadata?.tokens).toMatchObject({ input: 100, output: 12 })
      expect(vi.mocked(harness.executor.streamMessage).mock.calls.map(call => call[0])).toEqual([
        'https://ai.zyyun.xyz/v1/chat/completions',
        'https://ai.zyyun.xyz/v1/responses',
      ])
    } finally {
      harness.engine.destroy()
    }
  })

  it('uses Responses directly for GPT 5 gateways with cache and reasoning usage', async () => {
    let requestBody: Record<string, any> | undefined
    const harness = createProtocolHarness('custom', 'gpt-5.6-sol', async (url, _headers, body, onLine) => {
      expect(url).toBe('https://ai.zyyun.xyz/v1/responses')
      requestBody = JSON.parse(body)
      onLine(`data: ${JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: 'Brief reasoning.' })}`)
      onLine(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Visible answer.' })}`)
      onLine(`data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 12_400,
            output_tokens: 420,
            input_tokens_details: { cached_tokens: 10_000 },
            output_tokens_details: { reasoning_tokens: 384 },
          },
          output: [],
        },
      })}`)
      return { success: true, data: '' }
    })

    try {
      const turn = await harness.callModel()

      expect(harness.executor.streamMessage).toHaveBeenCalledOnce()
      expect(requestBody?.prompt_cache_key).toMatch(/^tf:gpt-5\.6-sol:/)
      expect(requestBody?.text).toEqual({ verbosity: 'low' })
      expect(requestBody?.reasoning).toMatchObject({ summary: 'detailed' })
      expect(turn.content).toBe('Visible answer.')
      expect(turn.metadata?.thinking?.tokenCount).toBe(384)
      expect(turn.metadata?.tokens).toMatchObject({ input: 12_400, output: 420, cached: 10_000 })
    } finally {
      harness.engine.destroy()
    }
  })

  it('keeps runtime context byte-stable across tool-loop calls in one user turn', async () => {
    const requestBodies: Array<Record<string, any>> = []
    const harness = createProtocolHarness('custom', 'gpt-5.5', async (_url, _headers, body, onLine) => {
      requestBodies.push(JSON.parse(body))
      onLine(`data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 80 } },
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        },
      })}`)
      return { success: true, data: '' }
    })

    try {
      await harness.callModel()
      harness.engine.setAppendSystemPrompt('changed-runtime-context')
      await harness.callModel()

      expect(requestBodies[1]?.input).toEqual(requestBodies[0]?.input)
      expect(JSON.stringify(requestBodies[1]?.input)).not.toContain('changed-runtime-context')
      expect(harness.executor.getCodeMap).not.toHaveBeenCalled()

      harness.engine.getSession().turns.push({
        id: 'user-protocol-next',
        role: 'user',
        content: 'next turn',
        timestamp: Date.now() + 1,
      })
      await harness.callModel()

      expect(JSON.stringify(requestBodies[2]?.input)).toContain('changed-runtime-context')
      expect(requestBodies[2]?.input.slice(0, requestBodies[0]?.input.length)).toEqual(requestBodies[0]?.input)
    } finally {
      harness.engine.destroy()
    }
  })

  it('restores the exact persisted runtime context for resumed conversations', async () => {
    let requestBody: Record<string, any> | undefined
    const harness = createProtocolHarness('custom', 'gpt-5.5', async (_url, _headers, body, onLine) => {
      requestBody = JSON.parse(body)
      onLine(`data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 90 } },
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        },
      })}`)
      return { success: true, data: '' }
    })

    try {
      const runtimeContext = '<runtime_context>\npersisted workspace state\n</runtime_context>'
      harness.engine.restoreFromMessages([{
        id: 'restored-user',
        role: 'user',
        content: 'continue',
        timestamp: 1,
        metadata: { runtimeContext },
      }])
      harness.engine.setAppendSystemPrompt('must-not-replace-the-persisted-context')

      await harness.callModel()

      expect(harness.engine.getSession().turns[0]?.metadata?.runtimeContext).toBe(runtimeContext)
      expect(JSON.stringify(requestBody?.input)).toContain('persisted workspace state')
      expect(JSON.stringify(requestBody?.input)).not.toContain('must-not-replace-the-persisted-context')
    } finally {
      harness.engine.destroy()
    }
  })

  it('recovers a reasoning summary delivered only in response.completed', async () => {
    const harness = createProtocolHarness('custom', 'gpt-5.5', async (_url, _headers, _body, onLine) => {
      onLine(`data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          usage: { input_tokens: 100, output_tokens: 40, output_tokens_details: { reasoning_tokens: 24 } },
          output: [
            { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Checking the completed response.' }] },
            { type: 'message', content: [{ type: 'output_text', text: 'Visible result.' }] },
          ],
        },
      })}`)
      return { success: true, data: '' }
    })

    try {
      const turn = await harness.callModel()
      expect(turn.content).toBe('Visible result.')
      expect(turn.metadata?.thinking?.content).toBe('Checking the completed response.')
      expect(harness.events).toContainEqual({ type: 'stream:thinking_delta', text: 'Checking the completed response.' })
    } finally {
      harness.engine.destroy()
    }
  })

  it('persists partial Responses output when the provider ends incomplete', async () => {
    const harness = createProtocolHarness('custom', 'gpt-5.5', async (_url, _headers, _body, onLine) => {
      onLine(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Partial but useful.' })}`)
      onLine(`data: ${JSON.stringify({
        type: 'response.incomplete',
        response: { incomplete_details: { reason: 'max_output_tokens' } },
      })}`)
      return { success: true, data: '' }
    })

    try {
      const turn = await harness.callModel()
      expect(turn).toMatchObject({
        content: 'Partial but useful.',
        metadata: expect.objectContaining({ interrupted: true }),
      })
      expect(harness.events).toContainEqual({ type: 'stream:end', interrupted: true })
    } finally {
      harness.engine.destroy()
    }
  })

  it('reports every attempted protocol and URL when all candidates fail', async () => {
    const harness = createProtocolHarness('custom', 'gpt-compatible-model', async url => {
      if (url.endsWith('/chat/completions')) return { success: false, status: 404, error: 'HTTP 404: endpoint not found' }
      if (url.endsWith('/responses')) return { success: false, status: 415, error: 'HTTP 415: unsupported request format' }
      return { success: false, status: 401, error: 'HTTP 401: invalid API key' }
    })

    try {
      const turn = await harness.callModel()
      expect(turn.content).toContain('https://ai.zyyun.xyz/v1/chat/completions')
      expect(turn.content).toContain('https://ai.zyyun.xyz/v1/responses')
      expect(turn.content).toContain('https://ai.zyyun.xyz/v1/messages')
      expect(harness.executor.streamMessage).toHaveBeenCalledTimes(3)
    } finally {
      harness.engine.destroy()
    }
  })
})

describe('context compaction boundaries', () => {
  it('clears a stale forced-compaction flag when restoring a terminal state', () => {
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: '',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, process.cwd())
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      workspacePath: process.cwd(),
      gitEnabled: false,
    }, new NodeToolExecutor(process.cwd()), stateProvider)
    const state = {
      id: 'compact-state-1',
      phase: 'interrupted' as const,
      source: 'compact' as const,
      startedAt: 1,
      updatedAt: 2,
      elapsedMs: 1,
      recoverable: true,
    }

    try {
      engine.setContextCompactionState(state)
      expect((engine as any).forceContextCompactionBeforeNextCall).toBe(true)
      engine.setContextCompactionState({ ...state, phase: 'completed', recoverable: false })
      expect((engine as any).forceContextCompactionBeforeNextCall).toBe(false)
      engine.setContextCompactionState(null)
      expect((engine as any).forceContextCompactionBeforeNextCall).toBe(false)
    } finally {
      engine.destroy()
    }
  })

  it('counts runtime context and provider reasoning without double counting the display trace', () => {
    expect(countTurnContextChars({
      id: 'reasoning-turn',
      role: 'assistant',
      content: '',
      timestamp: 1,
      metadata: {
        runtimeContext: 'ctx',
        thinking: { content: 'reasoning' },
        rawReasoningPayload: {
          provider: 'openai-compatible',
          blocks: [],
          reasoningContent: 'reasoning',
        },
      },
    })).toBe('ctx'.length + 'reasoning'.length)

    expect(countTurnContextChars({
      id: 'fallback-thinking',
      role: 'assistant',
      content: '',
      timestamp: 2,
      metadata: { thinking: { content: 'fallback' } },
    })).toBe('fallback'.length)
  })

  it('includes diff snapshots in the context budget', () => {
    const before = 'a'.repeat(120)
    const after = 'b'.repeat(80)
    const count = countTurnContextChars({
      id: 'diff-turn',
      role: 'tool_result',
      content: 'edit_file: ok',
      timestamp: 3,
      toolResults: [{
        toolCallId: 'edit-1',
        name: 'edit_file',
        output: 'ok',
        isError: false,
        changeSummary: {
          path: 'src/example.ts',
          operation: 'edit',
          before,
          after,
          preview: 'new',
          oldPreview: 'old',
        },
      }],
    })

    expect(count).toBeGreaterThan(before.length + after.length)
  })

  it('keeps assistant tool calls together with their tool results', () => {
    const turns = [
      { id: 'u1', role: 'user' as const, content: 'start', timestamp: 1 },
      { id: 'a1', role: 'assistant' as const, content: '', timestamp: 2, toolCalls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'a.ts' } }] },
      { id: 'tr1', role: 'tool_result' as const, content: 'result', timestamp: 3, toolResults: [{ toolCallId: 'tc1', name: 'read_file', output: 'result', isError: false }] },
      { id: 'a2', role: 'assistant' as const, content: 'done', timestamp: 4 },
    ]

    const split = splitTurnsForCompaction(turns, 2)

    expect(split.oldTurns.map(turn => turn.id)).toEqual(['u1'])
    expect(split.recentTurns.map(turn => turn.id)).toEqual(['a1', 'tr1', 'a2'])
  })

  it('reuses a persisted summary and carries preserved files into the next run', async () => {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      temperature: 0,
      maxTokens: 4096,
      workspacePath: workspace,
    }, new NodeToolExecutor(workspace), stateProvider)
    const oldTurns: AgentTurn[] = [
      { id: 'u-old', role: 'user', content: 'inspect the implementation', timestamp: 1 },
      {
        id: 'a-read',
        role: 'assistant',
        content: '',
        timestamp: 2,
        toolCalls: [{ id: 'read-1', name: 'read_file', arguments: { path: 'src/important.ts' } }],
      },
      {
        id: 'tr-read',
        role: 'tool_result',
        content: '',
        timestamp: 3,
        toolResults: [{ toolCallId: 'read-1', name: 'read_file', output: 'export const important = true', isError: false }],
      },
      { id: 'a-old', role: 'assistant', content: 'I found the owner.', timestamp: 4 },
    ]
    const recentTurns: AgentTurn[] = Array.from({ length: 10 }, (_, index) => ({
      id: `recent-${index}`,
      role: 'user' as const,
      content: `follow up ${index}`,
      timestamp: index + 5,
    }))
    engine.restoreFromTurns([...oldTurns, ...recentTurns])
    stateProvider.setContextSegments([{
      startMessageId: 'u-old',
      endMessageId: 'a-old',
      summary: '<continuation_summary>persisted state</continuation_summary>',
      isModelGenerated: true,
      kind: 'compact',
      originalCharCount: 100,
      isValid: true,
      createdAt: 1,
      coveredTurnIds: oldTurns.map(turn => turn.id),
    }])
    const generateSummary = vi.spyOn(engine as any, 'generateContinuationSummary')

    try {
      await engine.compactContext()

      expect(generateSummary).not.toHaveBeenCalled()
      expect(engine.getSession().turns.map(turn => turn.id)).toEqual(recentTurns.map(turn => turn.id))
      expect(stateProvider.getContextReservoir()).toHaveLength(1)

      let preservedAtModelCall: Array<{ path: string; content: string }> = []
      vi.spyOn(engine as any, 'callModel').mockImplementation(async () => {
        preservedAtModelCall = (engine as any).preservedFiles
        return { id: 'final', role: 'assistant', content: 'done', timestamp: Date.now() } satisfies AgentTurn
      })
      await engine.run('continue from the compacted context')

      expect(preservedAtModelCall).toEqual([{
        path: 'src/important.ts',
        content: 'export const important = true',
      }])
    } finally {
      engine.destroy()
    }
  })

  it('creates a deterministic development handoff when summary generation is unavailable', async () => {
    const workspace = process.cwd()
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: '',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, workspace)
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      temperature: 0,
      maxTokens: 4096,
      workspacePath: workspace,
      gitEnabled: false,
    }, new NodeToolExecutor(workspace), stateProvider)
    const oldTurns: AgentTurn[] = [
      { id: 'u-old', role: 'user', content: 'improve context compaction reliability', timestamp: 1 },
      {
        id: 'a-edit',
        role: 'assistant',
        content: 'Added a handoff checkpoint.',
        timestamp: 2,
        toolCalls: [{ id: 'edit-1', name: 'apply_patch', arguments: { path: 'src/core/contextCompaction.ts' } }],
      },
      {
        id: 'tr-edit',
        role: 'tool_result',
        content: '',
        timestamp: 3,
        toolResults: [{
          toolCallId: 'edit-1',
          name: 'apply_patch',
          output: 'ok',
          isError: false,
          changeSummary: { path: 'src/core/contextCompaction.ts', operation: 'edit' },
        }],
      },
    ]
    const recentTurns: AgentTurn[] = Array.from({ length: 10 }, (_, index) => ({
      id: 'recent-' + index,
      role: 'user' as const,
      content: index === 9 ? 'continue after compression without restarting' : 'follow up ' + index,
      timestamp: index + 4,
    }))
    engine.restoreFromTurns([...oldTurns, ...recentTurns])

    try {
      await engine.compactContext()

      expect(engine.getSession().turns.map(turn => turn.id)).toEqual(recentTurns.map(turn => turn.id))
      const [segment] = stateProvider.getContextSegments()
      expect(segment?.handoff?.summarySource).toBe('deterministic')
      expect(segment?.handoff?.document).toContain('TurboFlux Development Handoff')
      expect(segment?.handoff?.document).toContain('src/core/contextCompaction.ts')
      expect(segment?.handoff?.document).toContain('continue after compression without restarting')
      expect(segment?.summary).toContain('<continuation_summary>')
    } finally {
      engine.destroy()
    }
  })

  it('emits durable compaction lifecycle events and commits only after summarizing', async () => {
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: '',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, process.cwd())
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      temperature: 0,
      maxTokens: 4096,
      workspacePath: process.cwd(),
      gitEnabled: false,
    }, new NodeToolExecutor(process.cwd()), stateProvider)
    engine.restoreFromTurns([
      { id: 'compact-user-old', role: 'user', content: 'old objective', timestamp: 1 },
      { id: 'compact-assistant-old', role: 'assistant', content: 'old progress', timestamp: 2 },
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `compact-recent-${index}`,
        role: 'user' as const,
        content: `recent ${index}`,
        timestamp: index + 3,
      })),
    ])
    const events: AgentEventType[] = []
    engine.subscribe(event => events.push(event))

    try {
      await engine.compactContext()

      expect(events.map(event => event.type)).toEqual(expect.arrayContaining([
        'context:compaction_started',
        'context:compaction_summarizing',
        'context:compaction_fallback',
        'context:compaction_committing',
        'context:segment_created',
        'context:compaction_completed',
      ]))
      const completed = events.find(event => event.type === 'context:compaction_completed')
      expect(completed).toMatchObject({
        state: {
          phase: 'completed',
          recoverable: false,
          summarySource: 'deterministic',
          startMessageId: 'compact-user-old',
        },
      })
      expect(engine.getContextCompactionState()?.phase).toBe('completed')
      expect(engine.getContextReservoir()[0]?.turns.map(turn => turn.id)).toEqual([
        'compact-user-old',
        'compact-assistant-old',
      ])
    } finally {
      engine.destroy()
    }
  })

  it('marks an in-flight compaction interrupted without dropping original turns', async () => {
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: '',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 100_000,
      maxTokens: 4096,
    }, process.cwd())
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      temperature: 0,
      maxTokens: 4096,
      workspacePath: process.cwd(),
      gitEnabled: false,
    }, new NodeToolExecutor(process.cwd()), stateProvider)
    const turns: AgentTurn[] = [
      { id: 'interrupt-old', role: 'user', content: 'preserve me', timestamp: 1 },
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `interrupt-recent-${index}`,
        role: 'user' as const,
        content: `recent ${index}`,
        timestamp: index + 2,
      })),
    ]
    engine.restoreFromTurns(turns)
    const originalWorkspaceSnapshot = (engine as any).collectContinuationWorkspaceSnapshot.bind(engine)
    let releaseSnapshot: ((snapshot: unknown) => void) | undefined
    vi.spyOn(engine as any, 'collectContinuationWorkspaceSnapshot').mockImplementation(() => new Promise(resolve => {
      releaseSnapshot = resolve
    }))
    const events: AgentEventType[] = []
    engine.subscribe(event => events.push(event))

    try {
      const pending = engine.compactContext()
      await Promise.resolve()
      await Promise.resolve()
      engine.abort()
      releaseSnapshot?.(await originalWorkspaceSnapshot())
      await expect(pending).rejects.toMatchObject({ aborted: true })
      expect(events.some(event => event.type === 'context:compaction_interrupted')).toBe(true)
      expect(engine.getContextCompactionState()).toMatchObject({ phase: 'interrupted', recoverable: true })
      expect(engine.getSession().turns.map(turn => turn.id)).toEqual(turns.map(turn => turn.id))
    } finally {
      engine.destroy()
    }
  })
})
