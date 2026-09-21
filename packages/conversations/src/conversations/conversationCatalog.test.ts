import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConversationCatalog } from './conversationCatalog'
import type { PersistedConversation } from './types'

function conversation(id: string, update: Partial<PersistedConversation> = {}): PersistedConversation {
  return {
    id,
    title: 'Indexed task',
    titleSource: 'generated',
    workspacePath: '/workspace/project',
    createdAt: 100,
    updatedAt: 200,
    mode: 'vibe',
    model: 'test-model',
    provider: 'custom',
    turnCount: 1,
    turns: [{ id: 'user-1', role: 'user', content: 'hello', timestamp: 100 }],
    ...update,
  }
}

describe('ConversationCatalog', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'turboflux-catalog-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('migrates a huge snapshot by reading bounded metadata slices only', async () => {
    const huge = conversation('huge', {
      turns: [{ id: 'user-1', role: 'user', content: 'x'.repeat(2 * 1024 * 1024), timestamp: 100 }],
    })
    writeFileSync(join(directory, 'huge.jsonl'), `${JSON.stringify({ version: 1, type: 'snapshot', timestamp: 200, conversation: huge })}\n`)

    const catalog = new ConversationCatalog(directory)
    await catalog.initialize()

    expect(catalog.listAll()).toEqual([expect.objectContaining({ id: 'huge', title: 'Indexed task', turnCount: 1 })])
    expect(catalog.getDiagnostics().bytesRead).toBeLessThanOrEqual(512 * 1024)
  })

  it('keeps empty shells hidden and discovers durable drafts', async () => {
    const meta = conversation('draft', { title: 'Untitled', turnCount: 0, turns: [] })
    writeFileSync(join(directory, 'draft.jsonl'), [
      JSON.stringify({ version: 1, type: 'meta', timestamp: 100, meta }),
      JSON.stringify({ version: 2, type: 'draft_state', timestamp: 101, draft: { text: 'Drafted task' } }),
      '',
    ].join('\n'))
    writeFileSync(join(directory, 'empty.jsonl'), `${JSON.stringify({ version: 1, type: 'meta', timestamp: 100, meta: { ...meta, id: 'empty' } })}\n`)

    const catalog = new ConversationCatalog(directory)
    await catalog.initialize()

    expect(catalog.listAll()).toEqual([expect.objectContaining({ id: 'draft', title: 'Drafted task' })])
  })

  it('repairs cached generated titles that expose automation prompt markup', async () => {
    const source = conversation('automation-title', {
      title: '<automation_objective> Goal: Review release evidence Success criteria: - Record it </automation_objective>',
    })
    const sourcePath = join(directory, 'automation-title.jsonl')
    writeFileSync(sourcePath, `${JSON.stringify({ version: 1, type: 'snapshot', timestamp: 200, conversation: source })}\n`)
    const sourceInfo = statSync(sourcePath)
    writeFileSync(join(directory, '.conversation-catalog-v1.json'), `${JSON.stringify({
      version: 1,
      entries: [{
        meta: { ...source, turns: undefined },
        visible: true,
        fingerprint: `${sourcePath}:${sourceInfo.size}:${sourceInfo.mtimeMs}`,
      }],
    })}\n`)

    const catalog = new ConversationCatalog(directory)
    await catalog.initialize()

    expect(catalog.get('automation-title')?.title).toBe('Review release evidence')
  })

  it('keeps distinct canonical events emitted in the same millisecond', async () => {
    const meta = conversation('same-millisecond', { title: 'Untitled', turnCount: 0, turns: [] })
    const envelope = {
      schemaVersion: 1,
      conversationId: meta.id,
      threadId: meta.id,
      at: 101,
      source: 'agent',
      provenance: 'live',
    }
    writeFileSync(join(directory, 'same-millisecond.jsonl'), [
      JSON.stringify({ version: 1, type: 'meta', timestamp: 100, meta }),
      JSON.stringify({
        version: 3,
        type: 'canonical_event',
        timestamp: 101,
        event: {
          ...envelope,
          eventId: 'runtime-1',
          seq: 1,
          type: 'runtime.event',
          payload: { kind: 'state' },
        },
      }),
      JSON.stringify({
        version: 3,
        type: 'canonical_event',
        timestamp: 101,
        event: {
          ...envelope,
          eventId: 'turn-1',
          seq: 2,
          runId: 'run-1',
          turnId: 'user-1',
          itemId: 'user-1',
          type: 'turn.started',
          payload: {
            turn: { id: 'user-1', role: 'user', content: 'same millisecond prompt', timestamp: 101 },
          },
        },
      }),
      '',
    ].join('\n'))

    const catalog = new ConversationCatalog(directory)
    await catalog.initialize()

    expect(catalog.listAll()).toEqual([
      expect.objectContaining({ id: meta.id, title: 'same millisecond prompt', turnCount: 1 }),
    ])
  })

  it('counts a turn once when legacy and canonical journal events both contain it', async () => {
    const meta = conversation('dual-write', { title: 'Untitled', turnCount: 0, turns: [] })
    const userTurn = { id: 'user-1', role: 'user', content: 'count me once', timestamp: 101 }
    writeFileSync(join(directory, 'dual-write.jsonl'), [
      JSON.stringify({ version: 1, type: 'meta', timestamp: 100, meta }),
      JSON.stringify({ version: 1, type: 'turn', timestamp: 101, turn: userTurn }),
      JSON.stringify({
        version: 3,
        type: 'canonical_event',
        timestamp: 101,
        event: {
          schemaVersion: 1,
          eventId: 'turn-1',
          seq: 1,
          conversationId: meta.id,
          threadId: meta.id,
          runId: 'run-1',
          turnId: userTurn.id,
          itemId: userTurn.id,
          at: 101,
          source: 'agent',
          provenance: 'live',
          type: 'turn.started',
          payload: { turn: userTurn },
        },
      }),
      JSON.stringify({
        version: 1,
        type: 'turn',
        timestamp: 102,
        turn: { id: 'assistant-1', role: 'assistant', content: 'done', timestamp: 102 },
      }),
      '',
    ].join('\n'))

    const catalog = new ConversationCatalog(directory)
    await catalog.initialize()

    expect(catalog.get('dual-write')?.turnCount).toBe(2)
  })

  it('persists incremental upserts, title changes, and removals', async () => {
    mkdirSync(directory, { recursive: true })
    const catalog = new ConversationCatalog(directory)
    await catalog.initialize()
    catalog.upsert(conversation('active'))
    expect(catalog.updateTitle('active', 'Renamed task', 'custom', 300)).toBe(true)
    await catalog.flush()

    const persisted = readFileSync(join(directory, '.conversation-catalog-v1.json'), 'utf8')
    expect(persisted).toContain('Renamed task')

    catalog.remove('active')
    await catalog.flush()
    const reloaded = new ConversationCatalog(directory)
    await reloaded.initialize()
    expect(reloaded.listAll()).toEqual([])
  })

  it('serves repeated listings without touching conversation history again', async () => {
    writeFileSync(join(directory, 'one.jsonl'), `${JSON.stringify({ version: 1, type: 'snapshot', timestamp: 200, conversation: conversation('one') })}\n`)
    const catalog = new ConversationCatalog(directory)
    await catalog.initialize()
    const afterInitialize = catalog.getDiagnostics()

    expect(catalog.listAll()).toHaveLength(1)
    expect(catalog.listAll()).toHaveLength(1)
    expect(catalog.getDiagnostics()).toEqual(afterInitialize)
  })

  it('does not replace persisted activity time with the source file modification time', async () => {
    writeFileSync(join(directory, 'old-activity.jsonl'), `${JSON.stringify({
      version: 1,
      type: 'snapshot',
      timestamp: 200,
      conversation: conversation('old-activity', { updatedAt: 200 }),
    })}\n`)

    const catalog = new ConversationCatalog(directory)
    await catalog.initialize()

    expect(catalog.get('old-activity')?.updatedAt).toBe(200)
  })

  it('rescans source files when a persisted entry uses an older scan fingerprint', async () => {
    const source = conversation('stale-cache', { title: 'Fresh source title' })
    const sourcePath = join(directory, 'stale-cache.jsonl')
    writeFileSync(sourcePath, `${JSON.stringify({ version: 1, type: 'snapshot', timestamp: 200, conversation: source })}\n`)
    const sourceInfo = statSync(sourcePath)
    writeFileSync(join(directory, '.conversation-catalog-v1.json'), `${JSON.stringify({
      version: 1,
      entries: [{
        meta: { ...source, title: 'Stale cached title', turns: undefined },
        visible: true,
        fingerprint: `${sourcePath}:${sourceInfo.size}:${sourceInfo.mtimeMs}`,
      }],
    })}\n`)

    const catalog = new ConversationCatalog(directory)
    await catalog.initialize()

    expect(catalog.listAll()).toEqual([
      expect.objectContaining({ id: source.id, title: 'Fresh source title' }),
    ])
  })
})
