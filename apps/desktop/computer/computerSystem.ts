import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  BrowserWindow,
  desktopCapturer,
  nativeImage,
  screen,
  shell,
  systemPreferences,
  type Display,
  type NativeImage,
} from 'electron'
import {
  computerActionRequiresHandoff,
  inferComputerActionSafetyClass,
  type AgentAttachment,
} from '@turboflux/contracts'
import { type McpClient, type McpLocalToolResult } from '@turboflux/extensions'
import type {
  ComputerActivitySnapshot,
  ComputerAppSnapshot,
  ComputerBounds,
  ComputerControlMode,
  ComputerDisplaySnapshot,
  ComputerObservation,
  ComputerPermissionKind,
  ComputerPermissionSnapshot,
  ComputerPermissionState,
  ComputerPermissionStatus,
  ComputerPermissionRequestResult,
  ComputerPermissionRequirement,
  ComputerErrorSnapshot,
  ComputerPoint,
  ComputerSystemEvent,
  ComputerSystemSnapshot,
  ComputerToolOperation,
  ComputerWindowSnapshot,
} from '@turboflux/contracts'
import type {
  ComputerDriver,
  ComputerMouseButton,
  ComputerNativeSnapshot,
} from './computerDriver'
import { MacOSComputerDriver } from './macosComputerDriver'
import {
  COMPUTER_OBSERVATION_TTL_MS,
  assertSafeComputerText,
  normalizeComputerKeys,
  observationPoint,
  protectedComputerAppReason,
  sanitizeComputerPurpose,
} from './computerPolicy'
import {
  SerializedOperationCoordinator,
  abortableDelay as sharedAbortableDelay,
  assertOperationActive as assertSharedOperationActive,
  createOperationAbortError,
  isOperationAbort,
} from '../systems/operationCoordinator'
import type { RuntimePausableSystemCapability } from '../systems/systemCapability'
import { ComputerObservationStore } from './computerObservationStore'
import {
  assertObservationIdentity,
  assertPointOutsideProtectedRegions,
  expectedObservationTarget,
  requireObservationElement,
} from './computerTargetGuard'
import { registerComputerCapability } from './computerCapability'
import { computerTools, MAX_DRAG_POINTS } from './computerTools'

const MAX_CAPTURE_FILES = 24
const MAX_CAPTURE_AGE_MS = 30 * 60_000
const MAX_SCREENSHOT_WIDTH = 1_600
const MAX_SCREENSHOT_HEIGHT = 1_000
const ACTION_SETTLE_MS = 180
const COMPUTER_OPERATION_ABORT_MESSAGE = 'Computer operation aborted'

export interface ComputerSystemOptions {
  storageRoot?: string
  pauseRuntime?: () => void | Promise<void>
  requestPermission?: (kind: ComputerPermissionKind, operation: ComputerToolOperation) => Promise<ComputerPermissionRequestResult | boolean>
  beforeVisualCapture?: () => void | Promise<void>
  afterVisualCapture?: () => void | Promise<void>
  acquireControl?: () => boolean | Promise<boolean>
  releaseControl?: () => void
}

type ObservationModeRequest = 'auto' | 'background' | 'foreground'

interface ObservationTarget {
  pid: number
  appName: string
  bundleId: string
  windowId?: number
}

interface CaptureObservationOptions {
  scope: 'window' | 'display'
  displayId?: string
  target?: ObservationTarget
  mode?: ObservationModeRequest
}

export type DesktopComputerSystemEvent = ComputerSystemEvent | {
  type: 'artifact-ready'
  path: string
  name: string
  mime: 'image/png'
  capturedAt: number
  observationId: string
  appName: string
  windowTitle: string
}

function defaultActivityDescription(operation: ComputerToolOperation): string {
  return ({
    status: '检查电脑操控状态',
    observe: '查看当前应用',
    list_apps: '查看打开的应用',
    open_app: '打开目标应用',
    focus_app: '切换到目标应用',
    click: '操作当前界面',
    double_click: '操作当前界面',
    move: '定位当前界面',
    drag: '拖动当前内容',
    scroll: '浏览当前内容',
    type_text: '填写当前内容',
    press: '使用键盘操作',
    wait: '等待应用响应',
    assert: '核对操作结果',
    handoff: '等待用户接管',
  } as Record<ComputerToolOperation, string>)[operation]
}

function permissionState(value: string): ComputerPermissionState {
  if (value === 'granted') return 'granted'
  if (value === 'denied') return 'denied'
  if (value === 'restricted') return 'restricted'
  if (value === 'not-determined') return 'not-determined'
  return 'unknown'
}

function numberArg(value: unknown, name: string): number {
  const result = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(result)) throw new Error(`${name} must be a finite number`)
  return result
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

function mouseButton(value: unknown): ComputerMouseButton {
  return value === 'right' || value === 'middle' ? value : 'left'
}

function intersectBounds(left: ComputerBounds, right: ComputerBounds): ComputerBounds | null {
  const x = Math.max(left.x, right.x)
  const y = Math.max(left.y, right.y)
  const maxX = Math.min(left.x + left.width, right.x + right.width)
  const maxY = Math.min(left.y + left.height, right.y + right.height)
  return maxX > x && maxY > y ? { x, y, width: maxX - x, height: maxY - y } : null
}

function displaySnapshot(display: Display, primaryId: number): ComputerDisplaySnapshot {
  return {
    id: String(display.id),
    label: display.label || `显示器 ${display.id}`,
    bounds: { ...display.bounds },
    workArea: { ...display.workArea },
    scaleFactor: display.scaleFactor,
    primary: display.id === primaryId,
  }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return sharedAbortableDelay(milliseconds, signal, COMPUTER_OPERATION_ABORT_MESSAGE)
}

function computerOperationAbortError(): Error {
  return createOperationAbortError(COMPUTER_OPERATION_ABORT_MESSAGE)
}

function assertOperationActive(signal?: AbortSignal): void {
  assertSharedOperationActive(signal, COMPUTER_OPERATION_ABORT_MESSAGE)
}

export class ComputerSystem implements RuntimePausableSystemCapability<ComputerSystemSnapshot> {
  private workspacePath: string
  private readonly driver: ComputerDriver | null
  private paused = false
  private runtimePaused = false
  private handoffActive = false
  private sessionActive = false
  private activity: ComputerActivitySnapshot | undefined
  private lastNative: ComputerNativeSnapshot | null = null
  private readonly observations = new ComputerObservationStore()
  private readonly operations = new SerializedOperationCoordinator(COMPUTER_OPERATION_ABORT_MESSAGE)
  private captureCleanup: Promise<void>
  private storageRoot?: string
  private readonly requestedPermissions = new Set<ComputerPermissionKind>()
  private driverHealthy = false
  private permissionRequirement: ComputerPermissionRequirement | undefined
  private lastError: ComputerErrorSnapshot | undefined
  private permissionRequest: Promise<boolean> | undefined

