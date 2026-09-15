import { describe, expect, it } from 'vitest'
import { AutomationNotifications } from './automationNotifications'

describe('automation notifications', () => {
  it('ignores past results and notifies once when a running task finishes', () => {
    const planner = new AutomationNotifications()
    const definition = { name: 'Daily review', history: [{ id: 'old', status: 'completed' }, { id: 'new', status: 'running' }] }
    expect(planner.observe([definition])).toEqual([])
    definition.history[1]!.status = 'completed'
    expect(planner.observe([definition])).toMatchObject([{ runId: 'new', failed: false }])
    expect(planner.observe([definition])).toEqual([])
  })

  it('surfaces failures and pending recovery without replaying them on profile activation', () => {
    const planner = new AutomationNotifications()
    planner.observe([])
    const definition = { name: 'Daily review', history: [{ id: 'failed', status: 'failed', error: 'Workspace missing' }, { id: 'review', status: 'needs_review' }] }
    expect(planner.observe([definition])).toMatchObject([{ runId: 'failed', summary: 'Workspace missing', failed: true }, { runId: 'review', failed: true }])
    expect(new AutomationNotifications().observe([definition])).toEqual([])
  })
})
