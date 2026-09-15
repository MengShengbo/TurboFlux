import type { AgentRunPhase, AgentTurn, TaskNode, ToolCall, ToolResult } from '../shared/agentTypes'
import { isBuiltInBrowserTool } from '../shared/browserToolPresentation'
import { isBuiltInComputerTool } from '../shared/computerToolPresentation'
import {
  WORK_EXECUTION_SCHEMA_VERSION,
  type WorkActivity,
  type WorkActivityKind,
  type WorkExecutionSnapshot,
  type WorkRun,
  type WorkRunStatus,
  type ResponseMode,
  type WorkExecutionSegment,
  type WorkStep,
  type WorkStepStatus,
} from '../shared/workExecutionTypes'
import type { TaskManager } from './taskManager'

const MAX_RETAINED_RUNS = 24
const ACTIVE_PHASES = new Set<AgentRunPhase>(['thinking', 'compacting', 'tool_running', 'awaiting_approval', 'awaiting_input', 'paused', 'aborting'])
const RECOVERED_ACTIVE_STATUSES = new Set<WorkRunStatus>(['pending', 'running', 'waiting', 'paused'])

function cloneActivity(activity: WorkActivity): WorkActivity {
  return { ...activity, metadata: activity.metadata ? { ...activity.metadata } : undefined }
}

function cloneStep(step: WorkStep): WorkStep {
  return { ...step, childIds: [...step.childIds], dependencyIds: [...step.dependencyIds], activityIds: [...step.activityIds] }
}

function cloneRun(run: WorkRun): WorkRun {
  return {
    ...run,
    executionSegments: run.executionSegments?.map(segment => ({ ...segment })),
    rootStepIds: [...run.rootStepIds],
    steps: Object.fromEntries(Object.entries(run.steps).map(([id, step]) => [id, cloneStep(step)])),
    activities: Object.fromEntries(Object.entries(run.activities).map(([id, activity]) => [id, cloneActivity(activity)])),
  }
}

function activityKind(toolName: string): WorkActivityKind {
  if (isBuiltInBrowserTool(toolName)) return 'browser'
  if (isBuiltInComputerTool(toolName)) return 'computer'
  return 'tool'
}

function toolArgumentsSignature(argumentsValue: Record<string, unknown>): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalize(item)]))
  }
  return JSON.stringify(normalize(argumentsValue))
}

function stepStatus(task: TaskNode, tasks: Map<string, TaskNode>, calls: WorkActivity[]): WorkStepStatus {
  if (task.metadata?.workControlOutcome === 'skip') return 'skipped'
  if (task.metadata?.workControlOutcome === 'cancel') return 'cancelled'
  if (task.status === 'completed') return 'completed'
  if (task.status === 'failed') return 'failed'
  const running = calls.some(call => call.status === 'running')
  const recovered = calls.some(call => call.status === 'recovered')
  if (task.status === 'in_progress') return recovered && !running ? 'retrying' : 'running'
  const dependencies = task.dependencies.map(id => tasks.get(id)).filter((item): item is TaskNode => Boolean(item))
  if (dependencies.some(item => item.status === 'failed')) return 'blocked'
  if (dependencies.every(item => item.status === 'completed')) return 'ready'
  return 'pending'
}

function inferRunStatus(phase: AgentRunPhase, run: WorkRun): WorkRunStatus {
  if (phase === 'paused') return 'paused'
  if (phase === 'awaiting_approval' || phase === 'awaiting_input') return 'waiting'
  if (phase === 'recoverable_error') return 'failed'
  if (ACTIVE_PHASES.has(phase)) return 'running'
  return run.status
}

export class WorkExecutionTracker {
  private runs: WorkRun[] = []
  private currentRunId: string | null = null
  private toolActivityIds = new Map<string, string>()

  constructor(private conversationId: string) {}

  setConversationId(conversationId: string): void {
    this.conversationId = conversationId
  }

