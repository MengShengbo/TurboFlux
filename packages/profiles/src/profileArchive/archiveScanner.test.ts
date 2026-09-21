import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJsonBytes } from './canonicalJson'
import { writeProfileArchive } from './container'
import { finalizeManifest } from './manifest'
import { scanProfileArchive } from './archiveScanner'
import type { ArchiveComponentId, ArchiveEntryInput, ArchiveSensitivity } from './types'

const directories: string[] = []
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')

function jsonEntry(path: string, value: unknown): ArchiveEntryInput {
  const data = canonicalJsonBytes(value)
  return { path, data, size: data.length, digest: sha256(data) }
}

async function createArchive(input: {
  components: Array<{ id: ArchiveComponentId; path: string; value: unknown; schemaVersion?: number; itemCount?: number; sensitivity?: ArchiveSensitivity }>
  encrypted?: boolean
  workspaces?: Array<{ id: string; displayName: string }>
}): Promise<{ path: string; password?: string }> {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-scan-'))
  directories.push(root)
  const componentEntries = input.components.map(component => jsonEntry(component.path, component.value))
  const profile = jsonEntry('profile/profile.json', { schemaVersion: 1, displayName: 'Imported' })
  const checksums = jsonEntry('checksums.json', {
    schemaVersion: 1,
    algorithm: 'sha256',
    entries: Object.fromEntries([profile, ...componentEntries].map(entry => [entry.path, { sha256: entry.digest, bytes: entry.size }])),
  })
  const groupedComponents = [...new Set(input.components.map(component => component.id))].map(id => {
    const members = input.components.map((component, index) => ({ component, entry: componentEntries[index]! })).filter(item => item.component.id === id)
    const first = members[0]!
    return {
      id,
      schemaVersion: first.component.schemaVersion ?? 1,
      itemCount: first.component.itemCount ?? 1,
      logicalBytes: members.reduce((sum, member) => sum + member.entry.size, 0),
      blobCount: 0,
      sensitivity: first.component.sensitivity ?? 'normal',
    }
  })
  const conversationV2 = groupedComponents.find(component => component.id === 'conversations' && component.schemaVersion === 2)
  const conversationIndex = input.components.find(component => component.id === 'conversations'
    && component.path === 'components/conversations/index.json')?.value as { items?: Array<{ eventCount?: number }> } | undefined
  const conversationItems = conversationIndex?.items ?? []
  const manifest = finalizeManifest({
    schemaVersion: 1,
    archiveId: 'archive-scanner-test',
    exportedAt: 100,
    source: { appVersion: '1', coreVersion: '1', platform: 'darwin', profileStorageVersion: 1 },
    profile: { sourceProfileId: 'source-profile', displayName: 'Imported' },
    conversationDataVersion: conversationV2 ? 2 : undefined,
    conversationData: conversationV2 ? {
      schemaVersion: 2,
      eventSegments: {
        format: 'per-conversation-json',
        indexPath: 'components/conversations/index.json',
        segmentCount: conversationItems.length,
        eventCount: conversationItems.reduce((sum, item) => sum + Number(item.eventCount ?? 0), 0),
      },
      projections: { included: false, rebuildRequired: true },
      migrationSources: [],
    } : undefined,
    components: groupedComponents,
    workspaces: input.workspaces ?? [],
  })
  const targetPath = join(root, 'fixture.turboflux-profile')
  const password = input.encrypted ? 'scanner fixture password' : undefined
  await writeProfileArchive({ targetPath, password, verifyDocument: true, entries: [jsonEntry('manifest.json', manifest), profile, ...componentEntries, checksums] })
  return { path: targetPath, password }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('profile archive security scanner', () => {
  it('returns bounded metadata without exposing component content', async () => {
    const fixture = await createArchive({
      workspaces: [{ id: 'workspace-12345678', displayName: 'Demo' }],
      components: [{
        id: 'projects',
        path: 'components/projects/projects.json',
        value: { schemaVersion: 1, projects: [{ id: 'project-1', workspaceId: 'workspace-12345678', name: 'Demo' }] },
      }],
    })
    const scanned = await scanProfileArchive(fixture)
    expect(scanned.preview).toMatchObject({ archiveId: 'archive-scanner-test', suggestedProfileName: 'Imported', compatibility: 'supported' })
    expect(scanned.preview.workspaces).toEqual([{ id: 'workspace-12345678', displayName: 'Demo' }])
    expect(JSON.stringify(scanned.preview)).not.toContain('project-1')
  })

  it.each([
    ['absolute path', { path: 'C:\\Users\\attacker\\payload' }],
    ['device identity', { installationId: 'cloned-device' }],
    ['UNC path', { workspacePath: '\\\\server\\share' }],
  ])('fails closed for malicious %s fields', async (_label, payload) => {
    const fixture = await createArchive({
      components: [{ id: 'profile.preferences', path: 'components/profile.preferences/preferences.json', value: { schemaVersion: 1, payload } }],
    })
    await expect(scanProfileArchive(fixture)).rejects.toMatchObject({ code: 'ARCHIVE_COMPONENT_INVALID' })
  })

  it('rejects secret components in an unauthenticated archive', async () => {
    const fixture = await createArchive({
      components: [{ id: 'credentials', path: 'components/credentials/credentials.json', value: { schemaVersion: 1, credentials: { apiKey: 'secret' } }, sensitivity: 'secret' }],
    })
    await expect(scanProfileArchive(fixture)).rejects.toMatchObject({ code: 'ARCHIVE_COMPONENT_INVALID' })
  })

  it('accepts an authenticated secret component but unifies wrong-password failures', async () => {
    const fixture = await createArchive({
      encrypted: true,
      components: [{ id: 'credentials', path: 'components/credentials/credentials.json', value: { schemaVersion: 1, credentials: { apiKey: 'secret' } }, sensitivity: 'secret' }],
    })
    await expect(scanProfileArchive({ path: fixture.path, password: 'wrong' })).rejects.toMatchObject({ code: 'ARCHIVE_AUTHENTICATION_FAILED' })
    await expect(scanProfileArchive(fixture)).resolves.toMatchObject({ preview: { encrypted: true } })
  })

  it.each([
    ['deep nesting', (() => { let value: unknown = 'leaf'; for (let depth = 0; depth < 70; depth += 1) value = { child: value }; return value })()],
    ['long string', randomBytes(800 * 1024).toString('base64')],
    ['large array', Array.from({ length: 100_001 }, () => 0)],
  ])('rejects JSON with excessive %s', async (_label, payload) => {
    const fixture = await createArchive({
      components: [{ id: 'profile.preferences', path: 'components/profile.preferences/preferences.json', value: { schemaVersion: 1, payload } }],
    })
    await expect(scanProfileArchive(fixture)).rejects.toMatchObject({ code: 'ARCHIVE_RESOURCE_LIMIT' })
  })

  it.each([
    ['active automation', [{ id: 'automation-1', enabled: true, status: 'active' }]],
    ['automation approval', [{ id: 'automation-1', enabled: false, status: 'paused', pendingApprovals: ['approval-1'] }]],
    ['automation secret', [{ id: 'automation-1', enabled: false, status: 'paused', apiToken: 'secret-token' }]],
  ])('rejects %s state', async (_label, automations) => {
    const fixture = await createArchive({
      components: [{
        id: 'automations',
        path: 'components/automations/automations.json',
        value: { schemaVersion: 1, automations, importedEnabled: false },
        sensitivity: 'executable',
      }],
    })
    await expect(scanProfileArchive(fixture)).rejects.toMatchObject({ code: 'ARCHIVE_COMPONENT_INVALID' })
  })

  it.each([
    ['enabled MCP', { enabled: true, command: 'node' }],
    ['MCP inline secret', { enabled: false, command: 'node', env: { API_TOKEN: 'secret-token' } }],
  ])('rejects %s configuration', async (_label, server) => {
    const fixture = await createArchive({
      components: [{
        id: 'mcp.configurations',
        path: 'components/mcp.configurations/configurations.json',
        value: { schemaVersion: 1, configurations: { mcpServers: { imported: server } }, importedEnabled: false },
        sensitivity: 'executable',
      }],
    })
    await expect(scanProfileArchive(fixture)).rejects.toMatchObject({ code: 'ARCHIVE_COMPONENT_INVALID' })
  })

  it('rejects a conversation that carries an active approval', async () => {
    const fixture = await createArchive({
      components: [
        {
          id: 'conversations',
          path: 'components/conversations/index.json',
          value: { schemaVersion: 1, items: [{ id: 'conversation-1', path: 'components/conversations/items/conversation-1.json' }] },
          itemCount: 1,
          sensitivity: 'private',
        },
        {
          id: 'conversations',
          path: 'components/conversations/items/conversation-1.json',
          value: { schemaVersion: 1, conversation: { id: 'conversation-1', pendingApprovals: ['approval-1'] } },
          sensitivity: 'private',
        },
      ],
    })
    await expect(scanProfileArchive(fixture)).rejects.toMatchObject({ code: 'ARCHIVE_COMPONENT_INVALID' })
  })

  it('rejects Conversation V2 interaction documents that carry queued runtime state', async () => {
    const fixture = await createArchive({
      components: [
        {
          id: 'conversations',
          path: 'components/conversations/index.json',
          value: { schemaVersion: 2, items: [{ id: 'conversation-1', path: 'components/conversations/events/conversation-1.json', interactionPath: 'components/conversations/interactions/conversation-1.json', eventCount: 0, lastSeq: 0 }] },
          schemaVersion: 2,
          itemCount: 1,
          sensitivity: 'private',
        },
        {
          id: 'conversations',
          path: 'components/conversations/events/conversation-1.json',
          value: { schemaVersion: 2, conversationId: 'conversation-1', events: [] },
          schemaVersion: 2,
          sensitivity: 'private',
        },
        {
          id: 'conversations',
          path: 'components/conversations/interactions/conversation-1.json',
          value: { schemaVersion: 1, conversationId: 'conversation-1', draft: { text: 'safe' }, queuedInputs: [{ prompt: 'run me' }] },
          schemaVersion: 2,
          sensitivity: 'private',
        },
      ],
    })

    await expect(scanProfileArchive(fixture)).rejects.toMatchObject({ code: 'ARCHIVE_COMPONENT_INVALID' })
  })

  it('rejects Conversation V2 manifests whose segment totals do not match the event documents', async () => {
    const fixture = await createArchive({
      components: [
        {
          id: 'conversations',
          path: 'components/conversations/index.json',
          value: { schemaVersion: 2, items: [{ id: 'conversation-1', path: 'components/conversations/events/conversation-1.json', eventCount: 1, lastSeq: 1 }] },
          schemaVersion: 2,
          itemCount: 1,
          sensitivity: 'private',
        },
        {
          id: 'conversations',
          path: 'components/conversations/events/conversation-1.json',
          value: { schemaVersion: 2, conversationId: 'conversation-1', events: [] },
          schemaVersion: 2,
          sensitivity: 'private',
        },
      ],
    })

    await expect(scanProfileArchive(fixture)).rejects.toMatchObject({
      code: 'ARCHIVE_COMPONENT_INVALID',
      message: expect.stringContaining('事件数量'),
    })
  })

  it('rejects duplicate Conversation V2 event identities across conversation segments', async () => {
    const event = (conversationId: string) => ({
      schemaVersion: 2,
      eventId: 'event-shared-across-conversations',
      profileId: 'source-profile',
      conversationId,
      seq: 1,
      at: 100,
      source: 'user',
      provenance: 'live',
      type: 'conversation.renamed',
      payload: { title: conversationId, titleSource: 'custom' },
    })
    const fixture = await createArchive({
      components: [
        {
          id: 'conversations',
          path: 'components/conversations/index.json',
          value: { schemaVersion: 2, items: [
            { id: 'conversation-1', path: 'components/conversations/events/conversation-1.json', eventCount: 1, lastSeq: 1 },
            { id: 'conversation-2', path: 'components/conversations/events/conversation-2.json', eventCount: 1, lastSeq: 1 },
          ] },
          schemaVersion: 2,
          itemCount: 2,
          sensitivity: 'private',
        },
        {
          id: 'conversations',
          path: 'components/conversations/events/conversation-1.json',
          value: { schemaVersion: 2, conversationId: 'conversation-1', events: [event('conversation-1')] },
          schemaVersion: 2,
          sensitivity: 'private',
        },
        {
          id: 'conversations',
          path: 'components/conversations/events/conversation-2.json',
          value: { schemaVersion: 2, conversationId: 'conversation-2', events: [event('conversation-2')] },
          schemaVersion: 2,
          sensitivity: 'private',
        },
      ],
    })

    await expect(scanProfileArchive(fixture)).rejects.toMatchObject({ code: 'ARCHIVE_COMPONENT_INVALID' })
  })

  it('rejects Conversation V2 events that claim another source profile', async () => {
    const fixture = await createArchive({
      components: [
        {
          id: 'conversations',
          path: 'components/conversations/index.json',
          value: { schemaVersion: 2, items: [{ id: 'conversation-1', path: 'components/conversations/events/conversation-1.json', eventCount: 1, lastSeq: 1 }] },
          schemaVersion: 2,
          itemCount: 1,
          sensitivity: 'private',
        },
        {
          id: 'conversations',
          path: 'components/conversations/events/conversation-1.json',
          value: { schemaVersion: 2, conversationId: 'conversation-1', events: [{
            schemaVersion: 2,
            eventId: 'event-foreign-profile',
            profileId: 'foreign-profile',
            conversationId: 'conversation-1',
            seq: 1,
            at: 100,
            source: 'user',
            provenance: 'live',
            type: 'conversation.renamed',
            payload: { title: 'Foreign', titleSource: 'custom' },
          }] },
          schemaVersion: 2,
          sensitivity: 'private',
        },
      ],
    })

    await expect(scanProfileArchive(fixture)).rejects.toMatchObject({ code: 'ARCHIVE_COMPONENT_INVALID' })
  })
})
