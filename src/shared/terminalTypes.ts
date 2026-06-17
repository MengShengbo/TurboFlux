export type TerminalSessionStatus = 'starting' | 'running' | 'exited' | 'error'

export interface TerminalShellInfo {
  id: string
  label: string
  command: string
  args?: string[]
  available: boolean
  reason?: string
}

export interface TerminalOutputChunk {
  seq: number
  data: string
  timestamp: number
}

export interface TerminalSessionInfo {
  id: string
  pid: number
  shell: string
  shellId: string
  shellLabel: string
  cwd: string
  status: TerminalSessionStatus
  createdAt: number
  updatedAt: number
  isAgentSession: boolean
  title: string
  exitCode?: number | null
  exitSignal?: number | null
  error?: string
}

export interface TerminalCreateOptions {
  shell?: string
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
  isAgentSession?: boolean
}

export interface TerminalCreateResult {
  success: boolean
  session?: TerminalSessionInfo
  id?: string
  pid?: number
  shell?: string
  cwd?: string
  error?: string
}

export interface TerminalListResult {
  success: boolean
  sessions?: TerminalSessionInfo[]
  error?: string
}

export interface TerminalBufferResult {
  success: boolean
  chunks?: TerminalOutputChunk[]
  session?: TerminalSessionInfo
  error?: string
}

export interface TerminalShellsResult {
  success: boolean
  shells?: TerminalShellInfo[]
  defaultShellId?: string
  error?: string
}

export interface TerminalRunCommandResult {
  success: boolean
  output?: string
  exitCode?: number | null
  completed?: boolean
  error?: string
}

export interface TerminalDataEvent {
  sessionId: string
  data: string
  seq: number
  timestamp: number
}

export interface TerminalExitEvent {
  sessionId: string
  exitCode: number | null
  exitSignal?: number | null
  timestamp: number
}

export interface TerminalStatusEvent {
  session: TerminalSessionInfo
}
