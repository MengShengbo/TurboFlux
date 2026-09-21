import type { WebContentsView, WebFrameMain } from 'electron'

export type BrowserTabRetention = 'transient' | 'deliverable' | 'handoff'

export interface BrowserElementRefTarget {
  frame: WebFrameMain
  frameTreeNodeId: number
  processId: number
  routingId: number
  isMainFrame: boolean
}

export interface BrowserConsoleEntry {
  level: 'info' | 'warning' | 'error' | 'debug'
  message: string
  source?: string
  line?: number
  timestamp: number
}

export interface BrowserNetworkIssue {
  method: string
  url: string
  resourceType: string
  status?: number
  error?: string
  timestamp: number
}

export interface BrowserTab {
  id: string
  view: WebContentsView
  title: string
  url: string
  loading: boolean
  crashed: boolean
  consoleEntries: BrowserConsoleEntry[]
  networkIssues: BrowserNetworkIssue[]
  refScope: string
  unresponsive: boolean
  observationEpoch: number
  elementRefs: Map<string, BrowserElementRefTarget>
  retention: BrowserTabRetention
}
