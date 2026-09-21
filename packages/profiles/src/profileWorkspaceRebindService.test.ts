import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationStore } from '@turboflux/conversations/conversations/store'
import { ConversationRepositoryV2 } from '@turboflux/conversations/conversations/conversationRepositoryV2'
import type { PersistedConversation } from '@turboflux/conversations/conversations/types'
import { createProfileStorageLayout, ensureProfileStorageLayout } from './profileStorageLayout'
import { ProfileWorkspaceRebindService } from './profileWorkspaceRebindService'
import { WorkspaceBindingService } from './workspaceBindingService'

const directories: string[] = []

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-rebind-'))
  directories.push(root)
  const layout = createProfileStorageLayout(join(root, 'data'), join(root, 'device'), 'profile-imported')
  ensureProfileStorageLayout(layout)
  const workspaceId = 'workspace-12345678'
  const marker = `turboflux-unbound:${workspaceId}`
  new WorkspaceBindingService(layout, () => 10).addUnbound({
    id: workspaceId,
    displayName: 'Source Workspace',
    sourceHint: { platform: 'darwin', folderName: 'expected-workspace' },
  })
  const conversation: PersistedConversation = {
    id: 'conversation-1', title: 'Imported', workspacePath: marker, createdAt: 1, updatedAt: 2,
    mode: 'vibe', model: 'model-a', provider: 'custom', turnCount: 1,
    turns: [{ id: 'turn-1', role: 'user', content: 'history', timestamp: 1 }],
  }
  new ConversationStore(layout.conversationsRoot).save(conversation, { compact: true })
  writeFileSync(layout.projectsPath, JSON.stringify({ schemaVersion: 1, projects: [{ id: 'project-1', path: marker, available: false }] }))
  const artifactPath = join(layout.workspaceOverlaysRoot, workspaceId, 'artifacts', 'result.txt')
  mkdirSync(join(layout.workspaceOverlaysRoot, workspaceId, 'artifacts'), { recursive: true })
  writeFileSync(artifactPath, 'result')
  writeFileSync(layout.artifactsPath, JSON.stringify({ schemaVersion: 1, artifacts: [{ id: 'artifact-1', path: artifactPath, workspacePath: marker, available: false }] }))
  writeFileSync(layout.automationsPath, JSON.stringify({ schemaVersion: 2, automations: [{ id: 'automation-1', workspacePath: marker, enabled: true, status: 'active', activeRunId: 'run-1', nextRunAt: 30 }], approvals: [] }))
  return { root, layout, workspaceId }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('ProfileWorkspaceRebindService', () => {
  it('requires explicit confirmation for a source-hint mismatch without changing references', () => {
    const { root, layout, workspaceId } = fixture()
    const localPath = join(root, 'different-workspace')
    mkdirSync(localPath)
    const result = new ProfileWorkspaceRebindService(layout).rebind({ workspaceId, localPath })
    expect(result.requiresMismatchConfirmation).toBe(true)
    expect(result.updated).toEqual({ conversations: 0, projects: 0, artifacts: 0, automations: 0 })
    expect(new ConversationStore(layout.conversationsRoot).load('conversation-1')?.workspacePath).toBe(`turboflux-unbound:${workspaceId}`)
  })

  it('rebinds imported references while keeping automations disabled and is idempotent', () => {
    const { root, layout, workspaceId } = fixture()
    const localPath = join(root, 'expected-workspace')
    mkdirSync(localPath)
    const service = new ProfileWorkspaceRebindService(layout, () => 20)
    const first = service.rebind({ workspaceId, localPath })
    expect(first.workspace).toMatchObject({ state: 'bound', localPath })
    expect(first.updated).toEqual({ conversations: 1, projects: 1, artifacts: 1, automations: 1 })
    expect(new ConversationStore(layout.conversationsRoot).load('conversation-1')?.workspacePath).toBe(localPath)
    expect(JSON.parse(readFileSync(layout.projectsPath, 'utf8')).projects[0]).toMatchObject({ path: localPath, available: true })
    expect(JSON.parse(readFileSync(layout.artifactsPath, 'utf8')).artifacts[0]).toMatchObject({ workspacePath: localPath, available: true })
    const automation = JSON.parse(readFileSync(layout.automationsPath, 'utf8')).automations[0]
    expect(automation).toMatchObject({ workspacePath: localPath, enabled: false, status: 'paused' })
    expect(automation).not.toHaveProperty('activeRunId')
    expect(automation).not.toHaveProperty('nextRunAt')
    expect(existsSync(localPath)).toBe(true)

    const second = service.rebind({ workspaceId, localPath })
    expect(second.updated).toEqual({ conversations: 0, projects: 0, artifacts: 0, automations: 0 })
  })

  it('records a V2 workspace binding event without writing a machine path into conversation data', () => {
    const { root, layout, workspaceId } = fixture()
    const repository = new ConversationRepositoryV2(layout.conversationsV2Root, () => 15)
    repository.append([{
      eventId: 'event-created-v2',
      profileId: layout.profileId,
      conversationId: 'conversation-v2',
      workspaceId,
      source: 'user',
      provenance: 'imported',
      type: 'conversation.created',
      at: 15,
      payload: { record: {
        schemaVersion: 2,
        id: 'conversation-v2',
        profileId: layout.profileId,
        workspaceId,
        title: 'Imported V2',
        titleSource: 'custom',
        mode: 'vibe',
        provider: 'custom',
        model: 'model-a',
        status: 'needs_workspace',
        createdAt: 15,
        updatedAt: 15,
        lastEventSeq: 0,
        turnCount: 0,
        runCount: 0,
        tags: [],
      } },
    }])
    const localPath = join(root, 'expected-workspace')
    mkdirSync(localPath)

    const result = new ProfileWorkspaceRebindService(layout, () => 20).rebind({ workspaceId, localPath })

    expect(result.updated.conversations).toBe(1)
    expect(new ConversationRepositoryV2(layout.conversationsV2Root).projection('conversation-v2')).toMatchObject({
      conversation: { status: 'idle', workspaceId },
      workspace: { bindingState: 'bound', workspaceId },
    })
    expect(readFileSync(join(layout.conversationsV2Root, 'events', 'conversation-v2.jsonl'), 'utf8')).not.toContain(localPath)
    expect(new ProfileWorkspaceRebindService(layout, () => 30).rebind({ workspaceId, localPath }).updated.conversations).toBe(0)
  })
})
