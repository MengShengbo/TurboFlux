import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type {
  ComputerAccessibilityElement,
  ComputerAppSnapshot,
  ComputerWindowSnapshot,
} from '@turboflux/contracts'
import type { McpClient, McpLocalServerDefinition, McpLocalToolResult } from '@turboflux/extensions'
import type {
  ComputerDriver,
  ComputerExpectedTarget,
  ComputerMouseButton,
  ComputerNativeSnapshot,
  ComputerPointOwner,
} from './computerDriver'

const electronMocks = vi.hoisted(() => {
  class MockNativeImage {
    constructor(private readonly width: number, private readonly height: number) {}

    isEmpty(): boolean {
      return false
    }

    getSize(): { width: number; height: number } {
      return { width: this.width, height: this.height }
    }

    crop(bounds: { width: number; height: number }): MockNativeImage {
      return new MockNativeImage(bounds.width, bounds.height)
    }

    resize(bounds: { width: number; height: number }): MockNativeImage {
      return new MockNativeImage(bounds.width, bounds.height)
    }

    toPNG(): Buffer {
      return Buffer.from('mock-png')
    }

    toBitmap(): Buffer {
      return Buffer.alloc(this.width * this.height * 4)
    }
  }

  const display = {
    id: 7,
    label: 'Retina Left',
    bounds: { x: -800, y: -200, width: 800, height: 500 },
    workArea: { x: -800, y: -200, width: 800, height: 480 },
    scaleFactor: 2,
  }
  const state = { mediaStatus: 'granted', accessibilityTrusted: false }
  const getSources = vi.fn(async () => [{
    display_id: String(display.id),
    thumbnail: new MockNativeImage(1_600, 1_000),
  }])

  return {
    display,
    state,
    getSources,
    openExternal: vi.fn(async () => {}),
    createFromBitmap: vi.fn((_bitmap: Buffer, size: { width: number; height: number }) => (
      new MockNativeImage(size.width, size.height)
    )),
  }
})

vi.mock('electron', () => ({
  BrowserWindow: class {},
  desktopCapturer: { getSources: electronMocks.getSources },
  nativeImage: { createFromBitmap: electronMocks.createFromBitmap },
  screen: {
    getAllDisplays: () => [electronMocks.display],
    getPrimaryDisplay: () => electronMocks.display,
    getDisplayNearestPoint: () => electronMocks.display,
  },
  shell: { openExternal: electronMocks.openExternal },
  systemPreferences: {
    getMediaAccessStatus: () => electronMocks.state.mediaStatus,
    isTrustedAccessibilityClient: () => electronMocks.state.accessibilityTrusted,
  },
  app: { getAppPath: () => '/mock/TurboFlux', getPath: () => tmpdir(), isPackaged: false },
}))

import { ComputerSystem, type ComputerSystemOptions, type DesktopComputerSystemEvent } from './computerSystem'

const PAGES_APP: ComputerAppSnapshot = {
  pid: 1_001,
  name: 'Pages',
  bundleId: 'com.apple.Pages',
  active: true,
}

const PAGES_WINDOW: ComputerWindowSnapshot = {
  id: 81,
  pid: PAGES_APP.pid,
  appName: PAGES_APP.name,
  bundleId: PAGES_APP.bundleId,
  title: 'Draft',
  bounds: { ...electronMocks.display.bounds },
  layer: 0,
  onscreen: true,
  focused: true,
}

const DEFAULT_ELEMENTS: ComputerAccessibilityElement[] = [
  {
    ref: 'button-save',
    role: 'AXButton',
    title: 'Save',
    enabled: true,
    focused: false,
    secure: false,
    bounds: { x: -760, y: -160, width: 80, height: 32 },
  },
  {
    ref: 'text-body',
    role: 'AXTextArea',
    title: 'Document',
    value: 'Draft',
    enabled: true,
    focused: true,
    secure: false,
    bounds: { x: -700, y: -100, width: 600, height: 300 },
  },
  {
    ref: 'secure-input',
    role: 'AXSecureTextField',
    title: 'Password',
    enabled: true,
    focused: false,
    secure: true,
    bounds: { x: -700, y: 220, width: 240, height: 32 },
  },
]

