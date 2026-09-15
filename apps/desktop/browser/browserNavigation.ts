import { createOperationAbortError } from '../systems/operationCoordinator'

export const BROWSER_NAVIGATION_TIMEOUT_MS = 45_000

export interface BrowserNavigationTarget {
  loadURL(url: string): Promise<void>
  once(event: 'dom-ready', listener: () => void): void
  removeListener(event: 'dom-ready', listener: () => void): void
  stop(): void
}

export async function navigateBrowserDocument(
  target: BrowserNavigationTarget,
  url: string,
  signal?: AbortSignal,
  timeoutMs = BROWSER_NAVIGATION_TIMEOUT_MS,
): Promise<void> {
  if (signal?.aborted) {
    target.stop()
    throw createOperationAbortError('Browser operation aborted')
  }

  let timeout: ReturnType<typeof setTimeout> | undefined
  let rejectBoundary: ((error: Error) => void) | undefined
  let resolveDocumentReady: (() => void) | undefined
  const onDocumentReady = () => resolveDocumentReady?.()
  const documentReady = new Promise<void>(resolve => {
    resolveDocumentReady = resolve
    target.once('dom-ready', onDocumentReady)
  })
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject
    timeout = setTimeout(() => {
      target.stop()
      reject(new Error(`Timed out after ${timeoutMs}ms loading browser document`))
    }, timeoutMs)
  })
  const abort = () => {
    target.stop()
    rejectBoundary?.(createOperationAbortError('Browser operation aborted'))
  }
  signal?.addEventListener('abort', abort, { once: true })

  try {
    await Promise.race([target.loadURL(url), documentReady, boundary])
  } finally {
    if (timeout) clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
    target.removeListener('dom-ready', onDocumentReady)
  }
}
