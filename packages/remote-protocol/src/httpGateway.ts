import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { type AddressInfo } from 'node:net'
import { extname, resolve, sep } from 'node:path'
import { RemoteHostService, type AcceptRemotePairingOptions } from './remoteHostService'
import {
  type EncryptedRemoteEnvelope,
  type SignedPairingResponse,
} from './types'

const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024
const DEFAULT_PAIR_REQUESTS_PER_MINUTE = 10
const RATE_WINDOW_MS = 60_000

export interface RemoteHttpGatewayOptions {
  host?: string
  port?: number
  bodyLimit?: number
  allowedOrigins?: readonly string[]
  pairing?: AcceptRemotePairingOptions
  webRoot?: string
  allowedHosts?: readonly string[]
  pairRequestsPerMinute?: number
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('Remote request body is too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function securityHeaders(): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body), 'utf8')
  response.writeHead(status, { ...securityHeaders(), 'content-type': 'application/json; charset=utf-8', 'content-length': encoded.length })
  response.end(encoded)
}

function contentType(path: string): string {
  return ({
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
  } as Record<string, string>)[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function hostHeaderName(value: string | undefined): string | undefined {
  if (!value) return undefined
  const bracketed = value.match(/^\[([^\]]+)\](?::\d+)?$/u)
  if (bracketed) return bracketed[1]!.toLowerCase()
  const withoutPort = value.includes(':') ? value.slice(0, value.lastIndexOf(':')) : value
  return withoutPort.toLowerCase()
}

function pairingRateIdentity(body: unknown): string {
  if (!body || typeof body !== 'object') return 'malformed'
  const payload = 'payload' in body && body.payload && typeof body.payload === 'object' ? body.payload : undefined
  const client = payload && 'client' in payload && payload.client && typeof payload.client === 'object' ? payload.client : undefined
  const inviteId = payload && 'inviteId' in payload && typeof payload.inviteId === 'string' ? payload.inviteId : undefined
  const deviceId = client && 'deviceId' in client && typeof client.deviceId === 'string' ? client.deviceId : undefined
  if (!inviteId || !deviceId) return 'malformed'
  return `${inviteId.slice(0, 128)}:${deviceId.slice(0, 128)}`
}

export class RemoteHttpGateway<TEvent = unknown> {
  private server: Server | undefined
  private pairRequestCounts = new Map<string, { windowStart: number; count: number }>()

  constructor(readonly service: RemoteHostService<TEvent>, private readonly options: RemoteHttpGatewayOptions = {}) {}

  async start(): Promise<{ host: string; port: number; url: string }> {
    if (this.server) throw new Error('Remote HTTP gateway is already running')
    this.server = createServer((request, response) => void this.handleRequest(request, response))
    const host = this.options.host ?? '127.0.0.1'
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.options.port ?? 0, host, () => {
        this.server!.off('error', reject)
        resolve()
      })
    })
    const address = this.server.address() as AddressInfo
    return { host, port: address.port, url: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}` }
  }

  async close(): Promise<void> {
    if (!this.server) return
    const server = this.server
    this.server = undefined
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!this.allowHostHeader(request)) {
        send(response, 403, { ok: false, error: 'Host header is not allowed' })
        return
      }
      if (!this.allowOrigin(request, response)) return
      const pathname = new URL(request.url ?? '/', 'http://remote.local').pathname
      if (request.method === 'OPTIONS') {
        response.writeHead(204, { 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' })
        response.end()
        return
      }
      if (request.method === 'GET' && pathname === '/health') {
        send(response, 200, { ok: true })
        return
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && await this.serveWebAsset(pathname, response, request.method === 'HEAD')) return
      if (request.method !== 'POST') {
        send(response, 405, { ok: false, error: 'Method not allowed' })
        return
      }
      const body = await readJson(request, this.options.bodyLimit ?? DEFAULT_BODY_LIMIT)
      if (pathname === '/v1/pair') {
        if (!this.allowPairRequestRate(request, body)) {
          send(response, 429, { ok: false, error: 'Too many pairing requests; wait a moment and try again' })
          return
        }
      }
      if (pathname === '/v1/pair') {
        const receipt = this.service.requestPairing(body as SignedPairingResponse, this.options.pairing)
        send(response, 202, { ok: true, data: receipt })
        return
      }
      if (pathname === '/v1/pair/status') {
        const statusRequest = body as { requestId?: string; pollToken?: string }
        if (!statusRequest.requestId || !statusRequest.pollToken) throw new Error('Pairing status requires a request ID and poll token')
        send(response, 200, { ok: true, data: this.service.pairingStatus(statusRequest.requestId, statusRequest.pollToken) })
        return
      }
      if (pathname === '/v1/exchange') {
        const envelope = await this.service.handle(body as EncryptedRemoteEnvelope)
        send(response, 200, { ok: true, data: envelope })
        return
      }
      send(response, 404, { ok: false, error: 'Remote endpoint not found' })
    } catch (error) {
      send(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private allowHostHeader(request: IncomingMessage): boolean {
    const hostname = hostHeaderName(request.headers.host)
    if (!hostname) return false
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') return true
    return this.options.allowedHosts?.includes(hostname) ?? false
  }

  private allowPairRequestRate(request: IncomingMessage, body: unknown): boolean {
    const limit = this.options.pairRequestsPerMinute ?? DEFAULT_PAIR_REQUESTS_PER_MINUTE
    if (limit <= 0) return true
    const key = `${request.socket.remoteAddress ?? 'unknown'}:${pairingRateIdentity(body)}`
    const now = Date.now()
    const entry = this.pairRequestCounts.get(key)
    if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
      if (this.pairRequestCounts.size > 512) this.pairRequestCounts.clear()
      this.pairRequestCounts.set(key, { windowStart: now, count: 1 })
      return true
    }
    entry.count += 1
    return entry.count <= limit
  }

  private allowOrigin(request: IncomingMessage, response: ServerResponse): boolean {
    const origin = request.headers.origin
    const allowed = this.options.allowedOrigins
    if (!origin) return true
    let sameOrigin = false
    try {
      sameOrigin = new URL(origin).host === request.headers.host
    } catch {
      sameOrigin = false
    }
    if (!sameOrigin && !allowed?.includes(origin)) {
      send(response, 403, { ok: false, error: 'Origin is not allowed' })
      return false
    }
    response.setHeader('access-control-allow-origin', origin)
    response.setHeader('vary', 'origin')
    return true
  }

  private async serveWebAsset(pathname: string, response: ServerResponse, headOnly: boolean): Promise<boolean> {
    if (!this.options.webRoot || pathname.startsWith('/v1/')) return false
    const root = resolve(this.options.webRoot)
    const relativePath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
    const filePath = resolve(root, relativePath)
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      send(response, 403, { ok: false, error: 'Remote asset path is not allowed' })
      return true
    }
    try {
      if (!(await stat(filePath)).isFile()) return false
      const contents = await readFile(filePath)
      response.writeHead(200, { ...securityHeaders(), 'content-type': contentType(filePath), 'content-length': contents.length })
      response.end(headOnly ? undefined : contents)
      return true
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
      throw error
    }
  }
}
