export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserTabSnapshot {
  id: string
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  crashed?: boolean
  retention: BrowserTabRetention
}

export type BrowserTabRetention = 'transient' | 'deliverable' | 'handoff'

export type BrowserActivityPhase = 'opening' | 'navigating' | 'observing' | 'acting' | 'capturing' | 'recovering'

export interface BrowserActivitySnapshot {
  phase: BrowserActivityPhase
  operation?: string
  tabId?: string
  runId?: string
  toolCallId?: string
  itemId?: string
  description: string
  startedAt: number
}

export interface BrowserExecutionSnapshot {
  conversationId: string
  runId?: string
  toolCallId: string
  itemId: string
  operation: string
  phase: BrowserActivityPhase
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  tabId?: string
  title?: string
  url?: string
  startedAt: number
  updatedAt: number
}

export interface BrowserDownloadSnapshot {
  id: string
  filename: string
  path?: string
  status: 'started' | 'completed' | 'cancelled' | 'failed'
  receivedBytes?: number
  totalBytes?: number
  error?: string
  startedAt: number
  updatedAt: number
}

export interface BrowserErrorSnapshot {
  code: 'navigation-blocked' | 'load-failed' | 'renderer-crashed' | 'download-failed' | 'operation-failed'
  message: string
  tabId?: string
  recoverable: boolean
  occurredAt: number
}

export interface BrowserSystemSnapshot {
  conversationId: string
  visible: boolean
  activeTabId: string | null
  tabs: BrowserTabSnapshot[]
  activity?: BrowserActivitySnapshot
  executions: BrowserExecutionSnapshot[]
  downloads: BrowserDownloadSnapshot[]
  lastError?: BrowserErrorSnapshot
}

export interface BrowserObservedElement {
  ref: string
  role: string
  name: string
  description?: string
  disabled?: boolean
  checked?: boolean
  value?: string
  options?: string[]
  bounds?: { x: number; y: number; width: number; height: number }
  coordinateSpace?: 'viewport' | 'frame'
  frame?: BrowserFrameSnapshot
}

export interface BrowserFrameSnapshot {
  id: string
  name?: string
  url: string
  isMainFrame: boolean
  available: boolean
  elementCount: number
}

export interface BrowserObservation {
  tabId: string
  observationId: string
  title: string
  url: string
  text: string
  elements: BrowserObservedElement[]
  frames: BrowserFrameSnapshot[]
  viewport: { width: number; height: number; scrollX: number; scrollY: number }
  truncated: boolean
}

export type BrowserViewportMode = 'portrait' | 'landscape'

export type BrowserSystemEvent =
  | { type: 'state'; snapshot: BrowserSystemSnapshot }
  | { type: 'layout-request'; mode: BrowserViewportMode }
  | { type: 'blocked-navigation'; url: string; reason: string }
  | { type: 'download'; download: BrowserDownloadSnapshot; filename: string; path?: string; status: BrowserDownloadSnapshot['status']; error?: string }
  | { type: 'artifact-ready'; path: string; name: string; mime: string; kind: 'screenshot' | 'download'; tabId?: string; title?: string; url?: string }
