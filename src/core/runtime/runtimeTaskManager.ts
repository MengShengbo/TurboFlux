import type {
  RuntimeRestartPolicy,
  RuntimeTask,
  RuntimeTaskEvent,
  RuntimeTaskFilter,
  RuntimeTaskKind,
  RuntimeTaskStatus,
} from '../../shared/runtimeTaskTypes'

export interface RuntimeTaskControl {
  stop?: () => Promise<void> | void
  write?: (data: string) => Promise<void> | void
}

export interface RuntimeTaskManagerOptions {
  defaultOwnerSessionId?: string
  now?: () => number
}

export interface CreateRuntimeTaskInput {
  id?: string
  kind: RuntimeTaskKind
  ownerSessionId?: string
  parentTaskId?: string
  status?: 'starting' | 'running'
  command?: string
  cwd?: string
  pid?: number
  startedAt?: number
  interactive?: boolean
  restartPolicy?: RuntimeRestartPolicy
  metadata?: Record<string, unknown>
}

export type RuntimeTaskUpdate = Partial<Pick<
  RuntimeTask,
  'command' | 'cwd' | 'pid' | 'exitCode' | 'logPath' | 'outputOffset' | 'outputBytes' | 'error' | 'metadata'
>>

const TERMINAL_STATUSES = new Set<RuntimeTaskStatus>(['completed', 'failed', 'stopped', 'interrupted'])

function cloneTask(task: RuntimeTask): RuntimeTask {
  return {
    ...task,
    metadata: task.metadata ? { ...task.metadata } : undefined,
  }
}

export class RuntimeTaskManager {
  private tasks = new Map<string, RuntimeTask>()
  private controls = new Map<string, RuntimeTaskControl>()
  private listeners = new Set<(event: RuntimeTaskEvent) => void>()
  private sequence = 0
  private readonly now: () => number

  constructor(private options: RuntimeTaskManagerOptions = {}) {
    this.now = options.now || Date.now
  }

  createTask(input: CreateRuntimeTaskInput, control?: RuntimeTaskControl): RuntimeTask {
    const now = input.startedAt ?? this.now()
    const id = input.id || this.generateId(input.kind, now)
    if (this.tasks.has(id)) throw new Error(`Runtime task already exists: ${id}`)

    const task: RuntimeTask = {
      id,
      kind: input.kind,
      ownerSessionId: input.ownerSessionId || this.options.defaultOwnerSessionId,
      parentTaskId: input.parentTaskId,
      status: input.status || 'starting',
      command: input.command,
      cwd: input.cwd,
      pid: input.pid,
      startedAt: now,
      updatedAt: now,
      interactive: input.interactive ?? input.kind === 'terminal',
      restartPolicy: input.restartPolicy || 'never',
      metadata: input.metadata ? { ...input.metadata } : undefined,
    }
    this.tasks.set(id, task)
    if (control) this.controls.set(id, control)
    this.emit({ type: 'runtime-task:created', task: cloneTask(task) })
    return cloneTask(task)
  }

  getTask(taskId: string): RuntimeTask | null {
    const task = this.tasks.get(taskId)
    return task ? cloneTask(task) : null
  }

  listTasks(filter: RuntimeTaskFilter = {}): RuntimeTask[] {
    return Array.from(this.tasks.values())
      .filter(task => !filter.kind || task.kind === filter.kind)
      .filter(task => !filter.status || task.status === filter.status)
      .filter(task => !filter.ownerSessionId || task.ownerSessionId === filter.ownerSessionId)
      .filter(task => !filter.parentTaskId || task.parentTaskId === filter.parentTaskId)
      .sort((left, right) => left.startedAt - right.startedAt)
      .map(cloneTask)
  }

  updateTask(taskId: string, patch: RuntimeTaskUpdate): RuntimeTask | null {
    const task = this.tasks.get(taskId)
    if (!task) return null
    Object.assign(task, patch, {
      metadata: patch.metadata ? { ...task.metadata, ...patch.metadata } : task.metadata,
      updatedAt: this.now(),
    })
    this.emit({ type: 'runtime-task:updated', task: cloneTask(task) })
    return cloneTask(task)
  }

  markRunning(taskId: string, patch: RuntimeTaskUpdate = {}): RuntimeTask | null {
    const task = this.tasks.get(taskId)
    if (!task) return null
    if (task.status !== 'starting' && task.status !== 'running') {
      throw new Error(`Cannot mark runtime task ${taskId} as running from ${task.status}`)
    }
    return this.setStatus(task, 'running', patch)
  }

  markStopping(taskId: string): RuntimeTask | null {
    const task = this.tasks.get(taskId)
    if (!task) return null
    if (TERMINAL_STATUSES.has(task.status)) return cloneTask(task)
    if (task.status === 'stopping') return cloneTask(task)
    return this.setStatus(task, 'stopping')
  }

