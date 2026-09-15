export interface OperationExecutionOptions {
  externalSignal?: AbortSignal
  onAbort?: () => void
  allowEpochChange?: boolean
}

export function createOperationAbortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export function isOperationAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function assertOperationActive(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) throw createOperationAbortError(message)
}

export function abortableDelay(milliseconds: number, signal: AbortSignal | undefined, message: string): Promise<void> {
  if (signal?.aborted) return Promise.reject(createOperationAbortError(message))
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(resolvePromise, milliseconds)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(createOperationAbortError(message))
    }, { once: true })
  })
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {}
  const abort = () => target.abort(source.reason)
  if (source.aborted) abort()
  else source.addEventListener('abort', abort, { once: true })
  return () => source.removeEventListener('abort', abort)
}

export class SerializedOperationCoordinator {
  private queue: Promise<void> = Promise.resolve()
  private epoch = 0
  private activeController: AbortController | null = null

  constructor(private readonly abortMessage: string) {}

  enqueue<T>(
    work: (signal: AbortSignal) => Promise<T>,
    options: OperationExecutionOptions = {},
  ): Promise<T> {
    const epoch = this.epoch
    const operation = async () => {
      if (epoch !== this.epoch) throw createOperationAbortError(this.abortMessage)
      const controller = new AbortController()
      const handleAbort = () => options.onAbort?.()
      controller.signal.addEventListener('abort', handleAbort, { once: true })
      const stopForwarding = forwardAbort(options.externalSignal, controller)
      this.activeController = controller
      try {
        assertOperationActive(controller.signal, this.abortMessage)
        const result = await work(controller.signal)
        assertOperationActive(controller.signal, this.abortMessage)
        if (!options.allowEpochChange && epoch !== this.epoch) {
          throw createOperationAbortError(this.abortMessage)
        }
        return result
      } catch (error) {
        if (controller.signal.aborted || isOperationAbort(error)) {
          throw createOperationAbortError(this.abortMessage)
        }
        throw error
      } finally {
        stopForwarding()
        controller.signal.removeEventListener('abort', handleAbort)
        if (this.activeController === controller) this.activeController = null
      }
    }
    const queued = this.queue.then(operation, operation)
    this.queue = queued.then(() => undefined, () => undefined)
    return queued
  }

  invalidate(abortActive = true): void {
    this.epoch += 1
    if (abortActive) this.activeController?.abort(createOperationAbortError(this.abortMessage))
  }

  async drain(): Promise<void> {
    await this.queue
  }
}
