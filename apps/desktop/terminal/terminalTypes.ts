export type DesktopTerminalStatus = 'running' | 'exited'

export interface DesktopTerminalSession {
  id: string
  pid: number
  title: string
  shell: string
  cwd: string
  status: DesktopTerminalStatus
  cols: number
  rows: number
  createdAt: number
  updatedAt: number
  exitCode?: number
  exitSignal?: number
}

export interface DesktopTerminalChunk {
  seq: number
  data: string
}

export interface DesktopTerminalBuffer {
  session: DesktopTerminalSession
  chunks: DesktopTerminalChunk[]
}

export type DesktopTerminalEvent =
  | { type: 'data'; sessionId: string; seq: number; data: string }
  | { type: 'status'; session: DesktopTerminalSession }
  | { type: 'removed'; sessionId: string }
