export const COMPUTER_TOOL_OPERATIONS = [
  'status',
  'observe',
  'list_apps',
  'open_app',
  'focus_app',
  'click',
  'double_click',
  'move',
  'drag',
  'scroll',
  'type_text',
  'press',
  'wait',
  'assert',
  'handoff',
] as const

export type ComputerToolOperation = typeof COMPUTER_TOOL_OPERATIONS[number]

export type ComputerToolApprovalLevel = 'none' | 'policy' | 'always' | 'deny'

export type ComputerToolActivityStatus = 'running' | 'completed' | 'failed'

export type ComputerActionSafetyClass =
  | 'routine'
  | 'external'
  | 'sensitive'
  | 'destructive'
  | 'payment'
  | 'system'
  | 'credential'

export type ComputerPermissionKind = 'screen-recording' | 'accessibility' | 'post-event'

export type ComputerPermissionState =
  | 'unknown'
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unavailable'

export interface ComputerPermissionStatus {
  kind: ComputerPermissionKind
  state: ComputerPermissionState
  canRequest: boolean
  settingsPath?: string
  restartRequired?: boolean
}

export interface ComputerPermissionSnapshot {
  screenRecording: ComputerPermissionStatus
  accessibility: ComputerPermissionStatus
  postEvent: ComputerPermissionStatus
}

export type ComputerPermissionRequestOutcome = 'granted' | 'restart-required' | 'needs-settings' | 'cancelled'

export type ComputerControlMode = 'background-semantic' | 'foreground-visual' | 'takeover'

export interface ComputerPermissionRequestResult {
  kind: ComputerPermissionKind
  outcome: ComputerPermissionRequestOutcome
  snapshot: ComputerSystemSnapshot
}

export interface ComputerPermissionRequirement {
  kind: ComputerPermissionKind
  operation: ComputerToolOperation
  message: string
  requestedAt: number
}

export interface ComputerErrorSnapshot {
  code: 'permission-required' | 'unavailable' | 'stale-observation' | 'handoff-required' | 'operation-failed'
  message: string
  operation?: ComputerToolOperation
  permission?: ComputerPermissionKind
  recoverable: boolean
  occurredAt: number
}

export interface ComputerPoint {
  x: number
  y: number
}

export interface ComputerSize {
  width: number
  height: number
}

export interface ComputerBounds extends ComputerPoint, ComputerSize {}

export interface ComputerCoordinateSpace {
  frameId: string
  displayId: string
  capturedAt: number
  logicalBounds: ComputerBounds
  pixelSize: ComputerSize
  scaleFactor: number
}

export interface ComputerDisplaySnapshot {
  id: string
  label: string
  bounds: ComputerBounds
  workArea: ComputerBounds
  scaleFactor: number
  primary: boolean
}

export interface ComputerWindowSnapshot {
  id: number
  pid: number
  appName: string
  appId?: string
  bundleId?: string
  title?: string
  bounds: ComputerBounds
  layer: number
  onscreen: boolean
  focused?: boolean
  minimized?: boolean
}

export interface ComputerAppSnapshot {
  id?: string
  pid: number
  name: string
  bundleId?: string
  bundlePath?: string
  active: boolean
  hidden?: boolean
  windows?: ComputerWindowSnapshot[]
}

export interface ComputerAccessibilityElement {
  ref: string
  role: string
  subrole?: string
  title?: string
  description?: string
  value?: string
  enabled: boolean
  focused: boolean
  secure: boolean
  bounds?: ComputerBounds
}

export interface ComputerVisualAttachment {
  id: string
  type: 'image'
  path: string
  mime: string
  filename: string
  size: number
  width: number
  height: number
}

export interface ComputerObservation {
  frameId: string
  capturedAt: number
  expiresAt: number
  displayId: string
  scope: 'window' | 'display'
  coordinateSpace: ComputerCoordinateSpace
  image?: ComputerVisualAttachment
  controlMode: Exclude<ComputerControlMode, 'takeover'>
  activeApp?: ComputerAppSnapshot
  activeWindow?: ComputerWindowSnapshot
  elements: ComputerAccessibilityElement[]
  protectedRegions: ComputerBounds[]
}

export interface ComputerActivitySnapshot {
  phase: 'observing' | 'acting' | 'waiting' | 'handoff'
  operation?: ComputerToolOperation
  appName?: string
  description?: string
  controlMode?: ComputerControlMode
  startedAt: number
}

export interface ComputerSystemSnapshot {
  platform: 'darwin' | 'win32' | 'linux'
  available: boolean
  paused: boolean
  handoffActive: boolean
  sessionActive: boolean
  permissions: ComputerPermissionSnapshot
  displays: ComputerDisplaySnapshot[]
  activeApp?: ComputerAppSnapshot
  activeWindow?: ComputerWindowSnapshot
  activity?: ComputerActivitySnapshot
  permissionRequirement?: ComputerPermissionRequirement
  lastError?: ComputerErrorSnapshot
}

export interface ComputerToolTarget {
  appId?: string
  appName?: string
  bundleId?: string
  windowId?: number
  displayId?: string
  frameId?: string
}

export type ComputerSystemEvent =
  | { type: 'state'; snapshot: ComputerSystemSnapshot }
  | { type: 'permission-changed'; permission: ComputerPermissionStatus }
  | { type: 'handoff-changed'; active: boolean }
  | { type: 'activity-changed'; activity?: ComputerActivitySnapshot }
  | { type: 'permission-required'; requirement: ComputerPermissionRequirement }
  | { type: 'error'; error: ComputerErrorSnapshot }
