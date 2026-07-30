export interface ApprovalPresentationSnapshot {
  requestId: string | null
  requestedAt?: number
  showAt?: number
  presented: boolean
}

export interface ApprovalPresentationSchedulerOptions {
  idleDelayMs?: number
  now?: () => number
}

interface PendingPresentation {
  requestId: string
  requestedAt: number
  present: () => void
}

export class ApprovalPresentationScheduler {
  private readonly idleDelayMs: number
  private readonly now: () => number
  private pending: PendingPresentation | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private showAt: number | undefined
  private lastComposerActivityAt = Number.NEGATIVE_INFINITY
  private presented = false

  constructor(options: ApprovalPresentationSchedulerOptions = {}) {
    this.idleDelayMs = Math.max(0, options.idleDelayMs ?? 1_000)
    this.now = options.now ?? Date.now
  }

  noteComposerActivity(at = this.now()): void {
    this.lastComposerActivityAt = Math.max(this.lastComposerActivityAt, at)
    if (this.pending && !this.presented) this.schedule()
  }

  request(requestId: string, present: () => void, requestedAt = this.now()): void {
    this.clearTimer()
    this.pending = { requestId, requestedAt, present }
    this.presented = false
    this.schedule()
  }

  cancel(requestId?: string): boolean {
    if (!this.pending || (requestId !== undefined && this.pending.requestId !== requestId)) return false
    this.clearTimer()
    this.pending = null
    this.showAt = undefined
    this.presented = false
    return true
  }

  destroy(): void {
    this.cancel()
  }

  getSnapshot(): ApprovalPresentationSnapshot {
    return {
      requestId: this.pending?.requestId ?? null,
      requestedAt: this.pending?.requestedAt,
      showAt: this.showAt,
      presented: this.presented,
    }
  }

  private schedule(): void {
    const pending = this.pending
    if (!pending || this.presented) return
    this.clearTimer()
    this.showAt = Math.max(pending.requestedAt, this.lastComposerActivityAt + this.idleDelayMs)
    const remaining = Math.max(0, this.showAt - this.now())
    if (remaining === 0) {
      this.present(pending.requestId)
      return
    }
    this.timer = setTimeout(() => this.present(pending.requestId), remaining)
  }

  private present(requestId: string): void {
    if (!this.pending || this.pending.requestId !== requestId || this.presented) return
    this.clearTimer()
    this.presented = true
    this.showAt = this.now()
    this.pending.present()
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }
}
