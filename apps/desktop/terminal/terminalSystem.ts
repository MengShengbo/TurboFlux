import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { IPty } from 'node-pty'
import type {
  DesktopTerminalBuffer,
  DesktopTerminalChunk,
  DesktopTerminalEvent,
  DesktopTerminalSession,
} from './terminalTypes'

const DEFAULT_COLS = 100
const DEFAULT_ROWS = 24
const MAX_SESSIONS = 12
const MAX_WRITE_LENGTH = 256 * 1024
const MAX_BUFFER_LENGTH = 1_500_000

interface TerminalPtyFactory {
  spawn(file: string, args: string[], options: {
    name: string
    cols: number
    rows: number
    cwd: string
    env: Record<string, string>
  }): IPty
}

interface ManagedTerminalSession {
  info: DesktopTerminalSession
  process: IPty
  chunks: DesktopTerminalChunk[]
  bufferLength: number
  nextSeq: number
  disposables: Array<{ dispose(): void }>
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(maximum, Math.max(minimum, numeric))
}

function terminalEnvironment(): Record<string, string> {
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.NODE_OPTIONS
  environment.TERM = 'xterm-256color'
  environment.COLORTERM = 'truecolor'
  environment.TERM_PROGRAM = 'TurboFlux'
  return environment
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec || 'powershell.exe'
  return process.env.SHELL || '/bin/zsh'
}

function shellArguments(): string[] {
  return process.platform === 'win32' ? [] : ['-l']
}

function shellLabel(shell: string): string {
  return basename(shell).replace(/\.exe$/i, '') || 'shell'
}

function copySession(session: DesktopTerminalSession): DesktopTerminalSession {
  return { ...session }
}

export class DesktopTerminalSystem {
  private readonly sessions = new Map<string, ManagedTerminalSession>()
  private ptyFactory?: TerminalPtyFactory

  constructor(
    private readonly emit: (event: DesktopTerminalEvent) => void,
    ptyFactory?: TerminalPtyFactory,
  ) {
    this.ptyFactory = ptyFactory
  }

  list(): DesktopTerminalSession[] {
    return Array.from(this.sessions.values(), session => copySession(session.info))
  }

  async create(options: { cwd: string; cols?: number; rows?: number }): Promise<DesktopTerminalSession> {
    if (this.sessions.size >= MAX_SESSIONS) throw new Error(`最多同时打开 ${MAX_SESSIONS} 个终端`)
    if (!options.cwd || typeof options.cwd !== 'string') throw new Error('Terminal workspace is required')
    if (!this.ptyFactory) this.ptyFactory = await import('node-pty')

    const shell = defaultShell()
    const label = shellLabel(shell)
    const cols = boundedInteger(options.cols, DEFAULT_COLS, 20, 400)
    const rows = boundedInteger(options.rows, DEFAULT_ROWS, 5, 200)
    const processHandle = this.ptyFactory.spawn(shell, shellArguments(), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: options.cwd,
      env: terminalEnvironment(),
    })
    const now = Date.now()
    const info: DesktopTerminalSession = {
      id: `terminal-${randomUUID()}`,
      pid: processHandle.pid,
      title: this.nextTitle(),
      shell: label,
      cwd: options.cwd,
      status: 'running',
      cols,
      rows,
      createdAt: now,
      updatedAt: now,
    }
    const managed: ManagedTerminalSession = {
      info,
      process: processHandle,
      chunks: [],
      bufferLength: 0,
      nextSeq: 0,
      disposables: [],
    }
    this.sessions.set(info.id, managed)
    managed.disposables.push(processHandle.onData(data => this.handleData(info.id, data)))
    managed.disposables.push(processHandle.onExit(event => this.handleExit(info.id, event.exitCode, event.signal)))
    this.emit({ type: 'status', session: copySession(info) })
    return copySession(info)
  }

  read(sessionId: string, sinceSeq = 0): DesktopTerminalBuffer {
    const session = this.requireSession(sessionId)
    const cursor = boundedInteger(sinceSeq, 0, 0, Number.MAX_SAFE_INTEGER)
    return {
      session: copySession(session.info),
      chunks: session.chunks.filter(chunk => chunk.seq > cursor).map(chunk => ({ ...chunk })),
    }
  }

  write(sessionId: string, data: string): DesktopTerminalSession {
    const session = this.requireSession(sessionId)
    if (session.info.status !== 'running') throw new Error('这个终端已经结束')
    if (typeof data !== 'string' || data.length === 0) return copySession(session.info)
    if (data.length > MAX_WRITE_LENGTH) throw new Error('一次写入的内容过大')
    session.process.write(data)
    session.info.updatedAt = Date.now()
    return copySession(session.info)
  }

  resize(sessionId: string, cols: number, rows: number): DesktopTerminalSession {
    const session = this.requireSession(sessionId)
    const nextCols = boundedInteger(cols, session.info.cols, 20, 400)
    const nextRows = boundedInteger(rows, session.info.rows, 5, 200)
    if (nextCols === session.info.cols && nextRows === session.info.rows) return copySession(session.info)
    if (session.info.status === 'running') session.process.resize(nextCols, nextRows)
    session.info.cols = nextCols
    session.info.rows = nextRows
    session.info.updatedAt = Date.now()
    return copySession(session.info)
  }

  close(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    this.sessions.delete(sessionId)
    for (const disposable of session.disposables) disposable.dispose()
    if (session.info.status === 'running') {
      try {
        session.process.kill()
      } catch {
        // The shell may have exited between the status check and close.
      }
    }
    this.emit({ type: 'removed', sessionId })
    return true
  }

  destroy(): void {
    for (const sessionId of Array.from(this.sessions.keys())) this.close(sessionId)
  }

  private nextTitle(): string {
    const titles = new Set(Array.from(this.sessions.values(), session => session.info.title))
    let index = 1
    while (titles.has(`会话 ${index}`)) index += 1
    return `会话 ${index}`
  }

  private handleData(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || !data) return
    const chunk = { seq: ++session.nextSeq, data }
    session.chunks.push(chunk)
    session.bufferLength += data.length
    while (session.bufferLength > MAX_BUFFER_LENGTH && session.chunks.length > 1) {
      const removed = session.chunks.shift()
      if (removed) session.bufferLength -= removed.data.length
    }
    session.info.updatedAt = Date.now()
    this.emit({ type: 'data', sessionId, ...chunk })
  }

  private handleExit(sessionId: string, exitCode: number, signal?: number): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.info.status = 'exited'
    session.info.exitCode = exitCode
    session.info.exitSignal = signal
    session.info.updatedAt = Date.now()
    this.emit({ type: 'status', session: copySession(session.info) })
  }

  private requireSession(sessionId: string): ManagedTerminalSession {
    if (!sessionId || typeof sessionId !== 'string') throw new Error('Terminal session is required')
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('找不到这个终端')
    return session
  }
}
