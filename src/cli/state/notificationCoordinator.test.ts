import { describe, expect, it } from 'vitest'
import { NotificationCoordinator, sanitizeTerminalTitle } from './notificationCoordinator'

describe('NotificationCoordinator', () => {
  it('keeps action-required above completion and result notifications', () => {
    let now = 1
    const coordinator = new NotificationCoordinator(() => now++)
    coordinator.raise({ id: 'done', category: 'turn-complete', title: 'Done' })
    coordinator.raise({ id: 'result', category: 'result-ready', title: 'Agent result', sourceId: 'agent-1' })
    coordinator.raise({ id: 'approval', category: 'action-required', title: 'Review', sourceId: 'approval-1' })

    expect(coordinator.getSnapshot()).toMatchObject({
      active: { id: 'approval' },
      resultCount: 1,
      terminalTitle: '[ ! ] Action Required - TurboFlux',
    })
  })

  it('deduplicates by category and source while preserving a count', () => {
    const coordinator = new NotificationCoordinator()
    coordinator.raise({ id: 'first', category: 'result-ready', title: 'Ready', sourceId: 'agent-1' })
    coordinator.raise({ id: 'second', category: 'result-ready', title: 'Ready again', sourceId: 'agent-1' })

    const snapshot = coordinator.getSnapshot()
    expect(snapshot.resultCount).toBe(1)
    expect(snapshot.inbox[0]).toMatchObject({ id: 'first', count: 2, title: 'Ready again' })
  })

  it('retains results until explicit acknowledgement', () => {
    const coordinator = new NotificationCoordinator()
    coordinator.raise({ id: 'result', category: 'result-ready', title: 'Ready', sourceId: 'agent-1' })

    expect(coordinator.getSnapshot().inbox).toHaveLength(1)
    expect(coordinator.acknowledgeSource('result-ready', 'agent-1')).toBe(true)
    expect(coordinator.getSnapshot().inbox).toHaveLength(0)
  })

  it('bounds transient progress notifications while retaining persistent results', () => {
    const coordinator = new NotificationCoordinator()
    for (let index = 0; index < 100; index += 1) {
      coordinator.raise({ id: `progress-${index}`, category: 'info', title: `Progress ${index}` })
    }
    coordinator.raise({ id: 'result', category: 'result-ready', title: 'Ready' })

    expect(coordinator.getSnapshot()).toMatchObject({
      unacknowledgedCount: 65,
      resultCount: 1,
      inbox: [expect.objectContaining({ id: 'result' })],
    })
  })

  it('removes terminal control sequences from managed titles', () => {
    expect(sanitizeTerminalTitle('Ready\u001b]0;owned\u0007 now')).toBe('Ready ]0;owned now')
  })

  it('supports a no-owner-duplication rollback mode', () => {
    const coordinator = new NotificationCoordinator(() => 1, false)
    coordinator.raise({ id: 'result-1', category: 'result-ready', title: 'Ready' })

    expect(coordinator.getSnapshot()).toMatchObject({
      active: null,
      inbox: [],
      resultCount: 0,
    })
  })
})
