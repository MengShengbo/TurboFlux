import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { SandboxStatus } from './types'

export const SENSITIVE_ENV_NAME = /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY|AUTH|COOKIE|SESSION)/i
const DANGEROUS_ENV_NAME = /^(?:NODE_OPTIONS|BASH_ENV|ENV|PROMPT_COMMAND|SHELLOPTS|PS4|CDPATH|GLOBIGNORE|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.+|PYTHONPATH|PYTHONHOME|RUBYOPT|PERL5OPT|GIT_SSH_COMMAND|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|DOCKER_HOST|KUBECONFIG)$/i
const SANDBOX_CONTROLLED_ENV_NAME = /^(?:PATH|PATHEXT|HOME|USERPROFILE|TEMP|TMP|TMPDIR|APPDATA|LOCALAPPDATA|XDG_.+|COMSPEC|SYSTEMROOT|SHELL)$/i
const PROXY_ENV_NAME = /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i

export interface SandboxEnvironmentResult {
  targetEnvironment: NodeJS.ProcessEnv
  hostEnvironment: NodeJS.ProcessEnv
  sandboxHome: string
  sandboxTemp: string
  hostHome: string
}

export function buildSandboxEnvironment(
  workspacePath: string,
  status: SandboxStatus,
  overrides: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
  allowSensitiveOverrides = false,
): SandboxEnvironmentResult {
  validateEnvironmentOverrides(overrides, allowSensitiveOverrides)
  const sandboxRoot = join(workspacePath, '.turboflux', 'sandbox')
  const sandboxHome = join(sandboxRoot, 'home')
  const sandboxTemp = join(sandboxRoot, 'tmp')
  mkdirSync(sandboxHome, { recursive: true, mode: 0o700 })
  mkdirSync(sandboxTemp, { recursive: true, mode: 0o700 })

  const inherited: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || shouldStripEnvironmentName(name)) continue
    inherited[name] = value
  }

  const targetEnvironment: NodeJS.ProcessEnv = {
    ...inherited,
    ...overrides,
    TURBOFLUX_SANDBOX_POLICY: status.policy,
    TURBOFLUX_SANDBOX_ENFORCEMENT: status.enforcement,
    TURBOFLUX_SANDBOX_BACKEND: status.resolvedBackend,
    TURBOFLUX_SANDBOX_NETWORK: status.network,
  }
  if (status.enforcement === 'strict') {
    Object.assign(targetEnvironment, {
      HOME: sandboxHome,
      USERPROFILE: sandboxHome,
      XDG_CONFIG_HOME: join(sandboxHome, '.config'),
      XDG_CACHE_HOME: join(sandboxHome, '.cache'),
      TEMP: sandboxTemp,
      TMP: sandboxTemp,
      TMPDIR: sandboxTemp,
    })
  }

  return {
    targetEnvironment,
    hostEnvironment: inherited,
    sandboxHome,
    sandboxTemp,
    hostHome: source.HOME || source.USERPROFILE || homedir(),
  }
}

export function validateEnvironmentOverrides(overrides: Record<string, string>, allowSensitive = false): void {
  for (const [name, value] of Object.entries(overrides)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid environment variable name: ${name}`)
    if (!allowSensitive && SENSITIVE_ENV_NAME.test(name)) throw new Error(`Sandbox blocked sensitive environment override: ${name}`)
    if (!allowSensitive && SANDBOX_CONTROLLED_ENV_NAME.test(name)) throw new Error(`Sandbox blocked controlled environment override: ${name}`)
    if (DANGEROUS_ENV_NAME.test(name)) throw new Error(`Sandbox blocked process-injection environment override: ${name}`)
    if (value.includes('\0')) throw new Error(`Sandbox blocked environment value containing NUL: ${name}`)
  }
}

function shouldStripEnvironmentName(name: string): boolean {
  return SENSITIVE_ENV_NAME.test(name) || DANGEROUS_ENV_NAME.test(name) || PROXY_ENV_NAME.test(name)
}
