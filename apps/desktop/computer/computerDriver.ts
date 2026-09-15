import type {
  ComputerAccessibilityElement,
  ComputerAppSnapshot,
  ComputerBounds,
  ComputerWindowSnapshot,
} from '@turboflux/agent-core/contracts'

export interface ComputerNativeSnapshot {
  accessibilityTrusted: boolean
  postEventTrusted: boolean
  frontmostApp: ComputerAppSnapshot | null
  focusedWindow: ComputerWindowSnapshot | null
  targetApp?: ComputerAppSnapshot | null
  targetWindow?: ComputerWindowSnapshot | null
  focusedElement?: {
    role?: string
    subrole?: string
    title?: string
    secure: boolean
  }
  windows: ComputerWindowSnapshot[]
  elements: ComputerAccessibilityElement[]
}

export interface ComputerPointOwner {
  pid: number
  bundleId?: string
  appName: string
  windowId?: number
  title?: string
  bounds?: ComputerBounds
}

export type ComputerMouseButton = 'left' | 'right' | 'middle'

export interface ComputerExpectedTarget {
  pid: number
  bundleId: string
  windowId: number
  bounds: ComputerBounds
}

export interface ComputerDriver {
  readonly platform: NodeJS.Platform
  requestAccessibilityAccess(signal?: AbortSignal): Promise<boolean>
  requestPostEventAccess(signal?: AbortSignal): Promise<boolean>
  nativeSnapshot(options?: {
    includeElements?: boolean
    target?: { pid: number; bundleId?: string; windowId?: number }
    signal?: AbortSignal
  }): Promise<ComputerNativeSnapshot>
  listApps(signal?: AbortSignal): Promise<ComputerAppSnapshot[]>
  activateApp(target: { pid?: number; bundleId?: string; name?: string }, signal?: AbortSignal): Promise<ComputerAppSnapshot>
  openApp(target: { bundleId?: string; name?: string }, signal?: AbortSignal): Promise<ComputerAppSnapshot>
  pointOwner(point: { x: number; y: number }, signal?: AbortSignal): Promise<ComputerPointOwner | null>
  click(point: { x: number; y: number }, options: {
    button?: ComputerMouseButton
    count?: 1 | 2
    expectedTarget: ComputerExpectedTarget
  }, signal?: AbortSignal): Promise<void>
  move(point: { x: number; y: number }, options: { expectedTarget: ComputerExpectedTarget }, signal?: AbortSignal): Promise<void>
  drag(points: Array<{ x: number; y: number }>, options: {
    button?: ComputerMouseButton
    expectedTarget: ComputerExpectedTarget
  }, signal?: AbortSignal): Promise<void>
  scroll(
    point: { x: number; y: number },
    delta: { x: number; y: number },
    options: { expectedTarget: ComputerExpectedTarget },
    signal?: AbortSignal,
  ): Promise<void>
  press(keys: string[], targetPid: number, options: { expectedTarget: ComputerExpectedTarget }, signal?: AbortSignal): Promise<void>
  typeText(text: string, targetPid: number, options: { expectedTarget: ComputerExpectedTarget }, signal?: AbortSignal): Promise<void>
  pressElement(
    ref: string,
    expected: { role?: string; title?: string },
    options: { expectedTarget: ComputerExpectedTarget },
    signal?: AbortSignal,
  ): Promise<void>
  setElementValue(
    ref: string,
    text: string,
    expected: { role?: string; title?: string },
    options: { expectedTarget: ComputerExpectedTarget },
    signal?: AbortSignal,
  ): Promise<void>
}
