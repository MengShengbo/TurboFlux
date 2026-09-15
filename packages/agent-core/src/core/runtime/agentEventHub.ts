import { emitStreamTimingTrace, streamTimingTraceEnabled, summarizeTimings } from './streamTimingTrace'

export type AgentEventSink<TEvent> = (event: TEvent) => void

interface AgentEventHubOptions {
  traceScope?: string
  traceEnabled?: () => boolean
  now?: () => number
  reportTrace?: (scope: string, detail: Record<string, unknown>) => void
}

export class AgentEventHub<TEvent extends { type: string }> {
  private readonly listeners = new Set<AgentEventSink<TEvent>>()
  private recorder: AgentEventSink<TEvent> | null = null
  private suppressionDepth = 0
  private traceStartedAt: number | null = null
  private traceLastEventAt: number | null = null
  private readonly traceRecorderDurations = new Map<string, number[]>()
  private readonly traceListenerDurations = new Map<string, number[]>()
  private readonly traceEventIntervals = new Map<string, number[]>()
  private readonly traceScope: string
  private readonly traceEnabled: () => boolean
  private readonly now: () => number
  private readonly reportTrace: (scope: string, detail: Record<string, unknown>) => void

  constructor(options: AgentEventHubOptions = {}) {
    this.traceScope = options.traceScope ?? 'agent-engine'
    this.traceEnabled = options.traceEnabled ?? streamTimingTraceEnabled
    this.now = options.now ?? (() => performance.now())
    this.reportTrace = options.reportTrace ?? emitStreamTimingTrace
  }

  setRecorder(recorder: AgentEventSink<TEvent> | null): void {
    this.recorder = recorder
  }

  subscribe(listener: AgentEventSink<TEvent>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  suppress(): () => void {
    this.suppressionDepth += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.suppressionDepth = Math.max(0, this.suppressionDepth - 1)
    }
  }

  clear(): void {
    this.listeners.clear()
    this.recorder = null
    this.suppressionDepth = 0
    this.resetTrace()
  }

  emit(event: TEvent): void {
    if (this.suppressionDepth > 0) return
    const traceEnabled = this.traceEnabled()
    const emitStartedAt = traceEnabled ? this.now() : 0
    if (traceEnabled && event.type === 'stream:start') {
      this.traceStartedAt = emitStartedAt
      this.traceLastEventAt = emitStartedAt
      this.traceRecorderDurations.clear()
      this.traceListenerDurations.clear()
      this.traceEventIntervals.clear()
    }

    const recorderStartedAt = traceEnabled ? this.now() : 0
    this.recorder?.(event)
    const listenerStartedAt = traceEnabled ? this.now() : 0
    for (const listener of this.listeners) listener(event)

    if (!traceEnabled || this.traceStartedAt === null || this.traceLastEventAt === null) return
    const completedAt = this.now()
    this.appendTraceSample(this.traceRecorderDurations, event.type, listenerStartedAt - recorderStartedAt)
    this.appendTraceSample(this.traceListenerDurations, event.type, completedAt - listenerStartedAt)
    this.appendTraceSample(this.traceEventIntervals, event.type, emitStartedAt - this.traceLastEventAt)
    this.traceLastEventAt = emitStartedAt
    if (event.type !== 'stream:end') return

    this.reportTrace(this.traceScope, {
      totalMs: Number((completedAt - this.traceStartedAt).toFixed(3)),
      recorder: this.summarizeTraceMap(this.traceRecorderDurations),
      listeners: this.summarizeTraceMap(this.traceListenerDurations),
      intervals: this.summarizeTraceMap(this.traceEventIntervals),
    })
    this.resetTrace()
  }

  private appendTraceSample(target: Map<string, number[]>, type: string, value: number): void {
    const samples = target.get(type) ?? []
    samples.push(value)
    target.set(type, samples)
  }

  private summarizeTraceMap(source: Map<string, number[]>): Record<string, ReturnType<typeof summarizeTimings>> {
    return Object.fromEntries(
      [...source.entries()].map(([type, samples]) => [type, summarizeTimings(samples)]),
    )
  }

  private resetTrace(): void {
    this.traceStartedAt = null
    this.traceLastEventAt = null
    this.traceRecorderDurations.clear()
    this.traceListenerDurations.clear()
    this.traceEventIntervals.clear()
  }
}