  startRun(id: string, objective: string, startedAt = Date.now(), options?: { restart?: boolean }): WorkRun {
    const existing = this.runs.find(run => run.id === id)
    if (existing && !options?.restart) {
      this.currentRunId = existing.id
      existing.status = 'running'
      existing.phase = 'thinking'
      existing.updatedAt = startedAt
      delete existing.completedAt
      delete existing.error
      delete existing.outcome
      existing.executionSegments ??= []
      if (!existing.executionSegments.length || existing.executionSegments.at(-1)?.endedAt !== undefined) {
        existing.executionSegments.push({ startedAt })
      }
      return existing
    }
    const run: WorkRun = {
      id,
      conversationId: this.conversationId,
      objective: objective.trim(),
      presentation: 'conversation',
      status: 'running',
      phase: 'thinking',
      rootStepIds: [],
      steps: {},
      activities: {},
      startedAt,
      updatedAt: startedAt,
      executionSegments: [{ startedAt }],
    }
    if (existing) this.runs[this.runs.indexOf(existing)] = run
    else this.runs.push(run)
    if (this.runs.length > MAX_RETAINED_RUNS) this.runs.splice(0, this.runs.length - MAX_RETAINED_RUNS)
    this.currentRunId = id
    return run
  }

  setPhase(phase: AgentRunPhase, detail?: string): void {
    const run = this.currentRun()
    if (!run) return
    const now = Date.now()
    if (phase === 'paused' || phase === 'aborting') {
      this.finishSegment(run, phase === 'paused' ? 'paused' : 'stopped', now)
    } else if (run.phase === 'paused' && ACTIVE_PHASES.has(phase)) {
      run.executionSegments ??= []
      run.executionSegments.push({ startedAt: now })
    }
    run.phase = phase
    run.status = inferRunStatus(phase, run)
    run.updatedAt = now
    if (detail) run.outcome = detail
  }

  getResponseMode(): ResponseMode | undefined {
    return this.currentRun()?.responseMode
  }

  setResponseMode(mode: ResponseMode): void {
    const run = this.currentRun()
    if (!run) throw new Error('No active run for response mode')
    if (run.responseMode && run.responseMode !== mode) throw new Error('Response mode is already declared for this run')
    run.responseMode = mode
    run.presentation = mode === 'task' ? 'work' : 'conversation'
    run.updatedAt = Date.now()
  }

  private finishSegment(run: WorkRun, outcome: WorkExecutionSegment['outcome'], endedAt: number): void {
    const segment = run.executionSegments?.at(-1)
    if (!segment || segment.endedAt !== undefined) return
    segment.endedAt = Math.max(segment.startedAt, endedAt)
    segment.outcome = outcome
  }

  syncTasks(manager: TaskManager): void {
    const run = this.currentRun()
    if (!run) return
    const allTasks = manager.getAllTasks()
    const tasks = allTasks.filter(task => task.metadata?.workRunId === run.id)
    if (tasks.length === 0 && this.runs.at(-1)?.id === run.id) {
      tasks.push(...allTasks.filter(task => !task.metadata?.workRunId))
    }
    const taskMap = new Map(tasks.map(task => [task.id, task]))
    const activityList = Object.values(run.activities)
    const nextSteps: Record<string, WorkStep> = {}
    for (const task of tasks) {
      const activities = activityList.filter(activity => activity.stepId === task.id)
      const explicitProgress = task.metadata?.workProgressExplicit === true
      const structuralProgress = task.children.length > 0
        && task.children.every(childId => taskMap.get(childId)?.status === 'completed')
      nextSteps[task.id] = {
        id: task.id,
        runId: run.id,
        title: task.title,
        description: task.description,
        status: stepStatus(task, taskMap, activities),
        parentId: task.parentId,
        childIds: [...task.children],
        dependencyIds: [...task.dependencies],
        order: task.order,
        progress: task.status === 'completed' ? 100 : explicitProgress || structuralProgress ? task.progress : null,
        progressMode: explicitProgress ? 'explicit' : structuralProgress ? 'structural' : 'indeterminate',
        activityIds: activities.map(activity => activity.id),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        error: task.error,
      }
    }
    run.steps = nextSteps
    if (tasks.length > 0 && run.responseMode !== 'chat') run.presentation = 'work'
    run.rootStepIds = tasks.filter(task => !task.parentId).sort((left, right) => left.order - right.order).map(task => task.id)
    run.updatedAt = Date.now()
  }

