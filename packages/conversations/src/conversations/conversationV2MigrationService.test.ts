import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationRepositoryV2 } from './conversationRepositoryV2'
import { ConversationInteractionStoreV2 } from './conversationInteractionStoreV2'
import { migrateConversationStoreV1ToV2 } from './conversationV2MigrationService'
import { ConversationStore } from './store'
import type { PersistedConversation } from './types'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { root: string; v1: string; v2: string; conversation: PersistedConversation } {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-conversation-migration-'))
  roots.push(root)
  const v1 = join(root, 'conversations')
  const v2 = join(root, 'conversations-v2')
  mkdirSync(v1, { recursive: true })
  const conversation: PersistedConversation = {
    id: 'legacy-1',
    title: 'Legacy task',
    titleSource: 'custom',
    workspacePath: join(root, 'workspace'),
    createdAt: 10,
    updatedAt: 20,
    mode: 'vibe',
    provider: 'custom',
    model: 'test',
    turnCount: 2,
    turns: [
      { id: 'turn-1', role: 'user', content: 'Inspect it', timestamp: 10 },
      { id: 'turn-2', role: 'assistant', content: 'Done', timestamp: 20 },
    ],
    interactionState: {
      queuedInputs: [{ id: 'queued-1', prompt: 'Continue later' }],
      draft: { text: 'Unfinished draft' },
      pendingSteering: [{ id: 'steer-1', text: 'Change direction' }],
      pendingApprovals: [{ requestId: 'approval-1', requestKind: 'permission', question: 'Allow?' }],
    },
  }
  new ConversationStore(v1).save(conversation, { compact: true })
  return { root, v1, v2, conversation }
}

describe('migrateConversationStoreV1ToV2', () => {
  it('migrates through staging, reconciles history, and keeps V1 intact', () => {
    const { v1, v2, conversation } = fixture()
    const receipt = migrateConversationStoreV1ToV2({
      profileId: 'profile-1',
      conversationsRoot: v1,
      conversationsV2Root: v2,
      workspaceIdForConversation: () => 'workspace-12345678',
      now: (() => { let value = 100; return () => value++ })(),
      createId: () => 'migration-1',
    })

    expect(receipt).toMatchObject({
      status: 'completed',
      source: { conversationCount: 1, retained: true },
      reconciliation: { turns: 2, messageItems: 2 },
    })
    expect(new ConversationStore(v1).load(conversation.id)?.turns).toHaveLength(2)
    expect(new ConversationRepositoryV2(v2).projection(conversation.id)).toMatchObject({
      conversation: { title: 'Legacy task', workspaceId: 'workspace-12345678' },
      turns: [{ id: 'turn-1' }, { id: 'turn-2' }],
    })
    expect(JSON.parse(readFileSync(join(v2, 'migration-receipt.json'), 'utf8'))).toMatchObject({ status: 'completed' })
    expect(new ConversationInteractionStoreV2(join(v2, '..', 'interaction'), 'profile-1').load(conversation.id)).toEqual({
      queuedInputs: [{ id: 'queued-1', prompt: 'Continue later' }],
      draft: { text: 'Unfinished draft' },
      pendingSteering: [{ id: 'steer-1', text: 'Change direction' }],
      pendingApprovals: [],
    })
  })

  it('returns the same receipt on a second unchanged migration', () => {
    const { v1, v2 } = fixture()
    let ids = 0
    const options = {
      profileId: 'profile-1',
      conversationsRoot: v1,
      conversationsV2Root: v2,
      workspaceIdForConversation: () => 'workspace-12345678',
      createId: () => `migration-${++ids}`,
    }
    const first = migrateConversationStoreV1ToV2(options)
    const second = migrateConversationStoreV1ToV2(options)
    expect(second).toEqual(first)
    expect(ids).toBe(1)
  })

  it('preserves newer V2 state when the legacy source changes', () => {
    const { v1, v2, conversation } = fixture()
    const options = {
      profileId: 'profile-1',
      conversationsRoot: v1,
      conversationsV2Root: v2,
      workspaceIdForConversation: () => 'workspace-12345678',
    }
    migrateConversationStoreV1ToV2(options)
    const repository = new ConversationRepositoryV2(v2)
    repository.append([{
      eventId: 'live-rename',
      profileId: 'profile-1',
      conversationId: conversation.id,
      source: 'user',
      provenance: 'live',
      type: 'conversation.renamed',
      at: 30,
      payload: { title: 'Current V2 title', titleSource: 'custom' },
    }, {
      eventId: 'live-turn',
      profileId: 'profile-1',
      conversationId: conversation.id,
      source: 'user',
      provenance: 'live',
      type: 'turn.started',
      turnId: 'turn-live',
      at: 31,
      payload: { turn: { id: 'turn-live', conversationId: conversation.id, role: 'user', status: 'started', createdAt: 31 } },
    }])
    new ConversationStore(v1).save({
      ...conversation,
      updatedAt: 40,
      turnCount: 3,
      turns: [...conversation.turns, { id: 'turn-3', role: 'user', content: 'New legacy turn', timestamp: 40 }],
    }, { compact: true })

    expect(() => migrateConversationStoreV1ToV2(options)).not.toThrow()
    expect(new ConversationRepositoryV2(v2).projection(conversation.id)).toMatchObject({
      conversation: { title: 'Current V2 title' },
      turns: expect.arrayContaining([
        expect.objectContaining({ id: 'turn-live' }),
        expect.objectContaining({ id: 'turn-3' }),
      ]),
    })
  })

  it('does not count an orphaned turn work-run reference as a migrated run', () => {
    const { v1, v2, conversation } = fixture()
    new ConversationStore(v1).save({
      ...conversation,
      turns: conversation.turns.map((turn, index) => index === 0
        ? { ...turn, metadata: { workRunId: 'missing-legacy-run' } }
        : turn),
      canonicalEvents: [{
        schemaVersion: 1,
        eventId: 'orphaned-run-completion',
        conversationId: conversation.id,
        threadId: conversation.id,
        runId: 'missing-legacy-run',
        seq: 1,
        at: 20,
        source: 'workbench',
        provenance: 'live',
        type: 'run.completed',
        payload: { outcome: 'completed' },
      }],
    }, { compact: true })

    const receipt = migrateConversationStoreV1ToV2({
      profileId: 'profile-1',
      conversationsRoot: v1,
      conversationsV2Root: v2,
      workspaceIdForConversation: () => 'workspace-12345678',
    })

    expect(receipt.reconciliation.runs).toBe(0)
    expect(new ConversationRepositoryV2(v2).projection(conversation.id).turns[0]).toMatchObject({ runId: 'missing-legacy-run' })
  })

  it('leaves the current V2 root untouched when reconciliation fails', () => {
    const { root, v1, v2 } = fixture()
    mkdirSync(v2, { recursive: true })
    expect(() => migrateConversationStoreV1ToV2({
      profileId: 'profile-1',
      conversationsRoot: v1,
      conversationsV2Root: v2,
      workspaceIdForConversation: () => { throw new Error('workspace unavailable') },
      createId: () => 'migration-failure',
    })).toThrow('workspace unavailable')
    expect(existsSync(v2)).toBe(true)
    expect(existsSync(join(root, 'conversation-v2-migration-failure.json'))).toBe(true)
    expect(existsSync(`${v2}.migrating-conversation-v2-migration-failure`)).toBe(false)
  })
})
