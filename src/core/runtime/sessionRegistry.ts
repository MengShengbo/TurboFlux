import { randomUUID } from 'node:crypto'

export interface SessionIdentityChange {
  previousId: string
  currentId: string
}

type SessionIdentityListener = (change: SessionIdentityChange) => void
type SessionActivationGuard = (nextId: string, currentId: string) => void

export function createSessionId(prefix = 'conv'): string {
  return `${prefix}-${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export class SessionRegistry {
  private currentId: string
  private readonly listeners = new Set<SessionIdentityListener>()
  private readonly guards = new Set<SessionActivationGuard>()

  constructor(initialId = createSessionId()) {
    this.currentId = initialId
  }

  getCurrentId(): string {
    return this.currentId
  }

  createAndActivate(prefix = 'conv'): string {
    const nextId = createSessionId(prefix)
    this.activate(nextId)
    return nextId
  }

  activate(nextId: string): void {
    if (!nextId.trim()) throw new Error('Session id cannot be empty')
    if (nextId === this.currentId) return
    for (const guard of this.guards) guard(nextId, this.currentId)
    const previousId = this.currentId
    this.currentId = nextId
    for (const listener of this.listeners) listener({ previousId, currentId: nextId })
  }

  subscribe(listener: SessionIdentityListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  addGuard(guard: SessionActivationGuard): () => void {
    this.guards.add(guard)
    return () => this.guards.delete(guard)
  }
}