  startTool(toolCall: ToolCall, stepId?: string, path?: string): WorkActivity | null {
    const run = this.currentRun()
    if (!run) return null
    const signature = toolArgumentsSignature(toolCall.arguments)
    const priorAttempts = Object.values(run.activities).filter(activity =>
      activity.kind === activityKind(toolCall.name)
      && activity.title === toolCall.name
      && activity.stepId === stepId
      && activity.path === path
      && activity.metadata?.signature === signature)
    const now = Date.now()
    const activity: WorkActivity = {
      id: `activity-${toolCall.id}`,
      runId: run.id,
      stepId,
      kind: activityKind(toolCall.name),
      title: toolCall.name,
      status: 'running',
      attempt: priorAttempts.length + 1,
      startedAt: now,
      updatedAt: now,
      path,
      metadata: { arguments: toolCall.arguments, signature },
    }
    run.activities[activity.id] = activity
    this.toolActivityIds.set(toolCall.id, activity.id)
    run.updatedAt = now
    return activity
  }

  finishTool(result: ToolResult): WorkActivity | null {
    const run = this.currentRun()
    const activityId = this.toolActivityIds.get(result.toolCallId)
    if (!run || !activityId) return null
    const activity = run.activities[activityId]
    if (!activity) return null
    const now = Date.now()
    const failed = result.isError === true
    const recoveredAttempt = !failed && Object.values(run.activities).some(candidate =>
      candidate.id !== activity.id
      && candidate.stepId === activity.stepId
      && candidate.title === activity.title
      && candidate.path === activity.path
      && candidate.status === 'failed')
    activity.status = failed ? 'failed' : recoveredAttempt ? 'recovered' : 'completed'
    activity.updatedAt = now
    activity.completedAt = now
    if (failed) activity.error = result.output
    else activity.result = result.output
    run.updatedAt = now
    return activity
  }

  finishRun(
    status: Extract<WorkRunStatus, 'completed' | 'partial' | 'failed' | 'cancelled'>,
    outcome?: string,
    error?: string,
    manager?: TaskManager,
  ): void {
    const run = this.currentRun()
    if (!run) return
    const now = Date.now()
    this.finishSegment(run, status === 'cancelled' ? 'stopped' : status === 'partial' ? 'interrupted' : status, now)
    if (status === 'failed' && manager) {
      const tasks = manager.getTasksForWorkRun(run.id)
      const runningLeaves = tasks.filter(task => task.status === 'in_progress' && task.children.length === 0)
      const runningTasks = runningLeaves.length > 0 ? runningLeaves : tasks.filter(task => task.status === 'in_progress')
      for (const task of runningTasks) manager.updateTask(task.id, { status: 'failed', error })
      this.syncTasks(manager)
    }
    run.status = status
    run.phase = status
    run.outcome = outcome
    run.error = error
    run.updatedAt = now
    run.completedAt = now
    this.currentRunId = null
  }

  restoreFromTurns(turns: AgentTurn[], manager: TaskManager): void {
    this.runs = []
    this.currentRunId = null
    this.toolActivityIds.clear()
    let run: WorkRun | null = null
    const settleRestoredRun = (target: WorkRun, completedAt: number) => {
      const lastAssistant = [...turns].reverse().find(turn => (
        turn.timestamp <= completedAt
        && turn.role === 'assistant'
        && (!turn.metadata?.workRunId || turn.metadata.workRunId === target.id)
      ))
      const unfinishedTasks = manager.getTasksForWorkRun(target.id).some(task => (
        task.status === 'pending' || task.status === 'in_progress'
      ))
      const unfinishedActivities = Object.values(target.activities).some(activity => activity.status === 'running')
      const incomplete = lastAssistant?.metadata?.interrupted === true || unfinishedTasks || unfinishedActivities
      target.status = incomplete ? 'partial' : 'completed'
      target.phase = incomplete ? 'partial' : 'completed'
      target.completedAt = completedAt
      target.updatedAt = completedAt
      this.finishSegment(target, incomplete ? 'interrupted' : 'completed', completedAt)
    }
    for (const turn of turns) {
      if (turn.role === 'user' && turn.metadata?.internal !== true) {
        const restoredRunId = turn.metadata?.workRunId || turn.id
        if (run?.id === restoredRunId) continue
        if (run && !run.completedAt) {
          settleRestoredRun(run, turn.timestamp)
        }
        run = this.startRun(restoredRunId, turn.content, turn.timestamp)
        run.recoveredFromPersistence = true
      }
      if (!run) continue
      for (const call of turn.toolCalls || []) {
        if (call.name === 'set_response_mode') {
          const mode = call.arguments.mode
          if (mode === 'chat' || mode === 'task') this.setResponseMode(mode)
          continue
        }
        this.startTool(call)
      }
      for (const result of turn.toolResults || []) this.finishTool(result)
    }
    if (run) {
      settleRestoredRun(run, turns.at(-1)?.timestamp || run.startedAt)
    }
    this.currentRunId = null
    this.syncHistoricalTasks(manager)
  }