  constructor(
    _window: BrowserWindow,
    workspacePath: string,
    private readonly emit: (event: DesktopComputerSystemEvent) => void,
    driver?: ComputerDriver | null,
    private readonly options: ComputerSystemOptions = {},
  ) {
    this.workspacePath = resolve(workspacePath)
    this.storageRoot = options.storageRoot ? resolve(options.storageRoot) : undefined
    this.driver = driver === undefined
      ? process.platform === 'darwin' ? new MacOSComputerDriver() : null
      : driver
    this.driverHealthy = Boolean(this.driver)
    this.captureCleanup = this.clearCaptureDirectory(this.captureDirectory())
  }

  register(client: McpClient): void {
    registerComputerCapability(
      client,
      computerTools(),
      (toolName, args, options) => this.enqueueTool(toolName as ComputerToolOperation, args, options?.signal),
    )
  }

  setWorkspacePath(workspacePath: string): void {
    const nextWorkspacePath = resolve(workspacePath)
    if (nextWorkspacePath === this.workspacePath) return
    const previousCaptureDirectory = this.captureDirectory()
    this.operations.invalidate()
    this.workspacePath = nextWorkspacePath
    this.observations.clear()
    this.captureCleanup = Promise.all([
      this.captureCleanup,
      this.clearCaptureDirectory(previousCaptureDirectory),
      this.clearCaptureDirectory(this.captureDirectory()),
    ]).then(() => undefined)
  }

  setStorageRoot(storageRoot: string | undefined): void {
    const nextRoot = storageRoot ? resolve(storageRoot) : undefined
    if (nextRoot === this.storageRoot) return
    const previousCaptureDirectory = this.captureDirectory()
    this.storageRoot = nextRoot
    this.captureCleanup = Promise.all([
      this.captureCleanup,
      this.clearCaptureDirectory(previousCaptureDirectory),
      this.clearCaptureDirectory(this.captureDirectory()),
    ]).then(() => undefined)
  }

  getSnapshot(): ComputerSystemSnapshot {
    const displays = screen.getAllDisplays()
    const primaryId = screen.getPrimaryDisplay().id
    return {
      platform: process.platform as 'darwin' | 'win32' | 'linux',
      available: Boolean(this.driver) && this.driverHealthy,
      paused: this.paused || this.runtimePaused,
      handoffActive: this.handoffActive,
      sessionActive: this.sessionActive,
      permissions: this.permissionSnapshot(),
      displays: displays.map(display => displaySnapshot(display, primaryId)),
      activeApp: this.lastNative?.targetApp || this.lastNative?.frontmostApp || undefined,
      activeWindow: this.lastNative?.targetWindow || this.lastNative?.focusedWindow || undefined,
      activity: this.activity ? { ...this.activity } : undefined,
      permissionRequirement: this.permissionRequirement ? { ...this.permissionRequirement } : undefined,
      lastError: this.lastError ? { ...this.lastError } : undefined,
    }
  }

  async refresh(): Promise<ComputerSystemSnapshot> {
    if (this.driver) {
      try {
        this.lastNative = await this.driver.nativeSnapshot()
        this.driverHealthy = true
      } catch {
        this.lastNative = null
        this.driverHealthy = false
      }
    }
    this.emitState()
    return this.getSnapshot()
  }

  async restoreObservedTargetAfterApproval(): Promise<ComputerSystemSnapshot> {
    const driver = this.requireDriver()
    const targetApp = this.lastNative?.targetApp || this.lastNative?.frontmostApp
    const targetWindow = this.lastNative?.targetWindow || this.lastNative?.focusedWindow
    if (!targetApp?.bundleId || !targetWindow) throw new Error('没有可恢复的电脑操作目标，请重新观察应用')
    this.assertAppAllowed(targetApp)
    await driver.activateApp({ pid: targetApp.pid, bundleId: targetApp.bundleId, name: targetApp.name })
    await abortableDelay(ACTION_SETTLE_MS)
    const current = await driver.nativeSnapshot({
      includeElements: false,
      target: { pid: targetApp.pid, bundleId: targetApp.bundleId, windowId: targetWindow.id },
    })
    if (current.frontmostApp?.pid !== targetApp.pid || current.frontmostApp.bundleId !== targetApp.bundleId) {
      throw new Error(`无法把 ${targetApp.name} 恢复到前台，请重新观察应用`)
    }
    if (current.focusedWindow?.id !== targetWindow.id) {
      throw new Error(`无法恢复 ${targetApp.name} 的目标窗口，请重新观察应用`)
    }
    this.lastNative = current
    this.lastError = undefined
    this.emitState()
    return this.getSnapshot()
  }