class MockComputerDriver implements ComputerDriver {
  readonly platform = 'darwin' as const
  accessibilityGranted = true
  postEventGranted = true
  frontmostApp: ComputerAppSnapshot | null = { ...PAGES_APP }
  focusedWindow: ComputerWindowSnapshot | null = { ...PAGES_WINDOW, bounds: { ...PAGES_WINDOW.bounds } }
  focusedElement: ComputerNativeSnapshot['focusedElement'] = {
    role: 'AXTextArea',
    title: 'Document',
    secure: false,
  }
  windows: ComputerWindowSnapshot[] = [{ ...PAGES_WINDOW, bounds: { ...PAGES_WINDOW.bounds } }]
  elements = DEFAULT_ELEMENTS.map(element => ({ ...element, bounds: element.bounds ? { ...element.bounds } : undefined }))
  pointOwnerOverride: ComputerPointOwner | null | undefined
  listAppsImpl: ((signal?: AbortSignal) => Promise<ComputerAppSnapshot[]>) | undefined
  nativeSnapshotError: Error | undefined
  nativeSnapshotCalls = 0
  listAppsCalls = 0
  activateAppCalls: Array<{ pid?: number; bundleId?: string; name?: string }> = []
  openAppCalls: Array<{ bundleId?: string; name?: string }> = []
  pointOwnerCalls: Array<{ x: number; y: number }> = []
  clickCalls: Array<{ point: { x: number; y: number }; button?: ComputerMouseButton; count?: 1 | 2 }> = []
  moveCalls: Array<{ x: number; y: number }> = []
  dragCalls: Array<Array<{ x: number; y: number }>> = []
  scrollCalls: Array<{ point: { x: number; y: number }; delta: { x: number; y: number } }> = []
  pressCalls: Array<{ keys: string[]; targetPid: number }> = []
  typeTextCalls: Array<{ text: string; targetPid: number }> = []
  pressElementCalls: string[] = []
  setElementValueCalls: Array<{ ref: string; text: string }> = []
  expectedTargetCalls: Array<{ operation: string; target: ComputerExpectedTarget }> = []
  accessibilityRequestCalls = 0
  postEventRequestCalls = 0

  async requestAccessibilityAccess(): Promise<boolean> {
    this.accessibilityRequestCalls += 1
    return this.accessibilityGranted
  }

  async requestPostEventAccess(): Promise<boolean> {
    this.postEventRequestCalls += 1
    return this.postEventGranted
  }

  async nativeSnapshot(options: {
    includeElements?: boolean
    target?: { pid: number; bundleId?: string; windowId?: number }
    signal?: AbortSignal
  } = {}): Promise<ComputerNativeSnapshot> {
    if (options.signal?.aborted) throw new Error('Computer operation aborted')
    this.nativeSnapshotCalls += 1
    if (this.nativeSnapshotError) throw this.nativeSnapshotError
    return {
      accessibilityTrusted: this.accessibilityGranted,
      postEventTrusted: this.postEventGranted,
      frontmostApp: this.frontmostApp ? { ...this.frontmostApp } : null,
      focusedWindow: this.focusedWindow
        ? { ...this.focusedWindow, bounds: { ...this.focusedWindow.bounds } }
        : null,
      targetApp: options.target?.pid === PAGES_APP.pid ? { ...PAGES_APP, active: this.frontmostApp?.pid === PAGES_APP.pid } : null,
      targetWindow: options.target?.pid === PAGES_APP.pid
        ? { ...PAGES_WINDOW, bounds: { ...PAGES_WINDOW.bounds }, focused: this.frontmostApp?.pid === PAGES_APP.pid }
        : null,
      focusedElement: this.focusedElement ? { ...this.focusedElement } : undefined,
      windows: this.windows.map(window => ({ ...window, bounds: { ...window.bounds } })),
      elements: options.includeElements
        ? this.elements.map(element => ({ ...element, bounds: element.bounds ? { ...element.bounds } : undefined }))
        : [],
    }
  }

  async listApps(signal?: AbortSignal): Promise<ComputerAppSnapshot[]> {
    if (signal?.aborted) throw new Error('Computer operation aborted')
    this.listAppsCalls += 1
    if (this.listAppsImpl) return this.listAppsImpl(signal)
    return this.frontmostApp ? [{ ...this.frontmostApp }] : []
  }

  async activateApp(target: { pid?: number; bundleId?: string; name?: string }): Promise<ComputerAppSnapshot> {
    this.activateAppCalls.push({ ...target })
    const app = {
      ...PAGES_APP,
      pid: target.pid || PAGES_APP.pid,
      bundleId: target.bundleId || PAGES_APP.bundleId,
      name: target.name || PAGES_APP.name,
    }
    this.frontmostApp = app
    if (app.pid === PAGES_APP.pid) this.focusedWindow = { ...PAGES_WINDOW, bounds: { ...PAGES_WINDOW.bounds } }
    return { ...app }
  }

  async openApp(target: { bundleId?: string; name?: string }): Promise<ComputerAppSnapshot> {
    this.openAppCalls.push({ ...target })
    return this.activateApp({ bundleId: target.bundleId, name: target.name })
  }

