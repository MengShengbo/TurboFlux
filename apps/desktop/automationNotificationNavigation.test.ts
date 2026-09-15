import { describe, expect, it } from 'vitest'
import {
  automationApprovalNavigationIntent,
  automationResultNavigationIntent,
} from './automationNotificationNavigation'

describe('automation notification navigation', () => {
  it('routes result and approval notifications to their exact durable records', () => {
    expect(automationResultNavigationIntent({ runId: ' run-1 ' })).toEqual({
      kind: 'automation-run',
      runId: 'run-1',
    })
    expect(automationApprovalNavigationIntent({ approvalId: ' approval-1 ', runId: ' run-1 ' })).toEqual({
      kind: 'automation-approval',
      approvalId: 'approval-1',
      runId: 'run-1',
    })
  })
})
