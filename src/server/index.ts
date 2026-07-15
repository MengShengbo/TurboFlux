import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { ADMIN_HTML } from './adminPage'
import { getSupportedModelSpec, SUPPORTED_MODEL_SPECS } from '../core/modelRegistry'
import { writeFileAtomicSync } from '../core/fileIO'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8787
const DEFAULT_UPSTREAM_BASE_URL = 'https://api.example.com/v1'
const DEFAULT_MODEL = 'gpt-5.5'
const DEFAULT_CONTEXT_WINDOW = 1_000_000
const DEFAULT_MAX_TOKENS = 16_384
const MAX_BODY_BYTES = 20 * 1024 * 1024
const MAX_LOG_ENTRIES = 200
const UPSTREAM_TIMEOUT_MS = 5 * 60 * 1000

export interface ProxyModelConfig {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  description: string
}

interface PersistedProxyConfig {
  upstreamBaseUrl?: string
  upstreamApiKey?: string
  defaultModel?: string
  models?: ProxyModelConfig[]
  authToken?: string
  corsOrigin?: string
  updatedAt?: string
}

interface PersistedProxyCredentials {
  upstreamApiKey?: string
  authToken?: string
}

export interface ProxyConfig {
  host: string
  port: number
  configPath: string
  upstreamBaseUrl: string
  upstreamApiKey?: string
  defaultModel: string
  models: ProxyModelConfig[]
  authToken?: string
  corsOrigin: string
  updatedAt?: string
}

interface AdminConfigPatch {
  upstreamBaseUrl?: unknown
  upstreamApiKey?: unknown
  defaultModel?: unknown
  models?: unknown
  authToken?: unknown
  corsOrigin?: unknown
  clearUpstreamApiKey?: unknown
  clearAuthToken?: unknown
}

interface LogEntry {
  id: number
  time: string
  level: 'info' | 'warn' | 'error'
  area: string
  message: string
}

const logEntries: LogEntry[] = []
let nextLogId = 1

const DEFAULT_MODELS: ProxyModelConfig[] = SUPPORTED_MODEL_SPECS.map(spec => ({
  id: spec.id,
  name: spec.name,
  contextWindow: spec.contextWindow,
  maxTokens: spec.defaultRequestTokens,
  description: spec.description,
}))

