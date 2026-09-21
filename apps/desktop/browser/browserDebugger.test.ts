import { describe, expect, it, vi } from 'vitest'
import type { Debugger } from 'electron'
import { withBrowserDebugger } from './browserDebugger'
import { BrowserRuntime } from './browserRuntime'

function debuggerFixture(attached = false) {
  return {
    isAttached: vi.fn(() => attached),
    attach: vi.fn(() => { attached = true }),
    detach: vi.fn(() => { attached = false }),
    sendCommand: vi.fn(async () => ({})),
  }
}

describe('browser debugger lease', () => {
  it('keeps an existing debugger attachment owned by its caller', async () => {
    const api = debuggerFixture(true)
    await withBrowserDebugger(api as unknown as Debugger, new BrowserRuntime(), send => send('Page.getLayoutMetrics'))
    expect(api.attach).not.toHaveBeenCalled()
    expect(api.detach).not.toHaveBeenCalled()
  })

  it('never replays a command after an ambiguous protocol failure', async () => {
    const api = debuggerFixture()
    api.sendCommand.mockRejectedValueOnce(new Error('Detached after dispatch'))
    await expect(withBrowserDebugger(api as unknown as Debugger, new BrowserRuntime(), send => send('Input.dispatchMouseEvent'))).rejects.toThrow('Detached after dispatch')
    expect(api.sendCommand).toHaveBeenCalledTimes(1)
    expect(api.detach).toHaveBeenCalledOnce()
  })

  it('serializes capture and input so one operation cannot detach another', async () => {
    const api = debuggerFixture()
    const order: string[] = []
    let release!: () => void
    let ready!: () => void
    const started = new Promise<void>(resolve => { ready = resolve })
    const first = withBrowserDebugger(api as unknown as Debugger, new BrowserRuntime(), async () => {
      order.push('capture-start'); ready()
      await new Promise<void>(resolve => { release = resolve })
      order.push('capture-end')
    })
    await started
    const second = withBrowserDebugger(api as unknown as Debugger, new BrowserRuntime(), async () => { order.push('input') })
    await Promise.resolve()
    expect(order).toEqual(['capture-start'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['capture-start', 'capture-end', 'input'])
    expect(api.attach).toHaveBeenCalledTimes(2)
    expect(api.detach).toHaveBeenCalledTimes(2)
  })
})
