import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('global configuration watcher', () => {
  const directories: string[] = []
  const previousConfigDirectory = process.env.TURBOFLUX_CONFIG_DIR

  afterEach(() => {
    vi.resetModules()
    if (previousConfigDirectory === undefined) delete process.env.TURBOFLUX_CONFIG_DIR
    else process.env.TURBOFLUX_CONFIG_DIR = previousConfigDirectory
    while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
  })

  it('observes profile writes made by an external setup process', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'turboflux-global-watch-'))
    directories.push(directory)
    process.env.TURBOFLUX_CONFIG_DIR = directory
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
})
