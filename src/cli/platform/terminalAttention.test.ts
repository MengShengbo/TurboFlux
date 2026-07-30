import { describe, expect, it, vi } from 'vitest'
import {
  DISABLE_TERMINAL_FOCUS_REPORTING,
  ENABLE_TERMINAL_FOCUS_REPORTING,
  TERMINAL_FOCUS_IN,
  TERMINAL_FOCUS_OUT,
  TerminalAttentionAdapter,
  desktopNotificationInvocation,
  prefersReducedMotion,
  stripTerminalFocusSequences,
} from './terminalAttention'

describe('TerminalAttentionAdapter', () => {
  it('tracks focus protocol state and restores terminal mode', () => {
    const writes: string[] = []
    const adapter = new TerminalAttentionAdapter({
      interactive: true,
      environment: {},
      writeControl: sequence => writes.push(sequence),
    })

    expect(adapter.start()).toBe(true)
    expect(adapter.handleInput(TERMINAL_FOCUS_OUT)).toBe(true)
    expect(adapter.getFocusState()).toBe('background')
    expect(adapter.handleInput(TERMINAL_FOCUS_IN)).toBe(true)
    expect(adapter.getFocusState()).toBe('foreground')
    adapter.stop()
    expect(writes).toEqual([ENABLE_TERMINAL_FOCUS_REPORTING, DISABLE_TERMINAL_FOCUS_REPORTING])
  })

  it('consumes focus reports even when Ink strips the escape byte', () => {
    const adapter = new TerminalAttentionAdapter({
      interactive: true,
      environment: {},
      writeControl: () => {},
    })

    adapter.start()
    expect(adapter.handleInput('[O')).toBe(true)
    expect(adapter.getFocusState()).toBe('background')
    expect(adapter.handleInput('[I')).toBe(true)
    expect(adapter.getFocusState()).toBe('foreground')
    expect(stripTerminalFocusSequences('[O[Ityped')).toBe('typed')
  })

  it('notifies once only after explicit focus loss and never forwards content', () => {
    const spawnDetached = vi.fn()
    const adapter = new TerminalAttentionAdapter({
      interactive: true,
      platform: 'linux',
      environment: {},
      writeControl: () => {},
      spawnDetached,
    })
    adapter.start()

    expect(adapter.notify({ id: 'approval-1', category: 'action-required' })).toBe(false)
    adapter.handleInput(TERMINAL_FOCUS_OUT)
    expect(adapter.notify({ id: 'approval-1', category: 'action-required' })).toBe(true)
    expect(adapter.notify({ id: 'approval-1', category: 'action-required' })).toBe(false)
    expect(spawnDetached).toHaveBeenCalledWith('notify-send', [
      '--app-name=TurboFlux',
      'TurboFlux',
      'Action required',
    ])
  })

  it('stays silent when notifications are disabled', () => {
    const spawnDetached = vi.fn()
    const adapter = new TerminalAttentionAdapter({
      interactive: true,
      platform: 'win32',
      environment: { TURBOFLUX_DESKTOP_NOTIFICATIONS: '0' },
      writeControl: () => {},
      spawnDetached,
    })

    expect(adapter.start()).toBe(false)
    adapter.handleInput(TERMINAL_FOCUS_OUT)
    expect(adapter.notify({ id: 'error-1', category: 'error' })).toBe(false)
    expect(spawnDetached).not.toHaveBeenCalled()
  })
})

describe('terminal attention policy', () => {
  it('recognizes explicit reduced-motion signals', () => {
    expect(prefersReducedMotion({})).toBe(false)
    expect(prefersReducedMotion({ TURBOFLUX_REDUCED_MOTION: '1' })).toBe(true)
    expect(prefersReducedMotion({ CI: 'true' })).toBe(true)
  })

  it('builds argument-based platform invocations', () => {
    expect(desktopNotificationInvocation('win32', 'TurboFlux', 'Action required')).toMatchObject({
      command: 'powershell.exe',
    })
    expect(desktopNotificationInvocation('darwin', 'TurboFlux', 'Action required')?.command).toBe('osascript')
    expect(desktopNotificationInvocation('freebsd', 'TurboFlux', 'Action required')).toBeNull()
  })
})