  restoreSnapshot(snapshot: WorkExecutionSnapshot | undefined, manager: TaskManager): boolean {
    if (!snapshot || snapshot.schemaVersion !== WORK_EXECUTION_SCHEMA_VERSION || !Array.isArray(snapshot.runs)) return false
    const journalRuns = new Map(this.runs.map(run => [run.id, run]))
    this.runs = snapshot.runs
      .filter(run => run && run.conversationId === this.conversationId && typeof run.id === 'string')
      .slice(-MAX_RETAINED_RUNS)
      .map(run => cloneRun({
        ...run,
        presentation: run.presentation || (Object.keys(run.steps || {}).length > 0 ? 'work' : 'conversation'),
      }))
    const interruptedRun = snapshot.currentRunId
      ? this.runs.find(run => run.id === snapshot.currentRunId)
      : undefined
    if (interruptedRun && RECOVERED_ACTIVE_STATUSES.has(interruptedRun.status)) {
      interruptedRun.status = 'partial'
      interruptedRun.phase = 'partial'
      interruptedRun.completedAt = interruptedRun.updatedAt
      interruptedRun.recoveredFromPersistence = true
      this.finishSegment(interruptedRun, 'interrupted', interruptedRun.completedAt)
    }
    for (const run of this.runs) {
      const journalRun = journalRuns.get(run.id)
      for (const activity of Object.values(run.activities)) {
        if (activity.status !== 'running') continue
        const recoveredActivity = journalRun?.activities[activity.id]
        if (recoveredActivity && recoveredActivity.status !== 'running') {
          run.activities[activity.id] = cloneActivity(recoveredActivity)
          continue
        }
        activity.status = 'cancelled'
        activity.completedAt = activity.updatedAt
      }
    }
    this.currentRunId = null
    this.toolActivityIds.clear()
    for (const run of this.runs) {
      for (const activity of Object.values(run.activities)) {
        if (activity.id.startsWith('activity-')) this.toolActivityIds.set(activity.id.slice('activity-'.length), activity.id)
      }
    }
    this.syncHistoricalTasks(manager)
    return true
  }

  getSnapshot(manager: TaskManager): WorkExecutionSnapshot {
    if (this.currentRunId) this.syncTasks(manager)
    else if (this.runs.length > 0) {
      const latestRunId = this.runs.at(-1)!.id
      this.currentRunId = latestRunId
      this.syncTasks(manager)
      this.currentRunId = null
    }
    return {
      schemaVersion: WORK_EXECUTION_SCHEMA_VERSION,
      currentRunId: this.currentRunId,
      runs: this.runs.map(cloneRun),
    }
  }

  getCurrentRunId(): string | null {
    return this.currentRunId
  }

  private currentRun(): WorkRun | null {
    return this.currentRunId ? this.runs.find(run => run.id === this.currentRunId) || null : null
  }

  private syncHistoricalTasks(manager: TaskManager): void {
    const latest = this.runs.at(-1)
    if (!latest) return
    this.currentRunId = latest.id
    this.syncTasks(manager)
    this.currentRunId = null
  }
}
