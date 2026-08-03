import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('turboflux setup integration', () => {
  let configDirectory: string
  let previousConfigDirectory: string | undefined

  beforeEach(() => {
    configDirectory = mkdtempSync(join(tmpdir(), 'turboflux-setup-'))
    previousConfigDirectory = process.env.TURBOFLUX_CONFIG_DIR
    process.env.TURBOFLUX_CONFIG_DIR = configDirectory
    vi.resetModules()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (previousConfigDirectory === undefined) delete process.env.TURBOFLUX_CONFIG_DIR
    else process.env.TURBOFLUX_CONFIG_DIR = previousConfigDirectory
    rmSync(configDirectory, { recursive: true, force: true })
  })

  it('switches provider defaults without carrying connection state across providers', async () => {
    const { runSetup } = await import('./setup.js')
    const { loadConfig } = await import('../core/config.js')

    await runSetup({ action: 'api', provider: 'openai', apiKey: 'sk-openai', yes: true })
    await runSetup({ action: 'api', provider: 'anthropic', yes: true })

    const config = await loadConfig()
    expect(config.provider).toBe('anthropic')
    expect(config.baseUrl).toBe('https://api.anthropic.com/v1')
    expect(config.model).toBe('claude-opus-4-8')
    expect(config.apiKey).toBe('')
    expect(config.contextWindow).toBe(1_000_000)
    expect(config.reasoning?.effort).toBe('high')
  })

  it('keeps a custom provider endpoint when accepting API defaults', async () => {
    const { runSetup } = await import('./setup.js')
    const { loadConfig } = await import('../core/config.js')

    await runSetup({
      action: 'api',
      provider: 'custom',
      baseUrl: 'https://gateway.example.com/v1',
      model: 'gateway-model',
      apiKey: 'sk-custom',
      yes: true,
    })
    const before = await loadConfig()

    await runSetup({ action: 'api', yes: true })

    expect(await loadConfig()).toEqual(before)
  })

  it('keeps the existing interface language when accepting full-init defaults', async () => {
    const { runSetup } = await import('./setup.js')
    const { loadProfile, saveProfile } = await import('../core/profile.js')

    saveProfile({ interfaceLanguage: 'en', aiOutputLanguage: 'en' })
    await runSetup({ yes: true })

    expect(loadProfile()).toMatchObject({
      interfaceLanguage: 'en',
      aiOutputLanguage: 'en',
    })
  })

  it('normalizes direct base URLs and rejects non-HTTP API endpoints', async () => {
    const { runSetup } = await import('./setup.js')
    const { loadConfig } = await import('../core/config.js')
    const { saveProfile } = await import('../core/profile.js')

    saveProfile({ interfaceLanguage: 'en' })
    await runSetup({ action: 'api', provider: 'openai', baseUrl: '  https://api.example.com/v1/  ', yes: true })
    expect((await loadConfig()).baseUrl).toBe('https://api.example.com/v1')

    await expect(runSetup({ action: 'api', provider: 'openai', baseUrl: 'ftp://api.example.com/v1', yes: true }))
      .rejects.toThrow(/complete URL|HTTP/i)
  })

  it('recomputes model metadata when the model changes on the same connection', async () => {
    const { runSetup } = await import('./setup.js')
    const { loadConfig } = await import('../core/config.js')

    await runSetup({ action: 'api', provider: 'anthropic', apiKey: 'sk-anthropic', yes: true })
    await runSetup({ action: 'api', model: 'claude-haiku-4-5-20251001', yes: true })

    const config = await loadConfig()
    expect(config.model).toBe('claude-haiku-4-5-20251001')
    expect(config.contextWindow).toBe(200_000)
    expect(config.maxOutputTokens).toBe(64_000)
    expect(config.apiKey).toBe('sk-anthropic')
  })

  it('keeps the persisted API profile identity stable across reads', async () => {
    const { runSetup } = await import('./setup.js')
    const { loadConfig } = await import('../core/config.js')
    await runSetup({ action: 'api', provider: 'openai', apiKey: 'sk-openai', yes: true })

    const first = await loadConfig()
    await new Promise(resolve => setTimeout(resolve, 5))
    const second = await loadConfig()

    expect(second.apiConfigs?.[0]?.updatedAt).toBe(first.apiConfigs?.[0]?.updatedAt)
    expect(second).toEqual(first)
  })

  it('treats persona skip as no change and validates persona ids', async () => {
    const { runSetup } = await import('./setup.js')
    const { loadProfile, saveProfile } = await import('../core/profile.js')
    const before = saveProfile({
      enabledPersonaIds: ['architect'],
      defaultPersonaId: 'architect',
      interfaceLanguage: 'en',
    })

    await runSetup({ action: 'persona', outputStyle: 'SKIP', yes: true })
    const skipped = loadProfile()
    expect(skipped.enabledPersonaIds).toEqual(before.enabledPersonaIds)
    expect(skipped.defaultPersonaId).toBe(before.defaultPersonaId)

    await expect(runSetup({ action: 'persona', outputStyle: 'architect,missing', yes: true }))
      .rejects.toThrow(/Unknown persona: missing/)
  })

  it('enables an explicitly selected default persona deterministically', async () => {
    const { runSetup } = await import('./setup.js')
    const { loadProfile, saveProfile } = await import('../core/profile.js')
    saveProfile({ enabledPersonaIds: ['default'], defaultPersonaId: 'default' })

    await runSetup({ action: 'persona', outputStyle: 'default', defaultOutputStyle: 'ARCHITECT', yes: true })

    const profile = loadProfile()
    expect(profile.enabledPersonaIds).toEqual(['default', 'architect'])
    expect(profile.defaultPersonaId).toBe('architect')
  })

  it('rejects language options that would otherwise report a silent success', async () => {
    const { runSetup } = await import('./setup.js')
    const { saveProfile } = await import('../core/profile.js')
    saveProfile({ interfaceLanguage: 'en' })

    await expect(runSetup({ action: 'language', configLang: 'invalid', yes: true }))
      .rejects.toThrow(/Invalid setup language/)
    await expect(runSetup({ action: 'language', aiOutputLang: 'custom', yes: true }))
      .rejects.toThrow(/requires descriptive text/)
  })

  it('reports setup validation in the configured interface language', async () => {
    const { runSetup } = await import('./setup.js')
    const { saveProfile } = await import('../core/profile.js')
    saveProfile({ interfaceLanguage: 'zh-CN' })

    await expect(runSetup({ action: 'language', configLang: 'invalid', yes: true }))
      .rejects.toThrow(/无效的界面语言/)
  })

  it('configures full approval as complete runtime access', async () => {
    const { runSetup } = await import('./setup.js')
    const { loadConfig } = await import('../core/config.js')

    await runSetup({ action: 'approval', approvalPolicy: 'full', yes: true })

    const config = await loadConfig()
    expect(config).toMatchObject({
      approvalPolicy: 'full',
      capabilityProfile: 'danger-full-access',
    })
  })

  it('resets global configuration while retaining unrelated local data', async () => {
    const { runSetup } = await import('./setup.js')
    const { loadConfig } = await import('../core/config.js')
    const { loadProfile, saveProfile } = await import('../core/profile.js')
    await runSetup({ action: 'api', provider: 'openai', apiKey: 'sk-reset-me', yes: true })
    saveProfile({ interfaceLanguage: 'en', enabledPersonaIds: ['architect'], defaultPersonaId: 'architect' })
    const settingsPath = join(configDirectory, 'settings.json')
    writeFileSync(settingsPath, '{"mcpServers":{}}', 'utf-8')

    await runSetup({ action: 'reset', yes: true })

    const config = await loadConfig()
    const profile = loadProfile()
    const credentials = readFileSync(join(configDirectory, 'credentials.json'), 'utf-8')
    expect(config.apiConfigs).toEqual([])
    expect(config.apiKey).toBe('')
    expect(credentials).not.toContain('sk-reset-me')
    expect(profile.interfaceLanguage).toBe('zh-CN')
    expect(profile.defaultPersonaId).toBe('engineer-professional')
    expect(existsSync(settingsPath)).toBe(true)
  })
})
