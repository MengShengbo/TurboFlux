import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createTurboFluxServer } from './index'

const servers: Server[] = []
const tempDirs: string[] = []

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'turboflux-server-'))
  tempDirs.push(dir)
  return {
    host: '127.0.0.1',
    port: 0,
    configPath: join(dir, 'server-config.json'),
    upstreamBaseUrl: 'https://example.com/v1',
    upstreamApiKey: 'sk-test-secret',
    defaultModel: 'test-model',
    models: [{
      id: 'test-model',
      name: 'Test Model',
      contextWindow: 1000000,
      maxTokens: 16000,
      description: 'Test model',
    }],
    corsOrigin: 'http://127.0.0.1',
    ...overrides,
  }
}

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('TurboFlux backend server', () => {
  it('serves the admin console and redacts upstream API keys', async () => {
    const baseUrl = await listen(createTurboFluxServer(testConfig()))

    const admin = await fetch(`${baseUrl}/admin`)
    expect(admin.status).toBe(200)
    expect(await admin.text()).toContain('TurboFlux')

    const config = await fetch(`${baseUrl}/admin/api/config`).then(r => r.json()) as Record<string, unknown>
    expect(config.upstreamKeyConfigured).toBe(true)
    expect(config.upstreamKeyPreview).toBe('sk-tes...cret')
    expect(JSON.stringify(config)).not.toContain('sk-test-secret')
  })

  it('persists API config changes and exposes configured models for /v1/models', async () => {
    const baseUrl = await listen(createTurboFluxServer(testConfig({ upstreamApiKey: undefined })))

    const saved = await fetch(`${baseUrl}/admin/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        upstreamBaseUrl: 'https://api.example.test',
        upstreamApiKey: 'sk-new-secret',
        defaultModel: 'deepseek-v4-flash',
        models: [
          { id: 'deepseek-v4-flash', name: 'Flash', contextWindow: 1000000, maxTokens: 16384 },
          { id: 'deepseek-v4-pro', name: 'Pro', contextWindow: 1000000, maxTokens: 16384 },
        ],
      }),
    }).then(r => r.json()) as Record<string, unknown>

    expect(saved.upstreamBaseUrl).toBe('https://api.example.test/v1')
    expect(saved.defaultModel).toBe('deepseek-v4-flash')
    expect(saved.upstreamKeyPreview).toBe('sk-new...cret')
    expect(saved.models).toHaveLength(2)

    const models = await fetch(`${baseUrl}/v1/models`).then(r => r.json()) as { data: Array<{ id: string; context_window: number }> }
    expect(models.data.map(model => model.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(models.data[0].context_window).toBe(1000000)
  })

  it('serves placeholder users and in-process logs for the admin console', async () => {
    const baseUrl = await listen(createTurboFluxServer(testConfig()))

    const users = await fetch(`${baseUrl}/admin/api/users`).then(r => r.json()) as { data: Array<{ id: string; role: string }> }
    expect(users.data[0]).toMatchObject({ id: 'local-admin', role: 'owner' })

    const logs = await fetch(`${baseUrl}/admin/api/logs`).then(r => r.json()) as { data: Array<{ area: string; message: string }> }
    expect(Array.isArray(logs.data)).toBe(true)
    expect(logs.data.some(log => log.area === 'server' || log.area === 'config')).toBe(true)
  })

  it('protects admin APIs when a proxy auth token is configured', async () => {
    const baseUrl = await listen(createTurboFluxServer(testConfig({ authToken: 'admin-secret' })))

    const unauthorized = await fetch(`${baseUrl}/admin/api/config`)
    expect(unauthorized.status).toBe(401)

    const authorized = await fetch(`${baseUrl}/admin/api/config`, {
      headers: { 'X-TurboFlux-Token': 'admin-secret' },
    })
    expect(authorized.status).toBe(200)
  })

  it('refuses non-localhost binds without a proxy auth token', () => {
    expect(() => createTurboFluxServer(testConfig({
      host: '0.0.0.0',
      authToken: undefined,
    }))).toThrow(/without TURBOFLUX_PROXY_AUTH_TOKEN/)
  })

  it('allows non-localhost binds when a proxy auth token is configured', () => {
    const server = createTurboFluxServer(testConfig({
      host: '0.0.0.0',
      authToken: 'safe-token',
    }))
    server.close()
  })

  it('omits deprecated temperature for Claude-compatible upstream requests', async () => {
    let forwardedBody = ''
    const upstream = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      forwardedBody = await readBody(req)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }))
    })
    const upstreamBaseUrl = await listen(upstream)
    const baseUrl = await listen(createTurboFluxServer(testConfig({
      upstreamBaseUrl: `${upstreamBaseUrl}/v1`,
      defaultModel: 'claude-opus-4-8',
      models: [{
        id: 'claude-opus-4-8',
        name: 'Claude Opus',
        contextWindow: 1000000,
        maxTokens: 16000,
        description: 'Claude-compatible test model',
      }],
    })))

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        temperature: 0.7,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(200)
    const payload = JSON.parse(forwardedBody) as Record<string, unknown>
    expect(payload.model).toBe('claude-opus-4-8')
    expect(payload).not.toHaveProperty('temperature')
  })
})
