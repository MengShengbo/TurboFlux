export class SingleFlightGuard {
  private running = false

  get active(): boolean {
    return this.running
  }

  tryAcquire(): (() => void) | null {
    if (this.running) return null
    this.running = true
    let released = false
    return () => {
      if (released) return
      released = true
      this.running = false
    }
  }
}

export class SerializedAsyncQueue {
  private tail: Promise<void> = Promise.resolve()

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}
