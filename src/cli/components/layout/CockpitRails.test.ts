import { describe, expect, it } from 'vitest'
import { getTaskRailGoal, resolveCockpitLayout } from './CockpitRails'

describe('cockpit layout', () => {
  it('keeps the main conversation full width at every terminal size', () => {
    expect(resolveCockpitLayout(140)).toEqual({
      showWorkRail: false,
      showTaskRail: false,
      workWidth: 0,
      taskWidth: 0,
    })
  })

  it('keeps the conversation clear until the task rail has room', () => {
    expect(resolveCockpitLayout(110)).toMatchObject({ showWorkRail: false, showTaskRail: false })
    expect(resolveCockpitLayout(116)).toMatchObject({ showWorkRail: false, showTaskRail: false })
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
