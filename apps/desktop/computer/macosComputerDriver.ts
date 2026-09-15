import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type {
  ComputerAccessibilityElement,
  ComputerAppSnapshot,
  ComputerBounds,
  ComputerWindowSnapshot,
} from '@turboflux/agent-core/contracts'
import type {
  ComputerDriver,
  ComputerExpectedTarget,
  ComputerMouseButton,
  ComputerNativeSnapshot,
  ComputerPointOwner,
} from './computerDriver'
import { desktopAppRoot } from '../desktopPaths'

interface HelperResponse {
  ok: boolean
  error?: string
  [key: string]: unknown
}

const HELPER_SOURCE = join(desktopAppRoot, 'computer', 'native', 'TurboFluxComputerHelper.swift')
const HELPER_TIMEOUT_MS = 12_000

function computerOperationAbortError(): Error {
  const error = new Error('Computer operation aborted')
  error.name = 'AbortError'
  return error
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function boundsValue(value: unknown): ComputerBounds | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const x = numberValue(record.x)
  const y = numberValue(record.y)
  const width = numberValue(record.width)
  const height = numberValue(record.height)
  return x === undefined || y === undefined || width === undefined || height === undefined
    ? undefined
    : { x, y, width, height }
}

function appValue(value: unknown): ComputerAppSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const pid = numberValue(record.pid)
  const name = stringValue(record.name)
  if (pid === undefined || !name) return null
  return {
    pid,
    name,
    bundleId: stringValue(record.bundleId),
    bundlePath: stringValue(record.bundlePath),
    active: record.active === true,
    hidden: record.hidden === true,
  }
}

function windowValue(value: unknown): ComputerWindowSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = numberValue(record.id)
  const pid = numberValue(record.pid)
  const appName = stringValue(record.appName)
  const bounds = boundsValue(record.bounds)
  if (id === undefined || pid === undefined || !appName || !bounds) return null
  return {
    id,
    pid,
    appName,
    bundleId: stringValue(record.bundleId),
    title: stringValue(record.title),
    bounds,
    layer: numberValue(record.layer) || 0,
    onscreen: record.onscreen !== false,
  }
}

function elementValue(value: unknown): ComputerAccessibilityElement | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const ref = stringValue(record.ref)
  const role = stringValue(record.role)
  if (!ref || !role) return null
  return {
    ref,
    role,
    subrole: stringValue(record.subrole),
    title: stringValue(record.title),
    description: stringValue(record.description),
    value: record.secure === true ? undefined : stringValue(record.value),
    enabled: record.enabled !== false,
    focused: record.focused === true,
    secure: record.secure === true,
    bounds: boundsValue(record.bounds),
  }
}

function helperEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_CTYPE: process.env.LC_CTYPE || 'UTF-8',
  }
}

export class MacOSComputerDriver implements ComputerDriver {
  readonly platform = 'darwin' as const
  private helperPromise: Promise<string> | null = null

  async requestAccessibilityAccess(signal?: AbortSignal): Promise<boolean> {
    const response = await this.runHelper({ command: 'requestAccessibility' }, signal)
    return response.granted === true
  }

  async requestPostEventAccess(signal?: AbortSignal): Promise<boolean> {
    const response = await this.runHelper({ command: 'requestPostEvent' }, signal)
    return response.granted === true
  }

  async nativeSnapshot(options: {
    includeElements?: boolean
    target?: { pid: number; bundleId?: string; windowId?: number }
    signal?: AbortSignal
  } = {}): Promise<ComputerNativeSnapshot> {
    const response = await this.runHelper({
      command: 'snapshot',
      includeElements: options.includeElements === true,
      targetPid: options.target?.pid,
      targetBundleId: options.target?.bundleId,
      targetWindowId: options.target?.windowId,
    }, options.signal)
    const windows = Array.isArray(response.windows) ? response.windows.map(windowValue).filter((item): item is ComputerWindowSnapshot => Boolean(item)) : []
    const elements = Array.isArray(response.elements) ? response.elements.map(elementValue).filter((item): item is ComputerAccessibilityElement => Boolean(item)) : []
    const focusedElement = response.focusedElement && typeof response.focusedElement === 'object'
      ? response.focusedElement as Record<string, unknown>
      : undefined
    return {
      accessibilityTrusted: response.accessibilityTrusted === true,
      postEventTrusted: response.postEventTrusted === true,
      frontmostApp: appValue(response.frontmostApp),
      focusedWindow: windowValue(response.focusedWindow),
      targetApp: appValue(response.targetApp),
      targetWindow: windowValue(response.targetWindow),
      focusedElement: focusedElement
        ? {
            role: stringValue(focusedElement.role),
            subrole: stringValue(focusedElement.subrole),
            title: stringValue(focusedElement.title),
            secure: focusedElement.secure === true,
          }
        : undefined,
      windows,
      elements,
    }
  }

