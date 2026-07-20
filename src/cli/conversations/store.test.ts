import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTurn } from '../../shared/agentTypes'
import type { ConversationMeta, PersistedConversation } from './types'
import {
  appendConversationJournal,
  deleteConversation,
  getConversationsDir,
  listConversations,
  loadConversation,
  sameWorkspacePath,
  saveConversation,
} from './store'

function meta(id: string): ConversationMeta {
  return {
    id,
    title: 'Journal test',
    workspacePath: process.cwd(),
    createdAt: 100,
    updatedAt: 100,
    mode: 'vibe',
    model: 'test-model',
    provider: 'custom',
    turnCount: 0,
  }
}

function turn(id: string, role: AgentTurn['role'], content: string, timestamp: number): AgentTurn {
  return { id, role, content, timestamp }
}

describe.sequential('conversation journal store', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'turboflux-conversations-'))
    process.env.TURBOFLUX_CONVERSATIONS_DIR = directory
  })

  afterEach(() => {
    delete process.env.TURBOFLUX_CONVERSATIONS_DIR
    rmSync(directory, { recursive: true, force: true })
  })

  it('matches equivalent paths and rejects different workspaces', () => {
    expect(sameWorkspacePath('.', process.cwd())).toBe(true)
    expect(sameWorkspacePath(process.cwd(), `${process.cwd()}-other`)).toBe(false)
  })

  it('keeps legacy JSON conversations readable', () => {
    const conversation: PersistedConversation = {
      ...meta('legacy-1'),
      turnCount: 2,
      turns: [
        turn('user-1', 'user', 'hello', 100),
        turn('assistant-1', 'assistant', 'hi', 101),
      ],
    }
    mkdirSync(getConversationsDir(), { recursive: true })
    writeFileSync(join(getConversationsDir(), 'legacy-1.json'), JSON.stringify(conversation), 'utf-8')

    expect(loadConversation('legacy-1')).toMatchObject({ id: 'legacy-1', turnCount: 2 })
    expect(listConversations(process.cwd()).map(item => item.id)).toEqual(['legacy-1'])
  })

  it('appends snapshots and replays the newest state', () => {
    const first: PersistedConversation = {
      ...meta('snapshot-1'),
      turnCount: 1,
      turns: [turn('user-1', 'user', 'first', 100)],
    }
    const second: PersistedConversation = {
      ...first,
      updatedAt: 200,
      turnCount: 2,
      turns: [...first.turns, turn('assistant-1', 'assistant', 'second', 200)],
    }

    saveConversation(first)
    saveConversation(second)

    expect(loadConversation('snapshot-1')?.turns.map(item => item.content)).toEqual(['first', 'second'])
    expect(deleteConversation('snapshot-1')).toBe(true)
    expect(loadConversation('snapshot-1')).toBeNull()
  })

  it('recovers a partial assistant stream and ignores a damaged tail line', async () => {
    appendConversationJournal('stream-1', { version: 1, type: 'meta', timestamp: 100, meta: meta('stream-1') })
    appendConversationJournal('stream-1', { version: 1, type: 'turn', timestamp: 101, turn: turn('user-1', 'user', 'build it', 101) })
    appendConversationJournal('stream-1', { version: 1, type: 'stream_start', timestamp: 102 })
    appendConversationJournal('stream-1', { version: 1, type: 'stream_delta', timestamp: 103, text: 'partial answer' })
    appendFileSync(join(directory, 'stream-1.jsonl'), '{"version":1,"type":"stream_delta"', 'utf-8')
    vi.resetModules()
    const restartedStore = await import('./store')
    restartedStore.appendConversationJournal('stream-1', { version: 1, type: 'stream_delta', timestamp: 104, text: ' after tail damage' })

    const recovered = loadConversation('stream-1')

    expect(recovered?.turns.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'partial answer after tail damage',
      metadata: { interrupted: true },
    })
    expect(recovered?.recovery).toMatchObject({ interrupted: true, truncatedJournal: true })
  })

  it('recovers interrupted provider reasoning separately from the answer', () => {
    appendConversationJournal('thinking-1', { version: 1, type: 'meta', timestamp: 100, meta: meta('thinking-1') })
    appendConversationJournal('thinking-1', { version: 1, type: 'turn', timestamp: 101, turn: turn('user-1', 'user', 'inspect it', 101) })
    appendConversationJournal('thinking-1', { version: 1, type: 'stream_start', timestamp: 102 })
    appendConversationJournal('thinking-1', { version: 1, type: 'stream_thinking_delta', timestamp: 103, text: 'checking architecture ' })
    appendConversationJournal('thinking-1', { version: 1, type: 'stream_thinking_delta', timestamp: 104, text: 'and tests' })
    appendConversationJournal('thinking-1', { version: 1, type: 'stream_delta', timestamp: 105, text: 'partial answer' })

    const recovered = loadConversation('thinking-1')

    expect(recovered?.turns.at(-1)).toMatchObject({
      content: 'partial answer',
      metadata: {
        interrupted: true,
        thinking: { content: 'checking architecture and tests', status: 'interrupted' },
      },
    })
  })

  it('closes unresolved tool calls with synthetic abort results', () => {
    const assistant: AgentTurn = {
      ...turn('assistant-1', 'assistant', '', 102),
      toolCalls: [{ id: 'tool-1', name: 'write_file', arguments: { path: 'a.ts', content: 'x' } }],
    }
    appendConversationJournal('tools-1', { version: 1, type: 'meta', timestamp: 100, meta: meta('tools-1') })
    appendConversationJournal('tools-1', { version: 1, type: 'turn', timestamp: 101, turn: turn('user-1', 'user', 'edit', 101) })
    appendConversationJournal('tools-1', { version: 1, type: 'turn', timestamp: 102, turn: assistant })
    appendConversationJournal('tools-1', { version: 1, type: 'tool_call', timestamp: 103, toolCall: assistant.toolCalls![0] })

    const recovered = loadConversation('tools-1')
    const resultTurn = recovered?.turns.find(item => item.role === 'tool_result')

    expect(resultTurn?.toolResults?.[0]).toMatchObject({
      toolCallId: 'tool-1',
      isError: true,
      errorKind: 'abort',
    })
    expect(recovered?.recovery).toMatchObject({ interrupted: true, unresolvedToolCalls: 1 })
  })

  it('replays recorded tool results without reporting them as unresolved', () => {
    const assistant: AgentTurn = {
      ...turn('assistant-1', 'assistant', '', 102),
      toolCalls: [{ id: 'tool-1', name: 'read_file', arguments: { path: 'a.ts' } }],
    }
    appendConversationJournal('tool-result-1', { version: 1, type: 'meta', timestamp: 100, meta: meta('tool-result-1') })
    appendConversationJournal('tool-result-1', { version: 1, type: 'turn', timestamp: 101, turn: turn('user-1', 'user', 'read', 101) })
    appendConversationJournal('tool-result-1', { version: 1, type: 'turn', timestamp: 102, turn: assistant })
    appendConversationJournal('tool-result-1', {
      version: 1,
      type: 'tool_result',
      timestamp: 103,
      toolResult: { toolCallId: 'tool-1', name: 'read_file', output: 'content', isError: false },
    })

    const recovered = loadConversation('tool-result-1')

    expect(recovered?.turns.find(item => item.role === 'tool_result')?.toolResults?.[0]).toMatchObject({
      toolCallId: 'tool-1',
      output: 'content',
      isError: false,
    })
    expect(recovered?.recovery).toMatchObject({ interrupted: false, unresolvedToolCalls: 0 })
  })

  it('inserts recovered tool results before a later interrupted assistant stream', () => {
    const assistant: AgentTurn = {
      ...turn('assistant-1', 'assistant', '', 102),
      toolCalls: [{ id: 'tool-1', name: 'read_file', arguments: { path: 'a.ts' } }],
    }
    appendConversationJournal('ordered-1', { version: 1, type: 'meta', timestamp: 100, meta: meta('ordered-1') })
    appendConversationJournal('ordered-1', { version: 1, type: 'turn', timestamp: 101, turn: turn('user-1', 'user', 'read then explain', 101) })
    appendConversationJournal('ordered-1', { version: 1, type: 'turn', timestamp: 102, turn: assistant })
    appendConversationJournal('ordered-1', {
      version: 1,
      type: 'tool_result',
      timestamp: 103,
      toolResult: { toolCallId: 'tool-1', name: 'read_file', output: 'content', isError: false },
    })
    appendConversationJournal('ordered-1', { version: 1, type: 'stream_start', timestamp: 104 })
    appendConversationJournal('ordered-1', { version: 1, type: 'stream_delta', timestamp: 105, text: 'partial explanation' })

    const recovered = loadConversation('ordered-1')

    expect(recovered?.turns.map(item => item.role)).toEqual(['user', 'assistant', 'tool_result', 'assistant'])
    expect(recovered?.turns.at(-1)).toMatchObject({ content: 'partial explanation', metadata: { interrupted: true } })
  })
})
