import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import type { RuntimeTask, RuntimeTaskKind, RuntimeTaskStatus } from '../../shared/runtimeTaskTypes'
import type { RuntimeTaskManager } from './runtimeTaskManager'

export interface SubAgentTaskDescriptor {
  id: string
  kind: Extract<RuntimeTaskKind, 'agent' | 'fast_context'>
  agentType: string
  label: string
  objective: string
  workspacePath: string
  ownerSessionId?: string
  startedAt: number
  transcriptPath: string
}

export interface SubAgentTaskSnapshot extends SubAgentTaskDescriptor {
  runtimeTask: RuntimeTask
  result?: unknown
}

export type SubAgentTranscriptRecord =
  | { version: 1; type: 'start'; timestamp: number; task: SubAgentTaskDescriptor }
  | { version: 1; type: 'event'; timestamp: number; event: unknown }
  | { version: 1; type: 'result'; timestamp: number; status: 'completed' | 'failed'; result?: unknown; error?: string }
  | { version: 1; type: 'state'; timestamp: number; status: RuntimeTaskStatus; error?: string }

export interface StartSubAgentTaskContext {
  taskId: string
  signal: AbortSignal
  recordEvent: (event: unknown) => void
}

export interface StartSubAgentTaskInput<TResult> {
  kind: Extract<RuntimeTaskKind, 'agent' | 'fast_context'>
  agentType: string
  label: string
  objective: string
  workspacePath: string
  ownerSessionId?: string
  controller?: AbortController
  timeoutMs?: number
  run: (context: StartSubAgentTaskContext) => Promise<TResult>
  isSuccess?: (result: TResult) => boolean
  getError?: (result: TResult) => string | undefined
}

export interface StartedSubAgentTask<TResult> {
  task: RuntimeTask
  promise: Promise<TResult>
}

export interface ReadSubAgentTranscriptOptions {
  offset?: number
  limit?: number
}

export interface ReadSubAgentTranscriptResult {
  records: SubAgentTranscriptRecord[]
  offset: number
  nextOffset: number
  total: number
}

export interface SubAgentTaskManagerOptions {
  workspacePath: string
  runtimeTaskManager: RuntimeTaskManager
  ownerSessionId?: string
  storageDir?: string | false
  now?: () => number
}

const TERMINAL_STATUSES = new Set<RuntimeTaskStatus>(['completed', 'failed', 'stopped', 'interrupted'])

function isRuntimeTaskStatus(value: unknown): value is RuntimeTaskStatus {
  return ['starting', 'running', 'stopping', 'completed', 'failed', 'stopped', 'interrupted'].includes(String(value))
}

function parseTranscript(content: string): SubAgentTranscriptRecord[] {
  const records: SubAgentTranscriptRecord[] = []
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as SubAgentTranscriptRecord
      if (record?.version === 1 && typeof record.type === 'string') records.push(record)
    } catch {
      continue
    }
  }
  return records
}

export class SubAgentTaskManager {
  private readonly runtimeTaskManager: RuntimeTaskManager
  private readonly ownerSessionId?: string
  private readonly storageDir: string | null
  private readonly now: () => number
  private readonly descriptors = new Map<string, SubAgentTaskDescriptor>()
  private readonly results = new Map<string, unknown>()
  private readonly outputBytes = new Map<string, number>()
  private readonly unsubscribeRuntimeTasks: () => void
  private sequence = 0

  constructor(private readonly options: SubAgentTaskManagerOptions) {
    this.runtimeTaskManager = options.runtimeTaskManager
    this.ownerSessionId = options.ownerSessionId
    this.storageDir = options.storageDir === false
      ? null
      : options.storageDir || path.join(options.workspacePath, '.turboflux', 'runtime-agents')
    this.now = options.now || Date.now
    if (this.storageDir) {
      mkdirSync(this.storageDir, { recursive: true })
      this.recoverTranscripts()
    }
    this.unsubscribeRuntimeTasks = this.runtimeTaskManager.subscribe(event => {
      if (event.type !== 'runtime-task:finished' || !this.descriptors.has(event.task.id)) return
      this.appendRecord(event.task.id, {
        version: 1,
        type: 'state',
        timestamp: this.now(),
        status: event.task.status,
        error: event.task.error,
      })
    })
  }

