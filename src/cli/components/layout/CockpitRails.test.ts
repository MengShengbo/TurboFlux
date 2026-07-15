import { describe, expect, it } from 'vitest'
import { getTaskRailGoal, resolveCockpitLayout } from './CockpitRails'

describe('cockpit layout', () => {
  it('shows both information rails on wide terminals', () => {
    expect(resolveCockpitLayout(140)).toEqual({
      showWorkRail: true,
      showTaskRail: true,
      workWidth: 28,
      taskWidth: 34,
    })
  })

  it('keeps only the task rail at medium widths', () => {
    expect(resolveCockpitLayout(110)).toMatchObject({ showWorkRail: false, showTaskRail: true })
  })

  it('protects the conversation on narrow terminals', () => {
    expect(resolveCockpitLayout(88)).toMatchObject({ showWorkRail: false, showTaskRail: false })
  })
})

describe('task rail goal', () => {
  it('prefers the real user objective while the task plan is being built', () => {
    expect(getTaskRailGoal(null, '  Fix the terminal layout  ')).toBe('Fix the terminal layout')
  })

  it('falls back to the task manager title', () => {
    expect(getTaskRailGoal({
      taskId: 'task-1',
      title: 'Inspect rendering',
      priority: 'major',
      progress: 0,
      toolCalls: [],
      startedAt: 0,
    }, null)).toBe('Inspect rendering')
  })
})
