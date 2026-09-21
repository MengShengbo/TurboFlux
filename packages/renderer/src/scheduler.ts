export interface FrameClock {
  request(callback: () => void): number
  cancel(handle: number): void
}

interface RenderJob {
  priority: number
  render: () => void
}

/** One pending job per surface. State changes stay synchronous; DOM work is batched. */
export class RenderScheduler {
  private readonly jobs = new Map<string, RenderJob>()
  private frame: number | null = null
  private flushing = false
  private disposed = false

  constructor(
    private readonly clock: FrameClock = {
      request: callback => requestAnimationFrame(callback),
      cancel: handle => cancelAnimationFrame(handle),
    },
    private readonly onError: (error: unknown, surface: string) => void = error => {
      queueMicrotask(() => { throw error })
    },
  ) {}

  schedule(surface: string, render: () => void, priority = 0): void {
    if (this.disposed) return
    this.jobs.set(surface, { render, priority })
    this.requestFrame()
  }

  cancel(surface: string): void {
    this.jobs.delete(surface)
    if (!this.jobs.size && this.frame !== null) {
      this.clock.cancel(this.frame)
      this.frame = null
    }
  }

  flush(): void {
    if (this.disposed || this.flushing) return
    if (this.frame !== null) this.clock.cancel(this.frame)
    this.frame = null
    this.flushing = true
    const surfaces = [...this.jobs].sort((a, b) => a[1].priority - b[1].priority).map(([key]) => key)
    try {
      for (const surface of surfaces) {
        const job = this.jobs.get(surface)
        if (!job || this.disposed) continue
        this.jobs.delete(surface)
        try { job.render() } catch (error) { this.onError(error, surface) }
      }
    } finally {
      this.flushing = false
      this.requestFrame()
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.frame !== null) this.clock.cancel(this.frame)
    this.frame = null
    this.jobs.clear()
  }

  private requestFrame(): void {
    if (!this.disposed && !this.flushing && this.frame === null && this.jobs.size) {
      this.frame = this.clock.request(() => {
        this.frame = null
        this.flush()
      })
    }
  }
}
