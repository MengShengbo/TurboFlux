import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileLifecycleCoordinator } from './profileLifecycleCoordinator'
import { InstallationProfileRegistry } from './profileRegistry'

const roots: string[] = []

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-profile-lifecycle-'))
  roots.push(root)
  let nextId = 0
  const registry = new InstallationProfileRegistry(join(root, 'data'), {
    deviceRoot: join(root, 'device'),
    createId: () => nextId++ === 0 ? 'default-profile' : `secondary-profile-${nextId}`,
    installationId: () => 'installation-test',
    now: () => 100,
  })
  registry.initialize()
  const secondary = registry.create({ displayName: 'Secondary' })
  writeFileSync(join(secondary.storage.profileRoot, 'history.txt'), 'preserve me')
  mkdirSync(secondary.storage.remoteRoot, { recursive: true })
  writeFileSync(join(secondary.storage.remoteRoot, 'grant.json'), '{}')
  return { root, registry, secondary }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('ProfileLifecycleCoordinator', () => {
  it('moves an inactive profile to recoverable trash and revokes device-bound state', () => {
    const { registry, secondary } = fixture()
    const coordinator = new ProfileLifecycleCoordinator({ registry, createId: () => 'trash-1' })
    expect(coordinator.trash(secondary.profile.id).state).toBe('trashed')
    expect(existsSync(secondary.storage.profileRoot)).toBe(false)
    expect(existsSync(join(coordinator.trashRoot, secondary.profile.id, 'history.txt'))).toBe(true)
    expect(existsSync(secondary.storage.deviceBoundRoot)).toBe(false)
    expect(coordinator.restore(secondary.profile.id).state).toBe('ready')
    expect(existsSync(join(secondary.storage.profileRoot, 'history.txt'))).toBe(true)
    expect(existsSync(secondary.storage.remoteRoot)).toBe(false)
  })

  it('never trashes the active profile', () => {
    const { registry } = fixture()
    expect(() => new ProfileLifecycleCoordinator({ registry }).trash(registry.snapshot().activeProfileId)).toThrow('当前资料不能回收')
  })

  it.each([
    ['prepared', 'rolled_back', false],
    ['registered', 'committed', true],
    ['moved', 'committed', true],
  ] as const)('recovers trash interruption after %s as %s', (phase, outcome, trashed) => {
    const { registry, secondary } = fixture()
    const coordinator = new ProfileLifecycleCoordinator({ registry, createId: () => `trash-${phase}`, faultAfterPhase: phase })
    expect(() => coordinator.trash(secondary.profile.id)).toThrow(`trash:${phase}`)
    const recovered = new ProfileLifecycleCoordinator({ registry }).recoverTransactions()
    expect(recovered).toEqual([{ transactionId: `profile-lifecycle-trash-${phase}`, outcome }])
    expect(registry.context(secondary.profile.id).profile.state === 'trashed').toBe(trashed)
  })

  it.each([
    ['prepared', 'rolled_back', true],
    ['moved', 'committed', false],
    ['registered', 'committed', false],
  ] as const)('recovers restore interruption after %s as %s', (phase, outcome, trashed) => {
    const { registry, secondary } = fixture()
    new ProfileLifecycleCoordinator({ registry, createId: () => 'initial-trash' }).trash(secondary.profile.id)
    const coordinator = new ProfileLifecycleCoordinator({ registry, createId: () => `restore-${phase}`, faultAfterPhase: phase })
    expect(() => coordinator.restore(secondary.profile.id)).toThrow(`restore:${phase}`)
    const recovered = new ProfileLifecycleCoordinator({ registry }).recoverTransactions()
    expect(recovered).toEqual([{ transactionId: `profile-lifecycle-restore-${phase}`, outcome }])
    expect(registry.context(secondary.profile.id).profile.state === 'trashed').toBe(trashed)
  })
})
