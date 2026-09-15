/** Coordinates tasks that share one foreground computer input surface. */
export class ExclusiveControlLease {
  private owner: string | null = null

  get ownerId(): string | null {
    return this.owner
  }

  acquire(ownerId: string): boolean {
    if (!ownerId.trim()) throw new Error('Control ownership requires a task ID')
    if (this.owner !== null && this.owner !== ownerId) return false
    this.owner = ownerId
    return true
  }

  release(ownerId: string): boolean {
    if (this.owner !== ownerId) return false
    this.owner = null
    return true
  }

  reset(): void {
    this.owner = null
  }
}
