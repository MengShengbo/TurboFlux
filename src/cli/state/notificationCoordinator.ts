export type NotificationCategory =
  | 'action-required'
  | 'error'
  | 'warning'
  | 'result-ready'
  | 'turn-complete'
  | 'info'

export interface CoordinatedNotificationInput {
  id: string
  category: NotificationCategory
  title: string
  detail?: string
  sourceId?: string
  persistent?: boolean
  priority?: number
}

export interface CoordinatedNotification extends CoordinatedNotificationInput {
  priority: number
  persistent: boolean
  createdAt: number
  updatedAt: number
  count: number
  acknowledged: boolean
}

export interface NotificationSnapshot {
  active: CoordinatedNotification | null
  inbox: CoordinatedNotification[]
  unacknowledgedCount: number
  resultCount: number
  terminalTitle: string
}

const CATEGORY_PRIORITY: Record<NotificationCategory, number> = {
  'action-required': 100,
  error: 90,
  warning: 70,
  'result-ready': 60,
  'turn-complete': 20,
  info: 10,
}

const MAX_TRANSIENT_NOTIFICATIONS = 64

function notificationOrder(left: CoordinatedNotification, right: CoordinatedNotification): number {
  return right.priority - left.priority || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
}

export function sanitizeTerminalTitle(value: string): string {
  return Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim())
    .slice(0, 96)
    .join('')
}

export class NotificationCoordinator {
  private readonly notifications = new Map<string, CoordinatedNotification>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly enabled = true,
  ) {}

  raise(input: CoordinatedNotificationInput): CoordinatedNotification {
    const timestamp = this.now()
    const dedupeKey = `${input.category}:${input.sourceId ?? input.id}`
    const duplicate = [...this.notifications.values()].find(notification =>
      !notification.acknowledged && `${notification.category}:${notification.sourceId ?? notification.id}` === dedupeKey,
    )
    if (duplicate) {
      const updated: CoordinatedNotification = {
        ...duplicate,
        title: input.title,
        detail: input.detail,
        priority: input.priority ?? CATEGORY_PRIORITY[input.category],
        persistent: input.persistent ?? duplicate.persistent,
        updatedAt: timestamp,
        count: duplicate.count + 1,
      }
      this.notifications.set(updated.id, updated)
      this.pruneTransientNotifications()
      return { ...updated }
    }

    const notification: CoordinatedNotification = {
      ...input,
      priority: input.priority ?? CATEGORY_PRIORITY[input.category],
      persistent: input.persistent ?? (
        input.category === 'action-required' || input.category === 'error' || input.category === 'result-ready'
      ),
      createdAt: timestamp,
      updatedAt: timestamp,
      count: 1,
      acknowledged: false,
    }
    if (!this.enabled) return { ...notification, acknowledged: true }
    this.notifications.set(notification.id, notification)
    this.pruneTransientNotifications()
    return { ...notification }
  }

  acknowledge(id: string): boolean {
    const notification = this.notifications.get(id)
    if (!notification || notification.acknowledged) return false
    this.notifications.delete(id)
    return true
  }

  acknowledgeCategory(category: NotificationCategory): number {
    let acknowledged = 0
    for (const notification of this.notifications.values()) {
      if (notification.category === category && this.acknowledge(notification.id)) acknowledged += 1
    }
    return acknowledged
  }

  acknowledgeSource(category: NotificationCategory, sourceId: string): boolean {
    const notification = [...this.notifications.values()].find(item =>
      item.category === category && item.sourceId === sourceId && !item.acknowledged,
    )
    return notification ? this.acknowledge(notification.id) : false
  }

  getSnapshot(): NotificationSnapshot {
    const pending = [...this.notifications.values()]
      .filter(notification => !notification.acknowledged)
      .sort(notificationOrder)
    const inbox = pending.filter(notification => notification.persistent)
    const resultCount = pending.filter(notification => notification.category === 'result-ready').length
    return {
      active: pending[0] ? { ...pending[0] } : null,
      inbox: inbox.map(notification => ({ ...notification })),
      unacknowledgedCount: pending.length,
      resultCount,
      terminalTitle: this.resolveTerminalTitle(pending[0] ?? null, resultCount),
    }
  }

  private resolveTerminalTitle(active: CoordinatedNotification | null, resultCount: number): string {
    if (active?.category === 'action-required') return '[ ! ] Action Required - TurboFlux'
    if (active?.category === 'error') return '[!] TurboFlux needs attention'
    if (resultCount > 0) return `[${resultCount}] TurboFlux results ready`
    if (active?.category === 'warning') return '[!] TurboFlux warning'
    return 'TurboFlux - Ready'
  }

  private pruneTransientNotifications(): void {
    const transient = [...this.notifications.values()]
      .filter(notification => !notification.persistent)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
    for (const notification of transient.slice(MAX_TRANSIENT_NOTIFICATIONS)) {
      this.notifications.delete(notification.id)
    }
  }
}