  completeTask(taskId: string, patch: RuntimeTaskUpdate = {}): RuntimeTask | null {
    return this.finishTask(taskId, 'completed', patch)
  }

  failTask(taskId: string, error: string, patch: RuntimeTaskUpdate = {}): RuntimeTask | null {
    return this.finishTask(taskId, 'failed', { ...patch, error })
  }

  markStopped(taskId: string, reason?: string, patch: RuntimeTaskUpdate = {}): RuntimeTask | null {
    return this.finishTask(taskId, 'stopped', {
      ...patch,
      metadata: reason ? { ...patch.metadata, stopReason: reason } : patch.metadata,
    })
  }

  interruptTask(taskId: string, reason: string, patch: RuntimeTaskUpdate = {}): RuntimeTask | null {
    return this.finishTask(taskId, 'interrupted', { ...patch, error: reason })
  }

  setControl(taskId: string, control: RuntimeTaskControl): void {
    if (!this.tasks.has(taskId)) throw new Error(`Runtime task not found: ${taskId}`)
    this.controls.set(taskId, control)
  }

  async stopTask(taskId: string, reason = 'Stopped by request'): Promise<RuntimeTask> {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`Runtime task not found: ${taskId}`)
    if (TERMINAL_STATUSES.has(task.status)) return cloneTask(task)
    const control = this.controls.get(taskId)
    if (!control?.stop) throw new Error(`Runtime task cannot be stopped: ${taskId}`)

    this.markStopping(taskId)
    try {
      await control.stop()
      return this.markStopped(taskId, reason) || cloneTask(task)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const current = this.tasks.get(taskId)
      if (!current) return cloneTask(task)
      const failed = this.setStatus(current, 'failed', { error: message }, true)
      this.controls.delete(taskId)
      return failed
    }
  }

  async writeTask(taskId: string, data: string): Promise<RuntimeTask> {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`Runtime task not found: ${taskId}`)
    if (TERMINAL_STATUSES.has(task.status)) throw new Error(`Runtime task is ${task.status}: ${taskId}`)
    const control = this.controls.get(taskId)
    if (!control?.write) throw new Error(`Runtime task does not accept input: ${taskId}`)
    await control.write(data)
    return this.updateTask(taskId, {
      metadata: { lastInputAt: this.now() },
    }) || cloneTask(task)
  }

  async stopAll(reason = 'Runtime stopped'): Promise<Array<{ taskId: string; error: string }>> {
    const errors: Array<{ taskId: string; error: string }> = []
    for (const task of this.tasks.values()) {
      if (TERMINAL_STATUSES.has(task.status)) continue
      const control = this.controls.get(task.id)
      if (!control?.stop) {
        this.interruptTask(task.id, reason)
        continue
      }
      const stopped = await this.stopTask(task.id, reason)
      if (stopped.status === 'failed') errors.push({ taskId: task.id, error: stopped.error || 'Stop failed' })
    }
    return errors
  }

  removeTask(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || !TERMINAL_STATUSES.has(task.status)) return false
    this.tasks.delete(taskId)
    this.controls.delete(taskId)
    this.emit({ type: 'runtime-task:removed', taskId })
    return true
  }

  subscribe(listener: (event: RuntimeTaskEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private finishTask(taskId: string, status: Extract<RuntimeTaskStatus, 'completed' | 'failed' | 'stopped' | 'interrupted'>, patch: RuntimeTaskUpdate): RuntimeTask | null {
    const task = this.tasks.get(taskId)
    if (!task) return null
    const nextStatus = task.status === 'stopping' ? 'stopped' : TERMINAL_STATUSES.has(task.status) ? task.status : status
    const finished = this.setStatus(task, nextStatus, patch, true)
    this.controls.delete(taskId)
    return finished
  }

  private setStatus(task: RuntimeTask, status: RuntimeTaskStatus, patch: RuntimeTaskUpdate = {}, terminal = false): RuntimeTask {
    const now = this.now()
    const wasTerminal = TERMINAL_STATUSES.has(task.status)
    Object.assign(task, patch, {
      status,
      updatedAt: now,
      endedAt: terminal || TERMINAL_STATUSES.has(status) ? task.endedAt || now : undefined,
      metadata: patch.metadata ? { ...task.metadata, ...patch.metadata } : task.metadata,
    })
    const snapshot = cloneTask(task)
    this.emit({ type: 'runtime-task:updated', task: snapshot })
    if (!wasTerminal && TERMINAL_STATUSES.has(status)) {
      this.emit({ type: 'runtime-task:finished', task: cloneTask(task) })
    }
    return snapshot
  }

  private generateId(kind: RuntimeTaskKind, now: number): string {
    this.sequence += 1
    return `runtime_${kind}_${now.toString(36)}_${this.sequence.toString(36)}`
  }

  private emit(event: RuntimeTaskEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
