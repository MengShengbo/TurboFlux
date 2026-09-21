import type { AutomationDeliveryEventType, AutomationRunError } from './automationTypes'

export type AutomationFailureEventType = Extract<AutomationDeliveryEventType, 'failed' | 'timeout' | 'budget'>

interface AutomationFailureInput {
  status?: string
  result?: { outcome?: string } | null
  error?: string | Partial<AutomationRunError> | null
}

function errorText(error: AutomationFailureInput['error']): string {
  if (typeof error === 'string') return error
  return [error?.code, error?.category, error?.message].filter(Boolean).join('\n')
}

export function classifyAutomationFailure(error: AutomationFailureInput['error']): AutomationFailureEventType {
  if (typeof error !== 'string' && error?.category === 'budget') return 'budget'
  if (typeof error !== 'string' && error?.category === 'timeout') return 'timeout'
  const text = errorText(error).toLowerCase()
  if (/\b(?:budget|tool-call budget|input-token budget|output-token budget|subtask budget)\b/.test(text)) return 'budget'
  if (/\b(?:timed?\s*out|timeout|runtime limit)\b/.test(text)) return 'timeout'
  return 'failed'
}

export function automationFailureEvent(input: AutomationFailureInput): AutomationFailureEventType | null {
  const failed = ['failed', 'interrupted', 'retry_scheduled'].includes(input.status ?? '')
    || input.result?.outcome === 'failed'
  return failed ? classifyAutomationFailure(input.error) : null
}

export function automationRunErrorFromFailure(error: string): AutomationRunError {
  const eventType = classifyAutomationFailure(error)
  return {
    code: eventType === 'timeout'
      ? 'automation_execution_timeout'
      : eventType === 'budget'
        ? 'automation_budget_exhausted'
        : 'automation_execution_failed',
    category: eventType === 'timeout' ? 'timeout' : eventType === 'budget' ? 'budget' : 'transient',
    message: error,
    retryable: true,
  }
}
