import { execFileSync } from 'node:child_process'
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

const WINDOWS_PROXY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const DEFAULT_NO_PROXY = ['localhost', '127.0.0.1', '[::1]', '::1']

export interface WindowsProxySettings {
  enabled: boolean
  server?: string
  override?: string
}

export interface NetworkProxyConfiguration {
  source: 'turboflux' | 'environment' | 'windows' | 'direct'
  httpProxy?: string
  httpsProxy?: string
  noProxy: string
}

export interface NetworkProxyStatus {
  enabled: boolean
  source: NetworkProxyConfiguration['source']
  endpoint?: string
}

let configuredStatus: NetworkProxyStatus | undefined

function firstValue(environment: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = environment[name]?.trim()
    if (value) return value
  }
  return undefined
}

function normalizeProxyUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`
  try {
    const parsed = new URL(candidate)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined
  } catch {
    return undefined
  }
}

function parseProtocolProxyServer(value: string): { httpProxy?: string; httpsProxy?: string } {
  const entries = value.split(';').map(entry => entry.trim()).filter(Boolean)
  if (!entries.some(entry => entry.includes('='))) {
    const proxy = normalizeProxyUrl(value)
    return { httpProxy: proxy, httpsProxy: proxy }
  }

  const protocols = new Map<string, string>()
  for (const entry of entries) {
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    protocols.set(entry.slice(0, separator).trim().toLowerCase(), entry.slice(separator + 1).trim())
  }
  const httpProxy = normalizeProxyUrl(protocols.get('http') ?? protocols.get('https'))
  const httpsProxy = normalizeProxyUrl(protocols.get('https') ?? protocols.get('http'))
  return { httpProxy, httpsProxy }
}

function normalizeNoProxy(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(/[;,\s]+/)
    .map(entry => entry.trim())
    .filter(entry => entry && entry.toLowerCase() !== '<local>')
    .map(entry => entry.startsWith('*.') ? entry.slice(1) : entry)
}

function mergeNoProxy(...values: Array<string | undefined>): string {
  const entries = [...DEFAULT_NO_PROXY, ...values.flatMap(normalizeNoProxy)]
  return [...new Set(entries.map(entry => entry.toLowerCase()))].join(',')
}

function parseRegistryValue(output: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = output.match(new RegExp(`^\\s*${escapedName}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'im'))
  return match?.[1]?.trim()
}

function queryWindowsRegistryValue(name: string): string | undefined {
  try {
    const output = execFileSync('reg.exe', ['query', WINDOWS_PROXY_KEY, '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return parseRegistryValue(output, name)
  } catch {
    return undefined
  }
}

export function readWindowsProxySettings(): WindowsProxySettings | undefined {
  if (process.platform !== 'win32') return undefined
  const enabledValue = queryWindowsRegistryValue('ProxyEnable')
  if (!enabledValue) return undefined
  return {
    enabled: Number.parseInt(enabledValue, 0) !== 0,
    server: queryWindowsRegistryValue('ProxyServer'),
    override: queryWindowsRegistryValue('ProxyOverride'),
  }
}

export function resolveNetworkProxy(
  environment: NodeJS.ProcessEnv = process.env,
  windowsSettings?: WindowsProxySettings,
): NetworkProxyConfiguration {
  const noProxy = firstValue(environment, 'no_proxy', 'NO_PROXY')
  const turboFluxProxy = normalizeProxyUrl(firstValue(environment, 'turboflux_proxy', 'TURBOFLUX_PROXY'))
  if (turboFluxProxy) {
    return {
      source: 'turboflux',
      httpProxy: turboFluxProxy,
      httpsProxy: turboFluxProxy,
      noProxy: mergeNoProxy(noProxy),
    }
  }

  const environmentHttpProxy = normalizeProxyUrl(firstValue(environment, 'http_proxy', 'HTTP_PROXY'))
  const environmentHttpsProxy = normalizeProxyUrl(firstValue(environment, 'https_proxy', 'HTTPS_PROXY'))
  const environmentAllProxy = normalizeProxyUrl(firstValue(environment, 'all_proxy', 'ALL_PROXY'))
  if (environmentHttpProxy || environmentHttpsProxy || environmentAllProxy) {
    return {
      source: 'environment',
      httpProxy: environmentHttpProxy ?? environmentAllProxy ?? environmentHttpsProxy,
      httpsProxy: environmentHttpsProxy ?? environmentAllProxy ?? environmentHttpProxy,
      noProxy: mergeNoProxy(noProxy),
    }
  }

  if (windowsSettings?.enabled && windowsSettings.server) {
    const proxies = parseProtocolProxyServer(windowsSettings.server)
    if (proxies.httpProxy || proxies.httpsProxy) {
      return {
        source: 'windows',
        ...proxies,
        noProxy: mergeNoProxy(noProxy, windowsSettings.override),
      }
    }
  }

  return { source: 'direct', noProxy: mergeNoProxy(noProxy) }
}

export function describeNetworkProxy(config: NetworkProxyConfiguration): NetworkProxyStatus {
  const proxy = config.httpsProxy ?? config.httpProxy
  if (!proxy) return { enabled: false, source: config.source }
  const parsed = new URL(proxy)
  return {
    enabled: true,
    source: config.source,
    endpoint: `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`,
  }
}

export function configureNetworkProxy(): NetworkProxyStatus {
  if (configuredStatus) return configuredStatus
  const config = resolveNetworkProxy(process.env, readWindowsProxySettings())
  if (config.httpProxy || config.httpsProxy) {
    setGlobalDispatcher(new EnvHttpProxyAgent({
      httpProxy: config.httpProxy,
      httpsProxy: config.httpsProxy,
      noProxy: config.noProxy,
    }))
  }
  configuredStatus = describeNetworkProxy(config)
  return configuredStatus
}
