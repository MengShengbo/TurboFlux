export type AutomationNotificationNavigationIntent =
  | { kind: 'automation-run'; runId: string }
  | { kind: 'automation-approval'; approvalId: string; runId: string }

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${name}`)
  return value.trim()
}

export function automationApprovalNavigationIntent(input: {
  approvalId: unknown
  runId: unknown
}): AutomationNotificationNavigationIntent {
  return {
    kind: 'automation-approval',
    approvalId: identifier(input.approvalId, 'automation approval ID'),
    runId: identifier(input.runId, 'automation run ID'),
  }
}

export function automationResultNavigationIntent(
  input: { runId: unknown },
): AutomationNotificationNavigationIntent {
  return { kind: 'automation-run', runId: identifier(input.runId, 'automation run ID') }
}
