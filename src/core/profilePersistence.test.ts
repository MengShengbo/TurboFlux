import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalConfigDir = process.env.TURBOFLUX_CONFIG_DIR
const directories: string[] = []

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.TURBOFLUX_CONFIG_DIR
  else process.env.TURBOFLUX_CONFIG_DIR = originalConfigDir
  vi.restoreAllMocks()
  vi.resetModules()
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

function temporaryConfigDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'turboflux-profile-'))
  directories.push(directory)
  process.env.TURBOFLUX_CONFIG_DIR = directory
  vi.resetModules()
  return directory
}

describe('profile persistence', () => {
  it('preserves a malformed profile before restoring defaults', async () => {
    const directory = temporaryConfigDirectory()
    writeFileSync(join(directory, 'profile.json'), '{broken', 'utf-8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { loadProfile } = await import('./profile.js')

    const profile = loadProfile()

    expect(profile.defaultPersonaId).toBe('engineer-professional')
    expect(JSON.parse(readFileSync(join(directory, 'profile.json'), 'utf-8')).version).toBe(1)
    const backup = readdirSync(directory).find(name => name.startsWith('profile.json.corrupt-'))
    expect(backup).toBeDefined()
    expect(readFileSync(join(directory, backup!), 'utf-8')).toBe('{broken')
    expect(warn.mock.calls.some(([message]) => String(message).includes('invalid profile file'))).toBe(true)
  })

  it('merges independent profile fields under the profile lock', async () => {
    temporaryConfigDirectory()
    const { loadProfile, saveProfile } = await import('./profile.js')

    saveProfile({ interfaceLanguage: 'en' })
    saveProfile({ enabledPersonaIds: ['architect'], defaultPersonaId: 'architect' })

    const profile = loadProfile()
    expect(profile.interfaceLanguage).toBe('en')
    expect(profile.defaultPersonaId).toBe('architect')
  })
})
