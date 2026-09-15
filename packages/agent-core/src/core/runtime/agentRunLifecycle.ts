import type { AgentRunPhase, AgentRunState } from '../../shared/agentTypes'
import { AgentRunControl, type AgentRunControlSnapshot } from './runControl'

export interface PendingSteeringInput {
  id: string
  text: string
}

interface AgentRunLifecycleOptions {
  onStateChanged: (state: AgentRunState) => void
  onStateFallback: (state: AgentRunState) => void
  onInputState: (
    input: PendingSteeringInput,
    state: 'accepted' | 'committed' | 'rejected',
    reason?: string,
  ) => void
  onNotification: (message: string) => void
  now?: () => number
}

export interface AgentRunFailure {
  aborted: boolean
  alreadyReported: boolean
  message: string
}

export class AgentRunLifecycle<TRunResult = unknown> {
  readonly control = new AgentRunControl()
  private currentRunPromise: Promise<TRunResult> | null = null
  private pendingSteeringMessages: PendingSteeringInput[] = []
  private steeringOpen = false
  private runState: AgentRunState
  private pausedResumeState: AgentRunState | null = null
  private readonly now: () => number

  constructor(private readonly options: AgentRunLifecycleOptions) {
    this.now = options.now ?? Date.now
    this.runState = { phase: 'idle', updatedAt: this.now() }
  }

  isRunning(): boolean {
    return this.currentRunPromise !== null
  }

  getRunPromise(): Promise<TRunResult> | null {
    return this.currentRunPromise
  }

  getState(): AgentRunState {
    return this.runState
  }

  getControlSnapshot(): AgentRunControlSnapshot {
    return this.control.getSnapshot()
  }

  restoreIdle(emit: boolean): void {
    if (emit) {
      this.setState('idle')
      return
    }
    this.runState = { phase: 'idle', updatedAt: this.now() }
    this.pausedResumeState = null
  }

  setState(
    phase: AgentRunPhase,
    stateOptions?: Pick<AgentRunState, 'detail' | 'activeTool' | 'recoverable'>,
  ): void {
    const previousPhase = this.runState.phase
    const startsNewRun = phase === 'thinking'
      && (previousPhase === 'idle' || previousPhase === 'completed' || previousPhase === 'recoverable_error')
    const startedAt = phase === 'idle'
      ? undefined
      : startsNewRun
        ? this.now()
        : this.runState.startedAt ?? this.now()
    this.runState = {
      phase,
      startedAt,
      updatedAt: this.now(),
      ...stateOptions,
    }
    this.options.onStateChanged(this.runState)
  }

  setStateAfterPause(
    phase: AgentRunPhase,
    stateOptions?: Pick<AgentRunState, 'detail' | 'activeTool' | 'recoverable'>,
  ): void {
    if (this.control.getSnapshot().paused) {
      this.pausedResumeState = {
        phase,
        startedAt: this.runState.startedAt,
        updatedAt: this.now(),
        ...stateOptions,
      }
      return
    }
    this.setState(phase, stateOptions)
  }

  beginRun(controller: AbortController): void {
    this.control.start(controller)
    this.rejectPendingSteering('Previous run ended before guidance was committed')
    this.steeringOpen = true
  }

  trackRun(promise: Promise<TRunResult>): void {
    if (this.currentRunPromise) throw new Error('Agent run lifecycle is already tracking a run')
    this.currentRunPromise = promise
    void promise.catch(() => undefined).finally(() => {
      if (this.currentRunPromise !== promise) return
      this.currentRunPromise = null
      this.pausedResumeState = null
      this.control.finish()
    })
  }

  closeSteering(reason: string): void {
    this.steeringOpen = false
    this.rejectPendingSteering(reason)
  }

  submitSteering(
    message: string,
    inputId = `steer-${this.now()}-${Math.random().toString(36).slice(2, 8)}`,
  ): boolean {
    const trimmed = message.trim()
    if (!trimmed || !this.currentRunPromise || !this.steeringOpen) return false
    const pending = { id: inputId, text: trimmed }
    this.pendingSteeringMessages.push(pending)
    try {
      this.options.onInputState(pending, 'accepted')
    } catch (error) {
      const index = this.pendingSteeringMessages.indexOf(pending)
      if (index >= 0) this.pendingSteeringMessages.splice(index, 1)
      throw error
    }
    this.options.onNotification('Guidance added to the current run.')
    return true
  }

  consumeSteering(commit: (input: PendingSteeringInput) => void): boolean {
    if (this.pendingSteeringMessages.length === 0) return false
    const messages = this.pendingSteeringMessages.splice(0)
    for (const message of messages) {
      commit(message)
      this.options.onInputState(message, 'committed')
    }
    return true
  }

  rejectPendingSteering(reason: string): void {
    const pending = this.pendingSteeringMessages.splice(0)
    for (const message of pending) this.options.onInputState(message, 'rejected', reason)
  }

  pause(hasPendingInteractiveRequest: boolean, abortActiveStream: () => void): boolean {
    const resumeState = { ...this.runState }
    if (!this.control.pause({ interruptOperation: !hasPendingInteractiveRequest })) return false
    this.pausedResumeState = resumeState
    this.setState('paused', { detail: 'Paused by user' })
    abortActiveStream()
    return true
  }

  resume(): boolean {
    if (!this.control.resume()) return false
    const resumeState = this.pausedResumeState
    this.pausedResumeState = null
    this.setState(resumeState?.phase === 'paused' ? 'thinking' : resumeState?.phase || 'thinking', {
      detail: resumeState?.detail || 'Resuming run',
      activeTool: resumeState?.activeTool,
      recoverable: resumeState?.recoverable,
    })
    return true
  }

  abort(onAbort: () => void): void {
    if (this.currentRunPromise) this.setState('aborting', { detail: 'Stopping current run' })
    this.closeSteering('Current run was interrupted before guidance was committed')
    this.control.stop()
    this.pausedResumeState = null
    onAbort()
  }

  settleFailure(error: unknown): AgentRunFailure {
    const aborted = (error as { aborted?: boolean })?.aborted === true
      || this.control.getRunSignal()?.aborted === true
    const alreadyReported = (error as { alreadyReported?: boolean })?.alreadyReported === true
    const message = error instanceof Error ? error.message : 'Unknown error'
    const phase: AgentRunPhase = aborted ? 'completed' : 'recoverable_error'
    const detail = aborted ? 'Run stopped' : message
    try {
      this.setState(phase, { detail, recoverable: aborted ? undefined : true })
    } catch {
      const now = this.now()
      this.runState = {
        phase,
        startedAt: this.runState.startedAt ?? now,
        updatedAt: now,
        detail,
        recoverable: aborted ? undefined : true,
      }
      this.options.onStateFallback(this.runState)
    }
    try {
      this.closeSteering(aborted
        ? 'Current run was interrupted before guidance was committed'
        : 'Current run failed before guidance was committed')
    } catch {}
    return { aborted, alreadyReported, message }
  }

  destroy(): void {
    this.control.stop()
    this.closeSteering('Agent runtime was destroyed before guidance was committed')
    this.pausedResumeState = null
    this.currentRunPromise = null
    this.control.finish()
  }
}