function env(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

function addLog(level: LogEntry['level'], area: string, message: string): void {
  logEntries.unshift({
    id: nextLogId++,
    time: new Date().toISOString(),
    level,
    area,
    message,
  })
  if (logEntries.length > MAX_LOG_ENTRIES) {
    logEntries.length = MAX_LOG_ENTRIES
  }
}

function parsePort(raw: string | undefined): number {
  const port = raw ? Number(raw) : DEFAULT_PORT
  return Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT
}

function getConfigPath(): string {
  return env('TURBOFLUX_SERVER_CONFIG') ?? join(process.cwd(), '.turboflux', 'server-config.json')
}

function normalizeUpstreamBaseUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return DEFAULT_UPSTREAM_BASE_URL
  const withoutTrailingSlash = trimmed.replace(/\/+$/, '')
  return withoutTrailingSlash.endsWith('/v1')
    ? withoutTrailingSlash
    : `${withoutTrailingSlash}/v1`
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function safePositiveInteger(value: unknown, fallback: number): number {
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : fallback
}

function normalizeModels(value: unknown, defaultModel: string): ProxyModelConfig[] {
  const source = Array.isArray(value) ? value : DEFAULT_MODELS
  const models = source.flatMap((item): ProxyModelConfig[] => {
    if (!item || typeof item !== 'object') return []
    const raw = item as Record<string, unknown>
    const id = safeString(raw.id ?? raw.model)
    const spec = getSupportedModelSpec(id)
    if (!id || !spec) return []
    return [{
      id: spec.id,
      name: safeString(raw.name) ?? spec.name,
      contextWindow: safePositiveInteger(raw.contextWindow ?? raw.context_window, spec.contextWindow),
      maxTokens: safePositiveInteger(raw.maxTokens ?? raw.max_tokens, spec.defaultRequestTokens),
      description: safeString(raw.description) ?? spec.description,
    }]
  })
  const deduped = [...new Map(models.map(model => [model.id, model])).values()]
  const defaultSpec = getSupportedModelSpec(defaultModel)
  if (defaultSpec && !deduped.some(model => model.id === defaultSpec.id)) {
    deduped.unshift({
      id: defaultSpec.id,
      name: defaultSpec.name,
      contextWindow: defaultSpec.contextWindow,
      maxTokens: defaultSpec.defaultRequestTokens,
      description: defaultSpec.description,
    })
  }
  return deduped
}

function readPersistedConfig(configPath: string): PersistedProxyConfig {
  if (!existsSync(configPath)) return {}
  try {
    const raw = readFileSync(configPath, 'utf-8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw) as PersistedProxyConfig
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    addLog('warn', 'config', `Failed to read persisted config: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

function credentialsPath(configPath: string): string {
  return join(dirname(configPath), 'server-credentials.json')
}

function readPersistedCredentials(configPath: string): PersistedProxyCredentials {
  const filePath = credentialsPath(configPath)
  if (!existsSync(filePath)) return {}
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed as PersistedProxyCredentials : {}
  } catch {
    return {}
  }
}

function writePersistedConfig(config: ProxyConfig): void {
  const persisted: PersistedProxyConfig = {
    upstreamBaseUrl: config.upstreamBaseUrl,
    defaultModel: config.defaultModel,
    models: config.models,
    corsOrigin: config.corsOrigin,
    updatedAt: new Date().toISOString(),
  }
  const dir = dirname(config.configPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileAtomicSync(config.configPath, JSON.stringify(persisted, null, 2), 0o600)
  writeFileAtomicSync(credentialsPath(config.configPath), JSON.stringify({
    upstreamApiKey: config.upstreamApiKey,
    authToken: config.authToken,
  }, null, 2), 0o600)
}

function loadConfig(): ProxyConfig {
  const configPath = getConfigPath()
  const persisted = readPersistedConfig(configPath)
  const credentials = readPersistedCredentials(configPath)
  const requestedDefaultModel = persisted.defaultModel ?? env('TURBOFLUX_FREE_MODEL') ?? DEFAULT_MODEL
  const defaultModel = getSupportedModelSpec(requestedDefaultModel)?.id ?? DEFAULT_MODEL
  const upstreamBaseUrl = normalizeUpstreamBaseUrl(
    persisted.upstreamBaseUrl
      ?? env('TURBOFLUX_FREE_MODEL_BASE_URL')
      ?? DEFAULT_UPSTREAM_BASE_URL,
  )

  return {
    host: env('TURBOFLUX_SERVER_HOST') ?? DEFAULT_HOST,
    port: parsePort(env('TURBOFLUX_SERVER_PORT')),
    configPath,
    upstreamBaseUrl,
    upstreamApiKey: credentials.upstreamApiKey ?? persisted.upstreamApiKey ?? env('TURBOFLUX_FREE_MODEL_API_KEY'),
    defaultModel,
    models: normalizeModels(persisted.models, defaultModel),
    authToken: credentials.authToken ?? persisted.authToken ?? env('TURBOFLUX_PROXY_AUTH_TOKEN'),
    corsOrigin: persisted.corsOrigin ?? env('TURBOFLUX_CORS_ORIGIN') ?? 'http://127.0.0.1',
    updatedAt: persisted.updatedAt,
  }
}

function isLocalBindHost(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1'].includes(host.trim().toLowerCase())
}

function assertSafeExposure(config: ProxyConfig): void {
  if (!isLocalBindHost(config.host) && !config.authToken) {
    throw new Error('Refusing to bind TurboFlux backend outside localhost without TURBOFLUX_PROXY_AUTH_TOKEN')
  }
}

function keyPreview(value?: string): string {
  if (!value) return ''
  if (value.length <= 10) return `${value.slice(0, 2)}...${value.slice(-2)}`
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

function publicConfig(config: ProxyConfig): Record<string, unknown> {
  return {
    ok: true,
    host: config.host,
    port: config.port,
    upstreamKeyConfigured: Boolean(config.upstreamApiKey),
    upstreamKeyPreview: config.upstreamApiKey ? keyPreview(config.upstreamApiKey) : '',
    upstreamBaseUrl: config.upstreamBaseUrl,
    defaultModel: config.defaultModel,
    models: config.models,
    proxyAuth: config.authToken ? 'enabled' : 'disabled',
    corsOrigin: config.corsOrigin,
    configPath: config.configPath,
    updatedAt: config.updatedAt,
  }
}

function updateConfigFromPatch(config: ProxyConfig, patch: AdminConfigPatch): ProxyConfig {
  const upstreamBaseUrl = safeString(patch.upstreamBaseUrl)
  const defaultModel = safeString(patch.defaultModel)
  const corsOrigin = safeString(patch.corsOrigin)
  const upstreamApiKey = safeString(patch.upstreamApiKey)
  const authToken = safeString(patch.authToken)

  if (upstreamBaseUrl) {
    try {
      new URL(upstreamBaseUrl)
    } catch {
      throw new Error('Invalid upstream Base URL')
    }
    config.upstreamBaseUrl = normalizeUpstreamBaseUrl(upstreamBaseUrl)
  }

  if (defaultModel) {
    const spec = getSupportedModelSpec(defaultModel)
    if (!spec) throw new Error(`Unsupported model "${defaultModel}". Select one of: ${SUPPORTED_MODEL_SPECS.map(model => model.id).join(', ')}`)
    config.defaultModel = spec.id
  }
  if (patch.models !== undefined) config.models = normalizeModels(patch.models, config.defaultModel)
  else config.models = normalizeModels(config.models, config.defaultModel)
  if (corsOrigin) config.corsOrigin = corsOrigin
  if (patch.clearUpstreamApiKey === true) config.upstreamApiKey = undefined
  else if (upstreamApiKey) config.upstreamApiKey = upstreamApiKey
  if (patch.clearAuthToken === true) config.authToken = undefined
  else if (authToken) config.authToken = authToken

  config.updatedAt = new Date().toISOString()
  writePersistedConfig(config)
  addLog('info', 'config', 'API configuration saved')
  return config
}

function setCorsHeaders(res: ServerResponse, config: ProxyConfig): void {
  res.setHeader('Access-Control-Allow-Origin', config.corsOrigin)
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-TurboFlux-Token')
}

function sendJson(res: ServerResponse, status: number, data: unknown, config: ProxyConfig): void {
  setCorsHeaders(res, config)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data))
}

function sendHtml(res: ServerResponse, status: number, html: string, config: ProxyConfig): void {
  setCorsHeaders(res, config)
  res.statusCode = status
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(html)
}

function isAuthorized(req: IncomingMessage, config: ProxyConfig): boolean {
  if (!config.authToken) return true

  const authorization = req.headers.authorization ?? ''
  const tokenHeader = req.headers['x-turboflux-token']
  const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader

  return authorization === `Bearer ${config.authToken}` || token === config.authToken
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        settled = true
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', error => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req)
  if (body.length === 0) return {}
  try {
    const parsed = JSON.parse(body.toString('utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON body must be an object')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new Error(`Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function shouldOmitTemperature(model: unknown): boolean {
  return typeof model === 'string' && /(^|[-_:/])claude([-_:/]|\b)|anthropic/i.test(model)
}

function normalizeProxyBody(body: Buffer, defaultModel: string): Buffer {
  if (body.length === 0) return body

  try {
    const payload = JSON.parse(body.toString('utf-8')) as Record<string, unknown>
    if (!payload.model) {
      payload.model = defaultModel
    }
    if (shouldOmitTemperature(payload.model)) {
      delete payload.temperature
    }
    return Buffer.from(JSON.stringify(payload), 'utf-8')
  } catch {
    return body
  }
}

function upstreamTarget(config: ProxyConfig, pathname: string, search = ''): string {
  const upstreamPath = pathname.replace(/^\/v1/, '')
  return `${config.upstreamBaseUrl}${upstreamPath}${search}`
}

async function proxyOpenAiCompatibleRequest(req: IncomingMessage, res: ServerResponse, config: ProxyConfig, url: URL): Promise<void> {
  if (!config.upstreamApiKey) {
    addLog('warn', 'proxy', 'Rejected proxy request because upstream key is missing')
    sendJson(res, 503, {
      error: {
        message: 'TURBOFLUX_FREE_MODEL_API_KEY is not configured on the backend.',
        type: 'configuration_error',
      },
    }, config)
    return
  }

  const body = normalizeProxyBody(await readBody(req), config.defaultModel)
  const upstreamUrl = upstreamTarget(config, url.pathname, url.search)
  addLog('info', 'proxy', `${req.method} ${url.pathname} -> ${upstreamUrl}`)

  const controller = new AbortController()
  const abortUpstream = () => {
    if (!res.writableEnded) controller.abort()
  }
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  res.once('close', abortUpstream)
  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers: {
        'Authorization': `Bearer ${config.upstreamApiKey}`,
        'Content-Type': req.headers['content-type'] ?? 'application/json',
      },
      body: body.length > 0 ? body.toString('utf-8') : undefined,
      signal: controller.signal,
    })

    setCorsHeaders(res, config)
    res.statusCode = upstreamResponse.status
    const contentType = upstreamResponse.headers.get('content-type')
    if (contentType) res.setHeader('Content-Type', contentType)
    const cacheControl = upstreamResponse.headers.get('cache-control')
    if (cacheControl) res.setHeader('Cache-Control', cacheControl)

    const reader = upstreamResponse.body?.getReader()
    if (!reader) {
      res.end()
      return
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!res.write(Buffer.from(value))) await once(res, 'drain')
    }
    res.end()
  } finally {
    clearTimeout(timer)
    res.removeListener('close', abortUpstream)
  }
}

async function testUpstream(config: ProxyConfig): Promise<{ ok: boolean; message: string; status?: number }> {
  if (!config.upstreamApiKey) {
    return { ok: false, message: 'Upstream API key is not configured' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(`${config.upstreamBaseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.upstreamApiKey}` },
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      const clipped = text.slice(0, 180).replace(/\s+/g, ' ')
      return { ok: false, status: response.status, message: `Upstream returned HTTP ${response.status}: ${clipped || response.statusText}` }
    }
    return { ok: true, status: response.status, message: 'Upstream connection is healthy' }
  } finally {
    clearTimeout(timer)
  }
}

async function handleAdminApi(req: IncomingMessage, res: ServerResponse, config: ProxyConfig, url: URL): Promise<ProxyConfig> {
  if (!isAuthorized(req, config)) {
    sendJson(res, 401, { error: { message: 'Unauthorized', type: 'auth_error' } }, config)
    return config
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/config') {
    sendJson(res, 200, publicConfig(config), config)
    return config
  }

  if (req.method === 'PUT' && url.pathname === '/admin/api/config') {
    const patch = await readJson(req)
    const nextConfig = updateConfigFromPatch(config, patch)
    sendJson(res, 200, publicConfig(nextConfig), nextConfig)
    return nextConfig
  }

  if (req.method === 'POST' && url.pathname === '/admin/api/config/test') {
    const result = await testUpstream(config)
    addLog(result.ok ? 'info' : 'warn', 'upstream', result.message)
    sendJson(res, result.ok ? 200 : 502, result.ok ? result : { error: { message: result.message, type: 'upstream_error', status: result.status } }, config)
    return config
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/logs') {
    sendJson(res, 200, { data: logEntries }, config)
    return config
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/users') {
    sendJson(res, 200, {
      data: [
        { id: 'local-admin', name: 'local-admin', role: 'owner', status: 'placeholder' },
      ],
    }, config)
    return config
  }

  sendJson(res, 404, { error: { message: 'Not found', type: 'not_found' } }, config)
  return config
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, config: ProxyConfig): Promise<ProxyConfig> {
  const host = req.headers.host ?? `${config.host}:${config.port}`
  const url = new URL(req.url ?? '/', `http://${host}`)

  if (req.method === 'OPTIONS') {
    setCorsHeaders(res, config)
    res.statusCode = 204
    res.end()
    return config
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin' || url.pathname === '/admin/')) {
    sendHtml(res, 200, ADMIN_HTML, config)
    return config
  }

  if (url.pathname.startsWith('/admin/api/')) {
    return handleAdminApi(req, res, config, url)
  }

  if (!isAuthorized(req, config)) {
    sendJson(res, 401, { error: { message: 'Unauthorized', type: 'auth_error' } }, config)
    return config
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, publicConfig(config), config)
    return config
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    sendJson(res, 200, {
      object: 'list',
      data: config.models.map(model => ({
        id: model.id,
        object: 'model',
        owned_by: 'turboflux-proxy',
        context_window: model.contextWindow,
        max_tokens: model.maxTokens,
      })),
    }, config)
    return config
  }

  if (req.method === 'POST' && url.pathname.startsWith('/v1/')) {
    await proxyOpenAiCompatibleRequest(req, res, config, url)
    return config
  }

  sendJson(res, 404, { error: { message: 'Not found', type: 'not_found' } }, config)
  return config
}

export function createTurboFluxServer(initialConfig = loadConfig()): Server {
  let config = initialConfig
  assertSafeExposure(config)
  addLog('info', 'server', `Config loaded from ${config.configPath}`)

  return createServer((req, res) => {
    handleRequest(req, res, config)
      .then(nextConfig => { config = nextConfig })
      .catch(error => {
        addLog('error', 'server', error instanceof Error ? error.message : String(error))
        if (res.destroyed || res.writableEnded) return
        sendJson(res, 500, {
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: 'proxy_error',
          },
        }, config)
      })
  })
}

export function startServer(): Server {
  const config = loadConfig()
  const server = createTurboFluxServer(config)
  server.listen(config.port, config.host, () => {
    addLog('info', 'server', `Listening on http://${config.host}:${config.port}`)
    console.log(`TurboFlux backend listening on http://${config.host}:${config.port}`)
    console.log(`Admin: http://${config.host}:${config.port}/admin`)
    console.log(`Upstream: ${config.upstreamBaseUrl} (${config.upstreamApiKey ? 'key configured' : 'missing key'})`)
  })
  return server
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === entrypoint) {
  startServer()
}
