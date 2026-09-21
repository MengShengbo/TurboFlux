export const WORK_EXECUTION_SCHEMA_VERSION = 1 as const

export type WorkRunStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'

export type WorkStepStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'waiting'
  | 'blocked'
  | 'retrying'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'skipped'

export type WorkActivityKind = 'tool' | 'subagent' | 'browser' | 'computer' | 'service' | 'artifact'
export type WorkActivityStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'recovered'

export type ResponseMode = 'chat' | 'task'

export interface WorkExecutionSegment {
  startedAt: number
  endedAt?: number
  outcome?: 'paused' | 'stopped' | 'completed' | 'interrupted' | 'failed'
}

export interface WorkActivity {
  id: string
  runId: string
  stepId?: string
  kind: WorkActivityKind
  title: string
  detail?: string
  status: WorkActivityStatus
  attempt: number
  startedAt: number
  updatedAt: number
  completedAt?: number
  path?: string
  result?: string
  error?: string
  metadata?: Record<string, unknown>
}

export interface WorkStep {
  id: string
  runId: string
  title: string
  description: string
  status: WorkStepStatus
  parentId: string | null
  childIds: string[]
  dependencyIds: string[]
  order: number
  progress: number | null
  progressMode: 'explicit' | 'structural' | 'indeterminate'
  activityIds: string[]
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
  outcome?: string
  error?: string
}

export interface WorkRun {
  id: string
  conversationId: string
  objective: string
  presentation: 'conversation' | 'work'
  responseMode?: ResponseMode
  executionSegments?: WorkExecutionSegment[]
  status: WorkRunStatus
  phase: string
  rootStepIds: string[]
  steps: Record<string, WorkStep>
  activities: Record<string, WorkActivity>
  startedAt: number
  updatedAt: number
  completedAt?: number
  outcome?: string
  error?: string
  recoveredFromPersistence?: boolean
}

export interface WorkExecutionSnapshot {
  schemaVersion: typeof WORK_EXECUTION_SCHEMA_VERSION
  currentRunId: string | null
  runs: WorkRun[]
}

export type WorkStepControlAction = 'retry' | 'skip' | 'cancel' | 'resume'
