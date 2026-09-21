import { createOperationAbortError } from '../systems/operationCoordinator'
import { BrowserOperationError } from './browserRuntime'

export const BROWSER_NAVIGATION_TIMEOUT_MS = 45_000

export interface BrowserNavigationTarget {
  loadURL(url: string): Promise<void>
  on(event: string, listener: (...args: any[]) => void): unknown
  removeListener(event: string, listener: (...args: any[]) => void): unknown
  stop(): void
}

export function navigateBrowserDocument(target: BrowserNavigationTarget, url: string, signal?: AbortSignal, timeoutMs = BROWSER_NAVIGATION_TIMEOUT_MS): Promise<void> {
  return waitForBrowserNavigation(target, () => target.loadURL(url), signal, timeoutMs)
}

export async function waitForBrowserNavigation(target: BrowserNavigationTarget, start: () => Promise<void> | void, signal?: AbortSignal, timeoutMs = BROWSER_NAVIGATION_TIMEOUT_MS): Promise<void> {
  if (signal?.aborted) throw createOperationAbortError('Browser operation aborted')
  let timer: ReturnType<typeof setTimeout> | undefined
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const stop = () => { try { target.stop() } catch { /* Destroyed renderer. */ } }
  const fail = (message: string) => rejectReady(new BrowserOperationError('navigation-failed', message))
  const handlers: Record<string, (...args: any[]) => void> = {
    'dom-ready': () => resolveReady(),
    'did-navigate-in-page': (_event, _url, isMainFrame) => { if (isMainFrame) resolveReady() },
    'did-fail-load': (_event, code, description, _url, main) => { if (main && code !== -3) fail(`Browser navigation failed: ${description}`) },
    'render-process-gone': () => fail('Browser renderer exited during navigation'),
    destroyed: () => fail('Browser tab closed during navigation'),
  }
  const abort = () => { rejectReady(createOperationAbortError('Browser operation aborted')); stop() }
  for (const [event, handler] of Object.entries(handlers)) target.on(event, handler)
  signal?.addEventListener('abort', abort, { once: true })
  timer = setTimeout(() => { rejectReady(new BrowserOperationError('navigation-timeout', `Timed out after ${timeoutMs}ms loading browser document`)); stop() }, timeoutMs)
  try {
    const loading = start()
    // History and reload have no promise; loadURL failures must still be observed.
    if (loading) void loading.then(resolveReady, rejectReady)
    await ready
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    for (const [event, handler] of Object.entries(handlers)) target.removeListener(event, handler)
  }
}