  async pointOwner(point: { x: number; y: number }, signal?: AbortSignal): Promise<ComputerPointOwner | null> {
    if (signal?.aborted) throw new Error('Computer operation aborted')
    this.pointOwnerCalls.push({ ...point })
    if (this.pointOwnerOverride !== undefined) return this.pointOwnerOverride
    return {
      pid: PAGES_APP.pid,
      bundleId: PAGES_APP.bundleId,
      appName: PAGES_APP.name,
      windowId: PAGES_WINDOW.id,
      bounds: { ...PAGES_WINDOW.bounds },
    }
  }

  async click(point: { x: number; y: number }, options: { button?: ComputerMouseButton; count?: 1 | 2; expectedTarget: ComputerExpectedTarget }): Promise<void> {
    this.expectedTargetCalls.push({ operation: 'click', target: options.expectedTarget })
    this.clickCalls.push({ point: { ...point }, button: options.button, count: options.count })
  }

  async move(point: { x: number; y: number }, options: { expectedTarget: ComputerExpectedTarget }): Promise<void> {
    this.expectedTargetCalls.push({ operation: 'move', target: options.expectedTarget })
    this.moveCalls.push({ ...point })
  }

  async drag(points: Array<{ x: number; y: number }>, options: { button?: ComputerMouseButton; expectedTarget: ComputerExpectedTarget }): Promise<void> {
    this.expectedTargetCalls.push({ operation: 'drag', target: options.expectedTarget })
    this.dragCalls.push(points.map(point => ({ ...point })))
  }

  async scroll(point: { x: number; y: number }, delta: { x: number; y: number }, options: { expectedTarget: ComputerExpectedTarget }): Promise<void> {
    this.expectedTargetCalls.push({ operation: 'scroll', target: options.expectedTarget })
    this.scrollCalls.push({ point: { ...point }, delta: { ...delta } })
  }

  async press(keys: string[], targetPid: number, options: { expectedTarget: ComputerExpectedTarget }): Promise<void> {
    this.expectedTargetCalls.push({ operation: 'press', target: options.expectedTarget })
    this.pressCalls.push({ keys: [...keys], targetPid })
  }

  async typeText(text: string, targetPid: number, options: { expectedTarget: ComputerExpectedTarget }): Promise<void> {
    this.expectedTargetCalls.push({ operation: 'type_text', target: options.expectedTarget })
    this.typeTextCalls.push({ text, targetPid })
  }

  async pressElement(_ref: string, _expected: { role?: string; title?: string }, options: { expectedTarget: ComputerExpectedTarget }): Promise<void> {
    this.expectedTargetCalls.push({ operation: 'press_element', target: options.expectedTarget })
    const ref = _ref
    this.pressElementCalls.push(ref)
  }

  async setElementValue(ref: string, text: string, _expected: { role?: string; title?: string }, options: { expectedTarget: ComputerExpectedTarget }): Promise<void> {
    this.expectedTargetCalls.push({ operation: 'set_element_value', target: options.expectedTarget })
    this.setElementValueCalls.push({ ref, text })
  }
}

interface PublicObservation {
  observation_id: string
  control_mode: 'background-semantic' | 'foreground-visual'
  screenshot?: { width: number; height: number }
  coordinate_space: {
    logicalBounds: { x: number; y: number; width: number; height: number }
    pixelSize: { width: number; height: number }
    scaleFactor: number
  }
  app: { pid: number; name: string; bundleId: string }
  window: { id: number }
  protected_regions: Array<{ x: number; y: number; width: number; height: number }>
}

interface Harness {
  system: ComputerSystem
  driver: MockComputerDriver
  events: DesktopComputerSystemEvent[]
  workspacePath: string
  server: McpLocalServerDefinition
  invoke(toolName: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
}

const cleanups: Array<() => void> = []
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

beforeAll(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
})

afterAll(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
})

beforeEach(() => {
  electronMocks.state.mediaStatus = 'granted'
  electronMocks.state.accessibilityTrusted = false
  electronMocks.getSources.mockClear()
  electronMocks.openExternal.mockClear()
  electronMocks.createFromBitmap.mockClear()
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.useRealTimers()
})

function createHarness(options: ComputerSystemOptions = {}): Harness {
  const workspace = mkdtempSync(join(tmpdir(), 'turboflux-computer-system-'))
  const driver = new MockComputerDriver()
  const events: DesktopComputerSystemEvent[] = []
  const system = new ComputerSystem(
    {} as BrowserWindow,
    workspace,
    event => events.push(event),
    driver,
    options,
  )
  let server: McpLocalServerDefinition | undefined
  system.register({
    registerLocalServer(definition: McpLocalServerDefinition) {
      server = definition
      return {} as never
    },
  } as unknown as McpClient)
  if (!server) throw new Error('Computer local server was not registered')

  cleanups.push(() => {
    system.destroy()
    rmSync(workspace, { recursive: true, force: true })
  })

  return {
    system,
    driver,
    events,
    workspacePath: workspace,
    server,
    invoke: (toolName, args = {}, signal) => server!.handler(toolName, args, { signal }),
  }
}

