import { AsyncLocalStorage } from 'node:async_hooks'
import { createOperationAbortError } from '../systems/operationCoordinator'

export const BROWSER_COMMAND_TIMEOUT_MS = 5_000
export const BROWSER_TOOL_TIMEOUT_MS = 60_000

export class BrowserOperationError extends Error {
  constructor(readonly code: string, message: string, readonly recovery = 'Observe the current page and verify the result before retrying any action.') {
    super(message)
    this.name = 'BrowserOperationError'
  }
}

/** Bounds renderer/CDP calls, including calls that never settle after a crash. */
export class BrowserRuntime {
  private readonly context = new AsyncLocalStorage<AbortSignal>()

  get signal(): AbortSignal | undefined { return this.context.getStore() }

  assertActive(): void {
    if (this.signal?.aborted) throw this.abortReason(this.signal)
  }

  async run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new BrowserOperationError('operation-timeout', 'Browser operation exceeded its 60 second deadline')), BROWSER_TOOL_TIMEOUT_MS)
    try {
      return await this.context.run(controller.signal, () => this.call(work, BROWSER_TOOL_TIMEOUT_MS))
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      // Any continuation of a timed-out command must stop before issuing more work.
      controller.abort()
    }
  }

  async call<T>(work: () => Promise<T>, timeoutMs = BROWSER_COMMAND_TIMEOUT_MS): Promise<T> {
    this.assertActive()
    const signal = this.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const boundary = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(this.abortReason(signal!))
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => reject(new BrowserOperationError('command-timeout', `Browser command did not respond within ${timeoutMs}ms`)), timeoutMs)
    })
    try {
      const result = await Promise.race([Promise.resolve().then(() => { this.assertActive(); return work() }), boundary])
      this.assertActive()
      return result
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
    }
  }

  async delay(milliseconds: number): Promise<void> {
    this.assertActive()
    const signal = this.signal
    await new Promise<void>((resolve, reject) => {
      const finish = () => { signal?.removeEventListener('abort', abort); resolve() }
      const timer = setTimeout(finish, milliseconds)
      const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(this.abortReason(signal!)) }
      signal?.addEventListener('abort', abort, { once: true })
    })
    this.assertActive()
  }

  private abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof BrowserOperationError ? signal.reason : createOperationAbortError('Browser operation aborted')
  }
}

export function browserFailure(error: unknown, operation: string, tabId?: string) {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof BrowserOperationError ? error.code
    : /stale|detached|destroyed|context.*(lost|destroyed)/i.test(message) ? 'stale-reference'
    : /disabled|not editable|read.only|obscured|not visible/i.test(message) ? 'not-actionable'
    : /timed out|timeout/i.test(message) ? 'timeout'
    : 'operation-failed'
  return {
    operation, tabId, code, message,
    recovery: error instanceof BrowserOperationError ? error.recovery
      : code === 'stale-reference' ? 'Call observe or find on this tab to obtain fresh refs. Do not reuse the old ref.'
        : 'Inspect diagnostics and the current page. Verify whether the action already took effect before retrying.',
    retrySafe: ['observe', 'find', 'inspect', 'diagnostics', 'wait', 'assert', 'tabs', 'capabilities', 'screenshot', 'visual_observe'].includes(operation),
  }
}
