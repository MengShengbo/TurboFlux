import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationInteractionStoreV2 } from './conversationInteractionStoreV2'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'turboflux-interaction-v2-'))
  roots.push(directory)
  return directory
}

describe('ConversationInteractionStoreV2', () => {
  it('restores drafts and queued input without restoring temporary approvals', () => {
    const directory = root()
    const store = new ConversationInteractionStoreV2(directory, 'profile-1', () => 100)
    store.save('conversation-1', {
      queuedInputs: [{ id: 'input-1', prompt: 'continue the task' }],
      draft: { text: 'unfinished draft' },
      pendingSteering: [{ id: 'steer-1', text: 'change direction' }],
      pendingApprovals: [{ requestId: 'approval-1', requestKind: 'permission', question: 'Allow?' }],
    })

    expect(store.load('conversation-1')).toEqual({
      queuedInputs: [{ id: 'input-1', prompt: 'continue the task' }],
      draft: { text: 'unfinished draft' },
      pendingSteering: [{ id: 'steer-1', text: 'change direction' }],
      pendingApprovals: [],
    })
    expect(readFileSync(join(directory, 'conversation-1.json'), 'utf8')).not.toContain('approval-1')
  })

  it('isolates profile and conversation identities', () => {
    const directory = root()
    const store = new ConversationInteractionStoreV2(directory, 'profile-a')
    store.save('conversation-a', { queuedInputs: [], draft: { text: 'private' }, pendingSteering: [], pendingApprovals: [] })
    expect(() => new ConversationInteractionStoreV2(directory, 'profile-b').load('conversation-a')).toThrow('Invalid Conversation V2 interaction state')
    expect(() => store.load('../escape')).toThrow('Invalid conversation identity')
  })
})