function publicObservation(result: unknown): PublicObservation {
  const localResult = result as McpLocalToolResult
  const content = JSON.parse(localResult.content) as { observation: PublicObservation }
  return content.observation
}

function actionArgs(observation: PublicObservation, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    observation_id: observation.observation_id,
    app_name: observation.app.name,
    bundle_id: observation.app.bundleId,
    description: '编辑当前文稿',
    safety_class: 'routine',
    ...overrides,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

describe('ComputerSystem', () => {
  it('registers Computer as an always-available system plugin', () => {
    const harness = createHarness()

    expect(harness.server.name).toBe('computer')
    expect(harness.server.requiresSelection).toBeUndefined()
  })

  it('checks and requests Accessibility permission through the native helper identity', async () => {
    const harness = createHarness()
    harness.driver.accessibilityGranted = false

    const unavailable = await harness.system.refresh()
    expect(unavailable.permissions.accessibility.state).toBe('not-determined')

    harness.driver.accessibilityGranted = true
    const granted = await harness.system.requestPermission('accessibility')

    expect(harness.driver.accessibilityRequestCalls).toBe(1)
    expect(granted.permissions.accessibility.state).toBe('granted')
  })

  it('routes a declined native permission request to macOS settings on the next attempt', async () => {
    const harness = createHarness()
    harness.driver.accessibilityGranted = false

    const requested = await harness.system.requestPermission('accessibility')

    expect(requested.permissions.accessibility).toMatchObject({
      state: 'denied',
      canRequest: false,
      settingsPath: expect.stringContaining('Privacy_Accessibility'),
    })
  })

  it('routes a declined Input Control request to macOS settings on the next attempt', async () => {
    const harness = createHarness()
    harness.driver.postEventGranted = false

    const requested = await harness.system.requestPermission('post-event')

    expect(harness.driver.postEventRequestCalls).toBe(1)
    expect(requested.permissions.postEvent).toMatchObject({
      state: 'denied',
      canRequest: false,
      settingsPath: expect.stringContaining('Privacy_Accessibility'),
    })
  })

  it('reports a relaunch requirement when macOS granted the app but the helper still has stale trust', async () => {
    const harness = createHarness()
    harness.driver.accessibilityGranted = false
    harness.driver.postEventGranted = false
    electronMocks.state.accessibilityTrusted = true

    const snapshot = await harness.system.refresh()

    expect(snapshot.permissions.accessibility).toMatchObject({
      state: 'not-determined',
      canRequest: false,
      restartRequired: true,
    })
    expect(snapshot.permissions.postEvent).toMatchObject({
      state: 'not-determined',
      canRequest: false,
      restartRequired: true,
    })
  })

  it('clears stale native permission state when the helper becomes unavailable', async () => {
    const harness = createHarness()
    const healthy = await harness.system.refresh()
    expect(healthy).toMatchObject({
      available: true,
      permissions: {
        accessibility: { state: 'granted' },
        postEvent: { state: 'granted' },
      },
    })

    harness.driver.nativeSnapshotError = new Error('Helper missing')
    const unavailable = await harness.system.refresh()

    expect(unavailable).toMatchObject({
      available: false,
      permissions: {
        accessibility: { state: 'unavailable', canRequest: false },
        postEvent: { state: 'unavailable', canRequest: false },
      },
    })
  })

  it('pauses the whole runtime when the model hands control to the user', async () => {
    const pauseRuntime = vi.fn()
    const harness = createHarness({ pauseRuntime })

    const snapshot = await harness.invoke('handoff', {
      app_name: 'Pages',
      description: '等待用户完成验证',
      reason: '请完成受保护步骤',
      safety_class: 'credential',
    }) as { paused: boolean; handoffActive: boolean }

    expect(pauseRuntime).toHaveBeenCalledOnce()
    expect(snapshot).toMatchObject({ paused: true, handoffActive: true })
  })

  it('restores the observed target after an approval panel interaction steals focus', async () => {
    const harness = createHarness()
    await harness.invoke('observe', { scope: 'window', mode: 'foreground' })
    harness.driver.frontmostApp = { pid: 9_001, name: 'TurboFlux', bundleId: 'dev.turboflux.desktop', active: true }
    harness.driver.focusedWindow = {
      id: 9_002,
      pid: 9_001,
      appName: 'TurboFlux',
      bundleId: 'dev.turboflux.desktop',
      title: 'TurboFlux',
      bounds: { ...PAGES_WINDOW.bounds },
      layer: 0,
      onscreen: true,
      focused: true,
    }

    const restored = await harness.system.restoreObservedTargetAfterApproval()

    expect(harness.driver.activateAppCalls.at(-1)).toEqual({
      pid: PAGES_APP.pid,
      bundleId: PAGES_APP.bundleId,
      name: PAGES_APP.name,
    })
    expect(restored.activeApp).toMatchObject({ pid: PAGES_APP.pid, bundleId: PAGES_APP.bundleId })
    expect(restored.activeWindow).toMatchObject({ id: PAGES_WINDOW.id })
  })

  it('blocks protected applications before asking the driver to launch them', async () => {
    const harness = createHarness()

    await expect(harness.invoke('open_app', {
      name: 'Terminal',
      app_name: 'Terminal',
      bundle_id: 'com.apple.Terminal',
      description: '打开终端',
      safety_class: 'routine',
    })).rejects.toThrow(/Terminal cannot be controlled/i)
    expect(harness.driver.openAppCalls).toHaveLength(0)
  })

  it('redacts every protected application from display observations', async () => {
    const harness = createHarness()
    const turboFluxBounds = { x: -790, y: -190, width: 120, height: 80 }
    const passwordBounds = { x: -640, y: -120, width: 140, height: 100 }
    const terminalBounds = { x: -460, y: -40, width: 150, height: 120 }
    const systemSettingsBounds = { x: -280, y: 80, width: 160, height: 130 }
    harness.driver.windows = [
      { id: 1, pid: process.pid, appName: 'TurboFlux', bundleId: 'com.turboflux.desktop', bounds: turboFluxBounds, layer: 0, onscreen: true },
      { id: 2, pid: 2_001, appName: '1Password', bundleId: 'com.1password.1password', bounds: passwordBounds, layer: 0, onscreen: true },
      { id: 3, pid: 2_002, appName: 'Terminal', bundleId: 'com.apple.Terminal', bounds: terminalBounds, layer: 0, onscreen: true },
      { id: 4, pid: 2_003, appName: 'System Settings', bundleId: 'com.apple.SystemSettings', bounds: systemSettingsBounds, layer: 0, onscreen: true },
      { ...PAGES_WINDOW, bounds: { ...PAGES_WINDOW.bounds } },
    ]

    const observation = publicObservation(await harness.invoke('observe', { scope: 'display' }))

    expect(observation.protected_regions).toEqual([
      turboFluxBounds,
      passwordBounds,
      terminalBounds,
      systemSettingsBounds,
    ])
  })

  it('redacts only protected windows above the target in window observations', async () => {
    const harness = createHarness()
    const overlayBounds = { x: -760, y: -160, width: 100, height: 70 }
    harness.driver.windows = [
      { id: 2, pid: 2_001, appName: '1Password', bundleId: 'com.1password.1password', bounds: overlayBounds, layer: 0, onscreen: true },
      { ...PAGES_WINDOW, bounds: { ...PAGES_WINDOW.bounds } },
      { id: 3, pid: 2_002, appName: 'Terminal', bundleId: 'com.apple.Terminal', bounds: { x: -500, y: -20, width: 180, height: 120 }, layer: 0, onscreen: true },
    ]

    const observation = publicObservation(await harness.invoke('observe', { scope: 'window' }))

    expect(observation.protected_regions).toEqual([overlayBounds])
  })

  it('blocks observation or input when required macOS permissions are missing', async () => {
    const harness = createHarness()
    electronMocks.state.mediaStatus = 'denied'

    await expect(harness.invoke('observe')).rejects.toThrow(/Screen Recording permission is required/i)
    expect(harness.driver.nativeSnapshotCalls).toBe(0)
    expect(harness.system.getSnapshot().lastError?.code).toBe('permission-required')
    expect(harness.events.some(event => event.type === 'permission-required' && event.requirement.kind === 'screen-recording')).toBe(true)

    electronMocks.state.mediaStatus = 'granted'
    harness.driver.accessibilityGranted = false
    const accessibilityObservation = publicObservation(await harness.invoke('observe'))
    await expect(harness.invoke('click', actionArgs(accessibilityObservation, { x: 20, y: 20 })))
      .rejects.toThrow(/Accessibility permission is required/i)

    harness.driver.accessibilityGranted = true
    harness.driver.postEventGranted = false
    const inputObservation = publicObservation(await harness.invoke('observe'))
    await expect(harness.invoke('click', actionArgs(inputObservation, { x: 20, y: 20 })))
      .rejects.toThrow(/Input control permission is required/i)
    expect(harness.driver.clickCalls).toHaveLength(0)
  })

  it('requests missing native permission once and resumes the waiting action', async () => {
    const requested: string[] = []
    const harness = createHarness({
      requestPermission: async kind => {
        requested.push(kind)
        if (kind === 'accessibility') harness.driver.accessibilityGranted = true
        if (kind === 'post-event') harness.driver.postEventGranted = true
        return true
      },
    })
    harness.driver.accessibilityGranted = false
    const observation = publicObservation(await harness.invoke('observe'))
    await harness.invoke('click', actionArgs(observation, { x: 20, y: 20 }))
    expect(requested).toEqual(['accessibility'])
    expect(harness.driver.clickCalls).toHaveLength(1)
    expect(harness.system.getSnapshot().permissionRequirement).toBeUndefined()
    expect(harness.system.getSnapshot().lastError).toBeUndefined()
  })

  it('maps Retina pixels into negative global coordinates and returns a fresh screenshot after action', async () => {
    const harness = createHarness()
    const firstResult = await harness.invoke('observe') as McpLocalToolResult
    const first = publicObservation(firstResult)

    expect(first.screenshot).toEqual({ width: 1_600, height: 1_000 })
    expect(first.coordinate_space).toMatchObject({
      logicalBounds: { x: -800, y: -200, width: 800, height: 500 },
      pixelSize: { width: 1_600, height: 1_000 },
      scaleFactor: 2,
    })
    expect(electronMocks.getSources).toHaveBeenCalledWith(expect.objectContaining({
      thumbnailSize: { width: 1_600, height: 1_000 },
    }))

    const actionResult = await harness.invoke('click', actionArgs(first, { x: 800, y: 500 })) as McpLocalToolResult
    const next = publicObservation(actionResult)

    expect(harness.driver.pointOwnerCalls).toEqual([{ x: -400, y: 50 }])
    expect(harness.driver.clickCalls).toEqual([{
      point: { x: -400, y: 50 },
      button: 'left',
      count: 1,
    }])
    expect(harness.driver.expectedTargetCalls).toContainEqual({
      operation: 'click',
      target: {
        pid: PAGES_APP.pid,
        bundleId: PAGES_APP.bundleId,
        windowId: PAGES_WINDOW.id,
        bounds: PAGES_WINDOW.bounds,
      },
    })
    expect(next.observation_id).not.toBe(first.observation_id)
    expect(actionResult.attachments).toHaveLength(1)
    expect(electronMocks.getSources).toHaveBeenCalledTimes(2)
    await expect(harness.invoke('click', actionArgs(first, { x: 800, y: 500 })))
      .rejects.toThrow(/observation not found/i)
  })

  it('observes and edits an Accessibility target without stealing foreground focus', async () => {
    const harness = createHarness()
    const safari = { pid: 2_002, name: 'Safari', bundleId: 'com.apple.Safari', active: true }
    harness.driver.frontmostApp = safari
    harness.driver.focusedWindow = { ...PAGES_WINDOW, id: 92, pid: safari.pid, appName: safari.name, bundleId: safari.bundleId }
    harness.driver.listAppsImpl = async () => [{ ...PAGES_APP, active: false }, safari]

    const result = await harness.invoke('observe', {
      pid: PAGES_APP.pid,
      app_name: PAGES_APP.name,
      bundle_id: PAGES_APP.bundleId,
      interaction_mode: 'auto',
    }) as McpLocalToolResult
    const observation = publicObservation(result)

    expect(observation.control_mode).toBe('background-semantic')
    expect(observation.screenshot).toBeUndefined()
    expect(result.attachments).toEqual([])
    expect(electronMocks.getSources).not.toHaveBeenCalled()
    expect(harness.driver.frontmostApp?.name).toBe('Safari')

    const next = publicObservation(await harness.invoke('type_text', actionArgs(observation, {
      ref: 'text-body',
      text: 'Revised draft',
      field_type: 'document',
    })))
    expect(next.control_mode).toBe('background-semantic')
    expect(harness.driver.setElementValueCalls).toEqual([{ ref: 'text-body', text: 'Revised draft' }])
    expect(harness.driver.frontmostApp?.name).toBe('Safari')
  })

  it('requires a foreground visual observation before background coordinate input', async () => {
    const harness = createHarness()
    const safari = { pid: 2_002, name: 'Safari', bundleId: 'com.apple.Safari', active: true }
    harness.driver.frontmostApp = safari
    harness.driver.focusedWindow = { ...PAGES_WINDOW, id: 92, pid: safari.pid, appName: safari.name, bundleId: safari.bundleId }
    harness.driver.listAppsImpl = async () => [{ ...PAGES_APP, active: false }, safari]
    const observation = publicObservation(await harness.invoke('observe', {
      pid: PAGES_APP.pid,
      app_name: PAGES_APP.name,
      bundle_id: PAGES_APP.bundleId,
    }))

    await expect(harness.invoke('click', actionArgs(observation, { x: 20, y: 20 })))
      .rejects.toThrow(/needs the application in front/i)
    expect(harness.driver.clickCalls).toHaveLength(0)
  })

  it('falls back to foreground visual control when background semantics are unavailable', async () => {
    const harness = createHarness()
    const safari = { pid: 2_002, name: 'Safari', bundleId: 'com.apple.Safari', active: true }
    harness.driver.frontmostApp = safari
    harness.driver.focusedWindow = { ...PAGES_WINDOW, id: 92, pid: safari.pid, appName: safari.name, bundleId: safari.bundleId }
    harness.driver.listAppsImpl = async () => [{ ...PAGES_APP, active: false }, safari]
    harness.driver.elements = []

    const result = await harness.invoke('observe', {
      pid: PAGES_APP.pid,
      app_name: PAGES_APP.name,
      bundle_id: PAGES_APP.bundleId,
      interaction_mode: 'auto',
    }) as McpLocalToolResult
    const observation = publicObservation(result)

    expect(observation.control_mode).toBe('foreground-visual')
    expect(observation.screenshot).toEqual({ width: 1_600, height: 1_000 })
    expect(result.attachments).toHaveLength(1)
    expect(harness.driver.frontmostApp?.name).toBe('Pages')
  })

  it('rejects an expired observation before dispatching input', async () => {
    const harness = createHarness()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-07T08:00:00.000Z'))
    const observation = publicObservation(await harness.invoke('observe'))
    vi.setSystemTime(new Date('2026-08-07T08:00:20.001Z'))

    await expect(harness.invoke('click', actionArgs(observation, { x: 100, y: 100 })))
      .rejects.toThrow(/observation is stale/i)
    expect(harness.driver.clickCalls).toHaveLength(0)
  })

  it('rejects an action when the foreground application changes', async () => {
    const harness = createHarness()
    const observation = publicObservation(await harness.invoke('observe'))
    harness.driver.frontmostApp = {
      pid: 2_002,
      name: 'Safari',
      bundleId: 'com.apple.Safari',
      active: true,
    }
    harness.driver.focusedWindow = {
      ...PAGES_WINDOW,
      id: 92,
      pid: 2_002,
      appName: 'Safari',
      bundleId: 'com.apple.Safari',
    }

    await expect(harness.invoke('click', actionArgs(observation, { x: 200, y: 200 })))
      .rejects.toThrow(/foreground application changed/i)
    expect(harness.driver.pointOwnerCalls).toHaveLength(0)
    expect(harness.driver.clickCalls).toHaveLength(0)
  })

  it('blocks points owned by the TurboFlux process', async () => {
    const harness = createHarness()
    const observation = publicObservation(await harness.invoke('observe'))
    harness.driver.pointOwnerOverride = {
      pid: process.pid,
      appName: 'TurboFlux',
      bundleId: 'com.turboflux.desktop',
      windowId: 1,
    }

    await expect(harness.invoke('click', actionArgs(observation, { x: 300, y: 250 })))
      .rejects.toThrow(/cannot click its own window/i)
    expect(harness.driver.clickCalls).toHaveLength(0)
  })

  it('blocks credential field types and secure Accessibility controls', async () => {
    const harness = createHarness()
    const passwordObservation = publicObservation(await harness.invoke('observe'))
    await expect(harness.invoke('type_text', actionArgs(passwordObservation, {
      text: 'never-send-this',
      field_type: 'password',
    }))).rejects.toThrow(/Credentials and authentication codes require user takeover/i)

    const secureObservation = publicObservation(await harness.invoke('observe'))
    await expect(harness.invoke('type_text', actionArgs(secureObservation, {
      ref: 'secure-input',
      text: 'still-never-send-this',
      field_type: 'normal',
    }))).rejects.toThrow(/Secure text fields require user takeover/i)

    expect(harness.driver.typeTextCalls).toHaveLength(0)
    expect(harness.driver.setElementValueCalls).toHaveLength(0)
  })

  it('locally blocks payment actions even when the model labels them routine', async () => {
    const harness = createHarness()
    const observation = publicObservation(await harness.invoke('observe'))

    await expect(harness.invoke('click', actionArgs(observation, {
      ref: 'button-save',
      description: '确认付款',
      safety_class: 'routine',
    }))).rejects.toThrow(/Payments and financial transactions require user takeover/i)
    expect(harness.driver.pressElementCalls).toHaveLength(0)
  })

  it('serializes operations and cancels queued work before it reaches the driver', async () => {
    const harness = createHarness()
    const firstGate = deferred<ComputerAppSnapshot[]>()
    harness.driver.listAppsImpl = () => firstGate.promise

    const first = harness.invoke('list_apps')
    const controller = new AbortController()
    const cancelled = harness.invoke('list_apps', {}, controller.signal)

    await vi.waitFor(() => expect(harness.driver.listAppsCalls).toBe(1))
    controller.abort()
    firstGate.resolve([{ ...PAGES_APP }])

    await expect(first).resolves.toMatchObject({ apps: [expect.objectContaining({ name: 'Pages' })] })
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError', message: expect.stringMatching(/Computer operation aborted/i) })
    expect(harness.driver.listAppsCalls).toBe(1)
    expect(harness.events.some(event => event.type === 'error')).toBe(false)
  })

  it('keeps active work and observations when the normalized workspace path is unchanged', async () => {
    const harness = createHarness()
    const observationResult = await harness.invoke('observe') as McpLocalToolResult
    const observation = publicObservation(observationResult)
    const activeGate = deferred<ComputerAppSnapshot[]>()
    harness.driver.listAppsImpl = () => activeGate.promise

    const active = harness.invoke('list_apps')
    await vi.waitFor(() => expect(harness.driver.listAppsCalls).toBe(1))
    harness.system.setWorkspacePath(join(harness.workspacePath, 'unused', '..'))
    activeGate.resolve([{ ...PAGES_APP }])

    await expect(active).resolves.toMatchObject({
      apps: [expect.objectContaining({ name: 'Pages' })],
    })
    harness.driver.listAppsImpl = undefined
    await expect(harness.invoke('click', actionArgs(observation, { x: 20, y: 20 }))).resolves.toBeTruthy()
    expect(harness.driver.clickCalls).toHaveLength(1)
  })

  it('aborts active and queued helper work when the user takes control', async () => {
    const harness = createHarness()
    const firstGate = deferred<ComputerAppSnapshot[]>()
    harness.driver.listAppsImpl = () => firstGate.promise

    const active = harness.invoke('list_apps')
    const queued = harness.invoke('list_apps')
    await vi.waitFor(() => expect(harness.driver.listAppsCalls).toBe(1))

    harness.system.takeControl()
    firstGate.resolve([{ ...PAGES_APP }])

    await expect(active).rejects.toMatchObject({ name: 'AbortError', message: expect.stringMatching(/Computer operation aborted/i) })
    await expect(queued).rejects.toMatchObject({ name: 'AbortError', message: expect.stringMatching(/Computer operation aborted/i) })
    expect(harness.driver.listAppsCalls).toBe(1)
    expect(harness.events.some(event => event.type === 'error')).toBe(false)

    harness.driver.listAppsImpl = undefined
    harness.system.resumeControl()
    await expect(harness.invoke('list_apps')).resolves.toMatchObject({
      apps: [expect.objectContaining({ name: 'Pages' })],
    })
  })

  it('aborts active work while the runtime is paused and resumes cleanly', async () => {
    const harness = createHarness()
    const activeGate = deferred<ComputerAppSnapshot[]>()
    harness.driver.listAppsImpl = () => activeGate.promise

    const active = harness.invoke('list_apps')
    await vi.waitFor(() => expect(harness.driver.listAppsCalls).toBe(1))
    expect(harness.system.pauseForRuntime().paused).toBe(true)
    activeGate.resolve([{ ...PAGES_APP }])

    await expect(active).rejects.toThrow(/Computer operation aborted/i)
    await expect(harness.invoke('observe')).rejects.toThrow(/Computer control is paused/i)

    harness.driver.listAppsImpl = undefined
    expect(harness.system.resumeForRuntime().paused).toBe(false)
    await expect(harness.invoke('observe')).resolves.toBeTruthy()
  })

  it('invalidates queued work and deletes observation frames when a task finishes', async () => {
    const harness = createHarness()
    const observationResult = await harness.invoke('observe') as McpLocalToolResult
    const observation = publicObservation(observationResult)
    const capturePath = observationResult.attachments?.[0]?.path
    const evidenceEvent = harness.events.find(event => event.type === 'artifact-ready')
    expect(capturePath).toBeTruthy()
    expect(existsSync(capturePath!)).toBe(true)
    expect(evidenceEvent).toMatchObject({
      type: 'artifact-ready',
      mime: 'image/png',
      appName: 'Pages',
    })
    expect(evidenceEvent?.type === 'artifact-ready' && existsSync(evidenceEvent.path)).toBe(true)

    const activeGate = deferred<ComputerAppSnapshot[]>()
    harness.driver.listAppsImpl = () => activeGate.promise
    const active = harness.invoke('list_apps')
    const queued = harness.invoke('list_apps')
    await vi.waitFor(() => expect(harness.driver.listAppsCalls).toBe(1))

    const finishing = harness.system.finishTask()
    activeGate.resolve([{ ...PAGES_APP }])

    await expect(active).rejects.toThrow(/Computer operation aborted/i)
    await expect(queued).rejects.toThrow(/Computer operation aborted/i)
    await finishing
    expect(existsSync(capturePath!)).toBe(false)
    expect(evidenceEvent?.type === 'artifact-ready' && existsSync(evidenceEvent.path)).toBe(true)
    await expect(harness.invoke('click', actionArgs(observation, { x: 20, y: 20 })))
      .rejects.toThrow(/observation not found/i)
  })
})
