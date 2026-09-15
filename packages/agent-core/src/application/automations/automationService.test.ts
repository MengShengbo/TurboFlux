import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutomationService, nextAutomationRunAt, nextAutomationRunTimes } from './automationService'

const directories: string[] = []
afterEach(() => { vi.useRealTimers(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('AutomationService', () => {
  it('persists trigger definitions and returns them as owned deep copies', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const store = join(root, 'automations.json')
    const service = new AutomationService(store)
    const created = service.create({
      name: 'Event review',
      prompt: 'Review incoming events',
      workspacePath: root,
      schedule: { kind: 'manual' },
      triggers: [{
        id: 'webhook-primary',
        kind: 'webhook',
        sourceInstanceId: 'local-hook',
        secretRef: 'webhook-secret',
        signature: 'hmac-sha256',
        maxPayloadBytes: 128_000,
        filters: [{ field: 'event.action', operator: 'in', value: ['opened', 'reopened'] }],
      }],
    }).automations[0]!

    const webhook = created.triggers[0] as Extract<typeof created.triggers[number], { kind: 'webhook' }>
    ;(webhook.filters![0]!.value as string[]).push('closed')

    expect(service.get(created.id)?.triggers).toEqual([expect.objectContaining({
      id: 'webhook-primary',
      filters: [{ field: 'event.action', operator: 'in', value: ['opened', 'reopened'] }],
    })])
    expect(new AutomationService(store).get(created.id)?.triggers).toEqual(service.get(created.id)?.triggers)
  })

  it('migrates legacy failure notification switches once and preserves new independent choices', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const store = join(root, 'automations.json')
    const service = new AutomationService(store)
    const automation = service.create({
      name: 'Delivery migration',
      prompt: 'Verify notification policy migration',
      workspacePath: root,
      schedule: { kind: 'manual' },
      deliveryPolicy: {
        desktop: ['failed'],
        remoteMobile: ['failed'],
        providerRefs: [],
        providerEvents: ['failed'],
      },
    }).automations[0]!

    expect(automation.deliveryPolicy).toMatchObject({
      eventPolicyVersion: 2,
      desktop: ['failed', 'timeout', 'budget', 'recovered'],
      remoteMobile: ['failed', 'timeout', 'budget', 'recovered'],
      providerEvents: ['failed', 'timeout', 'budget', 'recovered'],
    })

    const persisted = JSON.parse(readFileSync(store, 'utf8')) as { automations: Array<Record<string, unknown>> }
    const legacy = persisted.automations[0] as { revision: number; deliveryPolicy: Record<string, unknown> }
    delete legacy.deliveryPolicy.eventPolicyVersion
    legacy.deliveryPolicy.desktop = ['failed']
    legacy.deliveryPolicy.remoteMobile = ['failed']
    legacy.deliveryPolicy.providerEvents = ['failed']
    writeFileSync(store, JSON.stringify(persisted))
    const migratedService = new AutomationService(store)
    expect(migratedService.get(automation.id)).toMatchObject({
      revision: legacy.revision + 1,
      deliveryPolicy: {
        eventPolicyVersion: 2,
        desktop: ['failed', 'timeout', 'budget', 'recovered'],
      },
    })
    expect(new AutomationService(store).get(automation.id)?.revision).toBe(legacy.revision + 1)

    migratedService.update(automation.id, {
      deliveryPolicy: {
        eventPolicyVersion: 2,
        desktop: ['failed'],
        remoteMobile: [],
        providerRefs: [],
        providerEvents: ['budget'],
      },
    })
    expect(migratedService.get(automation.id)?.deliveryPolicy).toMatchObject({
      desktop: ['failed'],
      remoteMobile: [],
      providerEvents: ['budget'],
    })
  })

  it('defaults new definitions to isolated mode and freezes run permission and context snapshots', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const automation = service.create({
      name: 'Isolated review',
      prompt: 'Review independently',
      objective: { successCriteria: ['Produce one report'] },
      workspacePath: root,
      schedule: { kind: 'manual' },
      approvalPolicy: 'ask',
    }).automations[0]
    const claim = service.claimManual(automation.id)

    expect(automation).toMatchObject({
      revision: 1,
      mode: 'isolated',
      objective: { goal: 'Review independently', successCriteria: ['Produce one report'] },
    })
    expect(claim.run).toMatchObject({
      definitionRevision: 1,
      permissionSnapshot: { approvalPolicy: 'ask', definitionRevision: 1 },
      contextSnapshot: { mode: 'isolated', definitionRevision: 1 },
    })
    expect(claim.run.contextSnapshot.conversationId).toBeUndefined()

    service.update(automation.id, { mode: 'continuation', approvalPolicy: 'full', prompt: 'Changed after claim' })
    expect(service.get(automation.id)).toMatchObject({ revision: 2, mode: 'continuation', approvalPolicy: 'full' })
    expect(service.getRun(automation.id, claim.run.id)).toMatchObject({
      definitionRevision: 1,
      permissionSnapshot: { approvalPolicy: 'ask', definitionRevision: 1 },
      contextSnapshot: { mode: 'isolated', definitionRevision: 1 },
    })
  })

  it('forces dry runs to ask without advancing their formal schedule', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T09:00:00+08:00'))
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const automation = service.create({
      name: 'Dry run',
      prompt: 'Test safely',
      workspacePath: root,
      schedule: { kind: 'daily', time: '10:00' },
      approvalPolicy: 'full',
    }).automations[0]
    const nextRunAt = automation.nextRunAt
    const claim = service.claimManual(automation.id, Date.now(), true)

    expect(claim.run).toMatchObject({ dryRun: true, permissionSnapshot: { approvalPolicy: 'ask' } })
    expect(service.get(automation.id)?.nextRunAt).toBe(nextRunAt)
  })

  it('freezes the previous run summary only when the context policy requests it', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const automation = service.create({
      name: 'Summary-aware review',
      prompt: 'Use the prior outcome as bounded context',
      workspacePath: root,
      schedule: { kind: 'manual' },
      contextPolicy: { includePreviousRunSummary: true },
    }).automations[0]
    const first = service.claimManual(automation.id, 10)
    service.markRunStatus(automation.id, first.run.id, 'completed', {
      now: 20,
      resultSummary: 'The first run produced report.md.',
      result: {
        outcome: 'success',
        summary: 'The first run produced report.md.',
        successCriteria: [],
        artifactIds: ['report'],
        sideEffectSummary: [],
        durationMs: 10,
      },
    })

    const second = service.claimManual(automation.id, 30)
    expect(second.run.contextSnapshot.previousRunSummary).toEqual({
      runId: first.run.id,
      summary: 'The first run produced report.md.',
      outcome: 'success',
      completedAt: 20,
    })

    service.update(automation.id, { contextPolicy: { includePreviousRunSummary: false } })
    service.markRunStatus(automation.id, second.run.id, 'completed', { now: 40, resultSummary: 'Second run.' })
    expect(service.claimManual(automation.id, 50).run.contextSnapshot.previousRunSummary).toBeUndefined()
  })

  it('freezes the selected child-agent strategy into each run snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const automation = service.create({
      name: 'Bounded delegation',
      prompt: 'Delegate one bounded review',
      workspacePath: root,
      schedule: { kind: 'manual' },
      routingPolicy: { defaultAction: 'run', defaultAgentStrategyId: 'review' },
      agentPolicy: {
        enabled: true,
        defaultStrategyId: 'review',
        strategies: [{ id: 'review', label: 'Review', allowedAgentTypes: ['reviewer'], maxSubtasks: 2, maxParallel: 1 }],
      },
    }).automations[0]
    const claim = service.claimManual(automation.id)

    service.update(automation.id, {
      agentPolicy: {
        enabled: true,
        defaultStrategyId: 'expanded',
        strategies: [{ id: 'expanded', label: 'Expanded', allowedAgentTypes: ['writer'], maxSubtasks: 10, maxParallel: 4 }],
      },
      routingPolicy: { defaultAction: 'run', defaultAgentStrategyId: 'expanded' },
    })

    expect(claim.run.contextSnapshot.agentPolicy).toEqual({
      strategyId: 'review',
      allowedAgentTypes: ['reviewer'],
      maxSubtasks: 2,
      maxParallel: 1,
    })
    expect(service.getRun(automation.id, claim.run.id)?.contextSnapshot.agentPolicy).toEqual(claim.run.contextSnapshot.agentPolicy)
  })

  it('retries with the failed run revision instead of adopting later permission edits', () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-09-01T01:00:00.000Z')
    vi.setSystemTime(now)
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const automation = service.create({
      name: 'Frozen retry',
      prompt: 'Retry safely',
      workspacePath: root,
      schedule: { kind: 'manual' },
      mode: 'isolated',
      approvalPolicy: 'ask',
      retryPolicy: { maxRetries: 1, backoffMinutes: 1 },
    }).automations[0]
    const first = service.claimManual(automation.id, now)
    service.markRunStatus(automation.id, first.run.id, 'failed', { now: now + 1_000, error: 'Temporary failure' })
    const retryAt = service.getRun(automation.id, first.run.id)?.retryAt
    service.update(automation.id, { mode: 'continuation', approvalPolicy: 'full' })

    const retry = service.claimDue(root, { now: retryAt })[0]!

    expect(retry.run).toMatchObject({
      trigger: 'retry',
      attempt: 2,
      definitionRevision: 1,
      permissionSnapshot: { approvalPolicy: 'ask', definitionRevision: 1 },
      contextSnapshot: { mode: 'isolated', definitionRevision: 1 },
    })
  })

  it('does not advance a schedule when the durable pre-persist hook fails', () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-09-01T01:30:00.000Z')
    vi.setSystemTime(now)
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const automation = service.create({
      name: 'Durable ordering',
      prompt: 'Create the durable run first',
      workspacePath: root,
      schedule: { kind: 'interval', everyMinutes: 1 },
    }).automations[0]!

    expect(() => service.claimDue(root, {
      now: automation.nextRunAt,
      beforePersist: () => { throw new Error('durable run write failed') },
    })).toThrow('durable run write failed')

    const afterFailure = service.get(automation.id)!
    expect(afterFailure).toMatchObject({
      nextRunAt: automation.nextRunAt,
      history: [],
    })
    expect(afterFailure).not.toHaveProperty('activeRunId')
    const restored = new AutomationService(join(root, 'automations.json')).get(automation.id)!
    expect(restored).toMatchObject({
      nextRunAt: automation.nextRunAt,
      history: [],
    })
    expect(restored).not.toHaveProperty('activeRunId')
  })

  it('loads the real v2 compatibility fixture with one audited delivery-policy revision', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const store = join(root, 'automations.json')
    const fixturePath = join(import.meta.dirname, 'fixtures', 'automation-v2.json')
    const fixture = readFileSync(fixturePath, 'utf8').replace('__WORKSPACE__', root)
    writeFileSync(store, fixture)

    const automation = new AutomationService(store).get('automation-v2-fixture')

    expect(automation).toMatchObject({
      revision: 2,
      mode: 'continuation',
      name: 'V2 compatibility fixture',
      workspacePath: root,
      schedule: { kind: 'weekly', weekday: 1, time: '09:30' },
      timezone: 'Asia/Shanghai',
      approvalPolicy: 'ask',
      overlapPolicy: 'queue-one',
      retryPolicy: { maxRetries: 3, backoffMinutes: 4 },
      maxRuntimeMinutes: 90,
      conversationId: 'desktop-v2-automation-conversation',
      lastStatus: 'completed',
    })
    expect(automation?.history).toEqual([
      expect.objectContaining({
        id: 'automation-run-v2-fixture',
        status: 'completed',
        resultSummary: 'Persisted V2 run completed.',
      }),
    ])
  })

  it('computes interval runs, marks due work, and survives restart', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-07T09:00:00+08:00'))
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const store = join(root, 'automations.json')
    const workspace = join(root, 'workspace')
    const service = new AutomationService(store)
    const created = service.create({ name: 'Review', prompt: 'Review outputs', workspacePath: workspace, schedule: { kind: 'interval', everyMinutes: 30 } }).automations[0]
    expect(created.nextRunAt).toBe(Date.now() + 30 * 60_000)
    expect(service.due(workspace, created.nextRunAt! - 1)).toEqual([])
    expect(service.due(workspace, created.nextRunAt!)).toHaveLength(1)
    service.markRun(created.id, 'completed', { now: created.nextRunAt })
    expect(new AutomationService(store).list(workspace).automations[0]).toMatchObject({ lastStatus: 'completed', nextRunAt: created.nextRunAt! + 30 * 60_000 })
  })

  it('removes next run while disabled and restores it when enabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const automation = service.create({ name: 'Daily', prompt: 'Run daily', workspacePath: root, schedule: { kind: 'daily', time: '09:30' } }).automations[0]
    expect(service.update(automation.id, { enabled: false }).automations[0].nextRunAt).toBeUndefined()
    expect(service.update(automation.id, { enabled: true }).automations[0].nextRunAt).toBeTypeOf('number')
  })

  it('does not create a definition revision when a one-time schedule is consumed', () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-09-01T01:00:00.000Z')
    vi.setSystemTime(now)
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const automation = service.create({
      name: 'One time',
      prompt: 'Run once',
      workspacePath: root,
      schedule: { kind: 'once', at: new Date(now + 60_000).toISOString() },
    }).automations[0]!

    const claim = service.claimDue(root, { now: now + 60_000 })[0]!

    expect(claim.run.definitionRevision).toBe(automation.revision)
    expect(service.get(automation.id)).toMatchObject({ revision: automation.revision, enabled: false, nextRunAt: undefined })
  })

  it('supports one-time and weekly schedules', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-07T09:00:00+08:00'))
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const onceAt = new Date('2026-08-07T10:30:00+08:00').toISOString()
    const once = service.create({ name: 'Once', prompt: 'Run once', workspacePath: root, schedule: { kind: 'once', at: onceAt } }).automations[0]
    expect(once.nextRunAt).toBe(Date.parse(onceAt))
    expect(service.claimDue(root, { now: Date.parse(onceAt) })).toHaveLength(1)
    expect(service.get(once.id)).toMatchObject({ enabled: false, nextRunAt: undefined })

    const weekly = service.create({ name: 'Weekly', prompt: 'Run weekly', workspacePath: root, timezone: 'Asia/Shanghai', schedule: { kind: 'weekly', weekday: 1, time: '09:30' } }).automations[0]
    expect(new Date(weekly.nextRunAt!).toISOString()).toBe(new Date('2026-08-10T09:30:00+08:00').toISOString())
  })

  it('keeps bounded run history and advances a schedule only once per run', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-07T09:00:00+08:00'))
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const automation = service.create({
      name: 'Review',
      prompt: 'Review outputs',
      workspacePath: root,
      schedule: { kind: 'interval', everyMinutes: 30 },
      approvalPolicy: 'agent',
    }).automations[0]
    const claim = service.claimDue(root, { now: automation.nextRunAt })[0]!
    const advancedAt = service.get(automation.id)!.nextRunAt
    service.markRunStatus(automation.id, claim.run.id, 'running', { inputId: 'input-1', now: automation.nextRunAt! + 1_000 })
    service.markRunStatus(automation.id, claim.run.id, 'completed', { inputId: 'input-1', now: automation.nextRunAt! + 2_000 })
    expect(service.get(automation.id)).toMatchObject({ approvalPolicy: 'agent', nextRunAt: advancedAt })
    expect(service.get(automation.id)!.history).toEqual([
      expect.objectContaining({ inputId: 'input-1', status: 'completed', completedAt: expect.any(Number) }),
    ])
  })

  it('duplicates automations as disabled independent records', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const original = service.create({ name: 'Daily', prompt: 'Run daily', workspacePath: root, schedule: { kind: 'daily', time: '09:30' }, approvalPolicy: 'full' }).automations[0]
    const copy = service.duplicate(original.id).automations.find(item => item.id !== original.id)!
    expect(copy).toMatchObject({ name: 'Daily 副本', enabled: false, approvalPolicy: 'full', history: [] })
  })

  it('marks overdue work in another project as waiting without consuming its schedule', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-07T09:00:00+08:00'))
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const otherWorkspace = join(root, 'other')
    const automation = service.create({ name: 'Other', prompt: 'Run elsewhere', workspacePath: otherWorkspace, schedule: { kind: 'interval', everyMinutes: 30 } }).automations[0]
    expect(service.markInactiveDueWaiting(root, automation.nextRunAt)).toBe(true)
    expect(service.get(automation.id)).toMatchObject({ lastStatus: 'waiting_for_workspace', nextRunAt: automation.nextRunAt })
    expect(service.markInactiveDueWaiting(root, automation.nextRunAt! + 1_000)).toBe(false)
    expect(service.due(otherWorkspace, automation.nextRunAt)).toHaveLength(1)
  })

  it('resolves daily schedules across daylight-saving transitions', () => {
    const spring = nextAutomationRunAt(
      { kind: 'daily', time: '02:30' },
      'America/New_York',
      Date.parse('2026-03-08T01:59:00-05:00'),
    )
    expect(new Date(spring!).toISOString()).toBe('2026-03-09T06:30:00.000Z')

    const firstFall = nextAutomationRunAt(
      { kind: 'daily', time: '01:30' },
      'America/New_York',
      Date.parse('2026-11-01T00:59:00-04:00'),
    )
    expect(new Date(firstFall!).toISOString()).toBe('2026-11-01T05:30:00.000Z')
    const secondFall = nextAutomationRunAt(
      { kind: 'daily', time: '01:30' },
      'America/New_York',
      firstFall! + 60_000,
    )
    expect(new Date(secondFall!).toISOString()).toBe('2026-11-01T06:30:00.000Z')
  })

  it('schedules standard Cron and skips duplicate DST wall-clock occurrences', () => {
    const times = nextAutomationRunTimes(
      { kind: 'cron', expression: '30 1 * * *' },
      'America/New_York',
      3,
      Date.parse('2026-10-31T23:59:00-04:00'),
    )
    expect(times.map(value => new Date(value).toISOString())).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
      '2026-11-03T06:30:00.000Z',
    ])
    expect(nextAutomationRunTimes({ kind: 'cron', expression: '0 9 * * MON-FRI' }, 'Asia/Shanghai', 5, Date.parse('2026-09-04T09:01:00+08:00'))).toHaveLength(5)
    expect(() => nextAutomationRunAt({ kind: 'cron', expression: '* * *' }, 'UTC')).toThrow('exactly five fields')
  })

  it('accepts numeric Sunday 7 in Cron weekday ranges', () => {
    expect(nextAutomationRunTimes({ kind: 'cron', expression: '0 9 * * 5-7' }, 'UTC', 3, Date.parse('2026-09-03T10:00:00Z')))
      .toEqual([
        Date.parse('2026-09-04T09:00:00Z'),
        Date.parse('2026-09-05T09:00:00Z'),
        Date.parse('2026-09-06T09:00:00Z'),
      ])
    expect(nextAutomationRunTimes({ kind: 'cron', expression: '0 9 * * 7' }, 'UTC', 1, Date.parse('2026-09-05T10:00:00Z')))
      .toEqual([Date.parse('2026-09-06T09:00:00Z')])
  })

  it('applies misfire and overlap policies without duplicate claims', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-07T09:00:00+08:00'))
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const skipped = service.create({
      name: 'Skip stale',
      prompt: 'Check once',
      workspacePath: root,
      schedule: { kind: 'interval', everyMinutes: 1 },
      misfirePolicy: 'skip',
    }).automations[0]
    expect(service.claimDue(root, { now: skipped.nextRunAt! + 61_000 })).toEqual([])
    expect(service.get(skipped.id)?.history[0]).toMatchObject({ status: 'skipped', trigger: 'scheduled' })
    service.update(skipped.id, { enabled: false })

    const queued = service.create({
      name: 'Queue overlap',
      prompt: 'Keep one occurrence',
      workspacePath: root,
      schedule: { kind: 'interval', everyMinutes: 1 },
      overlapPolicy: 'queue-one',
    }).automations[0]
    const claim = service.claimDue(root, { now: queued.nextRunAt! }).find(item => item.automation.id === queued.id)!
    expect(service.claimDue(root, { now: queued.nextRunAt! })).toEqual([])
    const completionAt = service.get(queued.id)!.nextRunAt! + 60_000
    service.markRunStatus(queued.id, claim.run.id, 'completed', { now: completionAt })
    const after = service.get(queued.id)!
    expect(after.pendingRunAt).toBeTypeOf('number')
    expect(service.claimDue(root, { now: completionAt })).toEqual([
      expect.objectContaining({ automation: expect.objectContaining({ id: queued.id }) }),
    ])
  })

  it('retries with exponential backoff and supports explicit cancellation', () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-08-07T01:00:00.000Z')
    vi.setSystemTime(now)
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const automation = service.create({
      name: 'Retry work',
      prompt: 'Try reliably',
      workspacePath: root,
      schedule: { kind: 'manual' },
      retryPolicy: { maxRetries: 2, backoffMinutes: 2 },
    }).automations[0]
    const first = service.claimManual(automation.id, now)
    service.markRunStatus(automation.id, first.run.id, 'failed', { now: now + 1_000, error: 'Temporary failure' })
    const failed = service.getRun(automation.id, first.run.id)!
    expect(failed).toMatchObject({ status: 'retry_scheduled', retryAt: now + 121_000 })
    const retry = service.claimDue(root, { now: failed.retryAt })[0]!
    expect(retry.run).toMatchObject({ trigger: 'retry', attempt: 2 })
    expect(service.cancelActiveRun(automation.id, now + 122_000)).toMatchObject({ status: 'canceled' })
    expect(service.get(automation.id)).toMatchObject({ activeRunId: undefined, lastStatus: 'canceled' })
  })

  it('keeps an explicitly interrupted run recoverable when retry scheduling is suppressed', () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-08-07T01:30:00.000Z')
    vi.setSystemTime(now)
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const automation = service.create({
      name: 'Graceful host exit',
      prompt: 'Resume only after checkpoint validation',
      workspacePath: root,
      schedule: { kind: 'manual' },
      retryPolicy: { maxRetries: 2, backoffMinutes: 1 },
    }).automations[0]!
    const claim = service.claimManual(automation.id, now)

    service.markRunStatus(automation.id, claim.run.id, 'interrupted', {
      now: now + 1_000,
      error: 'Host exited after saving a checkpoint.',
      suppressRetry: true,
    })

    expect(service.getRun(automation.id, claim.run.id)).toMatchObject({
      status: 'interrupted',
      retryAt: undefined,
      error: 'Host exited after saving a checkpoint.',
    })
    expect(service.get(automation.id)).toMatchObject({
      activeRunId: undefined,
      lastStatus: 'interrupted',
    })
    expect(service.claimDue(root, { now: now + 24 * 60 * 60_000 })).toEqual([])
  })

  it('treats explicit approval options as an authoritative response whitelist', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const automation = service.create({
      name: 'Approval whitelist',
      prompt: 'Write one bounded file',
      workspacePath: root,
      schedule: { kind: 'manual' },
      approvalPolicy: 'ask',
    }).automations[0]!
    const claim = service.claimManual(automation.id)
    const requestedAt = claim.run.startedAt
    service.recordApproval({
      id: 'approval-whitelist',
      automationId: automation.id,
      automationName: automation.name,
      runId: claim.run.id,
      definitionRevision: claim.run.definitionRevision,
      permissionSnapshotId: claim.run.permissionSnapshot.id,
      conversationId: 'conversation-whitelist',
      workspacePath: root,
      kind: 'permission',
      riskCategory: 'filesystem',
      question: 'Allow this write?',
      options: ['approve-everything', 'allow-once'],
      toolName: 'write_file',
      path: join(root, 'report.md'),
      requestedAt,
      expiresAt: requestedAt + 60_000,
      status: 'pending',
    })

    expect(service.getApproval('approval-whitelist')?.options).toEqual(['allow-once', 'deny'])
    expect(() => service.resolveApproval('approval-whitelist', 'allow-session', 'remote', requestedAt + 1_000))
      .toThrow('response is not allowed')
    expect(service.getApproval('approval-whitelist')).toMatchObject({ status: 'pending' })
    expect(service.resolveApproval('approval-whitelist', 'deny', 'desktop', requestedAt + 2_000)).toMatchObject({
      status: 'denied',
      decision: 'deny',
    })
  })

  it('migrates v1 data and recovers interrupted runs on startup', () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-08-07T01:00:00.000Z')
    vi.setSystemTime(now)
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const store = join(root, 'automations.json')
    writeFileSync(store, JSON.stringify({
      schemaVersion: 1,
      automations: [{
        id: 'legacy',
        name: 'Legacy',
        prompt: 'Resume safely',
        workspacePath: root,
        schedule: { kind: 'manual' },
        enabled: true,
        approvalPolicy: 'ask',
        createdAt: now - 10_000,
        updatedAt: now - 5_000,
        activeRunId: 'legacy-run',
        history: [{
          id: 'legacy-run',
          trigger: 'scheduled',
          status: 'running',
          attempt: 1,
          startedAt: now - 5_000,
          updatedAt: now - 5_000,
        }],
      }],
    }))
    const migrated = new AutomationService(store).get('legacy')!
    expect(migrated).toMatchObject({
      timezone: expect.any(String),
      misfirePolicy: 'run-once',
      overlapPolicy: 'skip',
      retryPolicy: { maxRetries: 2, backoffMinutes: 2 },
      activeRunId: undefined,
      lastStatus: 'retry_scheduled',
    })
    expect(migrated.history[0]).toMatchObject({ status: 'retry_scheduled', error: expect.stringContaining('exited') })
  })
})
