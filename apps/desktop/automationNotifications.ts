interface NotificationRun {
  id: string
  status: string
  conversationId?: string
  error?: string
  resultSummary?: string
}

export class AutomationNotifications {
  private initialized = false
  private observed = new Set<string>()

  observe(definitions: Array<{ name: string; history: NotificationRun[] }>) {
    const next = new Set<string>()
    const notifications: Array<{ runId: string; conversationId?: string; title: string; summary: string; failed: boolean }> = []
    for (const definition of definitions) {
      for (const run of definition.history) {
        if (!['completed', 'failed', 'interrupted', 'needs_review', 'invalid'].includes(run.status)) continue
        next.add(run.id)
        if (!this.initialized || this.observed.has(run.id)) continue
        const failed = run.status !== 'completed'
        notifications.push({
          runId: run.id,
          conversationId: run.conversationId,
          title: `${definition.name} · ${failed ? '需要检查' : '已完成'}`,
          summary: (run.error || run.resultSummary || '').slice(0, 1_000),
          failed,
        })
      }
    }
    this.observed = next
    this.initialized = true
    return notifications
  }
}
