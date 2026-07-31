import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalConfigDir = process.env.TURBOFLUX_CONFIG_DIR
const originalApiKey = process.env.TURBOFLUX_API_KEY

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.TURBOFLUX_CONFIG_DIR
  else process.env.TURBOFLUX_CONFIG_DIR = originalConfigDir
  if (originalApiKey === undefined) delete process.env.TURBOFLUX_API_KEY
  else process.env.TURBOFLUX_API_KEY = originalApiKey
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

  it('does not persist a process-level API key override during unrelated saves', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'turboflux-env-credentials-'))
    process.env.TURBOFLUX_CONFIG_DIR = directory
    delete process.env.TURBOFLUX_API_KEY
    vi.resetModules()
    try {
      const { saveConfig, loadConfig } = await import('./config.js')
      saveConfig({
        provider: 'openai',
        apiKey: 'sk-persisted',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-test',
        contextWindow: 128_000,
        maxTokens: 4096,
        approvalPolicy: 'ask',
        gitEnabled: true,
      })
      process.env.TURBOFLUX_API_KEY = 'sk-process-only'
      const loaded = await loadConfig()
      expect(loaded.apiKey).toBe('sk-process-only')

      const activeUpdatedAt = loaded.apiConfigs?.find(profile => profile.id === loaded.activeApiConfigId)?.updatedAt
      const saved = saveConfig({ ...loaded, approvalPolicy: 'agent' })

      const credentials = JSON.parse(readFileSync(join(directory, 'credentials.json'), 'utf-8'))
      const configDocument = readFileSync(join(directory, 'config.json'), 'utf-8')
      expect(credentials.apiKey).toBe('sk-persisted')
      expect(Object.values(credentials.apiConfigs)).toContain('sk-persisted')
      expect(JSON.stringify(credentials)).not.toContain('sk-process-only')
      expect(configDocument).not.toContain('sk-process-only')
      expect(saved.apiConfigs?.find(profile => profile.id === saved.activeApiConfigId)?.updatedAt).toBe(activeUpdatedAt)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('preserves malformed config before rebuilding it from stored credentials', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'turboflux-corrupt-config-'))
    process.env.TURBOFLUX_CONFIG_DIR = directory
    delete process.env.TURBOFLUX_API_KEY
    writeFileSync(join(directory, 'config.json'), '{broken', 'utf-8')
    writeFileSync(join(directory, 'credentials.json'), JSON.stringify({ apiKey: 'sk-recoverable' }), 'utf-8')
    vi.resetModules()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { loadConfig } = await import('./config.js')
      const loaded = await loadConfig()

      expect(loaded.apiKey).toBe('sk-recoverable')
      expect(JSON.parse(readFileSync(join(directory, 'config.json'), 'utf-8')).apiKey).toBe('')
      const backup = readdirSync(directory).find(name => name.startsWith('config.json.corrupt-'))
      expect(backup).toBeDefined()
      expect(readFileSync(join(directory, backup!), 'utf-8')).toBe('{broken')
      expect(warn.mock.calls.some(([message]) => String(message).includes('invalid configuration file'))).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('preserves malformed credentials instead of silently discarding the only copy', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'turboflux-corrupt-credentials-'))
    process.env.TURBOFLUX_CONFIG_DIR = directory
    delete process.env.TURBOFLUX_API_KEY
    writeFileSync(join(directory, 'config.json'), JSON.stringify({
      provider: 'openai',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-test',
      contextWindow: 128_000,
      maxTokens: 4096,
      approvalPolicy: 'ask',
      gitEnabled: true,
      activeApiConfigId: 'main',
      apiConfigs: [{
        id: 'main',
        name: 'Main',
        provider: 'openai',
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-test',
        contextWindow: 128_000,
        maxTokens: 4096,
        createdAt: 1,
        updatedAt: 1,
      }],
    }), 'utf-8')
    writeFileSync(join(directory, 'credentials.json'), '{broken-secret-document', 'utf-8')
    vi.resetModules()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { loadConfig } = await import('./config.js')
      const loaded = await loadConfig()

      expect(loaded.apiKey).toBe('')
      const backup = readdirSync(directory).find(name => name.startsWith('credentials.json.corrupt-'))
      expect(backup).toBeDefined()
      expect(readFileSync(join(directory, backup!), 'utf-8')).toBe('{broken-secret-document')
      expect(warn.mock.calls.some(([message]) => String(message).includes('invalid credentials file'))).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('migrates legacy full approval to complete runtime access', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'turboflux-full-access-migration-'))
    process.env.TURBOFLUX_CONFIG_DIR = directory
    delete process.env.TURBOFLUX_API_KEY
    writeFileSync(join(directory, 'config.json'), JSON.stringify({
      provider: 'custom',
      apiKey: '',
      baseUrl: 'https://api.example.test/v1',
      model: 'test-model',
      contextWindow: 128_000,
      maxTokens: 4096,
      approvalPolicy: 'full',
      capabilityProfile: 'workspace-write',
      gitEnabled: true,
    }), 'utf-8')
    vi.resetModules()
    try {
      const { loadConfig } = await import('./config.js')
      const loaded = await loadConfig()
      const persisted = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf-8'))

      expect(loaded.capabilityProfile).toBe('danger-full-access')
      expect(persisted.capabilityProfile).toBe('danger-full-access')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('migrates legacy credentials without dropping advanced model metadata', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'turboflux-legacy-config-'))
    process.env.TURBOFLUX_CONFIG_DIR = directory
    delete process.env.TURBOFLUX_API_KEY
    writeFileSync(join(directory, 'config.json'), JSON.stringify({
      provider: 'custom',
      apiKey: 'legacy-secret',
      baseUrl: 'https://api.example.test/v1',
      model: 'vendor/reasoner',
      contextWindow: 100_000,
      maxTokens: 8_000,
      maxOutputTokens: 12_000,
      modelCapabilities: { reasoning: true, reasoningEfforts: ['low', 'high'] },
      modelMetadataSources: ['api'],
      approvalPolicy: 'ask',
      gitEnabled: true,
    }), 'utf-8')
    vi.resetModules()
    try {
      const { loadConfig } = await import('./config.js')
      const loaded = await loadConfig()
      const profile = loaded.apiConfigs?.[0]

      expect(profile?.maxOutputTokens).toBe(12_000)
      expect(profile?.modelCapabilities?.reasoningEfforts).toEqual(['low', 'high'])
      expect(profile?.modelMetadataSources).toEqual(['api'])
      expect(readFileSync(join(directory, 'config.json'), 'utf-8')).not.toContain('legacy-secret')
      expect(readFileSync(join(directory, 'credentials.json'), 'utf-8')).toContain('legacy-secret')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
