import type { AnyFlowEvent } from '../../shared/flowEvents'
import { createThreadFlowState, reduceFlowEvent, type ThreadFlowState } from './flowReducer'

export interface FlowStoreSnapshot {
  revision: number
  activeThreadId: string | null
  threads: Readonly<Record<string, ThreadFlowState>>
}

export type FlowStoreListener = () => void

export class FlowStore {
  private readonly listeners = new Set<FlowStoreListener>()
  private snapshot: FlowStoreSnapshot = { revision: 0, activeThreadId: null, threads: {} }

  getSnapshot = (): FlowStoreSnapshot => this.snapshot

  getThread(threadId: string): ThreadFlowState | undefined {
    return this.snapshot.threads[threadId]
  }

  activateThread(sessionId: string, threadId: string): ThreadFlowState {
    const thread = this.ensureThread(sessionId, threadId)
    if (this.snapshot.activeThreadId !== threadId) {
      this.snapshot = { ...this.snapshot, revision: this.snapshot.revision + 1, activeThreadId: threadId }
      this.emit()
    }
    return thread
  }

  dispatch(event: AnyFlowEvent): ThreadFlowState {
    const current = this.ensureThread(event.sessionId, event.threadId)
    const next = reduceFlowEvent(current, event)
    if (next === current) return current
    this.snapshot = {
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      threads: { ...this.snapshot.threads, [event.threadId]: next },
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

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