  startTask<TResult>(input: StartSubAgentTaskInput<TResult>): StartedSubAgentTask<TResult> {
    const startedAt = this.now()
    const id = this.generateId(input.kind, startedAt)
    const transcriptPath = this.storageDir ? path.join(this.storageDir, `${id}.jsonl`) : ''
    const descriptor: SubAgentTaskDescriptor = {
      id,
      kind: input.kind,
      agentType: input.agentType,
      label: input.label,
      objective: input.objective,
      workspacePath: input.workspacePath,
      ownerSessionId: input.ownerSessionId || this.ownerSessionId,
      startedAt,
      transcriptPath,
    }
    this.descriptors.set(id, descriptor)
    this.appendRecord(id, { version: 1, type: 'start', timestamp: startedAt, task: descriptor })

    const controller = input.controller || new AbortController()
    const task = this.runtimeTaskManager.createTask({
      id,
      kind: input.kind,
      ownerSessionId: descriptor.ownerSessionId,
      status: 'starting',
      command: input.objective,
      cwd: input.workspacePath,
      startedAt,
      interactive: false,
      restartPolicy: 'never',
      metadata: {
        agentType: input.agentType,
        label: input.label,
        transcriptPath: transcriptPath || undefined,
      },
    }, {
      stop: () => controller.abort(),
    })
    this.runtimeTaskManager.markRunning(id, {
      logPath: transcriptPath || undefined,
      outputBytes: this.outputBytes.get(id) || 0,
      outputOffset: this.outputBytes.get(id) || 0,
    })

    const runPromise = Promise.resolve().then(() => input.run({
      taskId: id,
      signal: controller.signal,
      recordEvent: event => this.appendRecord(id, {
        version: 1,
        type: 'event',
        timestamp: this.now(),
        event,
      }),
    }))
    const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? Math.floor(input.timeoutMs) : 0
    let timeout: ReturnType<typeof setTimeout> | undefined
    const boundedRun = timeoutMs > 0
      ? Promise.race([
          runPromise,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              reject(new Error(`${input.label} timed out after ${timeoutMs}ms`))
              controller.abort()
            }, timeoutMs)
          }),
        ])
      : runPromise
    const promise = boundedRun.finally(() => {
      if (timeout) clearTimeout(timeout)
    }).then(result => {
      const succeeded = input.isSuccess ? input.isSuccess(result) : true
      const error = succeeded ? undefined : input.getError?.(result) || 'Subagent failed'
      this.results.set(id, result)
      this.appendRecord(id, {
        version: 1,
        type: 'result',
        timestamp: this.now(),
        status: succeeded ? 'completed' : 'failed',
        result,
        error,
      })
      if (succeeded) this.runtimeTaskManager.completeTask(id)
      else this.runtimeTaskManager.failTask(id, error || 'Subagent failed')
      return result
    }, error => {
      const message = error instanceof Error ? error.message : String(error)
      this.appendRecord(id, {
        version: 1,
        type: 'result',
        timestamp: this.now(),
        status: 'failed',
        error: message,
      })
      this.runtimeTaskManager.failTask(id, message)
      throw error
    })
    void promise.catch(() => {})
    return { task: this.runtimeTaskManager.getTask(task.id) || task, promise }
  }

  getTask(taskId: string): SubAgentTaskSnapshot | null {
    const descriptor = this.descriptors.get(taskId)
    const runtimeTask = this.runtimeTaskManager.getTask(taskId)
    if (!descriptor || !runtimeTask) return null
    return {
      ...descriptor,
      runtimeTask,
      result: this.results.get(taskId),
    }
  }

  listTasks(): SubAgentTaskSnapshot[] {
    return Array.from(this.descriptors.keys())
      .map(taskId => this.getTask(taskId))
      .filter((task): task is SubAgentTaskSnapshot => Boolean(task))
      .sort((left, right) => left.startedAt - right.startedAt)
  }

  readTranscript(taskId: string, options: ReadSubAgentTranscriptOptions = {}): ReadSubAgentTranscriptResult {
    const descriptor = this.descriptors.get(taskId)
    if (!descriptor) throw new Error(`Subagent task not found: ${taskId}`)
    const allRecords = descriptor.transcriptPath && existsSync(descriptor.transcriptPath)
      ? parseTranscript(readFileSync(descriptor.transcriptPath, 'utf8'))
      : []
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit || 20)))
    const requestedOffset = options.offset === undefined
      ? Math.max(0, allRecords.length - limit)
      : Math.max(0, Math.min(allRecords.length, Math.floor(options.offset)))
    const records = allRecords.slice(requestedOffset, requestedOffset + limit)
    return {
      records,
      offset: requestedOffset,
      nextOffset: requestedOffset + records.length,
      total: allRecords.length,
    }
  }

  async stopTask(taskId: string, reason = 'Subagent cancelled by request'): Promise<RuntimeTask> {
    if (!this.descriptors.has(taskId)) throw new Error(`Subagent task not found: ${taskId}`)
    return this.runtimeTaskManager.stopTask(taskId, reason)
  }

  destroy(): void {
    this.unsubscribeRuntimeTasks()
  }

  private recoverTranscripts(): void {
    if (!this.storageDir) return
    const files = readdirSync(this.storageDir)
      .filter(file => file.endsWith('.jsonl'))
      .sort()
    for (const file of files) {
      const transcriptPath = path.join(this.storageDir, file)
      const records = parseTranscript(readFileSync(transcriptPath, 'utf8'))
      const start = records.find((record): record is Extract<SubAgentTranscriptRecord, { type: 'start' }> => record.type === 'start')
      if (!start?.task?.id || this.runtimeTaskManager.getTask(start.task.id)) continue
      const descriptor = { ...start.task, transcriptPath }
      this.descriptors.set(descriptor.id, descriptor)
      this.outputBytes.set(descriptor.id, statSync(transcriptPath).size)

      let stateStatus: RuntimeTaskStatus | undefined
      let resultStatus: Extract<RuntimeTaskStatus, 'completed' | 'failed'> | undefined
      let error: string | undefined
      let result: unknown
      for (const record of records) {
        if (record.type === 'result') {
          resultStatus = record.status
          error = record.error
          result = record.result
        } else if (record.type === 'state' && isRuntimeTaskStatus(record.status)) {
          stateStatus = record.status
          error = record.error || error
        }
      }
      const status = stateStatus && TERMINAL_STATUSES.has(stateStatus)
        ? stateStatus
        : resultStatus || stateStatus || 'running'
      if (result !== undefined) this.results.set(descriptor.id, result)

      this.runtimeTaskManager.createTask({
        id: descriptor.id,
        kind: descriptor.kind,
        ownerSessionId: descriptor.ownerSessionId,
        status: 'running',
        command: descriptor.objective,
        cwd: descriptor.workspacePath,
        startedAt: descriptor.startedAt,
        interactive: false,
        restartPolicy: 'never',
        metadata: {
          agentType: descriptor.agentType,
          label: descriptor.label,
          transcriptPath,
          recovered: true,
        },
      })
      this.runtimeTaskManager.markRunning(descriptor.id, {
        logPath: transcriptPath,
        outputBytes: this.outputBytes.get(descriptor.id) || 0,
        outputOffset: this.outputBytes.get(descriptor.id) || 0,
      })

      if (status === 'completed') this.runtimeTaskManager.completeTask(descriptor.id)
      else if (status === 'failed') this.runtimeTaskManager.failTask(descriptor.id, error || 'Subagent failed')
      else if (status === 'stopped') this.runtimeTaskManager.markStopped(descriptor.id, error)
      else if (status === 'interrupted') this.runtimeTaskManager.interruptTask(descriptor.id, error || 'Subagent was interrupted')
      else {
        const reason = 'Subagent runtime restarted before this task completed'
        this.runtimeTaskManager.interruptTask(descriptor.id, reason)
        this.appendRecord(descriptor.id, {
          version: 1,
          type: 'state',
          timestamp: this.now(),
          status: 'interrupted',
          error: reason,
        })
      }
    }
  }

  private appendRecord(taskId: string, record: SubAgentTranscriptRecord): void {
    const descriptor = this.descriptors.get(taskId)
    if (!descriptor?.transcriptPath) return
    let line: string
    try {
      line = `${JSON.stringify(record)}\n`
    } catch {
      line = `${JSON.stringify({
        version: 1,
        type: 'event',
        timestamp: this.now(),
        event: { type: 'serialization_error' },
      })}\n`
    }
    appendFileSync(descriptor.transcriptPath, line, { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(descriptor.transcriptPath, 0o600) } catch {}
    const bytes = (this.outputBytes.get(taskId) || 0) + Buffer.byteLength(line)
    this.outputBytes.set(taskId, bytes)
    if (this.runtimeTaskManager.getTask(taskId)) {
      this.runtimeTaskManager.updateTask(taskId, {
        logPath: descriptor.transcriptPath,
        outputBytes: bytes,
        outputOffset: bytes,
      })
    }
  }

  private generateId(kind: Extract<RuntimeTaskKind, 'agent' | 'fast_context'>, now: number): string {
    let id: string
    do {
      this.sequence += 1
      id = `runtime_${kind}_${now.toString(36)}_${this.sequence.toString(36)}`
    } while (this.descriptors.has(id) || (this.storageDir && existsSync(path.join(this.storageDir, `${id}.jsonl`))))
    return id
  }
}

export function isTerminalSubAgentStatus(status: RuntimeTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}
