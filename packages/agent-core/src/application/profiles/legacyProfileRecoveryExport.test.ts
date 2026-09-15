import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InstallationProfileRegistry } from './profileRegistry'
import { writeLegacyProfileRecoveryExport } from './legacyProfileRecoveryExport'

const roots: string[] = []

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-profile-recovery-'))
  roots.push(root)
  const registry = new InstallationProfileRegistry(join(root, 'data'), {
    createId: () => 'default-profile',
    installationId: () => 'installation-secret',
  })
  registry.initialize()
  const context = registry.activeContext()
  writeFileSync(context.storage.configPath, JSON.stringify({ model: 'portable', apiKey: 'sk-never-export-this-value' }))
  writeFileSync(join(context.storage.conversationsRoot, 'conversation.jsonl'), '{"id":"conversation-1","content":"history survives"}\n')
  writeFileSync(context.storage.automationsPath, JSON.stringify({ schemaVersion: 2, automations: [{ id: 'automation-1', enabled: true, status: 'active', activeRunId: 'run-1', nextRunAt: 99 }], approvals: [{ id: 'approval-1' }] }))
  writeFileSync(context.storage.pluginsIndexPath, JSON.stringify({ schemaVersion: 1, plugins: [{ id: 'plugin-1', enabled: true, approvedPermissions: ['shell'] }] }))
  mkdirSync(join(context.storage.pluginsRoot, 'plugin-1'), { recursive: true })
  writeFileSync(join(context.storage.pluginsRoot, 'plugin-1', 'plugin.json'), '{"id":"plugin-1"}')
  mkdirSync(context.storage.pluginStorageRoot, { recursive: true })
  writeFileSync(join(context.storage.pluginStorageRoot, 'secret.json'), '{"token":"private"}')
  mkdirSync(context.storage.remoteRoot, { recursive: true })
  writeFileSync(join(context.storage.remoteRoot, 'grant.json'), '{"grant":"device"}')
  return { root, context }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('legacy profile recovery export', () => {
  it('writes a non-overwriting old-layout snapshot without secrets or active execution', () => {
    const { root, context } = fixture()
    const target = join(root, 'legacy-recovery')
    const result = writeLegacyProfileRecoveryExport(context, target, { now: () => 123 })

    expect(result).toMatchObject({ readOnlyRecovery: true, sourceProfileId: 'default-profile', createdAt: 123 })
    expect(readFileSync(join(target, 'legacy-config', 'conversations', 'conversation.jsonl'), 'utf8')).toContain('history survives')
    expect(JSON.parse(readFileSync(join(target, 'legacy-config', 'config.json'), 'utf8'))).toEqual({ model: 'portable', apiKey: '[REDACTED]' })
    expect(JSON.parse(readFileSync(join(target, 'legacy-platform', 'automations.json'), 'utf8'))).toMatchObject({
      approvals: [],
      automations: [{ id: 'automation-1', enabled: false, status: 'paused' }],
    })
    const automationText = readFileSync(join(target, 'legacy-platform', 'automations.json'), 'utf8')
    expect(automationText).not.toContain('activeRunId')
    expect(automationText).not.toContain('nextRunAt')
    expect(JSON.parse(readFileSync(join(target, 'legacy-platform', 'plugins.json'), 'utf8'))).toMatchObject({
      plugins: [{ id: 'plugin-1', enabled: false, approvedPermissions: [] }],
    })
    expect(existsSync(join(target, 'legacy-config', 'credentials.json'))).toBe(false)
    expect(existsSync(join(target, 'legacy-platform', 'plugin-storage'))).toBe(false)
    expect(readFileSync(join(target, 'recovery-manifest.json'), 'utf8')).not.toContain('installation-secret')
    expect(() => writeLegacyProfileRecoveryExport(context, target)).toThrow('already exists')
  })

  it('fails atomically instead of following a symlink', () => {
    if (process.platform === 'win32') return
    const { root, context } = fixture()
    symlinkSync(join(root, 'outside'), join(context.storage.userSkillsRoot, 'escape'))
    const target = join(root, 'legacy-recovery')

    expect(() => writeLegacyProfileRecoveryExport(context, target)).toThrow('does not follow symbolic links')
    expect(existsSync(target)).toBe(false)
    expect(readdirSync(root).some(entry => entry.includes('.staging-'))).toBe(false)
  })
})
