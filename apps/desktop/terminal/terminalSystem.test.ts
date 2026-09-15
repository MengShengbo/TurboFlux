import type { IPty } from 'node-pty'
import { describe, expect, it, vi } from 'vitest'
import { DesktopTerminalSystem, desktopTerminalShell, desktopTerminalShellArguments } from './terminalSystem'
import type { DesktopTerminalEvent } from './terminalTypes'

class FakePty {
  readonly pid: number
  readonly writes: string[] = []
  readonly resizes: Array<[number, number]> = []
  killed = false
  private dataListeners = new Set<(data: string) => void>()
  private exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>()

  constructor(pid: number) {
    this.pid = pid
  }

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener)
    return { dispose: () => this.dataListeners.delete(listener) }
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(listener)
    return { dispose: () => this.exitListeners.delete(listener) }
  }

  write(data: string) {
    this.writes.push(data)
  }

  resize(cols: number, rows: number) {
    this.resizes.push([cols, rows])
  }

  kill() {
    this.killed = true
  }

  emitData(data: string) {
    for (const listener of this.dataListeners) listener(data)
  }

  emitExit(exitCode: number, signal?: number) {
    for (const listener of this.exitListeners) listener({ exitCode, signal })
  }
}

describe('DesktopTerminalSystem', () => {
  it('selects PowerShell with profile isolation on Windows', () => {
    expect(desktopTerminalShell('win32', { TURBOFLUX_POWERSHELL: 'pwsh.exe' })).toBe('pwsh.exe')
    expect(desktopTerminalShell('win32', {})).toBe('powershell.exe')
    expect(desktopTerminalShellArguments('win32')).toEqual(['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass'])
  })

  it('creates independent interactive sessions and streams resumable output', async () => {
    const processes: FakePty[] = []
    const spawn = vi.fn((_file: string, _args: string[], _options: unknown) => {
      const processHandle = new FakePty(800 + processes.length)
      processes.push(processHandle)
      return processHandle as unknown as IPty
    })
    const events: DesktopTerminalEvent[] = []
    const system = new DesktopTerminalSystem(event => events.push(event), { spawn } as never)

    const first = await system.create({ cwd: '/workspace', cols: 120, rows: 30 })
    const second = await system.create({ cwd: '/workspace' })

    expect(first.title).toBe('会话 1')
    expect(second.title).toBe('会话 2')
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ cwd: '/workspace', cols: 120, rows: 30, name: 'xterm-256color' })

    processes[0]!.emitData('hello')
    processes[0]!.emitData(' world')
    expect(system.read(first.id).chunks).toEqual([
      { seq: 1, data: 'hello' },
      { seq: 2, data: ' world' },
    ])
    expect(system.read(first.id, 1).chunks).toEqual([{ seq: 2, data: ' world' }])
    expect(events).toContainEqual({ type: 'data', sessionId: first.id, seq: 2, data: ' world' })
  })

  it('writes, resizes, reports exit, and closes only the selected session', async () => {
    const processes: FakePty[] = []
    const events: DesktopTerminalEvent[] = []
    const system = new DesktopTerminalSystem(event => events.push(event), {
      spawn: () => {
        const processHandle = new FakePty(900 + processes.length)
        processes.push(processHandle)
        return processHandle as unknown as IPty
      },
    } as never)
    const first = await system.create({ cwd: '/workspace' })
    const second = await system.create({ cwd: '/workspace' })

    system.write(first.id, 'pwd\r')
    expect(processes[0]!.writes).toEqual(['pwd\r'])
    expect(system.resize(first.id, 999, 1)).toMatchObject({ cols: 400, rows: 5 })
    expect(processes[0]!.resizes).toEqual([[400, 5]])

    processes[0]!.emitExit(0)
    expect(system.read(first.id).session).toMatchObject({ status: 'exited', exitCode: 0 })
    expect(events.some(event => event.type === 'status' && event.session.id === first.id && event.session.status === 'exited')).toBe(true)
    expect(system.close(first.id)).toBe(true)
    expect(system.list().map(session => session.id)).toEqual([second.id])
    expect(processes[0]!.killed).toBe(false)
    expect(events).toContainEqual({ type: 'removed', sessionId: first.id })

    system.destroy()
    expect(processes[1]!.killed).toBe(true)
    expect(system.list()).toEqual([])
  })
})
