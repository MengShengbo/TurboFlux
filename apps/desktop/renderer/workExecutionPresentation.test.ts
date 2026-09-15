import { describe, expect, it } from 'vitest'
import type { WorkExecutionSnapshot, WorkRun, WorkStep } from '@turboflux/agent-core/workbench'
import {
  activeSiblingCount,
  activeWorkSteps,
  completedTaskTurnDuration,
  orderedWorkSteps,
  presentWorkRun,
  presentWorkStages,
  selectProjectedWorkRun,
  selectWorkRun,
  workRunDuration,
  workStepDependencies,
} from './workExecutionPresentation'

const step = (id: string, order: number, status: WorkStep['status'] = 'pending', parentId: string | null = null): WorkStep => ({
  id,
  runId: 'run-1',
  title: id,
  description: '',
  status,
  parentId,
  childIds: [],
  dependencyIds: [],
  order,
  progress: null,
  progressMode: 'indeterminate',
  activityIds: [],
  createdAt: order,
  updatedAt: order,
})

const run = (id: string, steps: WorkStep[] = []): WorkRun => ({
  id,
  conversationId: 'conversation-1',
  objective: id,
  presentation: 'work',
  status: 'running',
  phase: 'tool_running',
  rootStepIds: steps.filter(item => !item.parentId).map(item => item.id),
  steps: Object.fromEntries(steps.map(item => [item.id, { ...item, runId: id }])),
  activities: {},
  startedAt: 1,
  updatedAt: 1,
})

describe('work execution presentation', () => {
  it('sorts displayed children by semantic order instead of creation order', () => {
    const parent = step('parent', 0)
    const second = step('second', 2, 'pending', parent.id)
    const first = step('first', 1, 'pending', parent.id)
    parent.childIds = [second.id, first.id]
    const workRun = run('run-1', [parent, second, first])

    expect(orderedWorkSteps(workRun, parent.childIds).map(item => item.id)).toEqual(['first', 'second'])
  })

  it('reports unresolved dependencies and parallel active siblings', () => {
    const first = step('first', 1, 'running')
    const second = step('second', 2, 'waiting')
    const blocked = step('blocked', 3, 'blocked')
    blocked.dependencyIds = [first.id, second.id]
    const workRun = run('run-1', [first, second, blocked])

    expect(activeWorkSteps(workRun).map(item => item.id)).toEqual(['second', 'first'])
    expect(activeSiblingCount(first, workRun)).toBe(2)
    expect(workStepDependencies(blocked, workRun).unresolved.map(item => item.id)).toEqual(['first', 'second'])
  })

  it('selects an explicit historical run before current and latest fallbacks', () => {
    const first = run('run-1')
    first.status = 'completed'
    const second = run('run-2')
    const execution: WorkExecutionSnapshot = { schemaVersion: 1, currentRunId: second.id, runs: [first, second] }

    expect(selectWorkRun(execution, first.id)?.id).toBe(first.id)
    expect(selectWorkRun(execution)?.id).toBe(second.id)
    expect(selectWorkRun({ ...execution, currentRunId: null })?.id).toBe(second.id)
  })

  it('projects only the explicitly retained current-turn run', () => {
    const first = run('run-1', [step('旧任务', 1, 'completed')])
    first.status = 'completed'
    const second = run('run-2', [step('新任务', 1, 'running')])
    const execution: WorkExecutionSnapshot = { schemaVersion: 1, currentRunId: null, runs: [first, second] }

    expect(selectProjectedWorkRun(execution)).toBeUndefined()
    expect(selectProjectedWorkRun(execution, 'missing')).toBeUndefined()
    expect(selectProjectedWorkRun(execution, first.id)?.id).toBe(first.id)
    expect(selectProjectedWorkRun(execution, second.id)?.id).toBe(second.id)
  })

  it('projects one stable user-facing state for every work surface', () => {
    const first = step('收集资料', 1, 'completed')
    const second = step('整理交付', 2, 'running')
    second.updatedAt = 20
    const workRun = run('run-1', [first, second])
    workRun.startedAt = 1_000

    expect(presentWorkRun(workRun, 66_000)).toMatchObject({
      runId: 'run-1',
      status: 'running',
      statusLabel: '正在执行',
      tone: 'active',
      title: '整理交付',
      detail: '1/2 个步骤',
      activeStepCount: 1,
      completedStepCount: 1,
      totalStepCount: 2,
      duration: '1 分 5 秒',
      attention: false,
      terminal: false,
    })
  })

  it('uses the neutral request label before a concrete work step exists', () => {
    const workRun = run('run-1')
    workRun.phase = 'thinking'

    expect(presentWorkRun(workRun).title).toBe('请求中')
  })

  it('uses terminal truth instead of leaving a stale active-step title', () => {
    const unfinished = step('验证页面', 1, 'failed')
    const workRun = run('run-1', [unfinished])
    workRun.status = 'partial'
    workRun.completedAt = 62_000

    expect(presentWorkRun(workRun, 90_000)).toMatchObject({
      statusLabel: '部分工作未完成',
      title: '部分工作未完成',
      detail: '0/1 个步骤',
      tone: 'warning',
      attention: true,
      terminal: true,
    })
    expect(workRunDuration(1_000, 62_000, 90_000)).toBe('1 分 1 秒')
  })

  it('measures a completed task from its user turn through final delivery', () => {
    expect(completedTaskTurnDuration(1_000, 20_600)).toBe('19 秒')
    expect(completedTaskTurnDuration(1_000, 346_000)).toBe('5 分 45 秒')
    expect(completedTaskTurnDuration(20_000, 10_000)).toBe('')
    expect(completedTaskTurnDuration(undefined, 10_000)).toBe('')
  })

  it('projects semantic task hierarchy instead of tool categories', () => {
    const parent = step('调研并制定方案', 1, 'running')
    parent.title = '调研并制定方案'
    const child = step('核对官方资料', 2, 'completed', parent.id)
    child.title = '核对官方资料'
    parent.childIds = [child.id]
    const workRun = run('run-1', [parent, child])

    expect(presentWorkStages(workRun)).toEqual([
      { id: parent.id, title: '调研并制定方案', state: 'running', progress: null, depth: 0 },
      { id: child.id, title: '核对官方资料', state: 'completed', progress: null, depth: 1 },
    ])
  })
})
