export type RuntimeTaskKind = 'shell' | 'terminal' | 'agent' | 'mcp' | 'workflow' | 'remote'

export type RuntimeTaskStatus = 'starting' | 'running' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'interrupted' | 'orphaned'

export type RuntimeRestartPolicy = 'never' | 'on-failure' | 'always'

export type RuntimeTaskPresentationKind = 'work' | 'install' | 'build' | 'check' | 'service' | 'export'

export interface RuntimeTaskPresentation {
  kind: RuntimeTaskPresentationKind
  title: string
  detail?: string
  previewUrl?: string
}

export interface RuntimeTask {
  id: string
  kind: RuntimeTaskKind
  ownerSessionId?: string
  parentTaskId?: string
  status: RuntimeTaskStatus
  command?: string
  cwd?: string
  pid?: number
  startedAt: number
  updatedAt: number
  endedAt?: number
  exitCode?: number | null
  logPath?: string
  outputOffset?: number
  outputBytes?: number
  interactive: boolean
  restartPolicy: RuntimeRestartPolicy
  error?: string
  presentation?: RuntimeTaskPresentation
  metadata?: Record<string, unknown>
}

export interface RuntimeTaskFilter {
  kind?: RuntimeTaskKind
  status?: RuntimeTaskStatus
  ownerSessionId?: string
  parentTaskId?: string
}

export type RuntimeTaskEvent =
  | { type: 'runtime-task:created'; task: RuntimeTask }
  | { type: 'runtime-task:updated'; task: RuntimeTask }
  | { type: 'runtime-task:finished'; task: RuntimeTask }
  | { type: 'runtime-task:removed'; taskId: string }
