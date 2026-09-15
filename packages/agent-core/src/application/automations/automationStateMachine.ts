import type { AutomationRunStatus } from './automationTypes'

const transitions: Record<AutomationRunStatus, ReadonlySet<AutomationRunStatus>> = {
  queued: new Set(['preparing', 'skipped', 'canceled', 'invalid', 'needs_review']),
  preparing: new Set(['running', 'invalid', 'failed', 'canceled', 'interrupted', 'needs_review']),
  running: new Set(['waiting_for_approval', 'checkpointed', 'completed', 'failed', 'canceled', 'interrupted', 'needs_review']),
  waiting_for_approval: new Set(['running', 'canceled', 'expired', 'interrupted', 'needs_review']),
  checkpointed: new Set(['running', 'retry_scheduled', 'needs_review', 'canceled', 'interrupted']),
  retry_scheduled: new Set(['queued', 'canceled', 'expired']),
  needs_review: new Set(['queued', 'canceled']),
  completed: new Set(),
  failed: new Set(['retry_scheduled', 'needs_review']),
  canceled: new Set(),
  interrupted: new Set(['queued', 'retry_scheduled', 'needs_review', 'canceled']),
  skipped: new Set(),
  expired: new Set(),
  invalid: new Set(['queued', 'canceled']),
}

export function canTransitionAutomationRun(from: AutomationRunStatus, to: AutomationRunStatus): boolean {
  return from === to || transitions[from].has(to)
}

export function assertAutomationRunTransition(from: AutomationRunStatus, to: AutomationRunStatus): void {
  if (!canTransitionAutomationRun(from, to)) throw new Error(`Invalid automation run transition: ${from} -> ${to}`)
}

export function terminalAutomationRunStatus(status: AutomationRunStatus): boolean {
  return ['completed', 'canceled', 'skipped', 'expired'].includes(status)
}
