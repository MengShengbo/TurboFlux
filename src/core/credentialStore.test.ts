import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalConfigDir = process.env.TURBOFLUX_CONFIG_DIR

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.TURBOFLUX_CONFIG_DIR
  else process.env.TURBOFLUX_CONFIG_DIR = originalConfigDir
  vi.resetModules()
})

describe('credential storage', () => {
  it('keeps API keys out of config.json and restores them on load', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'turboflux-credentials-'))
    process.env.TURBOFLUX_CONFIG_DIR = directory
    vi.resetModules()
    try {
      const { saveConfig, loadConfig } = await import('./config.js')
      saveConfig({
        provider: 'openai',
        apiKey: 'sk-secret-value',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-test',
        contextWindow: 128_000,
        maxTokens: 4096,
      })

      const configDocument = readFileSync(join(directory, 'config.json'), 'utf-8')
      const credentialsDocument = readFileSync(join(directory, 'credentials.json'), 'utf-8')
      const loaded = await loadConfig()

      expect(configDocument).not.toContain('sk-secret-value')
      expect(credentialsDocument).toContain('sk-secret-value')
      expect(loaded.apiKey).toBe('sk-secret-value')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
