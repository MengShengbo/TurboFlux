import { describe, expect, it } from 'vitest'
import { automationFailureEvent, automationRunErrorFromFailure, classifyAutomationFailure } from './automationFailure'

describe('automation failure classification', () => {
  it('separates timeouts, exhausted budgets, and ordinary failures', () => {
    expect(classifyAutomationFailure('Exceeded the 60 minute runtime limit.')).toBe('timeout')
    expect(classifyAutomationFailure('Automation run exceeded its total output-token budget of 1000')).toBe('budget')
    expect(classifyAutomationFailure('Provider authentication failed')).toBe('failed')
    expect(classifyAutomationFailure({ category: 'budget', message: 'Localized message' })).toBe('budget')
  })

  it('only classifies failed run outcomes and creates durable structured errors', () => {
    expect(automationFailureEvent({ status: 'completed', result: { outcome: 'success' }, error: 'timed out' })).toBeNull()
    expect(automationFailureEvent({ status: 'failed', error: { category: 'timeout', message: 'Stopped' } })).toBe('timeout')
    expect(automationRunErrorFromFailure('Automation run exceeded its total subtask budget of 4')).toEqual({
      code: 'automation_budget_exhausted',
      category: 'budget',
      message: 'Automation run exceeded its total subtask budget of 4',
      retryable: true,
    })
  })
})
