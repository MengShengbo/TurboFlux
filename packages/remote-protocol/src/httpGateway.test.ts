import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteBrowserClient } from './browserClient'
import { HttpRemoteTransport, type RemoteClientTransport } from './browserTransport'
import { RemoteHttpGateway } from './httpGateway'
import { createNodeDeviceIdentity, createPairingResponse } from './nodeCrypto'
import { RemoteHostService } from './remoteHostService'
import { turboFluxWorkspaceId, type TurboFluxRemoteSnapshotLike } from './turbofluxAdapter'
import { type EncryptedRemoteEnvelope } from './types'

function rawRequest(port: number, path: string, init: { method?: string; host?: string; origin?: string; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: {
        ...(init.host ? { Host: init.host } : {}),
        ...(init.origin ? { Origin: init.origin } : {}),
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      } },
      response => {
        let body = ''
        response.on('data', chunk => { body += chunk })
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
      },
    )
    request.on('error', reject)
    if (init.body !== undefined) request.write(init.body)
    request.end()
  })
}

class GatewayRuntime {
  readonly prompts: string[] = []
  readonly snapshot: TurboFluxRemoteSnapshotLike = {
    workspace: { path: '/workspace', name: 'Workspace' },
    runtime: { status: 'ready', pendingRequests: [] },
    conversation: { id: 'session-1', turns: [] },
    conversationCatalog: [{ id: 'session-1', title: 'Task', workspacePath: '/workspace', updatedAt: 1 }],
    conversationRuntimes: [{ conversationId: 'session-1', status: 'ready', updatedAt: 1 }],
    artifacts: { artifacts: [] },
  }
  getSnapshot() { return this.snapshot }
  subscribe() { return () => undefined }
  submitPromptToConversation(_sessionId: string, prompt: string) { this.prompts.push(prompt); return { status: 'started' } }
  controlConversation() { return true }
  newConversation() {}
  switchConversation() {}
  activateRemoteSession() {}
  resolveRequestForConversation() { return true }
  getArtifact() { return null }
}

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))))

