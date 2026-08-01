export type StreamSchedulingMode = 'smooth' | 'catch-up'

export interface StreamBacklogSnapshot {
  depth: number
  oldestAgeMs: number
}

export interface StreamFlushBatch extends StreamBacklogSnapshot {
  bytes: number
  mode: StreamSchedulingMode
  inputPriority: boolean
  flushedAt: number
}

export interface AdaptiveStreamSchedulerStats {
  flushes: number
  modeTransitions: number
  maxDepth: number
  maxOldestAgeMs: number
  lastBatch: StreamFlushBatch | null
}

export interface AdaptiveStreamSchedulerOptions {
  now?: () => number
  smoothDelayMs?: number
  catchUpDelayMs?: number
  inputPriorityDelayMs?: number
  inputPriorityWindowMs?: number
}

const ENTER_DEPTH = 8
const ENTER_OLDEST_AGE_MS = 120
const SEVERE_DEPTH = 64
const SEVERE_OLDEST_AGE_MS = 300
const REENTRY_HOLD_MS = 250

export class AdaptiveStreamScheduler {
  private readonly now: () => number
  private readonly smoothDelayMs: number
  private readonly catchUpDelayMs: number
  private readonly inputPriorityDelayMs: number
  private readonly inputPriorityWindowMs: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private dueAt: number | null = null
  private depth = 0
  private bytes = 0
  private oldestQueuedAt: number | null = null
  private inputPriorityUntil = Number.NEGATIVE_INFINITY
  private mode: StreamSchedulingMode = 'smooth'
  private lastCatchUpExitAt = Number.NEGATIVE_INFINITY
  private stats: AdaptiveStreamSchedulerStats = {
    flushes: 0,
    modeTransitions: 0,
    maxDepth: 0,
    maxOldestAgeMs: 0,
    lastBatch: null,
  }

  constructor(
    private readonly flush: (batch: StreamFlushBatch) => void,
    options: AdaptiveStreamSchedulerOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.smoothDelayMs = Math.max(1, options.smoothDelayMs ?? 64)
    this.catchUpDelayMs = Math.max(1, options.catchUpDelayMs ?? 48)
    this.inputPriorityDelayMs = Math.max(1, options.inputPriorityDelayMs ?? 32)
    this.inputPriorityWindowMs = Math.max(0, options.inputPriorityWindowMs ?? 250)
  }

  enqueue(byteLength = 0): void {
    const now = this.now()
    if (this.oldestQueuedAt === null) this.oldestQueuedAt = now
    this.depth += 1
    this.bytes += Math.max(0, Math.floor(byteLength))
    const oldestAgeMs = this.oldestAge(now)
    this.stats.maxDepth = Math.max(this.stats.maxDepth, this.depth)
    this.stats.maxOldestAgeMs = Math.max(this.stats.maxOldestAgeMs, oldestAgeMs)
    this.updateMode(now, oldestAgeMs)
    this.schedule(now)
  }

  noteInput(at = this.now()): void {
    this.inputPriorityUntil = Math.max(this.inputPriorityUntil, at + this.inputPriorityWindowMs)
    if (this.depth > 0) this.schedule(at)
  }

  flushNow(): boolean {
    if (this.depth === 0) {
      this.clearTimer()
      return false
    }
    const now = this.now()
    const batch: StreamFlushBatch = {
      depth: this.depth,
      bytes: this.bytes,
      oldestAgeMs: this.oldestAge(now),
      mode: this.mode,
      inputPriority: now <= this.inputPriorityUntil,
      flushedAt: now,
    }
    this.clearTimer()
    this.depth = 0
    this.bytes = 0
    this.oldestQueuedAt = null
    this.stats.flushes += 1
    this.stats.maxOldestAgeMs = Math.max(this.stats.maxOldestAgeMs, batch.oldestAgeMs)
    this.stats.lastBatch = { ...batch }
    if (this.mode === 'catch-up') {
      this.mode = 'smooth'
      this.lastCatchUpExitAt = now
      this.stats.modeTransitions += 1
    }
    this.flush(batch)
    return true
  }

  cancel(): void {
    this.clearTimer()
    this.depth = 0
    this.bytes = 0
    this.oldestQueuedAt = null
    if (this.mode === 'catch-up') this.stats.modeTransitions += 1
    this.mode = 'smooth'
  }

  getBacklogSnapshot(): StreamBacklogSnapshot {
    return { depth: this.depth, oldestAgeMs: this.oldestAge(this.now()) }
  }

  getStats(): AdaptiveStreamSchedulerStats {
    return {
      ...this.stats,
      lastBatch: this.stats.lastBatch ? { ...this.stats.lastBatch } : null,
    }
  }

  private updateMode(now: number, oldestAgeMs: number): void {
    if (this.mode === 'catch-up') return
    const pressure = this.depth >= ENTER_DEPTH || oldestAgeMs >= ENTER_OLDEST_AGE_MS
    if (!pressure) return
    const severe = this.depth >= SEVERE_DEPTH || oldestAgeMs >= SEVERE_OLDEST_AGE_MS
    if (!severe && now - this.lastCatchUpExitAt < REENTRY_HOLD_MS) return
    this.mode = 'catch-up'
    this.stats.modeTransitions += 1
  }

  private schedule(now: number): void {
    const inputPriority = now <= this.inputPriorityUntil
    const delay = inputPriority
      ? this.inputPriorityDelayMs
      : this.mode === 'catch-up'
        ? this.catchUpDelayMs
        : this.smoothDelayMs
    const nextDueAt = now + delay
    if (this.timer && this.dueAt !== null && this.dueAt <= nextDueAt) return
    this.clearTimer()
    this.dueAt = nextDueAt
    this.timer = setTimeout(() => this.flushNow(), delay)
  }

  private oldestAge(now: number): number {
    return this.oldestQueuedAt === null ? 0 : Math.max(0, now - this.oldestQueuedAt)
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.dueAt = null
  }
}
