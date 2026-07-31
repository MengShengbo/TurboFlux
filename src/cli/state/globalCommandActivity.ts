export interface GlobalCommandActivity {
  id: number
  command: string
  detail: string
  startedAt: number
}

export type GlobalCommandOperation<T> = () => T | Promise<T>

export interface GlobalCommandActivityControllerOptions {
  now?: () => number
  yieldToRenderer?: () => Promise<void>
}

function yieldToRenderer(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

export class GlobalCommandActivityController {
  private activity: GlobalCommandActivity | null = null
  private readonly listeners = new Set<() => void>()
  private readonly now: () => number
  private readonly yieldBeforeWork: () => Promise<void>
  private sequence = 0
  private queue: Promise<void> | null = null

  constructor(options: GlobalCommandActivityControllerOptions = {}) {
    this.now = options.now ?? Date.now
    this.yieldBeforeWork = options.yieldToRenderer ?? yieldToRenderer
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): GlobalCommandActivity | null => this.activity

  run<T>(command: string, detail: string, operation: GlobalCommandOperation<T>): Promise<T> {
    const execute = async (): Promise<T> => {
      const activity: GlobalCommandActivity = {
        id: ++this.sequence,
        command,
        detail,
        startedAt: this.now(),
      }
      this.setActivity(activity)
      try {
        await this.yieldBeforeWork()
        return await operation()
      } finally {
        if (this.activity?.id === activity.id) this.setActivity(null)
      }
    }

    const result = this.queue ? this.queue.then(execute) : execute()
    const queue = result.then(() => undefined, () => undefined)
    this.queue = queue
    void queue.then(() => {
      if (this.queue === queue) this.queue = null
    })
    return result
  }

  destroy(): void {
    this.activity = null
    this.listeners.clear()
  }

  private setActivity(activity: GlobalCommandActivity | null): void {
    this.activity = activity
    for (const listener of this.listeners) listener()
  }
}
