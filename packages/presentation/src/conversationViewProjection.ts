import type { AgentRunState } from '@turboflux/contracts/agentTypes'
import type { WorkExecutionSnapshot, WorkRun } from '@turboflux/contracts/workExecutionTypes'
import type { AnyConversationEvent } from '@turboflux/contracts/conversationEvent'
import { applyTaskFlowEvent, type TaskFlowProjectionState } from './taskFlowProjection'

export type ConversationRuntimeStatus = 'ready' | 'running' | 'paused' | 'awaiting-action' | 'error'

/** One sequence cursor owns the transcript, execution timing, and composer state. */
export interface ConversationViewState {
  generation?: number
  flow: TaskFlowProjectionState
  execution: WorkExecutionSnapshot
  runState: AgentRunState
  status: ConversationRuntimeStatus
}

export function conversationRuntimeStatus(state: AgentRunState): ConversationRuntimeStatus {
  if (state.phase === 'paused') return 'paused'
  if (state.phase === 'awaiting_approval' || state.phase === 'awaiting_input') return 'awaiting-action'
  if (state.phase === 'recoverable_error') return 'error'
  if (['thinking', 'compacting', 'tool_running', 'aborting'].includes(state.phase)) return 'running'
  return 'ready'
}

export function applyConversationViewSnapshot(
  current: ConversationViewState | null,
  incoming: ConversationViewState,
): ConversationViewState {
  if (current?.flow.conversationId === incoming.flow.conversationId) {
    const currentGeneration = current.generation ?? 0
    const incomingGeneration = incoming.generation ?? 0
    if (incomingGeneration < currentGeneration
      || incomingGeneration === currentGeneration && incoming.flow.lastSeq < current.flow.lastSeq) return current
  }
  // A promise can still be releasing resources after its terminal fact was
  // published. Its bookkeeping must not turn a completed view back to running.
  if (!incoming.flow.activeRunId && ['completed', 'recoverable_error'].includes(incoming.runState.phase)) {
    return { ...incoming, status: conversationRuntimeStatus(incoming.runState) }
  }
  return incoming
}

function completedExecution(execution: WorkExecutionSnapshot, event: Extract<AnyConversationEvent, { type: 'run.completed' }>): WorkExecutionSnapshot {
  const previous = execution.runs.find(run => run.id === event.runId)
  // Old journals lack the run payload. Their timestamp and outcome remain
  // sufficient to settle timing without inventing a successful result.
  const status = event.payload.outcome === 'interrupted' ? 'partial' : event.payload.outcome
  const outcome = status === 'cancelled' ? 'stopped' : status === 'partial' ? 'interrupted' : status
  const run: WorkRun | undefined = event.payload.run || (previous ? {
    ...previous,
    status,
    phase: status,
    completedAt: event.at,
    updatedAt: event.at,
    error: event.payload.error,
    executionSegments: previous.executionSegments?.map(segment => segment.endedAt !== undefined
      ? segment
      : { ...segment, endedAt: event.at, outcome }),
  } : undefined)
  return {
    ...execution,
    currentRunId: execution.currentRunId === event.runId ? null : execution.currentRunId,
    runs: !run ? execution.runs : previous
      ? execution.runs.map(candidate => candidate.id === run.id ? run : candidate)
      : [...execution.runs, run],
  }
}

export function applyConversationViewEvent(current: ConversationViewState, event: AnyConversationEvent): ConversationViewState {
  const { flow } = current
  if ((event.generation ?? 0) !== (current.generation ?? 0)) return current
  if (event.conversationId !== flow.conversationId || event.threadId !== flow.conversationId || event.seq <= flow.lastSeq) return current
  // Never apply a completion ahead of missing text/tool events. The consumer
  // requests a snapshot at this boundary and resumes from its sequence cursor.
  if (event.seq !== flow.lastSeq + 1) return current
  if (event.type === 'run.state_changed' && event.runId !== flow.activeRunId) {
    return { ...current, flow: { ...flow, lastSeq: event.seq } }
  }
  const next: ConversationViewState = { ...current, flow: applyTaskFlowEvent(flow, event) }
  if (event.type === 'execution.updated') {
    next.execution = {
      ...event.payload.snapshot,
      currentRunId: flow.activeRunId || null,
      runs: event.payload.snapshot.runs.flatMap(run => {
        const previous = current.execution.runs.find(candidate => candidate.id === run.id)
        if (run.id !== flow.activeRunId && ['pending', 'running', 'waiting', 'paused'].includes(run.status)) return previous ? [previous] : []
        return [run]
      }),
    }
  }
  if (event.type === 'run.state_changed') {
    next.runState = event.payload.state
    next.status = conversationRuntimeStatus(next.runState)
  }
  if (event.type === 'run.started') {
    next.runState = { phase: 'thinking', startedAt: event.at, updatedAt: event.at }
    next.status = 'running'
  }
  if (event.type === 'run.completed') {
    next.execution = completedExecution(current.execution, event)
    if (!flow.activeRunId || flow.activeRunId === event.runId) {
      next.runState = event.payload.state || {
        phase: event.payload.outcome === 'failed' ? 'recoverable_error' : 'completed',
        startedAt: current.runState.startedAt,
        updatedAt: event.at,
        detail: event.payload.error,
      }
      next.status = conversationRuntimeStatus(next.runState)
    }
  }
  return next
}
