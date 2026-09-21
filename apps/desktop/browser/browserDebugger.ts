import type { Debugger } from 'electron'
import { BrowserOperationError, type BrowserRuntime } from './browserRuntime'

const queues = new WeakMap<Debugger, Promise<void>>()

/** One lease per WebContents: capture, upload and input must not detach each other. */
export async function withBrowserDebugger<T>(api: Debugger, runtime: BrowserRuntime, work: (send: (method: string, params?: Record<string, unknown>) => Promise<any>) => Promise<T>): Promise<T> {
  const previous = queues.get(api) || Promise.resolve()
  let cancelled = false
  const task = previous.then(async () => {
    runtime.assertActive()
    if (cancelled) throw new BrowserOperationError('debugger-timeout', 'Debugger lease expired before it became available')
    const attachedHere = !api.isAttached()
    if (attachedHere) {
      try { api.attach('1.3') } catch { throw new BrowserOperationError('debugger-unavailable', 'Browser debugger is unavailable; close DevTools and inspect the page before retrying') }
    }
    try {
      return await runtime.call(() => work((method, params) => runtime.call(() => api.sendCommand(method, params))), 15_000)
    } finally {
      if (attachedHere && api.isAttached()) {
        try { api.detach() } catch { /* The renderer may have exited during the command. */ }
      }
    }
  })
  const settled = task.then(() => undefined, () => undefined)
  queues.set(api, settled)
  void settled.then(() => { if (queues.get(api) === settled) queues.delete(api) })
  try { return await runtime.call(() => task, 20_000) } finally { cancelled = true }
}
