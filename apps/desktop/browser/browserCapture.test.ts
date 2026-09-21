import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureBrowserViewport } from './browserCapture'
import type { BrowserTab } from './browserTypes'

const ready = { width: 824, height: 769, deviceScaleFactor: 2 }
const empty = { width: 0, height: 0, deviceScaleFactor: 2 }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO2kAAAAASUVORK5CYII=', 'base64')

function captureTab(viewports = [ready], attached = false) {
  let cursor = 0
  const debuggerApi = {
    isAttached: vi.fn(() => attached),
    attach: vi.fn(() => { attached = true }),
    detach: vi.fn(() => { attached = false }),
    sendCommand: vi.fn(async (method: string) => method === 'Page.getLayoutMetrics'
      ? { cssVisualViewport: { pageX: 0, pageY: 120, clientWidth: ready.width, clientHeight: ready.height } }
      : { data: png.toString('base64') }),
  }
  const executeJavaScript = vi.fn(async () => viewports[Math.min(cursor++, viewports.length - 1)])
  const tab = { id: 'capture-test', title: 'Preview', url: 'http://localhost/preview', view: { webContents: { debugger: debuggerApi, executeJavaScript } } } as unknown as BrowserTab
  return { tab, debuggerApi, executeJavaScript }
}

describe('browser viewport capture readiness', () => {
  let storage: string
  beforeEach(async () => {
    storage = await mkdtemp(join(tmpdir(), 'turboflux-capture-'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(async () => {
    vi.useRealTimers()
    await rm(storage, { recursive: true, force: true })
  })

  it('waits through an unmounted and resizing viewport before publishing image evidence', async () => {
    const { tab, debuggerApi, executeJavaScript } = captureTab([empty, { ...ready, width: 400 }, ready, ready])
    const emit = vi.fn()
    const capture = captureBrowserViewport(tab, storage, emit)
    await vi.waitFor(() => expect(executeJavaScript).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(160)
    const result = await capture
    expect(result.viewport).toEqual(ready)
    expect(executeJavaScript).toHaveBeenCalledTimes(4)
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', expect.objectContaining({
      clip: { x: 0, y: 120, width: 824, height: 769, scale: 1 },
    }))
    expect(result.attachment.size).toBe(png.length)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'artifact-ready', path: result.path }))
    expect(debuggerApi.detach).toHaveBeenCalledOnce()
  })

  it('does not publish an empty capture when the viewport never becomes ready', async () => {
    const { tab, debuggerApi, executeJavaScript } = captureTab([empty])
    const emit = vi.fn()
    const capture = captureBrowserViewport(tab, storage, emit)
    const rejected = expect(capture).rejects.toThrow('did not become ready')
    await vi.waitFor(() => expect(executeJavaScript).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(2_050)
    await rejected
    expect(debuggerApi.sendCommand).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect(await readdir(join(storage, 'captures', 'browser'))).toEqual([])
    expect(debuggerApi.detach).toHaveBeenCalledOnce()
  })

  it('honors cancellation during layout wait and leaves no screenshot artifact', async () => {
    const { tab, debuggerApi, executeJavaScript } = captureTab([empty])
    const controller = new AbortController()
    const emit = vi.fn()
    const capture = captureBrowserViewport(tab, storage, emit, controller.signal)
    const rejected = expect(capture).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(executeJavaScript).toHaveBeenCalled())
    controller.abort()
    await vi.advanceTimersByTimeAsync(50)
    await rejected
    expect(debuggerApi.sendCommand).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect(await readdir(join(storage, 'captures', 'browser'))).toEqual([])
  })

  it('preserves a debugger connection owned by another caller', async () => {
    const { tab, debuggerApi, executeJavaScript } = captureTab([ready], true)
    const capture = captureBrowserViewport(tab, storage, vi.fn())
    await vi.waitFor(() => expect(executeJavaScript).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(60)
    await capture
    expect(debuggerApi.attach).not.toHaveBeenCalled()
    expect(debuggerApi.detach).not.toHaveBeenCalled()
  })
})
