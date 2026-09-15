import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InstallationProfileRegistry } from './profileRegistry'
import { copyNonSecretProfileSettings, redactProfileSettingsSecrets } from './profileSettingsCopyService'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('profile settings copy', () => {
  it('removes secret fields recursively without mutating the source', () => {
    const source = { model: 'gpt', apiKey: 'secret', nested: { accessToken: 'token', theme: 'dark' }, list: [{ password: 'hidden', value: 1 }] }

    expect(redactProfileSettingsSecrets(source)).toEqual({ model: 'gpt', nested: { theme: 'dark' }, list: [{ value: 1 }] })
    expect(source.apiKey).toBe('secret')
  })

  it('copies only config and persona documents to a blank profile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-profile-copy-'))
    roots.push(root)
    const registry = new InstallationProfileRegistry(root, { createId: (() => { const ids = ['profile-source-0001', 'profile-target-0002']; return () => ids.shift()! })() })
    registry.initialize()
    const source = registry.activeContext()
    const target = registry.create({ displayName: 'Target' })
    writeFileSync(source.storage.configPath, JSON.stringify({ theme: 'dark', apiKey: 'source-secret' }))
    writeFileSync(source.storage.personaPath, JSON.stringify({ name: 'Writer', authorization: 'Bearer source-secret' }))

    await copyNonSecretProfileSettings(source, target)

    expect(JSON.parse(readFileSync(target.storage.configPath, 'utf8'))).toEqual({ theme: 'dark' })
    expect(JSON.parse(readFileSync(target.storage.personaPath, 'utf8'))).toEqual({ name: 'Writer' })
    expect(readFileSync(source.storage.configPath, 'utf8')).toContain('source-secret')
  })
})
