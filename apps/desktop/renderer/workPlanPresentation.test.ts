import { describe, expect, it } from 'vitest'
import type { WorkRun, WorkStep } from '@turboflux/agent-core/workbench'
import { workPlanSummary, workPlanVersion } from './workPlanPresentation'

function step(id: string, order: number, status: WorkStep['status']): WorkStep {
  return {
    id,
    runId: 'run-1',
    title: id,
    description: '',
    status,
    parentId: null,
    childIds: [],
    dependencyIds: [],
    order,
    progress: null,
    progressMode: 'indeterminate',
    activityIds: [],
    createdAt: order,
    updatedAt: order,
  }
}

function run(steps: WorkStep[]): WorkRun {
  return {
    id: 'run-1',
    conversationId: 'conversation-1',
    objective: '完成任务',
    presentation: 'work',
    status: 'running',
    phase: 'tool_running',
    rootStepIds: steps.map(item => item.id),
    steps: Object.fromEntries(steps.map(item => [item.id, item])),
    activities: {},
    startedAt: 1,
    updatedAt: 4,
  }
}

describe('work plan presentation', () => {
  it('summarizes completed and currently active work', () => {
    const value = run([
      step('搭建页面', 1, 'completed'),
      step('实现交互', 2, 'running'),
      step('验证结果', 3, 'pending'),
    ])
    expect(workPlanSummary(value)).toEqual({ completed: 1, total: 3, activeTitle: '实现交互' })
  })

  it('changes its version when a step state changes', () => {
    const value = run([step('搭建页面', 1, 'running')])
    const before = workPlanVersion(value)
    value.steps['搭建页面'].status = 'completed'
    value.steps['搭建页面'].updatedAt = 9
    expect(workPlanVersion(value)).not.toBe(before)
  })
})
