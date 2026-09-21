import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  AgentAttachment,
  BrowserSystemEvent,
} from '@turboflux/contracts'
import { assertOperationActive } from '../systems/operationCoordinator'
import { withBrowserDebugger } from './browserDebugger'
import { BrowserRuntime } from './browserRuntime'
import type { BrowserTab } from './browserTypes'

const BROWSER_OPERATION_ABORT_MESSAGE = 'Browser operation aborted'

export interface BrowserViewportCapture {
  tabId: string
  path: string
  title: string
  url: string
  viewport: { width: number; height: number; deviceScaleFactor: number }
  attachment: AgentAttachment
}

export async function captureBrowserViewport(
  tab: BrowserTab,
  storageRoot: string,
  emit: (event: BrowserSystemEvent) => void,
  signal?: AbortSignal,
  runtime = new BrowserRuntime(),
): Promise<BrowserViewportCapture> {
  assertOperationActive(signal, BROWSER_OPERATION_ABORT_MESSAGE)
  const directory = join(storageRoot, 'captures', 'browser')
  await mkdir(directory, { recursive: true })
  assertOperationActive(signal, BROWSER_OPERATION_ABORT_MESSAGE)
  const { bytes, viewport } = await captureRenderedViewport(tab, runtime, signal)
  const capturedAt = Date.now()
  const filename = `browser-${capturedAt}-${safeFilename(tab.id)}.png`
  const path = join(directory, filename)
  await writeFile(path, bytes, { mode: 0o600 })
  assertOperationActive(signal, BROWSER_OPERATION_ABORT_MESSAGE)
  const attachment: AgentAttachment = {
    id: `browser-visual-${tab.id}-${capturedAt}`,
    type: 'image',
    path,
    mime: 'image/png',
    filename,
    size: bytes.length,
  }
  emit({ type: 'artifact-ready', path, name: filename, mime: 'image/png', kind: 'screenshot', tabId: tab.id, title: tab.title, url: tab.url })
  return { tabId: tab.id, path, title: tab.title, url: tab.url, viewport, attachment }
}

async function captureRenderedViewport(tab: BrowserTab, runtime: BrowserRuntime, signal?: AbortSignal): Promise<{
  bytes: Buffer
  viewport: { width: number; height: number; deviceScaleFactor: number }
}> {
  assertOperationActive(signal, BROWSER_OPERATION_ABORT_MESSAGE)
  const debuggerApi = tab.view.webContents.debugger
  return withBrowserDebugger(debuggerApi, runtime, async send => {
    const viewport = await waitForRenderedViewport(tab, runtime, signal)
    const metrics = await send('Page.getLayoutMetrics') as {
      cssVisualViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number }
    }
    const visualViewport = metrics.cssVisualViewport
    const clip = visualViewport && visualViewport.clientWidth >= 2 && visualViewport.clientHeight >= 2
      ? {
          x: visualViewport.pageX,
          y: visualViewport.pageY,
          width: visualViewport.clientWidth,
          height: visualViewport.clientHeight,
          scale: 1,
        }
      : undefined
    const capture = await send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
      ...(clip ? { clip } : {}),
    }) as { data?: string }
    assertOperationActive(signal, BROWSER_OPERATION_ABORT_MESSAGE)
    const bytes = capture.data ? Buffer.from(capture.data, 'base64') : Buffer.alloc(0)
    if (bytes.length === 0) throw new Error('Browser viewport capture produced no image data')
    return { bytes, viewport }
  })
}

async function waitForRenderedViewport(tab: BrowserTab, runtime: BrowserRuntime, signal?: AbortSignal): Promise<BrowserViewportCapture['viewport']> {
  let previous: BrowserViewportCapture['viewport'] | undefined
  // Opening or resizing the native view can briefly report a zero or changing viewport.
  // Poll from the host: animation frames can be suspended while the view is hidden.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    assertOperationActive(signal, BROWSER_OPERATION_ABORT_MESSAGE)
    const viewport = await runtime.call(() => tab.view.webContents.executeJavaScript(`({
      width: window.innerWidth,
      height: window.innerHeight,
      deviceScaleFactor: window.devicePixelRatio || 1,
    })`, true)) as BrowserViewportCapture['viewport']
    assertOperationActive(signal, BROWSER_OPERATION_ABORT_MESSAGE)
    if (viewport.width >= 2 && viewport.height >= 2
      && viewport.width === previous?.width && viewport.height === previous.height
      && viewport.deviceScaleFactor === previous.deviceScaleFactor) return viewport
    previous = viewport
    await runtime.delay(50)
  }
  throw new Error('Browser viewport did not become ready for visual capture within 2 seconds')
}

function safeFilename(value: string): string {
  return basename(value).replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 120) || 'capture'
}