  async requestPermission(kind: string): Promise<ComputerSystemSnapshot> {
    const driver = this.requireDriver()
    if (kind === 'screen-recording') {
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: false })
    } else if (kind === 'accessibility') {
      await driver.requestAccessibilityAccess()
    } else if (kind === 'post-event') {
      await driver.requestPostEventAccess()
    } else {
      throw new Error(`Unknown computer permission: ${kind}`)
    }
    this.requestedPermissions.add(kind)
    this.permissionRequirement = undefined
    this.lastError = undefined
    await abortableDelay(120)
    return this.refresh()
  }

  async openPermissionSettings(kind: string): Promise<void> {
    const route = kind === 'screen-recording'
      ? 'Privacy_ScreenCapture'
      : kind === 'accessibility' || kind === 'post-event'
        ? 'Privacy_Accessibility'
        : null
    if (!route) throw new Error(`Unknown computer permission: ${kind}`)
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${route}`)
  }

  takeControl(): ComputerSystemSnapshot {
    this.operations.invalidate()
    this.paused = true
    this.handoffActive = true
    this.observations.clear()
    this.sessionActive = true
    this.setActivity({ phase: 'handoff', description: '用户已接管电脑', controlMode: 'takeover', startedAt: Date.now() })
    this.emit({ type: 'handoff-changed', active: true })
    return this.getSnapshot()
  }

  pauseForRuntime(): ComputerSystemSnapshot {
    this.operations.invalidate()
    this.runtimePaused = true
    this.observations.clear()
    this.setActivity(undefined)
    this.options.releaseControl?.()
    return this.getSnapshot()
  }

  resumeForRuntime(): ComputerSystemSnapshot {
    this.operations.invalidate()
    this.runtimePaused = false
    this.observations.clear()
    if (!this.handoffActive) this.setActivity(undefined)
    return this.getSnapshot()
  }

  resumeControl(): ComputerSystemSnapshot {
    this.operations.invalidate()
    this.paused = false
    this.handoffActive = false
    this.observations.clear()
    this.setActivity(undefined)
    this.emit({ type: 'handoff-changed', active: false })
    return this.getSnapshot()
  }

  emergencyStop(): ComputerSystemSnapshot {
    this.operations.invalidate()
    this.paused = true
    this.handoffActive = false
    this.sessionActive = false
    this.observations.clear()
    this.setActivity(undefined)
    this.options.releaseControl?.()
    return this.getSnapshot()
  }

  async finishTask(): Promise<void> {
    this.operations.invalidate()
    this.runtimePaused = false
    this.observations.clear()
    this.sessionActive = false
    this.setActivity(undefined)
    this.options.releaseControl?.()
    const captureDirectory = this.captureDirectory()
    this.captureCleanup = Promise.all([
      this.captureCleanup,
      this.operations.drain(),
    ])
      .then(() => this.clearCaptureDirectory(captureDirectory))
      .then(() => undefined)
    await this.captureCleanup
  }

  destroy(): void {
    this.paused = true
    this.handoffActive = false
    void this.finishTask().catch(() => {})
  }

  private permissionSnapshot(): ComputerPermissionSnapshot {
    const driverAvailable = Boolean(this.driver) && this.driverHealthy
    const screenState = process.platform === 'darwin'
      ? permissionState(systemPreferences.getMediaAccessStatus('screen'))
      : 'unavailable'
    const applicationAccessibilityGranted = process.platform === 'darwin'
      && systemPreferences.isTrustedAccessibilityClient(false)
    const accessibilityGranted = this.lastNative?.accessibilityTrusted === true
    const postEventGranted = this.lastNative?.postEventTrusted === true
    const accessibilityRestartRequired = driverAvailable && applicationAccessibilityGranted && !accessibilityGranted
    const postEventRestartRequired = driverAvailable && applicationAccessibilityGranted && !postEventGranted
    const accessibilityState = accessibilityGranted
      ? 'granted'
      : driverAvailable
        ? this.requestedPermissions.has('accessibility') ? 'denied' : 'not-determined'
        : 'unavailable'
    const postEventState = postEventGranted
      ? 'granted'
      : driverAvailable
        ? this.requestedPermissions.has('post-event') ? 'denied' : 'not-determined'
        : 'unavailable'
    return {
      screenRecording: this.permissionStatus(
        'screen-recording',
        screenState === 'granted' || !this.requestedPermissions.has('screen-recording') ? screenState : 'denied',
        'Privacy_ScreenCapture',
      ),
      accessibility: this.permissionStatus('accessibility', accessibilityState, 'Privacy_Accessibility', accessibilityRestartRequired),
      postEvent: this.permissionStatus('post-event', postEventState, 'Privacy_Accessibility', postEventRestartRequired),
    }
  }

  private permissionStatus(
    kind: ComputerPermissionStatus['kind'],
    state: ComputerPermissionState,
    route: string,
    restartRequired = false,
  ): ComputerPermissionStatus {
    return {
      kind,
      state,
      canRequest: !restartRequired && Boolean(this.driver) && this.driverHealthy && (state === 'not-determined' || state === 'unknown'),
      settingsPath: `x-apple.systempreferences:com.apple.preference.security?${route}`,
      restartRequired: restartRequired || undefined,
    }
  }

  private async handleTool(toolName: ComputerToolOperation, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    assertOperationActive(signal)
    if (!['status', 'list_apps', 'handoff'].includes(toolName)) this.assertNotPaused()
    switch (toolName) {
      case 'status': return this.refresh()
      case 'list_apps': return this.listApps(signal)
      case 'open_app': return this.openApp(args, signal)
      case 'focus_app': return this.focusApp(args, signal)
      case 'observe': return this.observe(args, signal)
      case 'click': return this.click(args, 1, signal)
      case 'double_click': return this.click(args, 2, signal)
      case 'move': return this.move(args, signal)
      case 'drag': return this.drag(args, signal)
      case 'scroll': return this.scroll(args, signal)
      case 'type_text': return this.typeText(args, signal)
      case 'press': return this.press(args, signal)
      case 'wait': return this.wait(args, signal)
      case 'assert': return this.assertState(args, signal)
      case 'handoff': return this.handoff(args)
      default: throw new Error(`Unknown computer tool: ${toolName}`)
    }
  }

  private async listApps(signal?: AbortSignal): Promise<unknown> {
    const driver = this.requireDriver()
    const apps = await driver.listApps(signal)
    assertOperationActive(signal)
    return {
      apps: apps.map(app => ({
        ...app,
        protected: protectedComputerAppReason(app, process.pid) || undefined,
      })),
      instruction: 'Use exact pid, name, and bundleId values. Protected applications require user takeover and cannot be controlled.',
    }
  }

  private async observe(args: Record<string, unknown>, signal?: AbortSignal): Promise<McpLocalToolResult> {
    const target = await this.resolveObservationTarget(args, signal)
    const mode = ['background', 'foreground'].includes(String(args.interaction_mode))
      ? args.interaction_mode as ObservationModeRequest
      : 'auto'
    return this.captureObservation({
      scope: args.scope === 'display' ? 'display' : 'window',
      displayId: typeof args.display_id === 'string' ? args.display_id : undefined,
      target,
      mode,
    }, signal)
  }

  private async resolveObservationTarget(args: Record<string, unknown>, signal?: AbortSignal): Promise<ObservationTarget | undefined> {
    const hasTarget = args.pid !== undefined || args.app_name !== undefined || args.bundle_id !== undefined
    if (!hasTarget) return undefined
    const pid = Math.floor(numberArg(args.pid, 'pid'))
    const appName = stringArg(args.app_name, 'app_name')
    const bundleId = stringArg(args.bundle_id, 'bundle_id')
    const target = (await this.requireDriver().listApps(signal)).find(app => app.pid === pid)
    assertOperationActive(signal)
    if (!target || target.name !== appName || target.bundleId !== bundleId) {
      throw new Error('Application identity changed; list applications again')
    }
    this.assertAppAllowed(target)
    return { pid, appName, bundleId }
  }

  private async openApp(args: Record<string, unknown>, signal?: AbortSignal): Promise<McpLocalToolResult> {
    const driver = this.requireDriver()
    const appName = stringArg(args.app_name || args.name, 'app_name')
    const bundleId = typeof args.bundle_id === 'string' ? args.bundle_id.trim() : undefined
    this.assertActionRisk('open_app', args)
    this.assertAppAllowed({ pid: 0, name: appName, bundleId, active: false })
    const known = (await driver.listApps(signal)).find(app => app.bundleId === bundleId || app.name.toLowerCase() === appName.toLowerCase())
    assertOperationActive(signal)
    if (known) this.assertAppAllowed(known)
    return this.withActivity('open_app', args, async () => {
      const opened = await driver.openApp({ name: typeof args.name === 'string' ? args.name : appName, bundleId }, signal)
      assertOperationActive(signal)
      this.assertAppAllowed(opened)
      await abortableDelay(ACTION_SETTLE_MS, signal)
      return this.captureObservation({
        scope: 'window',
        target: { pid: opened.pid, appName: opened.name, bundleId: opened.bundleId || bundleId || '' },
        mode: 'foreground',
      }, signal)
    }, 'foreground-visual')
  }

  private async focusApp(args: Record<string, unknown>, signal?: AbortSignal): Promise<McpLocalToolResult> {
    const driver = this.requireDriver()
    const pid = Math.floor(numberArg(args.pid, 'pid'))
    const bundleId = stringArg(args.bundle_id, 'bundle_id')
    const appName = stringArg(args.app_name, 'app_name')
    this.assertActionRisk('focus_app', args)
    const target = (await driver.listApps(signal)).find(app => app.pid === pid)
    assertOperationActive(signal)
    if (!target || target.bundleId !== bundleId || target.name !== appName) throw new Error('Application identity changed; list applications again')
    this.assertAppAllowed(target)
    return this.withActivity('focus_app', args, async () => {
      await driver.activateApp({ pid, bundleId, name: appName }, signal)
      assertOperationActive(signal)
      await abortableDelay(ACTION_SETTLE_MS, signal)
      return this.captureObservation({ scope: 'window', target: { pid, appName, bundleId }, mode: 'foreground' }, signal)
    }, 'foreground-visual')
  }

  private async click(args: Record<string, unknown>, count: 1 | 2, signal?: AbortSignal): Promise<McpLocalToolResult> {
    const driver = this.requireDriver()
    const operation: ComputerToolOperation = count === 2 ? 'double_click' : 'click'
    const observation = await this.prepareAction(operation, args, signal)
    const expectedTarget = expectedObservationTarget(observation)
    const semanticAction = typeof args.ref === 'string' && args.ref.trim().length > 0
    return this.withActivity(operation, args, async () => {
      if (typeof args.ref === 'string' && args.ref.trim()) {
        const element = requireObservationElement(observation, stringArg(args.ref, 'ref'))
        if (element.secure) throw new Error('Secure controls require user takeover')
        await driver.pressElement(element.ref, { role: element.role, title: element.title }, { expectedTarget }, signal)
        assertOperationActive(signal)
      } else {
        const point = observationPoint(observation, { x: numberArg(args.x, 'x'), y: numberArg(args.y, 'y') })
        await this.assertPointTargetsObservedApp(observation, point, signal)
        await driver.click(point, { button: mouseButton(args.button), count, expectedTarget }, signal)
        assertOperationActive(signal)
      }
      return this.afterAction(observation, signal)
    }, semanticAction ? observation.controlMode : 'foreground-visual')
  }

  private async move(args: Record<string, unknown>, signal?: AbortSignal): Promise<McpLocalToolResult> {
    const driver = this.requireDriver()
    const observation = await this.prepareAction('move', args, signal)
    const expectedTarget = expectedObservationTarget(observation)
    const point = observationPoint(observation, { x: numberArg(args.x, 'x'), y: numberArg(args.y, 'y') })
    await this.assertPointTargetsObservedApp(observation, point, signal)
    return this.withActivity('move', args, async () => {
      await driver.move(point, { expectedTarget }, signal)
      assertOperationActive(signal)
      return this.afterAction(observation, signal)
    }, 'foreground-visual')
  }

  private async drag(args: Record<string, unknown>, signal?: AbortSignal): Promise<McpLocalToolResult> {
    const driver = this.requireDriver()
    const observation = await this.prepareAction('drag', args, signal)
    const expectedTarget = expectedObservationTarget(observation)
    if (!Array.isArray(args.points) || args.points.length < 2 || args.points.length > MAX_DRAG_POINTS) throw new Error(`Drag requires 2-${MAX_DRAG_POINTS} points`)
    const points = args.points.map((value, index) => {
      if (!value || typeof value !== 'object') throw new Error(`Invalid drag point ${index + 1}`)
      const point = value as Record<string, unknown>
      return observationPoint(observation, { x: numberArg(point.x, 'x'), y: numberArg(point.y, 'y') })
    })
    for (const point of [points[0]!, points.at(-1)!]) await this.assertPointTargetsObservedApp(observation, point, signal)
    return this.withActivity('drag', args, async () => {
      await driver.drag(points, { button: mouseButton(args.button), expectedTarget }, signal)
      assertOperationActive(signal)
      return this.afterAction(observation, signal)
    }, 'foreground-visual')
  }

  private async scroll(args: Record<string, unknown>, signal?: AbortSignal): Promise<McpLocalToolResult> {
    const driver = this.requireDriver()
    const observation = await this.prepareAction('scroll', args, signal)
    const expectedTarget = expectedObservationTarget(observation)
    const point = observationPoint(observation, { x: numberArg(args.x, 'x'), y: numberArg(args.y, 'y') })
    await this.assertPointTargetsObservedApp(observation, point, signal)
    const delta = {
      x: Math.max(-4_000, Math.min(4_000, numberArg(args.delta_x || 0, 'delta_x'))),
      y: Math.max(-4_000, Math.min(4_000, numberArg(args.delta_y, 'delta_y'))),
    }
    return this.withActivity('scroll', args, async () => {
      await driver.scroll(point, delta, { expectedTarget }, signal)
      assertOperationActive(signal)
      return this.afterAction(observation, signal)
    }, 'foreground-visual')
  }

  private async typeText(args: Record<string, unknown>, signal?: AbortSignal): Promise<McpLocalToolResult> {
    const driver = this.requireDriver()
    const observation = await this.prepareAction('type_text', args, signal)
    const expectedTarget = expectedObservationTarget(observation)
    const text = assertSafeComputerText(args.text)
    const fieldType = typeof args.field_type === 'string' ? args.field_type.toLowerCase() : 'normal'
    if (['password', 'credential', 'one-time-code', 'otp', 'pin'].includes(fieldType)) {
      throw new Error('Credentials and authentication codes require user takeover')
    }
    const semanticAction = typeof args.ref === 'string' && args.ref.trim().length > 0
    return this.withActivity('type_text', args, async () => {
      if (typeof args.ref === 'string' && args.ref.trim()) {
        const element = requireObservationElement(observation, stringArg(args.ref, 'ref'))
        if (element.secure) throw new Error('Secure text fields require user takeover')
        await driver.setElementValue(element.ref, text, { role: element.role, title: element.title }, { expectedTarget }, signal)
        assertOperationActive(signal)
      } else {
        const native = await this.assertObservedAppStillActive(observation, signal)
        if (native.focusedElement?.secure) throw new Error('Secure text fields require user takeover')
        await driver.typeText(text, observation.activeApp!.pid, { expectedTarget }, signal)
        assertOperationActive(signal)
      }
      return this.afterAction(observation, signal)
    }, semanticAction ? observation.controlMode : 'foreground-visual')
  }

  private async press(args: Record<string, unknown>, signal?: AbortSignal): Promise<McpLocalToolResult> {
    const driver = this.requireDriver()
    const observation = await this.prepareAction('press', args, signal)
    const expectedTarget = expectedObservationTarget(observation)
    const keys = normalizeComputerKeys(args.keys)
    return this.withActivity('press', args, async () => {
      await driver.press(keys, observation.activeApp!.pid, { expectedTarget }, signal)
      assertOperationActive(signal)
      return this.afterAction(observation, signal)
    }, 'foreground-visual')
  }

  private async wait(args: Record<string, unknown>, signal?: AbortSignal): Promise<McpLocalToolResult> {
    const milliseconds = Math.max(100, Math.min(10_000, Math.floor(numberArg(args.milliseconds || 800, 'milliseconds'))))
    const captureOptions = this.captureOptionsFromLatestObservation()
    return this.withActivity('wait', args, async () => {
      await abortableDelay(milliseconds, signal)
      return this.captureObservation(captureOptions, signal)
    }, this.latestControlMode())
  }

  private async assertState(args: Record<string, unknown>, signal?: AbortSignal): Promise<McpLocalToolResult> {
    const condition = stringArg(args.condition, 'condition')
    const expected = stringArg(args.expected, 'expected')
    const captureOptions = this.captureOptionsFromLatestObservation()
    return this.withActivity('assert', args, async () => {
      const result = await this.captureObservation(captureOptions, signal)
      const observation = this.latestObservation()
      let actual = ''
      let passed = false
      if (condition === 'active_app') {
        actual = observation.activeApp?.name || ''
        passed = actual.toLowerCase() === expected.toLowerCase()
      } else if (condition === 'window_title_contains') {
        actual = observation.activeWindow?.title || ''
        passed = actual.toLowerCase().includes(expected.toLowerCase())
      } else {
        const ref = stringArg(args.ref, 'ref')
        const element = observation.elements.find(item => item.ref === ref)
        actual = condition === 'element_value_contains' ? element?.value || '' : element?.title || element?.description || ''
        passed = condition === 'element_present' ? Boolean(element) : actual.toLowerCase().includes(expected.toLowerCase())
      }
      result.content = JSON.stringify({ assertion: { condition, expected, actual, passed }, observation: this.publicObservation(observation) }, null, 2)
      return result
    }, this.latestControlMode())
  }

  private async handoff(args: Record<string, unknown>): Promise<ComputerSystemSnapshot> {
    const reason = sanitizeComputerPurpose(args.reason, '需要用户完成受保护步骤')
    this.operations.invalidate(false)
    this.paused = true
    this.handoffActive = true
    this.observations.clear()
    this.sessionActive = true
    this.setActivity({ phase: 'handoff', operation: 'handoff', appName: typeof args.app_name === 'string' ? args.app_name : undefined, description: reason, controlMode: 'takeover', startedAt: Date.now() })
    this.emit({ type: 'handoff-changed', active: true })
    await this.options.pauseRuntime?.()
    return this.getSnapshot()
  }

  private async prepareAction(
    operation: ComputerToolOperation,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ComputerObservation> {
    await this.requireInputPermissions(operation)
    this.assertActionRisk(operation, args)
    const observationId = stringArg(args.observation_id, 'observation_id')
    const observation = this.observations.requireFresh(observationId)
    if (!observation.activeApp || !observation.activeWindow) throw new Error('The observation has no controllable foreground application')
    const appName = stringArg(args.app_name, 'app_name')
    const bundleId = stringArg(args.bundle_id, 'bundle_id')
    assertObservationIdentity(observation, appName, bundleId)
    this.assertAppAllowed(observation.activeApp)
    const elementRef = typeof args.ref === 'string' ? args.ref.trim() : ''
    const element = elementRef
      ? observation.elements.find(item => item.ref === elementRef)
      : undefined
    if (element?.secure) {
      throw new Error(operation === 'type_text'
        ? 'Secure text fields require user takeover'
        : 'Secure controls require user takeover')
    }
    this.assertActionRisk(operation, element
      ? {
          ...args,
          element_title: element.title,
          element_description: element.description,
          secure: element.secure,
        }
      : args)
    const semanticAction = Boolean(element) && (operation === 'click' || operation === 'type_text')
    if (observation.controlMode === 'background-semantic') {
      if (!semanticAction) {
        throw new Error('This action needs the application in front; focus it and observe again in foreground mode')
      }
      await this.assertObservedTargetStillAvailable(observation, signal)
    } else {
      await this.assertObservedAppStillActive(observation, signal)
    }
    assertOperationActive(signal)
    this.observations.delete(observationId)
    return observation
  }

  private assertActionRisk(operation: ComputerToolOperation, args: Record<string, unknown>): void {
    const toolName = `computer__${operation}`
    if (!computerActionRequiresHandoff(toolName, args)) return
    const safetyClass = inferComputerActionSafetyClass(toolName, args)
    if (safetyClass === 'payment') throw new Error('Payments and financial transactions require user takeover')
    if (safetyClass === 'system') throw new Error('Administrator approval and system permissions require user takeover')
    throw new Error('Credentials and authentication codes require user takeover')
  }

  private async assertObservedAppStillActive(observation: ComputerObservation, signal?: AbortSignal): Promise<ComputerNativeSnapshot> {
    const driver = this.requireDriver()
    const current = await driver.nativeSnapshot({ includeElements: false, signal })
    assertOperationActive(signal)
    this.lastNative = current
    if (!current.frontmostApp || current.frontmostApp.pid !== observation.activeApp?.pid || current.frontmostApp.bundleId !== observation.activeApp?.bundleId) {
      throw new Error('The foreground application changed; observe it again before acting')
    }
    if (current.focusedWindow?.id !== observation.activeWindow?.id) {
      throw new Error('The active window changed; observe it again before acting')
    }
    return current
  }

  private async assertObservedTargetStillAvailable(observation: ComputerObservation, signal?: AbortSignal): Promise<ComputerNativeSnapshot> {
    const activeApp = observation.activeApp
    const activeWindow = observation.activeWindow
    if (!activeApp?.bundleId || !activeWindow) throw new Error('The observation has no stable application target; observe again')
    const current = await this.requireDriver().nativeSnapshot({
      includeElements: false,
      target: { pid: activeApp.pid, bundleId: activeApp.bundleId, windowId: activeWindow.id },
      signal,
    })
    assertOperationActive(signal)
    this.lastNative = current
    if (!current.targetApp || current.targetApp.pid !== activeApp.pid || current.targetApp.bundleId !== activeApp.bundleId) {
      throw new Error('The target application closed or changed; observe again')
    }
    if (!current.targetWindow || current.targetWindow.id !== activeWindow.id) {
      throw new Error('The target window closed or changed; observe again')
    }
    return current
  }

  private async assertPointTargetsObservedApp(observation: ComputerObservation, point: ComputerPoint, signal?: AbortSignal): Promise<void> {
    assertPointOutsideProtectedRegions(observation, point)
    const owner = await this.requireDriver().pointOwner(point, signal)
    assertOperationActive(signal)
    if (!owner) throw new Error('No safe application window owns the target point')
    if (owner.pid === process.pid) throw new Error('TurboFlux cannot click its own window')
    if (owner.pid !== observation.activeApp?.pid || owner.bundleId !== observation.activeApp?.bundleId) {
      throw new Error(`The target is owned by ${owner.appName}, not the observed application`)
    }
  }

  private async afterAction(observation: ComputerObservation, signal?: AbortSignal): Promise<McpLocalToolResult> {
    await abortableDelay(ACTION_SETTLE_MS, signal)
    return this.captureObservation({
      scope: 'window',
      target: observation.activeApp?.bundleId ? {
        pid: observation.activeApp.pid,
        appName: observation.activeApp.name,
        bundleId: observation.activeApp.bundleId,
        windowId: observation.activeWindow?.id,
      } : undefined,
      mode: observation.controlMode === 'background-semantic' ? 'auto' : 'foreground',
    }, signal)
  }

  private async captureObservation(options: CaptureObservationOptions, signal?: AbortSignal): Promise<McpLocalToolResult> {
    const driver = this.requireDriver()
    assertOperationActive(signal)
    await this.captureCleanup
    assertOperationActive(signal)
    const requestedMode = options.mode || 'auto'
    const initialMode: ComputerControlMode = requestedMode === 'foreground' || !options.target
      ? 'foreground-visual'
      : 'background-semantic'
    return this.withActivity('observe', { app_name: options.target?.appName }, async () => {
      if (!options.target || requestedMode === 'foreground') await this.ensurePermission('screen-recording', 'observe')
      let native = await driver.nativeSnapshot({
        includeElements: true,
        target: options.target ? { pid: options.target.pid, bundleId: options.target.bundleId, windowId: options.target.windowId } : undefined,
        signal,
      })
      assertOperationActive(signal)
      this.lastNative = native
      if (options.target && requestedMode !== 'foreground' && !native.accessibilityTrusted) {
        await this.ensurePermission('accessibility', 'observe')
        native = await driver.nativeSnapshot({
          includeElements: true,
          target: { pid: options.target.pid, bundleId: options.target.bundleId, windowId: options.target.windowId },
          signal,
        })
        assertOperationActive(signal)
      }
      let activeApp = options.target ? native.targetApp : native.frontmostApp
      let activeWindow = options.target ? native.targetWindow : native.focusedWindow
      if (!activeApp) throw new Error(options.target ? 'The target application is unavailable' : 'No foreground application is available to observe')
      this.assertAppAllowed(activeApp)
      let foreground = this.matchesForegroundTarget(native, activeApp, activeWindow)
      let controlMode: Exclude<ComputerControlMode, 'takeover'> = 'foreground-visual'
      const canUseBackground = Boolean(options.target
        && (requestedMode === 'background' || !foreground)
        && activeWindow
        && native.accessibilityTrusted
        && native.elements.length > 0)

      if (canUseBackground && requestedMode !== 'foreground') {
        controlMode = 'background-semantic'
      } else if (options.target && !foreground) {
        if (requestedMode === 'background') {
          throw new Error('This application does not expose enough background controls; use foreground mode')
        }
        await driver.activateApp({ pid: options.target.pid, bundleId: options.target.bundleId, name: options.target.appName }, signal)
        assertOperationActive(signal)
        await abortableDelay(ACTION_SETTLE_MS, signal)
        native = await driver.nativeSnapshot({
          includeElements: true,
          target: { pid: options.target.pid, bundleId: options.target.bundleId, windowId: options.target.windowId },
          signal,
        })
        activeApp = native.targetApp || native.frontmostApp
        activeWindow = native.targetWindow || native.focusedWindow
        foreground = this.matchesForegroundTarget(native, activeApp, activeWindow)
        if (!foreground) throw new Error('The target application could not be brought to the foreground')
      }

      if (!activeApp) throw new Error('The target application became unavailable')
      this.lastNative = native
      this.updateCurrentActivity(controlMode, activeApp.name)
      const capturedAt = Date.now()
      const frameId = `computer-${capturedAt.toString(36)}-${randomUUID().slice(0, 8)}`
      let image: ComputerObservation['image']
      let coordinateSpace: ComputerObservation['coordinateSpace']
      let protectedRegions: ComputerBounds[] = []

      if (controlMode === 'foreground-visual') {
        await this.ensurePermission('screen-recording', 'observe')
        const displays = screen.getAllDisplays()
        const selectedDisplay = this.selectDisplay(displays, options.displayId, activeWindow || native.focusedWindow)
        const logicalRegion = options.scope === 'window' && activeWindow
          ? intersectBounds(activeWindow.bounds, selectedDisplay.bounds)
          : { ...selectedDisplay.bounds }
        if (!logicalRegion || logicalRegion.width < 2 || logicalRegion.height < 2) throw new Error('The target window is not visible on the selected display')
        const captured = await this.captureDisplay(selectedDisplay, logicalRegion, native, options.scope)
        assertOperationActive(signal)
        const directory = this.captureDirectory()
        await mkdir(directory, { recursive: true })
        await this.cleanupCaptures(directory)
        assertOperationActive(signal)
        const filename = `${frameId}.png`
        const path = join(directory, filename)
        const png = captured.image.toPNG()
        await writeFile(path, png, { mode: 0o600 })
        assertOperationActive(signal)
        const evidenceDirectory = this.storageRoot
          ? join(this.storageRoot, 'captures', 'computer-evidence')
          : join(this.workspacePath, '.turboflux', 'visual-evidence', 'computer')
        await mkdir(evidenceDirectory, { recursive: true })
        const evidencePath = join(evidenceDirectory, filename)
        await writeFile(evidencePath, png, { mode: 0o600 })
        assertOperationActive(signal)
        const size = captured.image.getSize()
        image = { id: `${frameId}-image`, type: 'image', path, mime: 'image/png', filename, size: png.length, width: size.width, height: size.height }
        this.emit({
          type: 'artifact-ready',
          path: evidencePath,
          name: filename,
          mime: 'image/png',
          capturedAt,
          observationId: frameId,
          appName: activeApp.name,
          windowTitle: activeWindow?.title || '',
        })
        coordinateSpace = {
          frameId,
          displayId: String(selectedDisplay.id),
          capturedAt,
          logicalBounds: logicalRegion,
          pixelSize: { width: size.width, height: size.height },
          scaleFactor: size.width / logicalRegion.width,
        }
        protectedRegions = this.protectedRegions(native, logicalRegion, options.scope)
      } else {
        if (!activeWindow) throw new Error('The target application has no usable background window')
        coordinateSpace = {
          frameId,
          displayId: String(this.selectDisplay(screen.getAllDisplays(), options.displayId, activeWindow).id),
          capturedAt,
          logicalBounds: { ...activeWindow.bounds },
          pixelSize: { width: activeWindow.bounds.width, height: activeWindow.bounds.height },
          scaleFactor: 1,
        }
      }

      const observation: ComputerObservation = {
        frameId,
        capturedAt,
        expiresAt: capturedAt + COMPUTER_OBSERVATION_TTL_MS,
        displayId: coordinateSpace.displayId,
        scope: options.scope,
        coordinateSpace,
        image,
        controlMode,
        activeApp: { ...activeApp },
        activeWindow: activeWindow ? { ...activeWindow, bounds: { ...activeWindow.bounds } } : undefined,
        elements: native.elements.map(element => ({ ...element, bounds: element.bounds ? { ...element.bounds } : undefined })),
        protectedRegions,
      }
      this.rememberObservation(observation)
      this.emitState()
      return this.observationResult(observation)
    }, initialMode)
  }

  private matchesForegroundTarget(
    native: ComputerNativeSnapshot,
    app: ComputerAppSnapshot | null | undefined,
    window: ComputerWindowSnapshot | null | undefined,
  ): boolean {
    return Boolean(app && window
      && native.frontmostApp?.pid === app.pid
      && native.frontmostApp.bundleId === app.bundleId
      && native.focusedWindow?.id === window.id)
  }

  private async captureDisplay(
    display: Display,
    region: ComputerBounds,
    native: ComputerNativeSnapshot,
    scope: 'window' | 'display',
  ): Promise<{ image: NativeImage }> {
    await this.options.beforeVisualCapture?.()
    let sourceImage: NativeImage
    try {
      const sourceSize = this.captureSourceSize(display)
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: sourceSize, fetchWindowIcons: false })
      const source = sources.find(candidate => candidate.display_id === String(display.id))
        || sources[screen.getAllDisplays().findIndex(item => item.id === display.id)]
      if (!source || source.thumbnail.isEmpty()) throw new Error('Unable to capture the selected display')
      sourceImage = source.thumbnail
    } finally {
      await this.options.afterVisualCapture?.()
    }
    const sourceDimensions = sourceImage.getSize()
    const scaleX = sourceDimensions.width / display.bounds.width
    const scaleY = sourceDimensions.height / display.bounds.height
    const crop = {
      x: Math.max(0, Math.round((region.x - display.bounds.x) * scaleX)),
      y: Math.max(0, Math.round((region.y - display.bounds.y) * scaleY)),
      width: Math.min(sourceDimensions.width, Math.max(1, Math.round(region.width * scaleX))),
      height: Math.min(sourceDimensions.height, Math.max(1, Math.round(region.height * scaleY))),
    }
    crop.width = Math.min(crop.width, sourceDimensions.width - crop.x)
    crop.height = Math.min(crop.height, sourceDimensions.height - crop.y)
    let image = sourceImage.crop(crop)
    const redactions = this.visibleProtectedWindowBounds(native, region, scope)
    if (redactions.length > 0) image = this.redactImage(image, region, redactions)
    const imageSize = image.getSize()
    const resizeScale = Math.min(1, MAX_SCREENSHOT_WIDTH / imageSize.width, MAX_SCREENSHOT_HEIGHT / imageSize.height)
    if (resizeScale < 1) {
      image = image.resize({ width: Math.max(1, Math.round(imageSize.width * resizeScale)), height: Math.max(1, Math.round(imageSize.height * resizeScale)), quality: 'best' })
    }
    return { image }
  }

  private captureSourceSize(display: Display): { width: number; height: number } {
    const nativeWidth = Math.max(1, Math.round(display.bounds.width * display.scaleFactor))
    const nativeHeight = Math.max(1, Math.round(display.bounds.height * display.scaleFactor))
    const scale = Math.min(1, 2_560 / nativeWidth, 1_600 / nativeHeight)
    return { width: Math.round(nativeWidth * scale), height: Math.round(nativeHeight * scale) }
  }

  private redactImage(image: NativeImage, region: ComputerBounds, redactions: ComputerBounds[]): NativeImage {
    const size = image.getSize()
    const bitmap = image.toBitmap()
    const scaleX = size.width / region.width
    const scaleY = size.height / region.height
    for (const redaction of redactions) {
      const intersection = intersectBounds(region, redaction)
      if (!intersection) continue
      const startX = Math.max(0, Math.floor((intersection.x - region.x) * scaleX))
      const startY = Math.max(0, Math.floor((intersection.y - region.y) * scaleY))
      const endX = Math.min(size.width, Math.ceil((intersection.x + intersection.width - region.x) * scaleX))
      const endY = Math.min(size.height, Math.ceil((intersection.y + intersection.height - region.y) * scaleY))
      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const offset = (y * size.width + x) * 4
          bitmap[offset] = 242
          bitmap[offset + 1] = 242
          bitmap[offset + 2] = 240
          bitmap[offset + 3] = 255
        }
      }
    }
    return nativeImage.createFromBitmap(bitmap, size)
  }

  private visibleProtectedWindowBounds(
    native: ComputerNativeSnapshot,
    region: ComputerBounds,
    scope: 'window' | 'display',
  ): ComputerBounds[] {
    const targetIndex = native.focusedWindow ? native.windows.findIndex(window => window.id === native.focusedWindow!.id) : -1
    return native.windows
      .map((window, index) => ({ window, index }))
      .filter(({ window, index }) => {
        const reason = protectedComputerAppReason({
          pid: window.pid,
          bundleId: window.bundleId,
          name: window.appName,
        }, process.pid)
        if (!reason || window.onscreen === false) return false
        return scope === 'display' || targetIndex < 0 || index < targetIndex
      })
      .map(({ window }) => intersectBounds(window.bounds, region))
      .filter((bounds): bounds is ComputerBounds => Boolean(bounds))
  }

  private protectedRegions(
    native: ComputerNativeSnapshot,
    region: ComputerBounds,
    scope: 'window' | 'display',
  ): ComputerBounds[] {
    return this.visibleProtectedWindowBounds(native, region, scope)
  }

  private selectDisplay(displays: Display[], requestedId: string | undefined, focusedWindow: ComputerWindowSnapshot | null): Display {
    if (requestedId) {
      const requested = displays.find(display => String(display.id) === requestedId)
      if (!requested) throw new Error(`Display not found: ${requestedId}`)
      return requested
    }
    if (focusedWindow) {
      const center = {
        x: Math.round(focusedWindow.bounds.x + focusedWindow.bounds.width / 2),
        y: Math.round(focusedWindow.bounds.y + focusedWindow.bounds.height / 2),
      }
      return screen.getDisplayNearestPoint(center)
    }
    return screen.getPrimaryDisplay()
  }

  private observationResult(observation: ComputerObservation): McpLocalToolResult {
    const attachments: AgentAttachment[] = observation.image ? [{
      id: observation.image.id,
      type: 'image',
      path: observation.image.path,
      mime: observation.image.mime,
      filename: observation.image.filename,
      size: observation.image.size,
    }] : []
    return {
      kind: 'local_tool_result',
      content: JSON.stringify({
        observation: this.publicObservation(observation),
        instruction: observation.controlMode === 'background-semantic'
          ? 'This is a background semantic observation with no screenshot. Use only Accessibility refs with click or type_text. If visual or coordinate interaction is needed, focus the application and observe again in foreground mode.'
          : 'Inspect the attached current application image. Prefer Accessibility refs. This observation expires quickly and is consumed by the next action; use the new observation_id returned after every action.',
      }, null, 2),
      attachments,
    }
  }

  private publicObservation(observation: ComputerObservation): unknown {
    return {
      observation_id: observation.frameId,
      captured_at: new Date(observation.capturedAt).toISOString(),
      expires_at: new Date(observation.expiresAt).toISOString(),
      scope: observation.scope,
      control_mode: observation.controlMode,
      display_id: observation.displayId,
      screenshot: observation.image ? { width: observation.image.width, height: observation.image.height } : undefined,
      coordinate_space: observation.coordinateSpace,
      app: observation.activeApp,
      window: observation.activeWindow,
      elements: observation.elements.map(element => ({
        ref: element.ref,
        role: element.role,
        subrole: element.subrole,
        title: element.title,
        description: element.description,
        value: element.secure ? undefined : element.value,
        enabled: element.enabled,
        focused: element.focused,
        secure: element.secure,
        bounds: element.bounds,
      })),
      protected_regions: observation.protectedRegions,
    }
  }

  private latestObservation(): ComputerObservation {
    return this.observations.latest()
  }

  private latestControlMode(): Exclude<ComputerControlMode, 'takeover'> {
    return this.observations.latestControlMode()
  }

  private captureOptionsFromLatestObservation(): CaptureObservationOptions {
    const observation = this.observations.latestOrUndefined()
    if (!observation) return { scope: 'window', mode: 'foreground' }
    return {
      scope: observation.scope,
      displayId: observation.displayId,
      target: observation.activeApp?.bundleId ? {
        pid: observation.activeApp.pid,
        appName: observation.activeApp.name,
        bundleId: observation.activeApp.bundleId,
        windowId: observation.activeWindow?.id,
      } : undefined,
      mode: observation.controlMode === 'background-semantic' ? 'auto' : 'foreground',
    }
  }

  private rememberObservation(observation: ComputerObservation): void {
    this.observations.remember(observation)
  }

  private async cleanupCaptures(directory: string): Promise<void> {
    let entries: string[]
    try {
      entries = (await readdir(directory)).filter(name => /^computer-[\w-]+\.png$/.test(name))
    } catch {
      return
    }
    const files = await Promise.all(entries.map(async name => {
      const path = join(directory, name)
      const info = await stat(path).catch(() => null)
      return info?.isFile() ? { path, mtime: info.mtimeMs } : null
    }))
    const ordered = files.filter((file): file is { path: string; mtime: number } => Boolean(file)).sort((left, right) => right.mtime - left.mtime)
    const now = Date.now()
    await Promise.all(ordered
      .filter((file, index) => index >= MAX_CAPTURE_FILES || now - file.mtime > MAX_CAPTURE_AGE_MS)
      .map(file => unlink(file.path).catch(() => {})))
  }

  private captureDirectory(): string {
    return this.storageRoot
      ? join(this.storageRoot, 'captures', 'computer')
      : join(this.workspacePath, '.turboflux', 'computer-captures')
  }

  private async clearCaptureDirectory(directory: string): Promise<void> {
    let entries: string[]
    try {
      entries = (await readdir(directory)).filter(name => /^computer-[\w-]+\.png$/.test(name))
    } catch {
      return
    }
    await Promise.all(entries.map(name => unlink(join(directory, name)).catch(() => {})))
  }

  private assertAppAllowed(app: ComputerAppSnapshot): void {
    const reason = protectedComputerAppReason(app, process.pid)
    if (reason) throw new Error(reason)
  }

  private async requireInputPermissions(operation: ComputerToolOperation): Promise<void> {
    const permissions = this.permissionSnapshot()
    if (permissions.accessibility.state !== 'granted') await this.ensurePermission('accessibility', operation)
    if (permissions.postEvent.state !== 'granted') await this.ensurePermission('post-event', operation)
  }

  private async ensurePermission(kind: ComputerPermissionKind, operation: ComputerToolOperation): Promise<void> {
    const key = kind === 'screen-recording' ? 'screenRecording' : kind === 'post-event' ? 'postEvent' : 'accessibility'
    if (this.permissionSnapshot()[key].state === 'granted') return
    const requirement: ComputerPermissionRequirement = {
      kind,
      operation,
      message: `${kind === 'screen-recording' ? '屏幕录制' : kind === 'accessibility' ? '辅助功能' : '输入控制'}权限是完成这一步所必需的`,
      requestedAt: Date.now(),
    }
    this.permissionRequirement = requirement
    this.emit({ type: 'permission-required', requirement })
    this.emitState()
    if (!this.options.requestPermission) throw this.permissionError(kind, requirement.message)
    if (!this.permissionRequest) {
      this.permissionRequest = this.options.requestPermission(kind, operation)
        .then(result => typeof result === 'boolean' ? result : result.outcome === 'granted')
        .finally(() => { this.permissionRequest = undefined })
    }
    const granted = await this.permissionRequest
    if (granted) await this.refresh()
    if (!granted || this.permissionSnapshot()[key].state !== 'granted') {
      throw this.permissionError(kind, `${requirement.message}，请在系统设置完成授权后重试`)
    }
    this.permissionRequirement = undefined
    this.lastError = undefined
    this.emitState()
  }

  private permissionError(kind: ComputerPermissionKind, message: string): Error & { code?: string; permission?: string } {
    const label = kind === 'screen-recording' ? 'Screen Recording permission is required' : kind === 'accessibility' ? 'Accessibility permission is required' : 'Input control permission is required'
    const error = new Error(`${label} · ${message}`) as Error & { code?: string; permission?: string }
    error.code = 'permission-required'
    error.permission = kind
    return error
  }

  private requireDriver(): ComputerDriver {
    if (!this.driver) throw new Error(`Computer control is not available on ${process.platform}`)
    return this.driver
  }

  private assertNotPaused(): void {
    if (this.paused || this.runtimePaused) throw new Error(this.handoffActive ? 'Computer control is paused for user takeover' : 'Computer control is paused')
  }

  private enqueueTool<T>(
    toolName: ComputerToolOperation,
    args: Record<string, unknown>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    return this.operations.enqueue(async signal => {
      try {
        assertOperationActive(signal)
        if (!['status', 'list_apps'].includes(toolName) && this.options.acquireControl && !await this.options.acquireControl()) {
          throw new Error('另一个对话正在使用电脑操控，请等待它完成或停止后再继续')
        }
        this.lastError = undefined
        const result = await this.handleTool(toolName, args, signal)
        assertOperationActive(signal)
        return result as T
      } catch (error) {
        if (signal.aborted || isOperationAbort(error)) throw computerOperationAbortError()
        const code = (error as { code?: string })?.code
        const permission = (error as { permission?: ComputerPermissionKind })?.permission
        const snapshot: ComputerErrorSnapshot = {
          code: code === 'permission-required' ? 'permission-required' : 'operation-failed',
          message: error instanceof Error ? error.message : String(error),
          operation: toolName,
          permission,
          recoverable: code === 'permission-required',
          occurredAt: Date.now(),
        }
        this.lastError = snapshot
        this.emit({ type: 'error', error: snapshot })
        this.emitState()
        throw error
      }
    }, { externalSignal, allowEpochChange: toolName === 'handoff' })
  }

  private async withActivity<T>(
    operation: ComputerToolOperation,
    args: Record<string, unknown>,
    work: () => Promise<T>,
    controlMode?: ComputerControlMode,
  ): Promise<T> {
    const fallbackDescription = defaultActivityDescription(operation)
    const activity: ComputerActivitySnapshot = {
      phase: operation === 'observe' ? 'observing' : operation === 'wait' ? 'waiting' : operation === 'handoff' ? 'handoff' : 'acting',
      operation,
      appName: typeof args.app_name === 'string' ? args.app_name.trim().slice(0, 80) : this.lastNative?.frontmostApp?.name,
      description: operation === 'type_text' || operation === 'press'
        ? fallbackDescription
        : sanitizeComputerPurpose(args.description, fallbackDescription),
      controlMode,
      startedAt: Date.now(),
    }
    this.sessionActive = true
    this.setActivity(activity)
    try {
      const result = await work()
      return result
    } finally {
      if (!this.handoffActive && this.activity === activity) this.setActivity(undefined)
    }
  }

  private updateCurrentActivity(controlMode: ComputerControlMode, appName?: string): void {
    if (!this.activity) return
    this.setActivity({ ...this.activity, controlMode, appName: appName || this.activity.appName })
  }

  private setActivity(activity: ComputerActivitySnapshot | undefined): void {
    this.activity = activity
    this.emit({ type: 'activity-changed', activity: activity ? { ...activity } : undefined })
    this.emitState()
  }

  private emitState(): void {
    this.emit({ type: 'state', snapshot: this.getSnapshot() })
  }
}
