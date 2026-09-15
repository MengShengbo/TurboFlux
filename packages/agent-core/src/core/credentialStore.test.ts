import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalConfigDir = process.env.TURBOFLUX_CONFIG_DIR
const originalApiKey = process.env.TURBOFLUX_API_KEY

function decodeCredentialsDocument(path: string): { protected: boolean; snapshot: Record<string, unknown> } {
  const document = JSON.parse(readFileSync(path, 'utf-8'))
  expect(document.schemaVersion).toBe(2)
  return {
    protected: document.protected === true,
    snapshot: JSON.parse(Buffer.from(document.payload, 'base64url').toString('utf-8')),
  }
}

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.TURBOFLUX_CONFIG_DIR
  else process.env.TURBOFLUX_CONFIG_DIR = originalConfigDir
  if (originalApiKey === undefined) delete process.env.TURBOFLUX_API_KEY
  else process.env.TURBOFLUX_API_KEY = originalApiKey
  vi.resetModules()
})

describe('credential storage', () => {
  it('keeps API keys out of config.json and stores them base64url-encoded in credentials.json', async () => {
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
      const decoded = decodeCredentialsDocument(join(directory, 'credentials.json'))
      const loaded = await loadConfig()

      expect(configDocument).not.toContain('sk-secret-value')
      expect(credentialsDocument).not.toContain('sk-secret-value')
      expect(decoded.protected).toBe(false)
      expect(decoded.snapshot.apiKey).toBe('sk-secret-value')
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

      const credentials = decodeCredentialsDocument(join(directory, 'credentials.json'))
      const configDocument = readFileSync(join(directory, 'config.json'), 'utf-8')
      expect(credentials.snapshot.apiKey).toBe('sk-persisted')
      expect(Object.values(credentials.snapshot.apiConfigs as Record<string, string>)).toContain('sk-persisted')
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
      const decoded = decodeCredentialsDocument(join(directory, 'credentials.json'))
      expect(decoded.snapshot.apiKey).toBe('legacy-secret')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('encrypts credentials at rest when platform protection is configured', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'turboflux-protected-credentials-'))
    process.env.TURBOFLUX_CONFIG_DIR = directory
    delete process.env.TURBOFLUX_API_KEY
    vi.resetModules()
    try {
      const { setCredentialProtection } = await import('./credentialStore.js')
      setCredentialProtection({
        protect: plaintext => Buffer.concat([Buffer.from('v1:'), plaintext]),
        unprotect: ciphertext => ciphertext.subarray(3),
      })
      const { saveConfig, loadConfig } = await import('./config.js')
      saveConfig({
        provider: 'openai',
        apiKey: 'sk-protected-secret',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-test',
        contextWindow: 128_000,
        maxTokens: 4096,
        approvalPolicy: 'ask',
        gitEnabled: true,
      })

      const credentialsDocument = readFileSync(join(directory, 'credentials.json'), 'utf-8')
      expect(credentialsDocument).not.toContain('sk-protected-secret')
      const document = JSON.parse(credentialsDocument)
      expect(document.protected).toBe(true)
      expect(Buffer.from(document.payload, 'base64url').subarray(0, 3).toString('utf-8')).toBe('v1:')

      const loaded = await loadConfig()
      expect(loaded.apiKey).toBe('sk-protected-secret')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('decrypts and re-protects a credential document for same-device migration', async () => {
    vi.resetModules()
    const { reprotectCredentialDocument, serializeCredentialSnapshot, setCredentialProtection } = await import('./credentialStore.js')
    setCredentialProtection({
      protect: plaintext => Buffer.concat([Buffer.from('v1:'), plaintext]),
      unprotect: ciphertext => Buffer.from(ciphertext.subarray(3)),
    })
    const legacy = Buffer.from(serializeCredentialSnapshot({ apiKey: 'sk-migrate-secret' }), 'utf8')
    setCredentialProtection({
      protect: plaintext => Buffer.concat([Buffer.from('v2:'), plaintext]),
      unprotect: ciphertext => Buffer.from(ciphertext.subarray(3)),
    })

    const migrated = reprotectCredentialDocument(legacy)
    const document = JSON.parse(migrated.toString('utf8')) as { protected: boolean; payload: string }
    const protectedPayload = Buffer.from(document.payload, 'base64url')

    expect(document.protected).toBe(true)
    expect(protectedPayload.subarray(0, 3).toString('utf8')).toBe('v2:')
    expect(migrated.toString('utf8')).not.toContain('sk-migrate-secret')
    expect(JSON.parse(protectedPayload.subarray(3).toString('utf8')).apiKey).toBe('sk-migrate-secret')
  })

  it('keeps protected credentials untouched when the key store disappears', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'turboflux-locked-credentials-'))
    process.env.TURBOFLUX_CONFIG_DIR = directory
    delete process.env.TURBOFLUX_API_KEY
    vi.resetModules()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { setCredentialProtection, saveCredentialSnapshot } = await import('./credentialStore.js')
      setCredentialProtection({
        protect: plaintext => Buffer.concat([Buffer.from('v1:'), plaintext]),
        unprotect: ciphertext => ciphertext.subarray(3),
      })
      saveCredentialSnapshot({ apiKey: 'sk-locked-secret' })
      const before = readFileSync(join(directory, 'credentials.json'), 'utf-8')

      vi.resetModules()
      const { loadCredentialSnapshot } = await import('./credentialStore.js')
      expect(loadCredentialSnapshot()).toEqual({})
      expect(readFileSync(join(directory, 'credentials.json'), 'utf-8')).toBe(before)
      expect(warn.mock.calls.some(([message]) => String(message).includes('platform key store is unavailable'))).toBe(true)
    } finally {
      warn.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
