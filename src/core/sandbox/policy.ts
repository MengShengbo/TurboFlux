import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import type { SandboxConfig } from '../../shared/agentTypes'
import type { SandboxOptions, SandboxResolvedBackend, SandboxStatus } from './types'

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  policy: 'workspace',
  enforcement: 'guarded',
  network: 'allow',
  backend: 'auto',
}

export interface ResolveSandboxDependencies {
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  executableAvailable?: (name: string) => boolean
}

export function normalizeSandboxOptions(options: SandboxOptions = {}): SandboxConfig {
  return {
    policy: options.policy || DEFAULT_SANDBOX_CONFIG.policy,
    enforcement: options.enforcement || DEFAULT_SANDBOX_CONFIG.enforcement,
    network: options.network || DEFAULT_SANDBOX_CONFIG.network,
    backend: options.backend || DEFAULT_SANDBOX_CONFIG.backend,
    dockerImage: options.dockerImage?.trim() || undefined,
  }
}

export function resolveSandboxStatus(
  workspacePath: string,
  options: SandboxOptions = {},
  dependencies: ResolveSandboxDependencies = {},
): SandboxStatus {
  const config = normalizeSandboxOptions(options)
  const platform = dependencies.platform || process.platform
  const executableAvailable = dependencies.executableAvailable
    || ((name: string) => hasExecutable(name, dependencies.environment || process.env, platform))

  if (config.policy === 'readonly') {
    return {
      ...config,
      resolvedBackend: 'guarded',
      available: true,
      osIsolation: false,
      networkIsolated: true,
      writableRoots: [],
      warning: 'Command execution is disabled by the read-only policy.',
    }
  }

  const resolvedBackend = resolveBackend(config, platform, executableAvailable)
  const capability = backendCapability(resolvedBackend, config.dockerImage, platform, executableAvailable)
  const requiresOsIsolation = config.enforcement === 'strict' || config.network === 'deny'
  const available = capability.available && (!requiresOsIsolation || capability.osIsolation)
  const reason = available
    ? undefined
    : capability.reason || (config.network === 'deny'
      ? 'Network denial requires an OS-level sandbox backend.'
      : 'Strict enforcement requires an OS-level sandbox backend.')

  return {
    ...config,
    resolvedBackend,
    available,
    osIsolation: capability.osIsolation,
    networkIsolated: capability.osIsolation && config.network === 'deny',
    writableRoots: config.policy === 'workspace' ? [workspacePath] : ['*'],
    reason,
    warning: available && resolvedBackend === 'guarded'
      ? 'Guarded mode applies path and environment policy checks but is not an OS security boundary.'
      : undefined,
  }
}

function resolveBackend(
  config: SandboxConfig,
  platform: NodeJS.Platform,
  executableAvailable: (name: string) => boolean,
): SandboxResolvedBackend {
  if (config.backend !== 'auto') return config.backend
  if (config.enforcement === 'guarded' && config.network === 'allow') return 'guarded'
  if (platform === 'linux' && executableAvailable('bwrap')) return 'bubblewrap'
  if (platform === 'darwin' && executableAvailable('sandbox-exec')) return 'sandbox-exec'
  if (config.dockerImage && executableAvailable('docker')) return 'docker'
  return 'guarded'
}

function backendCapability(
  backend: SandboxResolvedBackend,
  dockerImage: string | undefined,
  platform: NodeJS.Platform,
  executableAvailable: (name: string) => boolean,
): { available: boolean; osIsolation: boolean; reason?: string } {
  if (backend === 'guarded') return { available: true, osIsolation: false }
  if (backend === 'bubblewrap') {
    if (platform !== 'linux') return { available: false, osIsolation: true, reason: 'Bubblewrap is only supported on Linux.' }
    return executableAvailable('bwrap')
      ? { available: true, osIsolation: true }
      : { available: false, osIsolation: true, reason: 'Bubblewrap executable "bwrap" was not found.' }
  }
  if (backend === 'sandbox-exec') {
    if (platform !== 'darwin') return { available: false, osIsolation: true, reason: 'sandbox-exec is only supported on macOS.' }
    return executableAvailable('sandbox-exec')
      ? { available: true, osIsolation: true }
      : { available: false, osIsolation: true, reason: 'macOS sandbox-exec was not found.' }
  }
  if (!dockerImage) return { available: false, osIsolation: true, reason: 'Docker sandbox requires sandboxDockerImage.' }
  return executableAvailable('docker')
    ? { available: true, osIsolation: true }
    : { available: false, osIsolation: true, reason: 'Docker executable was not found.' }
}

function hasExecutable(name: string, environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const extensions = platform === 'win32'
    ? (environment.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : ['']
  const candidates = isAbsolute(name)
    ? [name]
    : (environment.PATH || '').split(delimiter).filter(Boolean).flatMap(directory => {
        if (platform !== 'win32' || extname(name)) return [join(directory, name)]
        return extensions.map(extension => join(directory, `${name}${extension.toLowerCase()}`))
          .concat(extensions.map(extension => join(directory, `${name}${extension.toUpperCase()}`)))
      })
  return candidates.some(candidate => {
    try {
      if (!existsSync(candidate)) return false
      accessSync(candidate, constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}
