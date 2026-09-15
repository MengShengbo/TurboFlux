import { describe, expect, it, vi } from 'vitest'
import { AgentEngine, type AgentEventType } from './agentEngine'
import { DefaultAgentStateProvider } from './runtime/stateProvider'
import type { ToolExecutor } from '../tools/executor'

describe('model response mode declaration', () => {
  it.each(['anthropic', 'responses'] as const)('uses the %s protocol for the first declaration and then restores normal requests', async protocol => {
    const bodies: Record<string, any>[] = []
    const streamMessage = vi.fn(async (_url, _headers, serialized, onLine) => {
      const body = JSON.parse(serialized)
      bodies.push(body)
      const declaring = bodies.length === 1
      const send = (value: unknown) => onLine(`data: ${JSON.stringify(value)}`)
      if (protocol === 'anthropic') {
        send({ type: 'content_block_start', index: 0, content_block: declaring
          ? { type: 'tool_use', id: 'mode-1', name: 'set_response_mode', input: { mode: 'task' } }
          : { type: 'text', text: 'Done' } })
        send({ type: 'content_block_stop', index: 0 })
        send({ type: 'message_delta', delta: { stop_reason: declaring ? 'tool_use' : 'end_turn' } })
        send({ type: 'message_stop' })
      } else {
        if (declaring) send({ type: 'response.output_item.added', output_index: 0, item: {
          type: 'function_call', id: 'mode-item', call_id: 'mode-1', name: 'set_response_mode', arguments: '{"mode":"task"}',
        } })
        send({ type: 'response.completed', response: { output: declaring ? [] : [{ type: 'message', content: [{ type: 'output_text', text: 'Done' }] }] } })
      }
      return { success: true, data: '' }
    })
    const state = new DefaultAgentStateProvider({
      provider: protocol === 'anthropic' ? 'anthropic' : 'openai', apiKey: 'test', baseUrl: 'http://example.test',
      model: protocol === 'anthropic' ? 'claude-opus-4-1' : 'gpt-5-codex', reasoning: { enabled: false, effort: 'none' },
      contextWindow: 100_000, maxTokens: 4096,
    }, process.cwd())
    const engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', gitEnabled: false, maxToolRounds: 1 }, { streamMessage } as unknown as ToolExecutor, state)
    vi.spyOn(engine as any, 'prepareContextWindow').mockResolvedValue(undefined)
    try {
      await engine.run('Inspect')
      expect(bodies).toHaveLength(2)
      expect(bodies[0].tool_choice).toEqual(protocol === 'anthropic'
        ? { type: 'tool', name: 'set_response_mode' }
        : { type: 'function', name: 'set_response_mode' })
      expect(bodies[1].tool_choice).toEqual(protocol === 'anthropic' ? { type: 'auto' } : 'auto')
      expect(engine.getWorkExecutionSnapshot().runs[0]).toMatchObject({ responseMode: 'task', status: 'completed' })
    } finally {
      engine.destroy()
    }
  })

  it.each(['chat', 'task'] as const)('declares %s before the normal response without exposing protocol output', async mode => {
    const bodies: Record<string, any>[] = []
    const events: AgentEventType[] = []
    const streamMessage = vi.fn(async (_url, _headers, serialized, onLine) => {
      const body = JSON.parse(serialized)
      bodies.push(body)
      if (body.tool_choice?.function?.name === 'set_response_mode') {
        onLine(`data: ${JSON.stringify({ choices: [{ delta: {
          content: 'Internal classification text',
          tool_calls: [{ index: 0, id: `mode-${bodies.length}`, type: 'function', function: { name: 'set_response_mode', arguments: JSON.stringify({ mode }) } }],
        }, finish_reason: 'tool_calls' }] })}`)
      } else {
        onLine(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Visible answer' }, finish_reason: 'stop' }] })}`)
      }
      onLine('data: [DONE]')
      return { success: true, data: '' }
    })
    const state = new DefaultAgentStateProvider({ provider: 'custom', apiKey: 'test', baseUrl: 'http://example.test', model: 'test-model', contextWindow: 100_000, maxTokens: 4096 }, process.cwd())
    const engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', gitEnabled: false }, { streamMessage } as unknown as ToolExecutor, state)
    engine.subscribe(event => events.push(event))
    vi.spyOn(engine as any, 'prepareContextWindow').mockResolvedValue(undefined)
    try {
      await engine.run('First request')
      await engine.waitUntilIdle()
      await engine.run('Second request')
      expect(bodies.map(body => body.tool_choice)).toEqual([
        { type: 'function', function: { name: 'set_response_mode' } }, 'auto',
        { type: 'function', function: { name: 'set_response_mode' } }, 'auto',
      ])
      expect(bodies[0].parallel_tool_calls).toBe(false)
      expect(bodies[1].tools.map((tool: any) => tool.function.name)).toContain('read_file')
      expect(events.filter(event => event.type === 'stream:delta').map(event => event.text)).toEqual(['Visible answer', 'Visible answer'])
      expect(engine.getWorkExecutionSnapshot().runs.map(run => [run.responseMode, run.presentation, run.status])).toEqual([
        [mode, mode === 'task' ? 'work' : 'conversation', 'completed'],
        [mode, mode === 'task' ? 'work' : 'conversation', 'completed'],
      ])
      expect(Object.values(engine.getWorkExecutionSnapshot().runs[0].activities)).toHaveLength(0)
    } finally {
      engine.destroy()
    }
  })

  it('rejects an undeclared response before executing tools or displaying its text', async () => {
    const events: AgentEventType[] = []
    const streamMessage = vi.fn(async (_url, _headers, _body, onLine) => {
      onLine(`data: ${JSON.stringify({ choices: [{ delta: {
        content: 'Unclassified content',
        tool_calls: [{ index: 0, id: 'invalid', type: 'function', function: { name: 'read_file', arguments: '{"path":"secret.txt"}' } }],
      }, finish_reason: 'tool_calls' }] })}`)
      onLine('data: [DONE]')
      return { success: true, data: '' }
    })
    const readFile = vi.fn()
    const state = new DefaultAgentStateProvider({ provider: 'custom', apiKey: 'test', baseUrl: 'http://example.test', model: 'test-model', contextWindow: 100_000, maxTokens: 4096 }, process.cwd())
    const engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', gitEnabled: false }, { streamMessage, readFile } as unknown as ToolExecutor, state)
    engine.subscribe(event => events.push(event))
    vi.spyOn(engine as any, 'prepareContextWindow').mockResolvedValue(undefined)
    try {
      await expect(engine.run('Inspect')).rejects.toThrow()
      expect(readFile).not.toHaveBeenCalled()
      expect(events.filter(event => event.type === 'stream:delta')).toEqual([])
      expect(engine.getWorkExecutionSnapshot().runs[0].status).toBe('failed')
      expect(engine.getWorkExecutionSnapshot().runs[0].responseMode).toBeUndefined()
    } finally {
      engine.destroy()
    }
  })
})