  async listApps(signal?: AbortSignal): Promise<ComputerAppSnapshot[]> {
    const response = await this.runHelper({ command: 'apps' }, signal)
    return Array.isArray(response.apps)
      ? response.apps.map(appValue).filter((item): item is ComputerAppSnapshot => Boolean(item))
      : []
  }

  async activateApp(target: { pid?: number; bundleId?: string; name?: string }, signal?: AbortSignal): Promise<ComputerAppSnapshot> {
    const response = await this.runHelper({ command: 'activate', ...target }, signal)
    const appSnapshot = appValue(response.app)
    if (!appSnapshot) throw new Error('The selected application could not be activated')
    return appSnapshot
  }

  async openApp(target: { bundleId?: string; name?: string }, signal?: AbortSignal): Promise<ComputerAppSnapshot> {
    const response = await this.runHelper({ command: 'open', ...target }, signal)
    const appSnapshot = appValue(response.app)
    if (!appSnapshot) throw new Error('The selected application could not be opened')
    return appSnapshot
  }

  async pointOwner(point: { x: number; y: number }, signal?: AbortSignal): Promise<ComputerPointOwner | null> {
    const response = await this.runHelper({ command: 'pointOwner', ...point }, signal)
    const owner = response.owner
    if (!owner || typeof owner !== 'object') return null
    const record = owner as Record<string, unknown>
    const pid = numberValue(record.pid)
    const appName = stringValue(record.appName)
    if (pid === undefined || !appName) return null
    return {
      pid,
      appName,
      bundleId: stringValue(record.bundleId),
      windowId: numberValue(record.windowId),
      title: stringValue(record.title),
      bounds: boundsValue(record.bounds),
    }
  }

  async click(point: { x: number; y: number }, options: {
    button?: ComputerMouseButton
    count?: 1 | 2
    expectedTarget: ComputerExpectedTarget
  }, signal?: AbortSignal): Promise<void> {
    await this.runHelper({
      command: 'click',
      ...point,
      button: options.button || 'left',
      count: options.count || 1,
      expectedTarget: options.expectedTarget,
    }, signal)
  }

  async move(point: { x: number; y: number }, options: { expectedTarget: ComputerExpectedTarget }, signal?: AbortSignal): Promise<void> {
    await this.runHelper({ command: 'move', ...point, expectedTarget: options.expectedTarget }, signal)
  }

  async drag(points: Array<{ x: number; y: number }>, options: {
    button?: ComputerMouseButton
    expectedTarget: ComputerExpectedTarget
  }, signal?: AbortSignal): Promise<void> {
    await this.runHelper({
      command: 'drag',
      points,
      button: options.button || 'left',
      expectedTarget: options.expectedTarget,
    }, signal)
  }

  async scroll(
    point: { x: number; y: number },
    delta: { x: number; y: number },
    options: { expectedTarget: ComputerExpectedTarget },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.runHelper({
      command: 'scroll',
      ...point,
      deltaX: delta.x,
      deltaY: delta.y,
      expectedTarget: options.expectedTarget,
    }, signal)
  }

  async press(keys: string[], targetPid: number, options: { expectedTarget: ComputerExpectedTarget }, signal?: AbortSignal): Promise<void> {
    await this.runHelper({ command: 'press', keys, pid: targetPid, expectedTarget: options.expectedTarget }, signal)
  }

  async typeText(text: string, targetPid: number, options: { expectedTarget: ComputerExpectedTarget }, signal?: AbortSignal): Promise<void> {
    await this.runHelper({ command: 'type', text, pid: targetPid, expectedTarget: options.expectedTarget }, signal)
  }

