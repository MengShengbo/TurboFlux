import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('model discovery', () => {
  let configDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'turboflux-models-'))
    vi.stubEnv('TURBOFLUX_CONFIG_DIR', configDir)
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    rmSync(configDir, { recursive: true, force: true })
  })

  it('uses rich gateway metadata and caches it per API profile', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      data: [{
        id: 'moonshotai/kimi-k3',
        name: 'Kimi K3',
        context_length: 1_048_576,
        top_provider: { max_completion_tokens: 131_072 },
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
        supported_parameters: ['tools', 'reasoning_effort', 'response_format'],
        reasoning: { supported_efforts: ['max'] },
      }],
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { discoverModelPresets } = await import('./modelDiscovery')
    const { createEmptyConfig } = await import('./config')
    const config = {
      ...createEmptyConfig(),
      provider: 'openrouter' as const,
      apiKey: 'secret-key',
      baseUrl: 'https://openrouter.example/api/v1',
      model: 'moonshotai/kimi-k3',
    }

    const first = await discoverModelPresets(config)
    const second = await discoverModelPresets(config)
    await discoverModelPresets({ ...config, apiKey: 'different-key' })
    const model = first.models[0]

    expect(first.source).toBe('network')
    expect(second.source).toBe('cache')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe('https://openrouter.example/api/v1/models')
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer secret-key' })
    expect(model.contextWindow).toBe(1_048_576)
    expect(model.maxOutputTokens).toBe(131_072)
    expect(model.capabilities).toMatchObject({ tools: true, vision: true, reasoning: true })
    expect(model.capabilities?.reasoningEfforts).toEqual(['max'])
  })

  it('enriches sparse OpenAI model rows from models.dev', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === 'https://models.dev/api.json') {
        return jsonResponse({
          example: {
            models: {
              'custom-chat': {
                id: 'custom-chat',
                reasoning: true,
                tool_call: true,
                modalities: { input: ['text', 'image'], output: ['text'] },
                limit: { context: 262_144, output: 32_768 },
              },
            },
          },
        })
      }
      return jsonResponse({ data: [{ id: 'example/custom-chat', owned_by: 'example' }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { discoverModelPresets } = await import('./modelDiscovery')
    const { createEmptyConfig } = await import('./config')
    const result = await discoverModelPresets({
      ...createEmptyConfig(),
      provider: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      model: 'example/custom-chat',
    })

    expect(result.models[0]).toMatchObject({
      model: 'example/custom-chat',
      contextWindow: 262_144,
      maxOutputTokens: 32_768,
      metadataSources: ['api', 'models.dev'],
    })
    expect(result.models[0].capabilities).toMatchObject({ tools: true, vision: true, reasoning: true })
  })

  it('falls back to 200K without presenting it as API metadata', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === 'https://models.dev/api.json') return jsonResponse({}, 401)
      return jsonResponse({ data: [{ id: 'unknown-chat', max_output_tokens: 8192 }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { discoverModelPresets } = await import('./modelDiscovery')
    const { createEmptyConfig } = await import('./config')
    const result = await discoverModelPresets({
      ...createEmptyConfig(),
      provider: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://api.unknown.test/v1',
      model: 'unknown-chat',
    })

    expect(result.models[0].contextWindow).toBe(200_000)
    expect(result.models[0].metadataSources).toContain('default')
    expect(result.models[0].maxTokens).toBe(8192)
  })

  it('does not retry authentication failures', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401))
    vi.stubGlobal('fetch', fetchMock)
    const { discoverModelPresets } = await import('./modelDiscovery')
    const { createEmptyConfig } = await import('./config')
    const result = await discoverModelPresets({
      ...createEmptyConfig(),
      provider: 'openai',
      apiKey: 'bad-key',
      baseUrl: 'https://auth-failure.test/v1',
      model: 'gpt-5.6',
    }, { force: true })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.source).toBe('fallback')
    expect(result.error).toContain('401')
  })
})
