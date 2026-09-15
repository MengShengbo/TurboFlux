import type { AgentRunInterruption } from '../../shared/agentTypes'

export type AgentRunInterruptionKind = AgentRunInterruption['kind']

export interface AgentRunInterruptionError extends Error {
  aborted: true
  paused: boolean
  interruption: AgentRunInterruptionKind
}

export interface AgentRunControlSnapshot {
  active: boolean
  paused: boolean
  generation: number
  runAborted: boolean
  operationAborted: boolean
}

export interface AgentRunPauseOptions {
  interruptOperation?: boolean
}

export function createAgentRunInterruption(kind: AgentRunInterruptionKind): AgentRunInterruptionError {
  const error = new Error(kind === 'pause' ? 'paused' : 'aborted') as AgentRunInterruptionError
  error.name = 'AgentRunInterruptionError'
  error.aborted = true
  error.paused = kind === 'pause'
  error.interruption = kind
  return error
}

export function isAgentRunInterruption(error: unknown, kind?: AgentRunInterruptionKind): error is AgentRunInterruptionError {
  const candidate = error as Partial<AgentRunInterruptionError> | null | undefined
  return candidate?.aborted === true
    && (candidate.interruption === 'pause' || candidate.interruption === 'stop')
    && (kind === undefined || candidate.interruption === kind)
}

export function interruptionMetadata(kind: AgentRunInterruptionKind): AgentRunInterruption {
  return { kind, resumable: kind === 'pause' }
}

export function resolveAgentRunInterruption(
  signal?: AbortSignal,
  error?: unknown,
): AgentRunInterruption | undefined {
  for (const candidate of [signal?.reason, error]) {
    if (isAgentRunInterruption(candidate)) return interruptionMetadata(candidate.interruption)
  }
  if (signal?.aborted || (error as { aborted?: boolean } | null | undefined)?.aborted === true) {
    return interruptionMetadata('stop')
  }
  return undefined
}

export class AgentRunControl {
  private runController: AbortController | null = null
  private operationController: AbortController | null = null
  private active = false
  private paused = false
  private generation = 0
  private pausePromise: Promise<void> | null = null
  private pauseResolve: (() => void) | null = null
  private operationInterruptedForPause = false

  start(runController = new AbortController()): AbortSignal {
    if (this.active) throw new Error('Agent run control is already active')
    this.runController = runController
    this.operationController = new AbortController()
    this.active = true
    this.paused = false
    this.generation += 1
    this.releasePauseGate()
    return runController.signal
  }

  pause(options: AgentRunPauseOptions = {}): boolean {
    if (!this.active || this.paused) return false
    this.paused = true
    this.pausePromise = new Promise(resolve => {
      this.pauseResolve = resolve
    })
    this.operationInterruptedForPause = options.interruptOperation !== false
    if (this.operationInterruptedForPause) {
      this.operationController?.abort(createAgentRunInterruption('pause'))
    }
    return true
  }

  resume(): boolean {
    if (!this.active || !this.paused) return false
    if (this.operationInterruptedForPause || !this.operationController || this.operationController.signal.aborted) {
      this.operationController = new AbortController()
    }
    this.operationInterruptedForPause = false
    this.paused = false
    this.generation += 1
    this.releasePauseGate()
    return true
  }

  stop(): boolean {
    if (!this.active && !this.runController && !this.operationController) return false
    const interruption = createAgentRunInterruption('stop')
    this.runController?.abort(interruption)
    this.operationController?.abort(interruption)
    this.operationInterruptedForPause = false
    this.paused = false
    this.releasePauseGate()
    return true
  }

  finish(): void {
    this.releasePauseGate()
    this.runController = null
    this.operationController = null
    this.active = false
    this.paused = false
    this.operationInterruptedForPause = false
  }

  waitIfPaused(): Promise<void> {
    return this.paused && this.pausePromise ? this.pausePromise : Promise.resolve()
  }

  async runAcrossPause<T>(operation: () => Promise<T>, runSignal?: AbortSignal): Promise<T> {
    while (true) {
      try {
        return await operation()
      } catch (error) {
        if (!this.isPauseInterruption(error)) throw error
        await this.waitIfPaused()
        if (runSignal?.aborted) throw this.createStopInterruption()
      }
    }
  }

  raceWithStop<T>(operation: Promise<T>, runSignal = this.getRunSignal()): Promise<T> {
    if (!runSignal) return operation
    if (runSignal.aborted) return Promise.reject(this.createStopInterruption())
    return new Promise<T>((resolve, reject) => {
      const stop = () => reject(this.createStopInterruption())
      runSignal.addEventListener('abort', stop, { once: true })
      operation.then(
        value => {
          runSignal.removeEventListener('abort', stop)
          resolve(value)
        },
        error => {
          runSignal.removeEventListener('abort', stop)
          reject(error)
        },
      )
    })
  }

  createStopInterruption(): AgentRunInterruptionError {
    return createAgentRunInterruption('stop')
  }

  isPauseInterruption(error: unknown): boolean {
    return isAgentRunInterruption(error, 'pause')
  }

  isPauseSignal(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true && this.isPauseInterruption(signal.reason)
  }

  getRunController(): AbortController | null {
    return this.runController
  }

  setRunController(controller: AbortController | null): void {
    this.runController = controller
    if (controller) {
      this.active = true
      this.operationController ||= new AbortController()
    } else if (!this.operationController) {
      this.active = false
    }
  }

  getOperationController(): AbortController | null {
    return this.operationController
  }

  setOperationController(controller: AbortController | null): void {
    this.operationController = controller
    this.operationInterruptedForPause = false
    if (controller) this.active = true
    else if (!this.runController) this.active = false
  }

  getRunSignal(): AbortSignal | undefined {
    return this.runController?.signal
  }

  getOperationSignal(): AbortSignal | undefined {
    return this.operationController?.signal || this.runController?.signal
  }

  linkOperation(controller: AbortController): () => void {
    const signal = this.getOperationSignal()
    if (!signal) return () => undefined
    const forward = () => controller.abort(signal.reason)
    if (signal.aborted) {
      forward()
      return () => undefined
    }
    signal.addEventListener('abort', forward, { once: true })
    return () => signal.removeEventListener('abort', forward)
  }

  getSnapshot(): AgentRunControlSnapshot {
    return {
      active: this.active,
      paused: this.paused,
      generation: this.generation,
      runAborted: this.runController?.signal.aborted === true,
      operationAborted: this.operationController?.signal.aborted === true,
    }
  }

  private releasePauseGate(): void {
    this.pauseResolve?.()
    this.pausePromise = null
    this.pauseResolve = null
  }
}
