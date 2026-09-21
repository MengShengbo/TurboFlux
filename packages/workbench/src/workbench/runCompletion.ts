import type { AgentTurn } from '@turboflux/contracts/agentTypes'
import type { WorkExecutionSnapshot, WorkRunStatus } from '@turboflux/contracts/workExecutionTypes'

export type WorkbenchRunCompletionStatus = 'completed' | 'partial' | 'failed' | 'interrupted'

export interface WorkbenchRunCompletion {
  status: WorkbenchRunCompletionStatus
  resultSummary?: string
  error?: string
}

function completionStatus(status: WorkRunStatus | undefined): WorkbenchRunCompletionStatus | undefined {
  if (status === 'completed') return 'completed'
  if (status === 'partial') return 'partial'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'interrupted'
  return undefined
}

function compactFinalDelivery(turns: readonly AgentTurn[], runId: string): string | undefined {
  const assistant = [...turns].reverse().find(turn => (
    turn.role === 'assistant'
    && turn.metadata?.internal !== true
    && (!turn.metadata?.workRunId || turn.metadata.workRunId === runId)
    && turn.content.trim()
  ))
  return assistant?.content.replace(/\s+/g, ' ').trim().slice(0, 4_000) || undefined
}

export function resolveWorkbenchRunCompletion(input: {
  runId: string
  turns: readonly AgentTurn[]
  execution: WorkExecutionSnapshot
  fallbackStatus: Exclude<WorkbenchRunCompletionStatus, 'partial'>
  error?: string
}): WorkbenchRunCompletion {
  const run = [...input.execution.runs].reverse().find(candidate => candidate.id === input.runId)
  const status = input.fallbackStatus === 'completed'
    ? completionStatus(run?.status) || 'completed'
    : input.fallbackStatus
  const resultSummary = status === 'completed' || status === 'partial'
    ? compactFinalDelivery(input.turns, input.runId)
    : undefined
  return {
    status,
    resultSummary,
    error: input.error || run?.error,
  }
}
