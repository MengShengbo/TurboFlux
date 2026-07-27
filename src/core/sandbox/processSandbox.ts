import { dirname, join, resolve } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import type { SandboxOptions, SandboxProcessRequest, SandboxSpawnPlan, SandboxStatus } from './types'
import { resolveSandboxStatus, type ResolveSandboxDependencies } from './policy'
import { buildSandboxEnvironment } from './environment'
import { GuardedCommandPolicy } from './guard'
import { guardedBackend } from './backends/guarded'
import { bubblewrapBackend } from './backends/bubblewrap'
import { sandboxExecBackend } from './backends/sandboxExec'
import { dockerBackend } from './backends/docker'

const BACKENDS = {
  guarded: guardedBackend,
  bubblewrap: bubblewrapBackend,
  'sandbox-exec': sandboxExecBackend,
  docker: dockerBackend,
}

export class ProcessSandbox {
  private readonly workspacePath: string
  private readonly status: SandboxStatus
  private readonly guard: GuardedCommandPolicy
  private readonly auditPath: string

  constructor(
    workspacePath: string,
    options: SandboxOptions = {},
    dependencies: ResolveSandboxDependencies & { auditDirectory?: string } = {},
  ) {
    this.workspacePath = resolve(workspacePath)
    this.status = resolveSandboxStatus(this.workspacePath, options, dependencies)
    this.guard = new GuardedCommandPolicy(this.workspacePath, this.status.policy)
    const auditDirectory = dependencies.auditDirectory || (process.env.NODE_ENV === 'test'
      ? join(this.workspacePath, '.turboflux', 'sandbox')
      : join(homedir(), '.turboflux', 'audit'))
    const workspaceId = createHash('sha256').update(this.workspacePath).digest('hex').slice(0, 24)
    this.auditPath = join(auditDirectory, `${workspaceId}.jsonl`)
  }

  getStatus(): SandboxStatus {
    return {
      ...this.status,
      writableRoots: [...this.status.writableRoots],
      auditPath: this.auditPath,
    }
  }

  validateCommand(command: string, cwd: string): void {
    try {
      this.assertAvailable()
      this.guard.validate(command, cwd)
      this.audit('validate', command, cwd, 'allow')
    } catch (error) {
      this.audit('validate', command, cwd, 'deny', error)
      throw error
    }
  }

  validateTerminalInput(data: string, cwd: string): void {
    for (const line of data.split(/\r?\n/)) {
      const command = line.trim()
      if (command) this.validateCommand(command, cwd)
    }
  }

  assertNetworkToolAccess(toolName: string): void {
    if (this.status.network === 'deny') {
      const error = new Error(`Sandbox network policy denied ${toolName}`)
      this.audit('network', toolName, this.workspacePath, 'deny', error)
      throw error
    }
  }

  prepare(request: SandboxProcessRequest): SandboxSpawnPlan {
    const displayCommand = [request.command, ...request.args].join(' ')
    try {
      this.assertAvailable()
      this.guard.validateProcess(request.command, request.args, request.cwd)
      const environment = buildSandboxEnvironment(this.workspacePath, this.status, request.env, process.env, request.trustedEnvironment === true)
      if (request.trustedEnvironment !== true) {
        for (const [name, value] of Object.entries(request.env || {})) {
          this.guard.validateEnvironmentValue(name, value, request.cwd)
        }
      }
      const plan = BACKENDS[this.status.resolvedBackend].build(request, {
        workspacePath: this.workspacePath,
        status: this.status,
        ...environment,
      })
      this.audit('spawn', displayCommand, request.cwd, 'allow')
      return plan
    } catch (error) {
      this.audit('spawn', displayCommand, request.cwd, 'deny', error)
      throw error
    }
  }

  cleanupProcess(plan: SandboxSpawnPlan | undefined, force = false): void {
    const cleanup = plan?.cleanup
    if (!cleanup || cleanup.kind !== 'docker') return
    const attempt = () => {
      if (!existsSync(cleanup.cidFile)) return false
      try {
        const containerId = readFileSync(cleanup.cidFile, 'utf-8').trim()
        if (force && /^[a-f0-9]{12,64}$/i.test(containerId)) {
          const cleaner = spawn('docker', ['rm', '-f', containerId], {
            cwd: plan.cwd,
            env: dockerCleanupEnvironment(plan.env),
            windowsHide: true,
            stdio: 'ignore',
          })
          cleaner.on('error', () => {})
          cleaner.unref()
        }
      } catch {}
      rmSync(cleanup.cidFile, { force: true })
      return true
    }
    const cleaned = attempt()
    if (force && !cleaned) {
      const retry = setTimeout(attempt, 250)
      retry.unref?.()
    }
  }

  private assertAvailable(): void {
    if (this.status.available) return
    throw new Error(`Sandbox unavailable: ${this.status.reason || 'the selected backend cannot enforce this policy'}`)
  }

  private audit(action: 'validate' | 'spawn' | 'network', command: string, cwd: string, verdict: 'allow' | 'deny', error?: unknown): void {
    try {
      mkdirSync(dirname(this.auditPath), { recursive: true, mode: 0o700 })
      const message = error instanceof Error ? error.message : error === undefined ? undefined : String(error)
      const record = {
        version: 1,
        timestamp: Date.now(),
        pid: process.pid,
        action,
        verdict,
        policy: this.status.policy,
        enforcement: this.status.enforcement,
        backend: this.status.resolvedBackend,
        network: this.status.network,
        cwd,
        commandDigest: createHash('sha256').update(command).digest('hex'),
        reason: message,
      }
      appendFileSync(this.auditPath, `${JSON.stringify(record)}\n`, { encoding: 'utf-8', mode: 0o600 })
    } catch {}
  }
}

function dockerCleanupEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = process.platform === 'win32'
    ? ['PATH', 'PATHEXT', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP']
    : ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']
  const result: NodeJS.ProcessEnv = {}
  for (const name of names) {
    const value = environment[name]
    if (value !== undefined) result[name] = value
  }
  return result
}