  async pressElement(
    ref: string,
    expected: { role?: string; title?: string },
    options: { expectedTarget: ComputerExpectedTarget },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.runHelper({ command: 'pressElement', ref, expected, expectedTarget: options.expectedTarget }, signal)
  }

  async setElementValue(
    ref: string,
    text: string,
    expected: { role?: string; title?: string },
    options: { expectedTarget: ComputerExpectedTarget },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.runHelper({ command: 'setElementValue', ref, text, expected, expectedTarget: options.expectedTarget }, signal)
  }

  private async runHelper(request: Record<string, unknown>, signal?: AbortSignal): Promise<HelperResponse> {
    if (signal?.aborted) throw computerOperationAbortError()
    const helper = await this.ensureHelper()
    if (signal?.aborted) throw computerOperationAbortError()
    return new Promise<HelperResponse>((resolve, reject) => {
      const child = spawn(helper, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: helperEnvironment(),
      })
      const output: Buffer[] = []
      const errors: Buffer[] = []
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        callback()
      }
      const abort = () => {
        child.kill('SIGTERM')
        finish(() => reject(computerOperationAbortError()))
      }
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        finish(() => reject(new Error('Computer helper timed out')))
      }, HELPER_TIMEOUT_MS)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) {
        abort()
        return
      }
      child.stdout.on('data', chunk => output.push(Buffer.from(chunk)))
      child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)))
      child.once('error', error => finish(() => reject(error)))
      child.once('close', code => finish(() => {
        const text = Buffer.concat(output).toString('utf8').trim()
        if (code !== 0 && !text) {
          reject(new Error(Buffer.concat(errors).toString('utf8').trim() || `Computer helper exited with code ${code}`))
          return
        }
        try {
          const response = JSON.parse(text) as HelperResponse
          if (!response.ok) reject(new Error(response.error || 'Computer helper rejected the operation'))
          else resolve(response)
        } catch (error) {
          reject(new Error(`Invalid computer helper response: ${error instanceof Error ? error.message : String(error)}`))
        }
      }))
      child.stdin.end(JSON.stringify(request))
    })
  }

  private ensureHelper(): Promise<string> {
    if (!this.helperPromise) {
      this.helperPromise = this.resolveHelper().catch(error => {
        this.helperPromise = null
        throw error
      })
    }
    return this.helperPromise
  }

  private async resolveHelper(): Promise<string> {
    const override = process.env.TURBOFLUX_COMPUTER_HELPER
    if (override) {
      return this.requireExecutableHelper(override, 'Configured Computer helper')
    }
    const bundled = join(process.resourcesPath, 'native', 'TurboFluxComputerHelper')
    try {
      return await this.requireExecutableHelper(bundled, 'Bundled Computer helper')
    } catch (error) {
      if (app.isPackaged) {
        throw new Error(`Computer control is unavailable because the signed helper is missing or invalid: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const source = await readFile(HELPER_SOURCE)
    const digest = createHash('sha256').update(source).digest('hex').slice(0, 16)
    const directory = join(app.getPath('userData'), 'native')
    const binary = join(directory, `TurboFluxComputerHelper-${digest}`)
    await mkdir(directory, { recursive: true })
    try {
      return await this.requireExecutableHelper(binary, 'Cached Computer helper')
    } catch {}
    await this.compileHelper(binary)
    return this.requireExecutableHelper(binary, 'Compiled Computer helper')
  }

  private async requireExecutableHelper(path: string, label: string): Promise<string> {
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`${label} is not a regular file`)
    await access(path, constants.X_OK)
    return path
  }

  private async compileHelper(binary: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/xcrun', [
        'swiftc',
        '-O',
        '-framework', 'AppKit',
        '-framework', 'ApplicationServices',
        HELPER_SOURCE,
        '-o', binary,
      ], {
        cwd: dirname(HELPER_SOURCE),
        stdio: ['ignore', 'ignore', 'pipe'],
        env: helperEnvironment(),
      })
      const errors: Buffer[] = []
      child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)))
      child.once('error', reject)
      child.once('close', code => {
        if (code === 0) resolve()
        else reject(new Error(`Unable to build the macOS computer helper: ${Buffer.concat(errors).toString('utf8').trim()}`))
      })
    })
  }
}
