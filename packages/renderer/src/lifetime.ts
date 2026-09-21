/** Every mounted surface owns its listeners, observers, timers and subscriptions. */
export class RenderLifetime {
  private readonly cleanups = new Set<() => void>()
  private readonly frames = new Map<number, () => void>()
  private readonly timers = new Map<number, () => void>()
  readonly controller = new AbortController()

  get disposed(): boolean { return this.controller.signal.aborted }

  add(cleanup: (() => void) | void): () => void {
    if (!cleanup) return () => undefined
    if (this.disposed) { cleanup(); return () => undefined }
    let active = true
    const release = () => {
      if (!active) return
      active = false
      this.cleanups.delete(release)
      cleanup()
    }
    this.cleanups.add(release)
    return release
  }

  listen<K extends keyof WindowEventMap>(target: Window, event: K, listener: (event: WindowEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void
  listen<K extends keyof DocumentEventMap>(target: Document, event: K, listener: (event: DocumentEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void
  listen(target: EventTarget, event: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void
  listen(target: EventTarget, event: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void {
    target.addEventListener(event, listener, { ...(typeof options === 'boolean' ? { capture: options } : options), signal: this.controller.signal })
  }

  guard<T extends unknown[]>(callback: (...args: T) => void): (...args: T) => void {
    return (...args) => { if (!this.disposed) callback(...args) }
  }

  frame(callback: FrameRequestCallback): number {
    if (this.disposed) return -1
    const handle = window.requestAnimationFrame(time => {
      this.frames.get(handle)?.()
      this.frames.delete(handle)
      if (!this.disposed) callback(time)
    })
    this.frames.set(handle, this.add(() => window.cancelAnimationFrame(handle)))
    return handle
  }

  cancelFrame(handle: number): void {
    this.frames.get(handle)?.()
    this.frames.delete(handle)
  }

  timeout(callback: () => void, delay: number): number {
    if (this.disposed) return -1
    const handle = window.setTimeout(() => {
      this.timers.get(handle)?.()
      this.timers.delete(handle)
      if (!this.disposed) callback()
    }, delay)
    this.timers.set(handle, this.add(() => window.clearTimeout(handle)))
    return handle
  }

  clearTimeout(handle: number): void {
    this.timers.get(handle)?.()
    this.timers.delete(handle)
  }

  dispose(): void {
    if (this.disposed) return
    this.controller.abort()
    const errors: unknown[] = []
    for (const release of [...this.cleanups].reverse()) {
      try { release() } catch (error) { errors.push(error) }
    }
    this.frames.clear()
    this.timers.clear()
    if (errors.length) throw new AggregateError(errors, 'Unable to dispose renderer resources')
  }
}
