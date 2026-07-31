import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('global configuration watcher', () => {
  const directories: string[] = []
  const previousConfigDirectory = process.env.TURBOFLUX_CONFIG_DIR
  const previousApiKey = process.env.TURBOFLUX_API_KEY

  afterEach(() => {
    vi.resetModules()
    if (previousConfigDirectory === undefined) delete process.env.TURBOFLUX_CONFIG_DIR
    else process.env.TURBOFLUX_CONFIG_DIR = previousConfigDirectory
    if (previousApiKey === undefined) delete process.env.TURBOFLUX_API_KEY
    else process.env.TURBOFLUX_API_KEY = previousApiKey
    while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
  })

  it('observes profile writes made by an external setup process', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'turboflux-global-watch-'))
    directories.push(directory)
    process.env.TURBOFLUX_CONFIG_DIR = directory
    delete process.env.TURBOFLUX_API_KEY
    vi.resetModules()
    const { watchGlobalConfiguration } = await import('./globalConfiguration.js')
    const { loadProfile, saveProfile } = await import('../core/profile.js')
    await import('../core/config.js').then(module => module.loadConfig())
    loadProfile()

    const snapshots: Array<{ defaultPersonaId: string }> = []
    const stop = watchGlobalConfiguration(snapshot => {
      snapshots.push({ defaultPersonaId: snapshot.profile.defaultPersonaId })
    }, { intervalMs: 20, debounceMs: 5 })

    try {
      saveProfile({ enabledPersonaIds: ['architect'], defaultPersonaId: 'architect' })
      await vi.waitFor(() => {
        expect(snapshots.at(-1)?.defaultPersonaId).toBe('architect')
      }, { timeout: 2_000, interval: 20 })
    } finally {
      stop()
    }
  })

  it('observes credential-only writes without exposing them through config.json', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'turboflux-global-credentials-'))
    directories.push(directory)
    process.env.TURBOFLUX_CONFIG_DIR = directory
    delete process.env.TURBOFLUX_API_KEY
    vi.resetModules()
    const { watchGlobalConfiguration } = await import('./globalConfiguration.js')
    const { loadConfig, saveConfig } = await import('../core/config.js')
    const { saveCredentialSnapshot } = await import('../core/credentialStore.js')
    const initial = saveConfig({
      provider: 'openai',
      apiKey: 'sk-initial',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-test',
      contextWindow: 128_000,
      maxTokens: 4096,
      approvalPolicy: 'ask',
      gitEnabled: true,
    })
    const activeId = initial.activeApiConfigId!
    await loadConfig()

    const keys: string[] = []
    const stop = watchGlobalConfiguration(snapshot => {
      keys.push(snapshot.config.apiKey)
    }, { intervalMs: 20, debounceMs: 5 })

    try {
      saveCredentialSnapshot({ apiKey: 'sk-external', apiConfigs: { [activeId]: 'sk-external' } })
      await vi.waitFor(() => {
        expect(keys.at(-1)).toBe('sk-external')
      }, { timeout: 2_000, interval: 20 })
    } finally {
      stop()
    }
  })
})
