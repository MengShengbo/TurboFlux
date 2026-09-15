import { describe, expect, it } from 'vitest'
import type { AgentTurn } from '../../shared/agentTypes'
import type { WorkExecutionSnapshot, WorkRun, WorkRunStatus } from '../../shared/workExecutionTypes'
import { resolveWorkbenchRunCompletion } from './runCompletion'

function execution(status?: WorkRunStatus): WorkExecutionSnapshot {
  const run: WorkRun | undefined = status ? {
    id: 'run-1',
    conversationId: 'conversation-1',
    objective: '完成任务',
    presentation: 'work',
    status,
    phase: status,
    rootStepIds: [],
    steps: {},
    activities: {},
    startedAt: 1,
    updatedAt: 2,
    completedAt: 2,
  } : undefined
  return { schemaVersion: 1, currentRunId: null, runs: run ? [run] : [] }
}

function assistant(content: string, metadata: AgentTurn['metadata'] = { workRunId: 'run-1' }): AgentTurn {
  return { id: `assistant-${content}`, role: 'assistant', content, timestamp: 2, metadata }
}

describe('workbench run completion', () => {
  it('keeps ordinary answers completed when no execution record is available', () => {
    expect(resolveWorkbenchRunCompletion({
      runId: 'run-1',
      turns: [assistant('直接回答')],
      execution: execution(),
      fallbackStatus: 'completed',
    })).toEqual({ status: 'completed', resultSummary: '直接回答', error: undefined })
  })

  it('preserves partial execution instead of publishing false success', () => {
    expect(resolveWorkbenchRunCompletion({
      runId: 'run-1',
      turns: [assistant('已完成可交付部分，剩余风险已说明。')],
      execution: execution('partial'),
      fallbackStatus: 'completed',
    })).toEqual({
      status: 'partial',
      resultSummary: '已完成可交付部分，剩余风险已说明。',
      error: undefined,
    })
  })

  it('does not expose internal or unrelated turns as the final delivery', () => {
    expect(resolveWorkbenchRunCompletion({
      runId: 'run-1',
      turns: [
        assistant('真实总结'),
        assistant('其他任务', { workRunId: 'run-2' }),
        assistant('内部错误', { workRunId: 'run-1', internal: true }),
      ],
      execution: execution('completed'),
      fallbackStatus: 'completed',
    }).resultSummary).toBe('真实总结')
  })
})
