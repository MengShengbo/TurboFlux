import type { WorkExecutionSnapshot, WorkRun, WorkRunStatus, WorkStep } from '@turboflux/contracts/workExecutionTypes'

const ACTIVE_WORK_STEP_STATUSES = new Set(['running', 'retrying', 'waiting'])
const RESOLVED_DEPENDENCY_STATUSES = new Set(['completed', 'skipped'])

export type WorkRunPresentationTone = 'neutral' | 'active' | 'attention' | 'success' | 'warning' | 'danger'

export interface WorkRunPresentation {
  runId: string
  status: WorkRunStatus
  statusLabel: string
  tone: WorkRunPresentationTone
  title: string
  detail: string
  currentStep?: WorkStep
  activeStepCount: number
  completedStepCount: number
  totalStepCount: number
  duration: string
  attention: boolean
  terminal: boolean
}

export interface WorkStagePresentation {
  id: string
  title: string
  state: 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'
  progress: number | null
  depth: number
}

const TERMINAL_WORK_RUN_STATUSES = new Set<WorkRunStatus>(['completed', 'partial', 'failed', 'cancelled'])

export function workRunStatusLabel(status: WorkRunStatus): string {
  return ({
    pending: '准备开始',
    running: '正在执行',
    waiting: '等待处理',
    paused: '工作已暂停',
    completed: '工作已完成',
    partial: '部分工作未完成',
    failed: '工作未完成',
    cancelled: '工作已停止',
  } satisfies Record<WorkRunStatus, string>)[status]
}

export function workRunDuration(startedAt: number, completedAt?: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor(((completedAt || now) - startedAt) / 1_000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return remaining ? `${minutes} 分 ${remaining} 秒` : `${minutes} 分钟`
}

export function completedTaskTurnDuration(startedAt?: number, completedAt?: number): string {
  if (
    startedAt === undefined
    || completedAt === undefined
    || !Number.isFinite(startedAt)
    || !Number.isFinite(completedAt)
    || completedAt < startedAt
  ) return ''
  return workRunDuration(startedAt, completedAt, completedAt)
}

function workRunTone(status: WorkRunStatus): WorkRunPresentationTone {
  if (status === 'completed') return 'success'
  if (status === 'partial') return 'warning'
  if (status === 'failed' || status === 'cancelled') return 'danger'
  if (status === 'waiting' || status === 'paused') return 'attention'
  if (status === 'running') return 'active'
  return 'neutral'
}

export function presentWorkRun(run: WorkRun, now = Date.now()): WorkRunPresentation {
  const steps = Object.values(run.steps)
  const activeSteps = activeWorkSteps(run)
  const currentStep = activeSteps[0]
  const completedStepCount = steps.filter(step => step.status === 'completed' || step.status === 'skipped').length
  const totalStepCount = steps.length
  const terminal = TERMINAL_WORK_RUN_STATUSES.has(run.status)
  const progress = totalStepCount > 0 ? `${completedStepCount}/${totalStepCount} 个步骤` : ''
  const activity = activeSteps.length > 1 ? `${activeSteps.length} 项并行进行` : ''
  const fallback = run.status === 'running'
    ? run.phase === 'thinking' ? '请求中' : '工作正在推进'
    : workRunStatusLabel(run.status)
  const title = terminal ? workRunStatusLabel(run.status) : currentStep?.title || fallback
  const detail = [activity, progress].filter(Boolean).join(' · ') || (
    terminal ? '查看本轮结果' : run.status === 'waiting' ? '需要处理后才能继续' : workRunStatusLabel(run.status)
  )

  return {
    runId: run.id,
    status: run.status,
    statusLabel: workRunStatusLabel(run.status),
    tone: workRunTone(run.status),
    title,
    detail,
    currentStep,
    activeStepCount: activeSteps.length,
    completedStepCount,
    totalStepCount,
    duration: workRunDuration(run.startedAt, run.completedAt, now),
    attention: run.status === 'waiting' || run.status === 'paused' || run.status === 'partial' || run.status === 'failed',
    terminal,
  }
}

function workStageState(step: WorkStep): WorkStagePresentation['state'] {
  if (step.status === 'completed' || step.status === 'skipped') return 'completed'
  if (step.status === 'partial') return 'partial'
  if (step.status === 'failed' || step.status === 'blocked') return 'failed'
  if (step.status === 'cancelled') return 'cancelled'
  if (ACTIVE_WORK_STEP_STATUSES.has(step.status)) return 'running'
  return 'pending'
}

export function presentWorkStages(run: WorkRun): WorkStagePresentation[] {
  const stages: WorkStagePresentation[] = []
  const visited = new Set<string>()
  const append = (step: WorkStep, depth: number) => {
    if (visited.has(step.id)) return
    visited.add(step.id)
    stages.push({
      id: step.id,
      title: step.title,
      state: workStageState(step),
      progress: step.progress,
      depth,
    })
    for (const child of orderedWorkSteps(run, step.childIds)) append(child, depth + 1)
  }
  for (const root of orderedWorkSteps(run, run.rootStepIds)) append(root, 0)
  for (const step of Object.values(run.steps).sort(compareWorkSteps)) append(step, step.parentId ? 1 : 0)
  return stages
}

export function compareWorkSteps(left: WorkStep, right: WorkStep): number {
  return left.order - right.order || left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}

export function orderedWorkSteps(run: WorkRun, stepIds: string[]): WorkStep[] {
  return stepIds
    .map(id => run.steps[id])
    .filter((step): step is WorkStep => Boolean(step))
    .sort(compareWorkSteps)
}

export function activeWorkSteps(run: WorkRun): WorkStep[] {
  return Object.values(run.steps)
    .filter(step => ACTIVE_WORK_STEP_STATUSES.has(step.status))
    .sort((left, right) => right.updatedAt - left.updatedAt || compareWorkSteps(left, right))
}

export function recentActiveWorkStep(run: WorkRun): WorkStep | undefined {
  return activeWorkSteps(run)[0]
}

export function activeSiblingCount(step: WorkStep, run: WorkRun): number {
  return Object.values(run.steps).filter(candidate => (
    candidate.parentId === step.parentId && ACTIVE_WORK_STEP_STATUSES.has(candidate.status)
  )).length
}

export function workStepDependencies(step: WorkStep, run: WorkRun): { all: WorkStep[]; unresolved: WorkStep[] } {
  const all = orderedWorkSteps(run, step.dependencyIds)
  return {
    all,
    unresolved: all.filter(dependency => !RESOLVED_DEPENDENCY_STATUSES.has(dependency.status)),
  }
}

export function workRunHistory(execution: WorkExecutionSnapshot): WorkRun[] {
  return execution.runs.filter(run => run.presentation === 'work')
}

export function selectWorkRun(execution: WorkExecutionSnapshot, requestedRunId?: string | null): WorkRun | undefined {
  const runs = workRunHistory(execution)
  if (requestedRunId) {
    const requested = runs.find(run => run.id === requestedRunId)
    if (requested) return requested
  }
  if (execution.currentRunId) {
    const current = runs.find(run => run.id === execution.currentRunId)
    if (current) return current
  }
  return runs.at(-1)
}

export function selectProjectedWorkRun(
  execution: WorkExecutionSnapshot,
  projectedRunId?: string | null,
): WorkRun | undefined {
  if (!projectedRunId) return undefined
  return execution.runs.find(run => run.id === projectedRunId && run.presentation === 'work')
}
