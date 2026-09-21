export interface ApprovalRequestIdentity {
  id: string
}

export interface ApprovalRequestOptions<Decision> {
  signal?: AbortSignal
  cancelDecision: Decision
}

export interface ApprovalRequestSnapshot<Request> {
  active: Request | null
  queued: Request[]
  pendingCount: number
}

export type ApprovalLifecycleState = 'requested' | 'resolved' | 'cancelled'

export interface ApprovalLifecycleEvent<Request, Decision> {
  request: Request
  state: ApprovalLifecycleState
  decision?: Decision
}

interface PendingApproval<Request, Decision> {
  request: Request
  promise: Promise<Decision>
  resolve: (decision: Decision) => void
  cancelDecision: Decision
  signal?: AbortSignal
  abortListener?: () => void
}

export class ApprovalCoordinator<Request extends ApprovalRequestIdentity, Decision> {
  private readonly pending = new Map<string, PendingApproval<Request, Decision>>()
  private readonly order: string[] = []
  private activeId: string | null = null

  constructor(
    private readonly present: (request: Request, queuedCount: number) => void,
    private readonly lifecycle?: (event: ApprovalLifecycleEvent<Request, Decision>) => void,
  ) {}

  request(request: Request, options: ApprovalRequestOptions<Decision>): Promise<Decision> {
    if (this.pending.has(request.id)) {
      throw new Error(`Approval request already exists: ${request.id}`)
    }

    let settle!: (decision: Decision) => void
    const promise = new Promise<Decision>(resolve => {
      settle = resolve
    })
    const entry: PendingApproval<Request, Decision> = {
      request,
      promise,
      resolve: settle,
      cancelDecision: options.cancelDecision,
      signal: options.signal,
    }
    this.lifecycle?.({ request, state: 'requested' })
    this.pending.set(request.id, entry)
    this.order.push(request.id)

    if (options.signal?.aborted) {
      this.cancel(request.id, options.cancelDecision)
      return promise
    }
    if (options.signal) {
      entry.abortListener = () => this.cancel(request.id, options.cancelDecision)
      options.signal.addEventListener('abort', entry.abortListener, { once: true })
    }

    this.presentNext()
    return promise
  }

  wait(requestId: string): Promise<Decision> {
    const entry = this.pending.get(requestId)
    if (!entry) throw new Error(`Unknown approval request: ${requestId}`)
    return entry.promise
  }

  resolve(requestId: string, decision: Decision): boolean {
    if (requestId !== this.activeId) return false
    return this.settle(requestId, decision, 'resolved')
  }

  cancel(requestId: string, decision: Decision): boolean {
    return this.settle(requestId, decision, 'cancelled')
  }

  cancelAll(decision?: Decision): number {
    const requestIds = [...this.order]
    let cancelled = 0
    for (const requestId of requestIds) {
      const entry = this.pending.get(requestId)
      if (entry && this.cancel(requestId, decision ?? entry.cancelDecision)) cancelled += 1
    }
    return cancelled
  }

  has(requestId: string): boolean {
    return this.pending.has(requestId)
  }

  getActiveRequest(): Request | null {
    return this.activeId ? this.pending.get(this.activeId)?.request ?? null : null
  }

  getSnapshot(): ApprovalRequestSnapshot<Request> {
    const active = this.getActiveRequest()
    const queued = this.order
      .filter(requestId => requestId !== this.activeId)
      .map(requestId => this.pending.get(requestId)?.request)
      .filter((request): request is Request => Boolean(request))
    return { active, queued, pendingCount: this.pending.size }
  }

  private settle(requestId: string, decision: Decision, state: Exclude<ApprovalLifecycleState, 'requested'>): boolean {
    const entry = this.pending.get(requestId)
    if (!entry) return false
    this.lifecycle?.({ request: entry.request, state, decision })
    if (entry.signal && entry.abortListener) {
      entry.signal.removeEventListener('abort', entry.abortListener)
    }
    this.pending.delete(requestId)
    const index = this.order.indexOf(requestId)
    if (index >= 0) this.order.splice(index, 1)
    if (this.activeId === requestId) this.activeId = null
    entry.resolve(decision)
    this.presentNext()
    return true
  }

  private presentNext(): void {
    if (this.activeId !== null) return
    const nextId = this.order.find(requestId => this.pending.has(requestId))
    if (!nextId) return
    this.activeId = nextId
    const entry = this.pending.get(nextId)
    if (!entry) return
    if (entry.signal?.aborted) {
      this.cancel(nextId, entry.cancelDecision)
      return
    }
    this.present(entry.request, Math.max(0, this.pending.size - 1))
  }
}
