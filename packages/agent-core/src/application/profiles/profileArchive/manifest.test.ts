import { describe, expect, it } from 'vitest'
import { finalizeManifest, parseManifest, serializeManifest } from './manifest'
import { ProfileArchiveError } from './types'

function fixture() {
  return finalizeManifest({
    schemaVersion: 1,
    archiveId: 'archive-1',
    exportedAt: 1_788_200_000_000,
    source: { appVersion: '1.0.1', coreVersion: '1.0.1', platform: 'darwin', profileStorageVersion: 1 },
    profile: { sourceProfileId: 'profile-default', displayName: '默认资料' },
    components: [{ id: 'conversations', schemaVersion: 1, itemCount: 2, logicalBytes: 10, blobCount: 0, sensitivity: 'private' }],
    workspaces: [{ id: 'workspace-12345678', displayName: 'Demo' }],
  })
}

describe('profile archive manifest', () => {
  it('uses deterministic serialization and validates its content digest', () => {
    const manifest = fixture()
    expect(parseManifest(JSON.parse(serializeManifest(manifest).toString('utf8')))).toEqual(manifest)
    expect(serializeManifest(manifest).toString('utf8')).toContain('"schemaVersion":1')
  })

  it('accepts UUID workspace identities while retaining legacy archive compatibility', () => {
    const manifest = fixture()
    const { contentDigest: _contentDigest, ...unsigned } = manifest
    const uuidManifest = finalizeManifest({
      ...unsigned,
      workspaces: [{ id: 'a47ac10b-58cc-4372-a567-0e02b2c3d479', displayName: 'UUID workspace' }],
    })
    expect(parseManifest(uuidManifest).workspaces[0]?.id).toBe('a47ac10b-58cc-4372-a567-0e02b2c3d479')
    expect(parseManifest(manifest).workspaces[0]?.id).toBe('workspace-12345678')
  })

  it('fails closed for an altered manifest or unknown required component', () => {
    const altered = { ...fixture(), exportedAt: 2 }
    expect(() => parseManifest(altered)).toThrow(ProfileArchiveError)
    const unknown = { ...fixture(), components: [{ ...fixture().components[0], id: 'future.required' }] }
    expect(() => parseManifest(unknown)).toThrow('清单不完整')
  })

  it('fails closed for missing or mistyped manifest fields', () => {
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      value => { delete value.archiveId },
      value => { value.exportedAt = 'now' },
      value => { value.source = null },
      value => { value.profile = [] },
      value => { value.components = {} },
      value => { value.workspaces = 'all' },
      value => { value.contentDigest = 'invalid' },
    ]
    for (const mutate of mutations) {
      const malformed = structuredClone(fixture()) as unknown as Record<string, unknown>
      mutate(malformed)
      expect(() => parseManifest(malformed)).toThrow()
    }
  })

  it('requires strict Conversation V2 segment and projection metadata', () => {
    const manifest = finalizeManifest({
      schemaVersion: 1,
      archiveId: 'archive-v2',
      exportedAt: 1_788_200_000_000,
      source: { appVersion: '1.0.1', coreVersion: '1.0.1', platform: 'darwin', profileStorageVersion: 1 },
      profile: { sourceProfileId: 'profile-default', displayName: '默认资料' },
      conversationDataVersion: 2,
      conversationData: {
        schemaVersion: 2,
        eventSegments: { format: 'per-conversation-json', indexPath: 'components/conversations/index.json', segmentCount: 2, eventCount: 10 },
        projections: { included: false, rebuildRequired: true },
        migrationSources: ['legacy-v1'],
      },
      components: [{ id: 'conversations', schemaVersion: 2, itemCount: 2, logicalBytes: 10, blobCount: 0, sensitivity: 'private' }],
      workspaces: [{ id: 'workspace-12345678', displayName: 'Demo' }],
    })
    expect(parseManifest(manifest)).toEqual(manifest)

    const missing = finalizeManifest({
      schemaVersion: 1,
      archiveId: 'archive-v2-missing',
      exportedAt: 1_788_200_000_000,
      source: manifest.source,
      profile: manifest.profile,
      conversationDataVersion: 2,
      components: manifest.components,
      workspaces: manifest.workspaces,
    })
    expect(() => parseManifest(missing)).toThrow('清单不完整')

    const downgraded = finalizeManifest({
      schemaVersion: 1,
      archiveId: 'archive-v2-downgraded',
      exportedAt: 1_788_200_000_000,
      source: manifest.source,
      profile: manifest.profile,
      components: manifest.components,
      workspaces: manifest.workspaces,
    })
    expect(() => parseManifest(downgraded)).toThrow('清单不完整')

    const unsafeProjection = structuredClone(manifest) as unknown as Record<string, unknown>
    const conversationData = unsafeProjection.conversationData as Record<string, unknown>
    conversationData.projections = { included: true, rebuildRequired: false }
    const { contentDigest: _contentDigest, ...unsigned } = unsafeProjection
    expect(() => parseManifest(finalizeManifest(unsigned as Parameters<typeof finalizeManifest>[0]))).toThrow('清单不完整')
  })
})
