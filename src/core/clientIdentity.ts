import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const DEFAULT_VERSION = '0.1.5'
const DEFAULT_SURFACE = 'cli'

let cachedVersion: string | undefined

function packageVersion(): string {
  if (cachedVersion) return cachedVersion
  try {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown }
    cachedVersion = typeof packageJson.version === 'string' && packageJson.version.trim()
      ? packageJson.version.trim()
      : DEFAULT_VERSION
  } catch {
    cachedVersion = DEFAULT_VERSION
  }
  return cachedVersion
}

function clientSurface(environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment.TURBOFLUX_CLIENT_SURFACE?.trim().toLowerCase()
  return value && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value) ? value : DEFAULT_SURFACE
}

export function getTurboFluxClientIdentity(environment: NodeJS.ProcessEnv = process.env): {
  product: string
  originator: string
  userAgent: string
} {
  const surface = clientSurface(environment)
  const product = `turboflux-${surface}`
  return {
    product,
    originator: product.replace(/-/g, '_'),
    userAgent: `${product}/${packageVersion()} (${process.platform}; ${process.arch})`,
  }
}

export function createTurboFluxRequestHeaders(
  headers: Record<string, string> = {},
  requestId = randomUUID(),
): Record<string, string> {
  const identity = getTurboFluxClientIdentity()
  return {
    'User-Agent': identity.userAgent,
    'x-app': identity.product,
    'x-client-app': identity.product,
    'originator': identity.originator,
    'x-client-request-id': requestId,
    ...headers,
  }
}
