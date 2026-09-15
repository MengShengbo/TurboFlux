import { createThreadFlowState, reduceFlowEvent, type ThreadFlowState } from './flowReducer'
import type { AnyFlowEvent } from '../../shared/flowEvents'

export interface FlowStoreSnapshot {
  revision: number
  activeThreadId: string | null
  threads: Readonly<Record<string, ThreadFlowState>>
}

export type FlowStoreListener = () => void

export interface FlowStoreOptions {
  maxThreads?: number
}

const DEFAULT_MAX_FLOW_THREADS = 8

export class FlowStore {
  private readonly listeners = new Set<FlowStoreListener>()
  private snapshot: FlowStoreSnapshot = { revision: 0, activeThreadId: null, threads: {} }
  private readonly maxThreads: number

  constructor(options: FlowStoreOptions = {}) {
    this.maxThreads = Number.isFinite(options.maxThreads)
      ? Math.max(1, Math.floor(options.maxThreads!))
      : DEFAULT_MAX_FLOW_THREADS
  }

  getSnapshot = (): FlowStoreSnapshot => this.snapshot

  getThread(threadId: string): ThreadFlowState | undefined {
    return this.snapshot.threads[threadId]
  }

  activateThread(sessionId: string, threadId: string): ThreadFlowState {
    const thread = this.ensureThread(sessionId, threadId)
    if (this.snapshot.activeThreadId !== threadId) {
      this.snapshot = {
        ...this.snapshot,
        revision: this.snapshot.revision + 1,
        activeThreadId: threadId,
        threads: this.retainRecentThreads(this.snapshot.threads, threadId),
      }
      this.emit()
    }
    return thread
  }

  resetThread(sessionId: string, threadId: string): ThreadFlowState {
    const thread = createThreadFlowState(sessionId, threadId)
    this.snapshot = {
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      activeThreadId: threadId,
      threads: this.retainRecentThreads({ ...this.snapshot.threads, [threadId]: thread }, threadId),
    }
    this.emit()
    return thread
  }

  dispatch(event: AnyFlowEvent): ThreadFlowState {
    const current = this.ensureThread(event.sessionId, event.threadId)
    const next = reduceFlowEvent(current, event)
    if (next === current) return current
    this.snapshot = {
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      threads: this.retainRecentThreads({ ...this.snapshot.threads, [event.threadId]: next }, this.snapshot.activeThreadId),
    }
    this.emit()
    return next
  }

  subscribe = (listener: FlowStoreListener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private ensureThread(sessionId: string, threadId: string): ThreadFlowState {
    const existing = this.snapshot.threads[threadId]
    if (existing) return existing
    const created = createThreadFlowState(sessionId, threadId)
    this.snapshot = {
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      threads: { ...this.snapshot.threads, [threadId]: created },
    }
    return created
  }

  private retainRecentThreads(
    threads: Readonly<Record<string, ThreadFlowState>>,
    protectedThreadId: string | null,
  ): Readonly<Record<string, ThreadFlowState>> {
    const entries = Object.entries(threads)
    if (entries.length <= this.maxThreads) return threads
    const retained = entries
      .map((entry, insertionIndex) => ({ entry, insertionIndex }))
      .filter(({ entry: [threadId] }) => threadId !== protectedThreadId)
      .sort((left, right) => (
        right.entry[1].lastEventAt - left.entry[1].lastEventAt
        || right.entry[1].lastSeq - left.entry[1].lastSeq
        || right.insertionIndex - left.insertionIndex
      ))
      .slice(0, Math.max(0, this.maxThreads - (protectedThreadId && threads[protectedThreadId] ? 1 : 0)))
      .map(({ entry }) => entry)
    if (protectedThreadId && threads[protectedThreadId]) retained.push([protectedThreadId, threads[protectedThreadId]])
    return Object.fromEntries(retained)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
