import { unwatchFile, watchFile } from 'node:fs'
import { getConfigFile, loadConfig, type TurboFluxConfig } from '../core/config'
import { getCredentialsFile } from '../core/credentialStore'
import { getProfileFile, loadProfile, type TurboFluxProfile } from '../core/profile'

export interface GlobalConfigurationSnapshot {
  config: TurboFluxConfig
  profile: TurboFluxProfile
}

export interface GlobalConfigurationWatchOptions {
  intervalMs?: number
  debounceMs?: number
  onError?: (error: Error) => void
}

export function globalConfigurationFingerprint(snapshot: GlobalConfigurationSnapshot): string {
  return JSON.stringify([snapshot.config, snapshot.profile])
}

export function watchGlobalConfiguration(
  listener: (snapshot: GlobalConfigurationSnapshot) => void | Promise<void>,
  options: GlobalConfigurationWatchOptions = {},
): () => void {
  const paths = [getConfigFile(), getCredentialsFile(), getProfileFile()]
  const intervalMs = options.intervalMs ?? 750
  const debounceMs = options.debounceMs ?? 100
  let stopped = false
  let loading = false
  let reloadRequested = false
  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  const load = async () => {
    if (stopped) return
    if (loading) {
      reloadRequested = true
      return
    }
    loading = true
    try {
      const config = await loadConfig()
      if (!stopped) await listener({ config, profile: loadProfile() })
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)))
    } finally {
      loading = false
      if (reloadRequested && !stopped) {
        reloadRequested = false
        schedule()
      }
    }
  }

  const schedule = () => {
    if (stopped) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      void load()
    }, debounceMs)
  }

  for (const path of paths) {
    watchFile(path, { interval: intervalMs, persistent: false }, schedule)
  }

  return () => {
    stopped = true
    if (debounceTimer) clearTimeout(debounceTimer)
    for (const path of paths) unwatchFile(path, schedule)
  }
}
