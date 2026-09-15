import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { countVisibleProfileConversations, countVisibleProfileWorkspaces, listVisibleProfileConversations, summarizeProfileDirectory } from './profileSummary'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createProfileRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-profile-summary-'))
  roots.push(root)
  mkdirSync(join(root, 'conversations'), { recursive: true })
  return root
}

describe('profile summary', () => {
  it('excludes host-internal workspaces from user-facing counts', () => {
    expect(countVisibleProfileWorkspaces([
      { state: 'bound', localPath: '/tmp/turboflux/internal/unscoped' },
      { state: 'bound', localPath: '/tmp/project' },
      { state: 'unbound' },
    ], ['/tmp/turboflux/internal/unscoped'])).toEqual({ bound: 1, unbound: 1 })
  })

  it('counts visible conversations instead of hidden runtime placeholders', async () => {
    const root = createProfileRoot()
    writeFileSync(join(root, 'conversations', 'visible.jsonl'), '{}\n')
    writeFileSync(join(root, 'conversations', 'hidden.jsonl'), '{}\n')
    writeFileSync(join(root, 'conversations', '.conversation-catalog-v1.json'), JSON.stringify({
      version: 1,
      entries: [
        { meta: { id: 'visible', title: 'Visible task', workspacePath: '/tmp/project', updatedAt: 20, turnCount: 1 }, visible: true },
        { meta: { id: 'hidden', title: 'Hidden task', workspacePath: '/tmp/project', updatedAt: 10, turnCount: 0 }, visible: false },
      ],
    }))

    await expect(countVisibleProfileConversations(root)).resolves.toBe(1)
  })

  it('prefers the Conversation V2 catalog and excludes archived records', async () => {
    const root = createProfileRoot()
    mkdirSync(join(root, 'conversations-v2'), { recursive: true })
    writeFileSync(join(root, 'conversations-v2', 'catalog.json'), JSON.stringify({
      schemaVersion: 1,
      records: [
        { id: 'active', title: 'Current task', workspaceId: 'workspace-1', status: 'idle', updatedAt: 30, turnCount: 2 },
        { id: 'needs-workspace', title: 'Imported task', workspaceId: 'workspace-2', status: 'needs_workspace', updatedAt: 40, turnCount: 4 },
        { id: 'archived', title: 'Archived task', workspaceId: 'workspace-1', status: 'archived', updatedAt: 50, turnCount: 1 },
      ],
    }))
    writeFileSync(join(root, 'conversations', '.conversation-catalog-v1.json'), JSON.stringify({ version: 1, entries: [] }))

    await expect(countVisibleProfileConversations(root)).resolves.toBe(2)
    await expect(listVisibleProfileConversations(root)).resolves.toEqual([
      expect.objectContaining({ id: 'needs-workspace', title: 'Imported task', workspaceId: 'workspace-2', status: 'needs_workspace' }),
      expect.objectContaining({ id: 'active', title: 'Current task', workspaceId: 'workspace-1', status: 'idle' }),
    ])
  })

  it('falls back to conversation files when no catalog exists', async () => {
    const root = createProfileRoot()
    writeFileSync(join(root, 'conversations', 'one.jsonl'), '{}\n')
    writeFileSync(join(root, 'conversations', 'one.json'), '{}\n')
    writeFileSync(join(root, 'conversations', 'two.jsonl'), '{}\n')

    await expect(countVisibleProfileConversations(root)).resolves.toBe(2)
  })

  it('keeps profile summaries available when an installation staging path disappears', async () => {
    const vanished = Object.assign(new Error('path disappeared'), { code: 'ENOENT' })
    await expect(summarizeProfileDirectory('/profile', {
      async readDirectory() {
        return [{ name: 'stable.json' }, { name: 'plugin.installing' }]
      },
      async inspectPath(path) {
        if (path.endsWith('plugin.installing')) throw vanished
        return {
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
          size: 128,
        }
      },
    })).resolves.toEqual({ bytes: 128, files: 1 })
  })
})
