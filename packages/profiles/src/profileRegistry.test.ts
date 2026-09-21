import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InstallationProfileRegistry } from './profileRegistry'
import { createProfileStorageLayout, workspaceOverlayRoot } from './profileStorageLayout'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-profiles-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('InstallationProfileRegistry', () => {
  it('uses UUIDs for newly created profile identities', () => {
    const registry = new InstallationProfileRegistry(temporaryRoot())
    const initial = registry.initialize()
    const created = registry.create({ displayName: 'Second' })
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    expect(initial.activeProfileId).toMatch(uuid)
    expect(created.profile.id).toMatch(uuid)
  })

  it('creates one durable default profile and stable isolated storage roots', () => {
    const root = temporaryRoot()
    let sequence = 0
    const registry = new InstallationProfileRegistry(root, {
      now: () => 1_000 + sequence,
      createId: () => `profile-${++sequence}`,
      installationId: () => 'installation-1',
    })

    const initial = registry.initialize()
    expect(initial).toMatchObject({ installationId: 'installation-1', activeProfileId: 'profile-1' })
    expect(initial.profiles).toHaveLength(1)
    expect(initial.profiles[0]).toMatchObject({ displayName: '默认资料', state: 'ready' })
    expect(existsSync(registry.activeContext().storage.conversationsRoot)).toBe(true)

    const second = registry.create({ displayName: ' Work   Profile ' })
    expect(second.profile).toMatchObject({ id: 'profile-2', displayName: 'Work Profile', state: 'ready' })
    expect(second.storage.profileRoot).not.toBe(registry.activeContext().storage.profileRoot)
    writeFileSync(join(second.storage.configRoot, 'private.txt'), 'second')
    expect(existsSync(join(registry.activeContext().storage.configRoot, 'private.txt'))).toBe(false)

    registry.activate(second.profile.id)
    const restored = new InstallationProfileRegistry(root).initialize()
    expect(restored.activeProfileId).toBe('profile-2')
    expect(restored.profiles.map(profile => profile.displayName)).toEqual(['默认资料', 'Work Profile'])
  })

  it('rebuilds an invalid registry from valid profile metadata without deleting data', () => {
    const root = temporaryRoot()
    const registry = new InstallationProfileRegistry(root, {
      createId: () => 'profile-default',
      installationId: () => 'installation-original',
      now: () => 100,
    })
    registry.initialize()
    writeFileSync(join(registry.activeContext().storage.profileRoot, 'kept.txt'), 'keep')
    writeFileSync(join(root, 'profiles.json'), '{broken')

    const recovered = new InstallationProfileRegistry(root, {
      installationId: () => 'installation-recovered',
      now: () => 200,
    }).initialize()

    expect(recovered.installationId).toBe('installation-recovered')
    expect(recovered.activeProfileId).toBe('profile-default')
    expect(recovered.warnings.join(' ')).toMatch(/invalid local profile registry|Rebuilt/u)
    expect(readFileSync(join(root, 'profiles', 'profile-default', 'kept.txt'), 'utf8')).toBe('keep')
  })

  it('fails closed without renaming or replacing a newer registry', () => {
    const root = temporaryRoot()
    mkdirSync(join(root, 'profiles'), { recursive: true })
    const registryPath = join(root, 'profiles.json')
    const futureRegistry = JSON.stringify({ schemaVersion: 99, installationId: 'future', activeProfileId: 'future-profile', profiles: [] })
    writeFileSync(registryPath, futureRegistry)

    expect(() => new InstallationProfileRegistry(root, { now: () => 200 }).initialize()).toThrow('compatible TurboFlux version')
    expect(readFileSync(registryPath, 'utf8')).toBe(futureRegistry)
    expect(existsSync(`${registryPath}.corrupt-200`)).toBe(false)
    expect(readdirSync(join(root, 'profiles'))).toEqual([])
  })

  it('fails closed when profile directories use a newer storage version', () => {
    const root = temporaryRoot()
    const profileRoot = join(root, 'profiles', 'future-profile')
    mkdirSync(profileRoot, { recursive: true })
    const metadataPath = join(profileRoot, 'profile.json')
    writeFileSync(metadataPath, JSON.stringify({
      schemaVersion: 1,
      id: 'future-profile',
      displayName: 'Future',
      createdAt: 1,
      updatedAt: 1,
      state: 'ready',
      lock: { kind: 'none' },
      storageVersion: 99,
    }))

    expect(() => new InstallationProfileRegistry(root).initialize()).toThrow('future-profile (storage 99)')
    expect(readFileSync(metadataPath, 'utf8')).toContain('"storageVersion":99')
    expect(existsSync(join(root, 'profiles.json'))).toBe(false)
  })

  it('prevents activating importing profiles and trashing the active profile', () => {
    const root = temporaryRoot()
    let sequence = 0
    const registry = new InstallationProfileRegistry(root, {
      createId: () => `profile-${++sequence}`,
      installationId: () => 'installation-1',
    })
    registry.initialize()
    const imported = registry.create({
      displayName: 'Imported',
      importedFrom: { archiveId: 'archive-1', sourceProfileId: 'source-1', importedAt: 1 },
    })

    expect(() => registry.activate(imported.profile.id)).toThrow(/not available/u)
    expect(() => registry.setState(registry.snapshot().activeProfileId, 'trashed')).toThrow(/active/u)
    registry.setState(imported.profile.id, 'ready')
    expect(registry.activate(imported.profile.id).profile.id).toBe(imported.profile.id)
  })
})

describe('ProfileStorageLayout', () => {
  it('rejects unsafe profile and workspace identities', () => {
    const root = temporaryRoot()
    expect(() => createProfileStorageLayout(root, join(root, 'device'), '../escape')).toThrow(/Invalid/u)
    const layout = createProfileStorageLayout(root, join(root, 'device'), 'profile-safe')
    expect(() => workspaceOverlayRoot(layout, '../workspace-bad')).toThrow(/Invalid/u)
    expect(workspaceOverlayRoot(layout, 'workspace-abcdefgh')).toBe(join(layout.workspaceOverlaysRoot, 'workspace-abcdefgh'))
    const uuid = 'a47ac10b-58cc-4372-a567-0e02b2c3d479'
    expect(workspaceOverlayRoot(layout, uuid)).toBe(join(layout.workspaceOverlaysRoot, uuid))
  })
})
