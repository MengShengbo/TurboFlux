import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTurn } from '../../shared/agentTypes'
import type { ContextCompactionState } from '../../state/types'
import type { ConversationMeta, PersistedConversation } from './types'
import type { AnyConversationEvent } from '../events/index'
import { ModelSurface } from '../../core/modelSurface'
import {
  appendConversationJournal,
  ConversationStore,
  deleteConversation,
  deleteConversationAsync,
  getConversationsDir,
  listConversations,
  listConversationsAsync,
  loadConversation,
  loadConversationAsync,
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

  it('never treats the conversation catalog or malformed JSON as a conversation', async () => {
    mkdirSync(getConversationsDir(), { recursive: true })
    writeFileSync(join(getConversationsDir(), '.conversation-catalog-v1.json'), JSON.stringify({
      version: 1,
      entries: [{ meta: meta('indexed-only'), visible: true }],
    }), 'utf8')
    writeFileSync(join(getConversationsDir(), 'malformed.json'), JSON.stringify({ id: 'malformed' }), 'utf8')

    expect(listConversations(process.cwd())).toEqual([])
    await expect(listConversationsAsync(process.cwd())).resolves.toEqual([])
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

  it('keeps two explicit conversation stores isolated in one process', () => {
    const firstStore = new ConversationStore(join(directory, 'profile-a'))
    const secondStore = new ConversationStore(join(directory, 'profile-b'))
    const first: PersistedConversation = {
      ...meta('shared-id'),
      title: 'Profile A',
      turnCount: 1,
      turns: [turn('user-a', 'user', 'only-a', 100)],
    }
    const second: PersistedConversation = {
      ...meta('shared-id'),
      title: 'Profile B',
      turnCount: 1,
      turns: [turn('user-b', 'user', 'only-b', 100)],
    }

    firstStore.save(first, { compact: true })
    secondStore.save(second, { compact: true })

    expect(firstStore.load('shared-id')?.title).toBe('Profile A')
    expect(secondStore.load('shared-id')?.title).toBe('Profile B')
    expect(firstStore.list().map(item => item.title)).toEqual(['Profile A'])
    expect(secondStore.list().map(item => item.title)).toEqual(['Profile B'])
  })

  it('rejects a canonical sequence gap during journal replay', () => {
    appendConversationJournal('canonical-gap', {
      version: 1,
      type: 'meta',
      timestamp: 100,
      meta: meta('canonical-gap'),
    })
    const event = (seq: number, eventId: string): AnyConversationEvent => ({
      schemaVersion: 1,
      eventId,
      conversationId: 'canonical-gap',
      threadId: 'canonical-gap',
      seq,
      at: 100 + seq,
      source: 'runtime',
      provenance: 'live',
      type: 'run.completed',
      payload: { outcome: 'completed' },
    })
    appendConversationJournal('canonical-gap', { version: 3, type: 'canonical_event', timestamp: 101, event: event(1, 'event-1') })
    appendConversationJournal('canonical-gap', { version: 3, type: 'canonical_event', timestamp: 103, event: event(3, 'event-3') })

    const recovered = loadConversation('canonical-gap')
    expect(recovered?.canonicalEvents?.map(item => item.seq)).toEqual([1])
    expect(recovered?.recovery?.truncatedJournal).toBe(true)
  })

  it('redacts computer payloads at the final JSONL write boundary', () => {
    const computerCall = {
      id: 'computer-call-1',
      name: 'computer__click',
      arguments: {
        x: 321.25,
        y: 654.75,
        pid: 424242,
        ref: 'ax-private-ref',
        observation_id: 'observation-private',
      },
    }
    const computerResult = {
      toolCallId: computerCall.id,
      name: computerCall.name,
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
    const privateTurns: AgentTurn[] = [
      { ...turn('assistant-1', 'assistant', '', 101), toolCalls: [computerCall] },
      {
        ...turn('result-1', 'tool_result', `computer__click: [ok] ${computerResult.output}`, 102),
        toolResults: [computerResult],
      },
    ]
    const canonicalEvents: AnyConversationEvent[] = [
      {
        schemaVersion: 1,
        eventId: 'canonical-tool-call',
        conversationId: 'computer-private',
        threadId: 'computer-private',
        seq: 1,
        at: 101,
        source: 'runtime',
        provenance: 'live',
        type: 'tool.proposed',
        payload: { toolCall: computerCall },
      },
      {
        schemaVersion: 1,
        eventId: 'canonical-tool-result',
        conversationId: 'computer-private',
        threadId: 'computer-private',
        seq: 2,
        at: 102,
        source: 'runtime',
        provenance: 'live',
        type: 'tool.completed',
        payload: { toolResult: computerResult },
      },
    ]
    saveConversation({
      ...meta('computer-private'),
      turnCount: 2,
      turns: privateTurns,
      canonicalEvents,
      modelSurface: new ModelSurface(undefined, privateTurns).getState(),
    }, { compact: true })

    const serialized = readFileSync(join(getConversationsDir(), 'computer-private.jsonl'), 'utf8')
    for (const sensitive of [
      'PRIVATE_AX_VALUE',
      '/private/tmp/computer-frame.png',
      'observation-private',
      'ax-private-ref',
      '424242',
      '321.25',
      '654.75',
    ]) expect(serialized).not.toContain(sensitive)
    expect(loadConversation('computer-private')?.turns).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolCalls: [expect.objectContaining({ arguments: {} })] }),
      expect.objectContaining({
        toolResults: [expect.objectContaining({ output: expect.stringContaining('ephemeral') })],
      }),
    ]))
    expect(loadConversation('computer-private')?.canonicalEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: { toolCall: expect.objectContaining({ arguments: {} }) } }),
      expect.objectContaining({ payload: { toolResult: expect.objectContaining({ output: expect.stringContaining('ephemeral') }) } }),
    ]))
    expect(computerCall.arguments.x).toBe(321.25)
    expect(computerResult.attachments[0]?.path).toBe('/private/tmp/computer-frame.png')
  })

  it('repairs duplicate turn ids without losing the older turn', () => {
    const olderUser = turn('msg-1', 'user', 'first prompt', 100)
    const olderAssistant = turn('assistant-1', 'assistant', 'first answer', 101)
    const newerUser = turn('msg-1', 'user', 'second prompt', 200)
    const newerAssistant = turn('assistant-2', 'assistant', 'second answer', 201)
    saveConversation({
      ...meta('duplicate-turn-id'),
      updatedAt: 201,
      turnCount: 3,
      turns: [newerUser, olderAssistant, newerAssistant],
      activeTurns: [olderUser, olderAssistant, newerUser, newerAssistant],
    })

    const recovered = loadConversation('duplicate-turn-id')

    expect(recovered?.turns.map(item => item.content)).toEqual([
      'first prompt',
      'first answer',
      'second prompt',
      'second answer',
    ])
    expect(new Set(recovered?.turns.map(item => item.id))).toHaveProperty('size', 4)
    expect(recovered?.turns[0]?.id).toBe('msg-1')
    expect(recovered?.turns[2]?.id).toMatch(/^msg-1~/)
    expect(recovered?.activeTurns?.map(item => item.id)).toEqual(recovered?.turns.map(item => item.id))
  })

  it('starts a fresh journal generation after a colliding session id', () => {
    saveConversation({
      ...meta('colliding-session'),
      createdAt: 100,
      updatedAt: 200,
      turnCount: 2,
      turns: [
        turn('old-user', 'user', 'old session prompt', 100),
        turn('old-assistant', 'assistant', 'old session reply', 200),
      ],
    })
    appendConversationJournal('colliding-session', {
      version: 1,
      type: 'meta',
      timestamp: 400,
      meta: { ...meta('colliding-session'), createdAt: 300, updatedAt: 400, title: 'Untitled' },
    })
    appendConversationJournal('colliding-session', {
      version: 2,
      type: 'draft_state',
      timestamp: 401,
      draft: { text: 'new session draft' },
    })

    const recovered = loadConversation('colliding-session')

    expect(recovered).toMatchObject({ createdAt: 300, title: 'new session draft', turnCount: 0 })
    expect(recovered?.turns).toEqual([])
  })

  it('loads, lists, and deletes conversations through asynchronous storage', async () => {
    const conversation: PersistedConversation = {
      ...meta('async-1'),
      turnCount: 2,
      turns: [
        turn('user-1', 'user', 'async hello', 100),
        turn('assistant-1', 'assistant', 'async reply', 101),
      ],
    }
    saveConversation(conversation)

    await expect(loadConversationAsync('async-1')).resolves.toMatchObject({ id: 'async-1', turnCount: 2 })
    await expect(listConversationsAsync(process.cwd())).resolves.toEqual([
      expect.objectContaining({ id: 'async-1', turnCount: 2 }),
    ])
    await expect(deleteConversationAsync('async-1')).resolves.toBe(true)
    await expect(loadConversationAsync('async-1')).resolves.toBeNull()
  })

  it('hides empty shell conversations and titles recoverable drafts', async () => {
    appendConversationJournal('empty-shell', {
      version: 1,
      type: 'meta',
      timestamp: 100,
      meta: { ...meta('empty-shell'), title: 'Untitled' },
    })
    appendConversationJournal('empty-shell', { version: 2, type: 'queue_state', timestamp: 101, inputs: [] })
    appendConversationJournal('empty-shell', { version: 2, type: 'draft_state', timestamp: 102, draft: { text: '' } })

    expect(listConversations(process.cwd()).map(item => item.id)).not.toContain('empty-shell')
    await expect(listConversationsAsync(process.cwd())).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'empty-shell' })]),
    )

    appendConversationJournal('empty-shell', {
      version: 2,
      type: 'draft_state',
      timestamp: 103,
      draft: { text: 'drafted conversation title' },
    })

    expect(listConversations(process.cwd())).toContainEqual(
      expect.objectContaining({ id: 'empty-shell', title: 'drafted conversation title', turnCount: 0 }),
    )
  })

  it('atomically compacts a completed journal to one current snapshot', () => {
    const first: PersistedConversation = {
      ...meta('compact-1'),
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
    appendConversationJournal('compact-1', { version: 1, type: 'stream_start', timestamp: 150 })
    appendConversationJournal('compact-1', { version: 1, type: 'stream_delta', timestamp: 160, text: 'obsolete partial' })
    saveConversation(second, { compact: true })

    const lines = readFileSync(join(directory, 'compact-1.jsonl'), 'utf8').trim().split(/\r?\n/)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'snapshot', conversation: { turnCount: 2 } })
    expect(loadConversation('compact-1')?.turns.map(item => item.content)).toEqual(['first', 'second'])
  })

  it('does not treat snapshot write time as conversation activity', async () => {
    const persisted: PersistedConversation = {
      ...meta('stable-activity'),
      updatedAt: 200,
      turnCount: 1,
      turns: [turn('user-1', 'user', 'old activity', 200)],
    }

    saveConversation(persisted, { compact: true })

    expect(loadConversation('stable-activity')?.updatedAt).toBe(200)
    await expect(loadConversationAsync('stable-activity')).resolves.toMatchObject({ updatedAt: 200 })
  })

  it('drops obsolete entries and damage before the latest valid snapshot', async () => {
    const older: PersistedConversation = {
      ...meta('latest-snapshot'),
      turnCount: 1,
      turns: [turn('old-user', 'user', 'obsolete', 100)],
    }
    const latest: PersistedConversation = {
      ...meta('latest-snapshot'),
      updatedAt: 200,
      turnCount: 1,
      turns: [turn('new-user', 'user', 'current', 200)],
    }
    const journalPath = join(directory, 'latest-snapshot.jsonl')
    writeFileSync(journalPath, [
      JSON.stringify({ version: 1, type: 'snapshot', timestamp: 100, conversation: older }),
      '{"version":1,"type":"turn"',
      JSON.stringify({ version: 1, type: 'snapshot', timestamp: 200, conversation: latest }),
      JSON.stringify({ version: 1, type: 'stream_start', timestamp: 201 }),
      JSON.stringify({ version: 1, type: 'stream_delta', timestamp: 202, text: 'partial' }),
      '',
    ].join('\n'), 'utf8')

    expect(loadConversation('latest-snapshot')).toMatchObject({
      turns: [
        expect.objectContaining({ content: 'current' }),
        expect.objectContaining({ content: 'partial' }),
      ],
      recovery: { interrupted: true, truncatedJournal: false },
    })
    await expect(loadConversationAsync('latest-snapshot')).resolves.toMatchObject({
      recovery: { interrupted: true, truncatedJournal: false },
    })
  })

  it('replays journals whose lines cross file read chunks', () => {
    const persisted: PersistedConversation = {
      ...meta('chunked-journal'),
      turnCount: 1,
      turns: [turn('chunked-user', 'user', '保留当前用户资料', 200)],
    }
    const journalPath = join(directory, 'chunked-journal.jsonl')
    writeFileSync(journalPath, [
      `{"damaged":"${'x'.repeat(70 * 1024)}"}`,
      JSON.stringify({ version: 1, type: 'snapshot', timestamp: 200, conversation: persisted }),
      JSON.stringify({ version: 1, type: 'stream_start', timestamp: 201 }),
      JSON.stringify({ version: 1, type: 'stream_delta', timestamp: 202, text: '，并继续工作' }),
      '',
    ].join('\n'), 'utf8')

    expect(loadConversation('chunked-journal')).toMatchObject({
      turns: [
        expect.objectContaining({ content: '保留当前用户资料' }),
        expect.objectContaining({ content: '，并继续工作' }),
      ],
      recovery: { interrupted: true, truncatedJournal: false },
    })
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

  it('turns an unfinished compaction checkpoint into a recoverable interruption', () => {
    const state: ContextCompactionState = {
      id: 'compact-recovery-1',
      phase: 'summarizing',
      source: 'compact',
      startedAt: 100,
      updatedAt: 150,
      elapsedMs: 50,
      startMessageId: 'old-user',
      endMessageId: 'old-assistant',
      oldTurnCount: 2,
      originalCharCount: 1200,
      progress: 0.3,
      recoverable: true,
    }
    appendConversationJournal('compaction-recovery', { version: 1, type: 'meta', timestamp: 100, meta: meta('compaction-recovery') })
    appendConversationJournal('compaction-recovery', {
      version: 1,
      type: 'turn',
      timestamp: 101,
      turn: turn('old-user', 'user', 'preserve this', 101),
    })
    appendConversationJournal('compaction-recovery', {
      version: 2,
      type: 'context_compaction',
      timestamp: 150,
      state,
    })

    const recovered = loadConversation('compaction-recovery')
    expect(recovered?.turns[0]?.id).toBe('old-user')
    expect(recovered?.turns[0]?.content).toBe('preserve this')
    expect(recovered?.contextCompactionState).toMatchObject({
      phase: 'interrupted',
      recoverable: true,
      startMessageId: 'old-user',
    })
    expect(recovered?.recovery?.interrupted).toBe(true)
  })

  it('skips structurally invalid journal events without losing later valid turns', () => {
    appendConversationJournal('invalid-event-1', { version: 1, type: 'meta', timestamp: 100, meta: meta('invalid-event-1') })
    appendFileSync(join(directory, 'invalid-event-1.jsonl'), '{"version":1,"type":"turn","timestamp":101}\n', 'utf-8')
    appendConversationJournal('invalid-event-1', {
      version: 1,
      type: 'turn',
      timestamp: 102,
      turn: turn('user-1', 'user', 'survived', 102),
    })

    const recovered = loadConversation('invalid-event-1')

    expect(recovered?.turns.map(item => item.content)).toEqual(['survived'])
    expect(recovered?.recovery?.truncatedJournal).toBe(true)
    expect(recovered?.recovery?.interrupted).toBe(true)
  })

  it('does not invent an assistant reply when a request failed before producing content', () => {
    const conversation: PersistedConversation = {
      ...meta('failed-before-content'),
      turnCount: 1,
      turns: [turn('user-1', 'user', 'try it', 100)],
      workExecution: {
        schemaVersion: 1,
        currentRunId: null,
        runs: [{
          id: 'user-1',
          conversationId: 'failed-before-content',
          objective: 'try it',
          presentation: 'conversation',
          status: 'failed',
          phase: 'failed',
          rootStepIds: [],
          steps: {},
          activities: {},
          startedAt: 100,
          updatedAt: 101,
          completedAt: 101,
          error: 'All compatible model protocols failed: HTTP 402: {"error":{"message":"Insufficient Balance"}}',
        }],
      },
    }
    saveConversation(conversation)

    const recovered = loadConversation('failed-before-content')

    expect(recovered?.turns.map(item => item.content)).toEqual(['try it'])
    expect(recovered?.workExecution?.runs[0]?.error).toBe('你配置的模型 API 拒绝了请求，请检查该连接的服务状态。\n上游返回：Insufficient Balance')
    expect(recovered?.recovery?.interrupted).toBe(false)
  })

  it('removes assistant placeholders created by older recovery versions', () => {
    const conversation: PersistedConversation = {
      ...meta('legacy-placeholder'),
      turnCount: 2,
      turns: [
        turn('user-1', 'user', 'keep me', 100),
        turn('recovered-assistant-101', 'assistant', 'Interrupted: assistant response was not recorded before restart.', 101),
      ],
    }
    saveConversation(conversation)

    expect(loadConversation('legacy-placeholder')?.turns.map(item => item.content)).toEqual(['keep me'])
  })

  it('restores the interrupted marker stripped from a recovered assistant snapshot', () => {
    const recoveredTurn = turn('recovered-assistant-101', 'assistant', 'partial answer', 101)
    recoveredTurn.metadata = {
      thinking: { content: 'partial reasoning', source: 'provider', status: 'interrupted' },
    }
    saveConversation({
      ...meta('recovered-snapshot'),
      turnCount: 2,
      turns: [turn('user-1', 'user', 'keep working', 100), recoveredTurn],
      workExecution: {
        schemaVersion: 1,
        currentRunId: null,
        runs: [{
          id: 'user-1',
          conversationId: 'recovered-snapshot',
          objective: 'keep working',
          presentation: 'conversation',
          status: 'completed',
          phase: 'completed',
          rootStepIds: [],
          steps: {},
          activities: {},
          startedAt: 100,
          updatedAt: 101,
          completedAt: 101,
        }],
      },
    })

    expect(loadConversation('recovered-snapshot')).toMatchObject({
      recovery: { interrupted: true },
      workExecution: {
        currentRunId: null,
        runs: [{ status: 'partial', phase: 'partial', recoveredFromPersistence: true }],
      },
      turns: [
        { id: 'user-1' },
        {
          id: 'recovered-assistant-101',
          metadata: {
            interrupted: true,
            interruption: { kind: 'stop', resumable: false },
            thinking: { status: 'interrupted' },
          },
        },
      ],
    })
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

  it('replays a large delta burst without repeated whole-string concatenation', () => {
    const journalPath = join(directory, 'chunked-replay.jsonl')
    const entries: unknown[] = [
      { version: 1, type: 'meta', timestamp: 100, meta: meta('chunked-replay') },
      { version: 1, type: 'turn', timestamp: 101, turn: turn('user-1', 'user', 'recover burst', 101) },
      { version: 1, type: 'stream_start', timestamp: 102 },
    ]
    for (let index = 0; index < 10_000; index += 1) {
      entries.push({ version: 1, type: 'stream_delta', timestamp: 103 + index, text: 'x' })
      entries.push({ version: 1, type: 'stream_thinking_delta', timestamp: 103 + index, text: 'y' })
    }
    writeFileSync(journalPath, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8')

    const recovered = loadConversation('chunked-replay')?.turns.at(-1)

    expect(recovered?.content).toBe('x'.repeat(10_000))
    expect(recovered?.metadata?.thinking?.content).toBe('y'.repeat(10_000))
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

  it('recovers queue, draft, pending steer, and unresolved approvals from v2 state records', () => {
    appendConversationJournal('interaction-1', { version: 1, type: 'meta', timestamp: 100, meta: meta('interaction-1') })
    appendConversationJournal('interaction-1', {
      version: 2,
      type: 'queue_state',
      timestamp: 101,
      inputs: [{ id: 'queue-1', prompt: 'run tests' }],
    })
    appendConversationJournal('interaction-1', {
      version: 2,
      type: 'draft_state',
      timestamp: 102,
      draft: { text: 'unfinished thought' },
    })
    appendConversationJournal('interaction-1', {
      version: 2,
      type: 'input_state',
      timestamp: 103,
      inputId: 'steer-1',
      intent: 'steer',
      state: 'accepted',
      text: 'also update docs',
    })
    appendConversationJournal('interaction-1', {
      version: 2,
      type: 'approval_state',
      timestamp: 104,
      requestId: 'approval-1',
      requestKind: 'permission',
      state: 'requested',
      question: 'Allow write?',
      toolName: 'write_file',
    })

    expect(loadConversation('interaction-1')?.interactionState).toEqual({
      queuedInputs: [{ id: 'queue-1', prompt: 'run tests' }],
      draft: { text: 'unfinished thought', attachments: undefined },
      pendingSteering: [{ id: 'steer-1', text: 'also update docs' }],
      pendingApprovals: [{
        requestId: 'approval-1',
        requestKind: 'permission',
        question: 'Allow write?',
        toolName: 'write_file',
        path: undefined,
      }],
    })
  })
})
