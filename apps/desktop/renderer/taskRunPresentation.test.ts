import { describe, expect, it } from 'vitest'
import type { LinearTaskFlowItem, TaskFlowNode, WorkRun } from '@turboflux/presentation'
import { formatTaskDuration, phaseStatusLabel, taskRunElapsedMs, taskRunStatusLabel, withTaskRunStatus } from '@turboflux/renderer/taskRunPresentation'

const run: WorkRun = {
  id: 'run-1', conversationId: 'conversation-1', objective: 'Inspect', responseMode: 'task', presentation: 'work',
  status: 'running', phase: 'thinking', rootStepIds: [], steps: {}, activities: {}, startedAt: 1_000, updatedAt: 201_000,
  executionSegments: [
    { startedAt: 1_000, endedAt: 8_000, outcome: 'paused' },
    { startedAt: 100_000, endedAt: 105_000, outcome: 'paused' },
    { startedAt: 200_000 },
  ],
}

function item(id: string, kind: 'input' | 'answer', at: number): LinearTaskFlowItem {
  return { key: id, kind: 'node', node: {
    id, kind, runId: run.id, ordinal: at, phase: 'delivery', status: 'completed', content: id,
    createdAt: at, updatedAt: at, settled: true,
  } }
}

describe('task run presentation', () => {
  const phase: TaskFlowNode = {
    id: 'phase:run-1', runId: 'run-1', kind: 'phase', ordinal: 2, phase: 'execution',
    status: 'running', settled: false, content: 'Planning the next step', createdAt: 1_000, updatedAt: 60_000,
  }

  it.each([
    [1_000, '0秒'], [1_999, '0秒'], [2_000, '1秒'],
    [60_999, '59秒'], [61_000, '1分0秒'], [62_000, '1分1秒'],
  ])('keeps the request timer anchored at its start at %i', (now, duration) => {
    expect(phaseStatusLabel(phase, undefined, now)).toBe(`正在请求中 ${duration}`)
    expect(phaseStatusLabel({ ...phase, content: 'Running 1 tool', updatedAt: now }, undefined, now))
      .toBe(`正在请求中 ${duration}`)
  })

  it('uses execution time after pause and preserves non-request statuses', () => {
    expect(phaseStatusLabel(phase, run, 248_000)).toBe('正在请求中 1分0秒')
    expect(phaseStatusLabel({ ...phase, status: 'paused' }, run, 248_000)).toBe('工作已暂停')
    expect(phaseStatusLabel({ ...phase, content: 'awaiting_approval' }, run, 248_000)).toBe('正在等待确认')
    expect(phaseStatusLabel({ ...phase, status: 'failed' }, run, 248_000)).toBe('任务需要处理')
    expect(phaseStatusLabel({ ...phase, status: 'completed', settled: true }, run, 248_000)).toBe('任务已完成')
  })

  it.each([
    [0, '0秒'], [999, '0秒'], [1_000, '1秒'], [59_999, '59秒'], [60_000, '1分0秒'], [61_000, '1分1秒'], [3_600_000, '60分0秒'],
  ])('formats %i milliseconds as %s', (ms, label) => {
    expect(formatTaskDuration(ms)).toBe(label)
  })

  it('shows immutable stop durations and cumulative execution time on completion', () => {
    expect(taskRunElapsedMs(run, 248_000)).toBe(60_000)
    expect(taskRunStatusLabel(run, 0, 248_000)).toBe('你在 7秒 后停止了')
    expect(taskRunStatusLabel(run, 1, 248_000)).toBe('你在 5秒 后停止了')
    expect(taskRunStatusLabel(run, 2, 248_000)).toBe('已处理 1分0秒')
    const completed: WorkRun = { ...run, status: 'completed', completedAt: 248_000 }
    expect(taskRunStatusLabel(completed, 2, 900_000)).toBe('用时 1分0秒')
    expect(taskRunStatusLabel({ ...completed, status: 'failed' }, 2)).not.toMatch(/^用时/)
  })

  it('places each status above its execution segment and retains all stop records', () => {
    const items = [item('input', 'input', 1_000), item('first', 'answer', 2_000), item('second', 'answer', 101_000)]
    const result = withTaskRunStatus(items, () => run)
    expect(result.map(item => item.key)).toEqual([
      'input', 'run-status:run-1:0', 'first', 'run-status:run-1:1', 'second', 'run-status:run-1:2',
    ])
    expect(withTaskRunStatus(items, () => ({ ...run, responseMode: 'chat' }))).toEqual(items)
    expect(withTaskRunStatus(items, () => ({ ...run, responseMode: undefined }))).toEqual(items)
  })
})
