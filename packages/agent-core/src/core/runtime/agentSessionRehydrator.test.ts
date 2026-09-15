import { describe, expect, it } from 'vitest'
import type { AgentTurn } from '../../shared/agentTypes'
import { TaskManager } from '../taskManager'
import { AgentSessionRehydrator } from './agentSessionRehydrator'

describe('AgentSessionRehydrator', () => {
  it('preserves interrupted assistant metadata across persistence rehydration', () => {
    const rehydrator = new AgentSessionRehydrator()
    const messages = rehydrator.messagesFromTurns([{
      id: 'recovered-assistant-1',
      role: 'assistant',
      content: 'partial answer',
      timestamp: 1,
      metadata: {
        interrupted: true,
        interruption: { kind: 'stop', resumable: false },
        thinking: { content: 'partial reasoning', status: 'interrupted' },
      },
    }])
    const turns = rehydrator.rehydrateMessages(messages, {
      systemTurns: [],
      taskManager: new TaskManager(),
      isToolOutputFailure: () => false,
    })

    expect(turns[0]?.metadata).toMatchObject({
      interrupted: true,
      interruption: { kind: 'stop', resumable: false },
      thinking: { content: 'partial reasoning', status: 'interrupted' },
    })
  })

  it('rebuilds tool results, interruption metadata, and provider reasoning payloads', () => {
    const rehydrator = new AgentSessionRehydrator()
    const turns = rehydrator.rehydrateMessages([{
      id: 'assistant-1',
      role: 'assistant',
      content: 'partial answer',
      timestamp: 10,
      metadata: {
        rawReasoningPayload: {
          provider: 'openai',
          blocks: [{ type: 'reasoning', text: 'trace' }],
          reasoningContent: 'provider-reasoning',
        },
        thinking: { content: 'thinking', source: 'provider', isStreaming: true },
        toolCalls: [{
          id: 'tool-1',
          name: 'read_file',
          arguments: { path: 'README.md' },
          result: 'Paused by user',
          status: 'cancelled',
        }],
      },
    }], {
      systemTurns: [],
      taskManager: new TaskManager(),
      isToolOutputFailure: () => false,
    })

    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({
      id: 'assistant-1',
      toolCalls: [{ id: 'tool-1', name: 'read_file' }],
      metadata: {
        thinking: { content: 'thinking', isStreaming: false },
        rawReasoningPayload: { reasoningContent: 'provider-reasoning' },
      },
    })
    expect(turns[1]?.toolResults?.[0]).toMatchObject({
      toolCallId: 'tool-1',
      errorKind: 'abort',
      interruption: { kind: 'pause' },
    })
  })

  it('preserves system turns and deterministically fills missing timestamps', () => {
    const rehydrator = new AgentSessionRehydrator()
    const systemTurn: AgentTurn = { id: 'system-1', role: 'system', content: 'system', timestamp: 1 }
    const turns = rehydrator.rehydrateMessages([
      { id: 'user-1', role: 'user', content: 'first' },
      { id: 'assistant-1', role: 'assistant', content: 'second' },
    ], {
      systemTurns: [systemTurn],
      taskManager: new TaskManager(),
      isToolOutputFailure: () => false,
      now: () => 100,
    })

    expect(turns.map(turn => turn.id)).toEqual(['system-1', 'user-1', 'assistant-1'])
    expect(turns.map(turn => turn.timestamp)).toEqual([1, 100, 101])
  })

  it('restores completed task calls while rejecting failed task history', () => {
    const rehydrator = new AgentSessionRehydrator()
    const taskManager = new TaskManager()
    rehydrator.rehydrateMessages([{
      id: 'assistant-tasks',
      role: 'assistant',
      content: '',
      timestamp: 20,
      metadata: {
        workRunId: 'run-1',
        toolCalls: [
          {
            name: 'create_task',
            arguments: { title: 'Keep me', priority: 'high' },
            result: JSON.stringify({ id: 'task-1', status: 'completed' }),
            status: 'completed',
          },
          {
            name: 'create_task',
            arguments: { title: 'Drop me' },
            result: 'failed',
            status: 'error',
          },
        ],
      },
    }], {
      systemTurns: [],
      taskManager,
      isToolOutputFailure: (_name, output) => output === 'failed',
    })

    expect(taskManager.getAllTasks()).toEqual([
      expect.objectContaining({ id: 'task-1', title: 'Keep me', status: 'completed', progress: 100 }),
    ])
  })

  it('joins standalone tool-result turns back onto their original calls', () => {
    const rehydrator = new AgentSessionRehydrator()
    const messages = rehydrator.messagesFromTurns([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [{ id: 'tool-1', name: 'write_file', arguments: { path: 'a.txt' } }],
      },
      {
        id: 'result-1',
        role: 'tool_result',
        content: 'ok',
        timestamp: 2,
        toolResults: [{
          toolCallId: 'tool-1',
          name: 'write_file',
          output: 'written',
          isError: false,
          changeSummary: { path: 'a.txt', operation: 'write', addedLines: 1 },
        }],
      },
    ])

    expect(messages[0]?.metadata?.toolCalls?.[0]).toMatchObject({
      id: 'tool-1',
      result: 'written',
      status: 'completed',
      changeSummary: { path: 'a.txt', operation: 'write' },
    })
  })
})
