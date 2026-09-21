export interface ModelStreamSnapshot {
  active: boolean
  streamId?: number
  aborted: boolean
}

export class ModelStreamControl {
  private activeStream: { id: number; signal?: AbortSignal } | null = null

  constructor(private readonly createStreamId: () => number = () => Date.now() + Math.floor(Math.random() * 1_000_000)) {}

  async run<T>(signal: AbortSignal | undefined, operation: (streamId: number) => Promise<T>): Promise<T> {
    if (this.activeStream) throw new Error(`Model stream ${this.activeStream.id} is already active`)
    const streamId = this.createStreamId()
    this.activeStream = { id: streamId, signal }
    try {
      return await operation(streamId)
    } finally {
      if (this.activeStream?.id === streamId) this.activeStream = null
    }
  }

  abortActive(abort: (streamId: number) => void | Promise<void>): boolean {
    const streamId = this.activeStream?.id
    if (streamId === undefined) return false
    void Promise.resolve(abort(streamId)).catch(() => {})
    return true
  }

  clear(): void {
    this.activeStream = null
  }

  getSnapshot(): ModelStreamSnapshot {
    return {
      active: this.activeStream !== null,
      streamId: this.activeStream?.id,
      aborted: this.activeStream?.signal?.aborted === true,
    }
  }
}