describe('remote HTTP gateway', () => {
  it('pairs a browser client and runs an encrypted command end to end', async () => {
    const runtime = new GatewayRuntime()
    const service = await RemoteHostService.create({ displayName: 'Home Mac', runtime })
    const workspaceId = turboFluxWorkspaceId('/workspace')
    const gateway = new RemoteHttpGateway(service, { pairing: { workspaceIds: [workspaceId] } })
    const endpoint = await gateway.start()
    try {
      const delegate = new HttpRemoteTransport(endpoint.url, undefined, { pollIntervalMs: 10 })
      let dropNextResponse = false
      let droppedEnvelope: EncryptedRemoteEnvelope | undefined
      const transport: RemoteClientTransport = {
        pair: response => delegate.pair(response),
        exchange: async envelope => {
          if (dropNextResponse) {
            dropNextResponse = false
            droppedEnvelope = structuredClone(envelope)
            await delegate.exchange(envelope)
            throw new Error('simulated response loss')
          }
          if (droppedEnvelope) expect(envelope).toEqual(droppedEnvelope)
          return delegate.exchange(envelope)
        },
      }
      const code = service.createPairingCode(['session.control', 'session.read', 'session.submit'], [{ kind: 'custom', value: endpoint.url }])
      const pairing = RemoteBrowserClient.pair(code, transport, { displayName: 'Phone' })
      await vi.waitFor(() => expect(service.listPendingPairings()).toHaveLength(1))
      await service.approvePairing(service.listPendingPairings()[0]!.requestId)
      const client = await pairing
      await client.claimControl()
      const snapshot = await client.snapshot()
      expect(snapshot).toMatchObject({ snapshots: [{ sessions: [{ id: 'session-1', workspaceId }] }] })
      dropNextResponse = true
      await client.submit('turboflux-native', 'session-1', 'Continue remotely')
      expect(runtime.prompts).toEqual(['Continue remotely'])
      expect(droppedEnvelope).toBeDefined()
    } finally {
      await gateway.close()
      service.close()
    }
  })

  it('serves the mobile shell but rejects every legacy plaintext LAN route', async () => {
    const webRoot = await mkdtemp(join(tmpdir(), 'turboflux-remote-web-'))
    directories.push(webRoot)
    await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>TurboFlux Remote</title>')
    const runtime = new GatewayRuntime()
    const service = await RemoteHostService.create({ displayName: 'Home Mac', runtime })
    const gateway = new RemoteHttpGateway(service, {
      webRoot,
    })
    const endpoint = await gateway.start()
    try {
      const page = await fetch(endpoint.url)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('TurboFlux Remote')

      for (const path of ['/v1/lan/pair', '/v1/lan/pair/status', '/v1/lan/command']) {
        const response = await fetch(`${endpoint.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        expect(response.status).toBe(404)
      }
    } finally {
      await gateway.close()
      service.close()
    }
  })

  it('rejects DNS-rebinding style requests whose Host header is not the gateway address', async () => {
    const runtime = new GatewayRuntime()
    const service = await RemoteHostService.create({ displayName: 'Home Mac', runtime })
    const gateway = new RemoteHttpGateway(service)
    const endpoint = await gateway.start()
    const port = endpoint.port
    try {
      const rebound = await rawRequest(port, '/health', {
        host: `evil.example:${port}`,
        origin: `http://evil.example:${port}`,
      })
      expect(rebound.status).toBe(403)

      expect((await rawRequest(port, '/health')).status).toBe(200)
    } finally {
      await gateway.close()
      service.close()
    }
  })

  it('stops disclosing the device id on /health', async () => {
    const runtime = new GatewayRuntime()
    const service = await RemoteHostService.create({ displayName: 'Home Mac', runtime })
    const gateway = new RemoteHttpGateway(service, {})
    const endpoint = await gateway.start()
    try {
      const health = await fetch(`${endpoint.url}/health`)
      expect(health.status).toBe(200)
      expect(await health.json()).toEqual({ ok: true })
    } finally {
      await gateway.close()
      service.close()
    }
  })

  it('rate-limits pairing requests from the same address', async () => {
    const runtime = new GatewayRuntime()
    const service = await RemoteHostService.create({ displayName: 'Home Mac', runtime })
    const gateway = new RemoteHttpGateway(service, { pairRequestsPerMinute: 3 })
    const endpoint = await gateway.start()
    try {
      const statuses: number[] = []
      for (let index = 0; index < 5; index += 1) {
        const response = await rawRequest(endpoint.port, '/v1/pair', {
          method: 'POST',
          body: '{}',
        })
        statuses.push(response.status)
      }
      expect(statuses.slice(0, 3)).toEqual([400, 400, 400])
      expect(statuses.slice(3)).toEqual([429, 429])
    } finally {
      await gateway.close()
      service.close()
    }
  })

  it('does not let malformed proxy traffic consume another device pairing budget', async () => {
    const runtime = new GatewayRuntime()
    const service = await RemoteHostService.create({ displayName: 'Home Mac', runtime })
    const gateway = new RemoteHttpGateway(service, { pairRequestsPerMinute: 2 })
    const endpoint = await gateway.start()
    try {
      for (let index = 0; index < 3; index += 1) {
        await rawRequest(endpoint.port, '/v1/pair', { method: 'POST', body: '{}' })
      }
      const invite = service.createPairingInvite(['session.read'], [{ kind: 'custom', value: endpoint.url }])
      // A response must not predate the invite when the clock advances between calls.
      const now = Date.now()
      const phone = createNodeDeviceIdentity('Phone behind the same proxy', now)
      const response = await rawRequest(endpoint.port, '/v1/pair', {
        method: 'POST',
        body: JSON.stringify(createPairingResponse(phone, invite, ['session.read'], now)),
      })

      expect(response.status, response.body).toBe(202)
      expect(service.listPendingPairings()).toHaveLength(1)
    } finally {
      await gateway.close()
      service.close()
    }
  })

  it('caps the total number of pending pairing requests', async () => {
    const runtime = new GatewayRuntime()
    const service = await RemoteHostService.create({ displayName: 'Home Mac', runtime })
    const gateway = new RemoteHttpGateway(service, { pairRequestsPerMinute: 0 })
    const endpoint = await gateway.start()
    try {
      const statuses: number[] = []
      for (let index = 0; index < 66; index += 1) {
        const invite = service.createPairingInvite(['session.read'], [{ kind: 'custom', value: endpoint.url }])
        const now = Date.now()
        const identity = createNodeDeviceIdentity(`device-${index}`, now)
        const response = await rawRequest(endpoint.port, '/v1/pair', {
          method: 'POST',
          body: JSON.stringify(createPairingResponse(identity, invite, ['session.read'], now)),
        })
        statuses.push(response.status)
      }
      expect(statuses.filter(status => status === 202)).toHaveLength(64)
      expect(statuses.slice(64)).toEqual([400, 400])
    } finally {
      await gateway.close()
      service.close()
    }
  })

  it('validates a capability grant at approval time rather than request time', async () => {
    let now = Date.now()
    const runtime = new GatewayRuntime()
    const service = await RemoteHostService.create({ displayName: 'Home Mac', runtime, now: () => now })
    const gateway = new RemoteHttpGateway(service)
    const endpoint = await gateway.start()
    try {
      const code = service.createPairingCode(['session.read'], [{ kind: 'custom', value: endpoint.url }])
      const pairing = RemoteBrowserClient.pair(
        code,
        new HttpRemoteTransport(endpoint.url, undefined, { pollIntervalMs: 10 }),
        { displayName: 'Slow approval phone', now: () => now },
      )
      await vi.waitFor(() => expect(service.listPendingPairings()).toHaveLength(1))
      now += 2 * 60_000
      await service.approvePairing(service.listPendingPairings()[0]!.requestId)
      await expect(pairing).resolves.toBeInstanceOf(RemoteBrowserClient)
    } finally {
      await gateway.close()
      service.close()
    }
  })
})
