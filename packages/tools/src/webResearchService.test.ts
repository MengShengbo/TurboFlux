import { lookup } from 'node:dns/promises'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { Agent, buildConnector, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebResearchService } from './webResearchService'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))

const PUBLIC = '93.184.216.34'
const globalDispatcher = getGlobalDispatcher()
const cleanup: Array<() => Promise<unknown>> = []

afterEach(async () => {
  setGlobalDispatcher(globalDispatcher)
  vi.restoreAllMocks()
  vi.mocked(lookup).mockReset()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return (server.address() as { port: number }).port
}

function directFixture(ca?: Buffer) {
  const connections: Array<{ hostname: string; servername?: string }> = []
  // An unsafe second DNS resolution would return loopback.
  const connectionLookup = vi.fn((_hostname, options, callback) => {
    callback(null, options?.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4)
  })
  const connector = buildConnector({ lookup: connectionLookup, ca })
  const agent = new Agent({
    connect(options, callback) {
      connections.push({ hostname: options.hostname, servername: options.servername })
      // Route the approved address to our fixture only after observing the
      // transport target; the test never connects to a public server.
      connector({ ...options, hostname: options.hostname === PUBLIC ? '127.0.0.1' : options.hostname }, callback)
    },
  })
  setGlobalDispatcher(agent)
  cleanup.push(() => agent.destroy())
  vi.mocked(lookup).mockResolvedValue([{ address: PUBLIC, family: 4 }])
  return { connections, connectionLookup }
}

describe('webpage transport boundary', () => {
  it('preserves TLS SNI and verifies the certificate for the original hostname', async () => {
    const cert = readFileSync(new URL('./fixtures/web-test-cert.pem', import.meta.url))
    const key = readFileSync(new URL('./fixtures/web-test-key.pem', import.meta.url))
    const names: string[] = []
    const server = createHttpsServer({ cert, key }, (request, response) => {
      names.push((request.socket as TLSSocket).servername)
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('authenticated fixture')
    })
    const port = await listen(server)
    const { connections } = directFixture(cert)
    const result = await new WebResearchService().fetchPages({ url: `https://rebind.test:${port}/` })
    expect(result).toMatchObject({ success: true, data: { pages: [{ text: 'authenticated fixture' }] } })
    expect(names).toEqual(['rebind.test'])
    expect(connections).toEqual([{ hostname: PUBLIC, servername: 'rebind.test' }])
  })

  it('pins validation DNS to real connections and revalidates redirects', async () => {
    const hosts: string[] = []
    const port = await listen(createServer((request, response) => {
      hosts.push(request.headers.host!)
      if (request.url === '/start') {
        response.writeHead(302, { location: '/final' })
        response.end()
      } else {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('fixture page')
      }
    }))
    const { connections, connectionLookup } = directFixture()
    const result = await new WebResearchService().fetchPages({ url: `http://rebind.test:${port}/start` })

    expect(result).toMatchObject({ success: true, data: { pages: [{ text: 'fixture page' }] } })
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(connectionLookup).not.toHaveBeenCalled()
    expect(connections.length).toBeGreaterThan(0)
    expect(connections.every(item => item.hostname === PUBLIC)).toBe(true)
    expect(hosts).toEqual([`rebind.test:${port}`, `rebind.test:${port}`])
  })

  it('rejects a redirect whose second DNS answer is private', async () => {
    let requests = 0
    const port = await listen(createServer((_request, response) => {
      requests += 1
      response.writeHead(302, { location: '/private' })
      response.end()
    }))
    directFixture()
    vi.mocked(lookup)
      .mockResolvedValueOnce([{ address: PUBLIC, family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
    const result = await new WebResearchService().fetchPages({ url: `http://rebind.test:${port}/start` })
    expect(result.success).toBe(false)
    expect(result.error).toContain('private-network')
    expect(requests).toBe(1)
  })

  it.each(['127.0.0.1', '2130706433', '0x7f000001', '[::1]', '[::ffff:7f00:1]', '[2001:db8::1]', '[64:ff9b::7f00:1]'])(
    'rejects private or reserved address spelling %s before dispatch', async host => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      const result = await new WebResearchService().fetchPages({ url: `http://${host}/` })
      expect(result.success).toBe(false)
      expect(fetchSpy).not.toHaveBeenCalled()
    },
  )

  it('rejects mixed public and private DNS answers', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: PUBLIC, family: 4 }, { address: '::ffff:7f00:1', family: 6 }])
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await new WebResearchService().fetchPages({ url: 'https://mixed.test/' })
    expect(result.success).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('cancels a real stalled HTTP body after headers on caller abort', async () => {
    let received!: () => void
    let closed!: () => void
    const headersSent = new Promise<void>(resolve => { received = resolve })
    const bodyClosed = new Promise<void>(resolve => { closed = resolve })
    const port = await listen(createServer((_request, response) => {
      response.on('close', closed)
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('partial body')
      received()
    }))
    directFixture()
    const controller = new AbortController()
    const pending = new WebResearchService().fetchPages({ url: `http://body.test:${port}/`, signal: controller.signal })
    await headersSent
    // Let the response headers reach fetch, then interrupt body consumption.
    await new Promise<void>(resolve => setImmediate(resolve))
    controller.abort(new Error('caller stopped'))
    await expect(pending).resolves.toMatchObject({ success: false, error: expect.stringContaining('caller stopped') })
    await bodyClosed
  })

  it('sends the validated IP to a configured proxy CONNECT and retains Host', async () => {
    const hosts: string[] = []
    const port = await listen(createServer((request, response) => {
      hosts.push(request.headers.host!)
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('proxied')
    }))
    const targets: string[] = []
    const proxy = createServer()
    const sockets = new Set<import('node:net').Socket>()
    proxy.on('connect', (request, client, head) => {
      targets.push(request.url!)
      // Never resolve the supplied proxy target; route the test tunnel locally.
      const upstream = connect(port, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
      sockets.add(upstream)
      sockets.add(client)
      upstream.on('error', () => client.destroy())
      client.on('error', () => upstream.destroy())
      client.on('close', () => upstream.destroy())
    })
    const proxyPort = await listen(proxy)
    cleanup.push(async () => { for (const socket of sockets) socket.destroy() })
    const agent = new EnvHttpProxyAgent({ httpProxy: `http://127.0.0.1:${proxyPort}`, noProxy: '' })
    cleanup.push(() => agent.destroy())
    setGlobalDispatcher(agent)
    vi.mocked(lookup).mockResolvedValue([{ address: PUBLIC, family: 4 }])
    const result = await new WebResearchService().fetchPages({ url: `http://proxied.test:${port}/` })
    expect(result).toMatchObject({ success: true, data: { pages: [{ text: 'proxied' }] } })
    expect(targets).toEqual([`${PUBLIC}:${port}`])
    expect(hosts).toEqual([`proxied.test:${port}`])
  })
})
