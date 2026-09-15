import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AutomationCoordinator,
  automationQueuePriority,
  type AutomationCoordinatorOptions,
  type AutomationExecutionHandle,
  type AutomationExecutionPool,
} from './automationCoordinator'
import { AutomationRepository } from './automationRepository'
import { AutomationService, type AutomationClaim, type AutomationRecord, type AutomationRunRecord } from './automationService'
import { captureAutomationWorkspaceIdentity, createAutomationCheckpoint } from './automationCheckpoint'

const directories: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

class FakeExecutionPool implements AutomationExecutionPool {
  readonly claims: AutomationClaim[] = []
  readonly blocked = new Set<string>()
  readonly releases = new Map<string, (error?: string) => void>()
  readonly events: string[] = []
  startGate?: Promise<void>
  interruptGate?: Promise<void>
  foreground = ''

  constructor(private readonly service: AutomationService) {}

  foregroundWorkspacePath(): string | undefined {
    return this.foreground || undefined
  }

  canStart(automation: AutomationRecord): { ok: true } | { ok: false; reason: string } {
    return this.blocked.has(automation.workspacePath)
      ? { ok: false, reason: `Foreground work owns ${automation.workspacePath}` }
      : { ok: true }
  }

  async start(claim: AutomationClaim): Promise<AutomationExecutionHandle> {
    this.events.push(`start-enter:${claim.run.id}`)
    await this.startGate
    this.claims.push(claim)
    this.events.push(`started:${claim.run.id}`)
    this.service.markRunStatus(claim.automation.id, claim.run.id, 'running', {
      inputId: `input-${claim.run.id}`,
      conversationId: `conversation-${claim.run.id}`,
    })
    let release!: (error?: string) => void
    const completion = new Promise<AutomationRunRecord>(resolve => {
      release = error => {
        const current = this.service.getRun(claim.automation.id, claim.run.id)
        if (!current || !['completed', 'failed', 'canceled', 'interrupted', 'needs_review', 'skipped', 'missed', 'retry_scheduled'].includes(current.status)) {
          if (error) this.service.markRunStatus(claim.automation.id, claim.run.id, 'failed', { error })
          else this.service.markRunStatus(claim.automation.id, claim.run.id, 'completed', {
            conversationId: `conversation-${claim.run.id}`,
            resultSummary: 'Finished by the fake workspace runtime.',
            result: {
              outcome: 'success',
              summary: 'Finished by the fake workspace runtime.',
              successCriteria: [],
              artifactIds: [],
              sideEffectSummary: [],
              durationMs: 10,
            },
          })
        }
        resolve(this.service.getRun(claim.automation.id, claim.run.id)!)
      }
    })
    this.releases.set(claim.run.id, release)
    return {
      started: {
        status: 'started',
        inputId: `input-${claim.run.id}`,
        automationId: claim.automation.id,
        automationRunId: claim.run.id,
        conversationId: `conversation-${claim.run.id}`,
      },
      completion,
    }
  }

  async interrupt(runId: string, reason: string): Promise<boolean> {
    this.events.push(`interrupt-enter:${runId}`)
    await this.interruptGate
    const claim = this.claims.find(candidate => candidate.run.id === runId)
    if (!claim) return false
    const run = this.service.getRun(claim.automation.id, runId)
    if (run && !['completed', 'failed', 'canceled', 'interrupted', 'needs_review', 'skipped', 'missed', 'retry_scheduled'].includes(run.status)) {
      this.service.markRunStatus(claim.automation.id, runId, 'interrupted', { error: reason, suppressRetry: true })
    }
    this.releases.get(runId)?.()
    this.releases.delete(runId)
    this.events.push(`interrupted:${runId}`)
    return true
  }

  finishAll(): void {
    for (const release of [...this.releases.values()]) release()
    this.releases.clear()
  }

  fail(runId: string, error: string): void {
    this.releases.get(runId)?.(error)
    this.releases.delete(runId)
  }
}

function createHarness(now: number, options: Partial<AutomationCoordinatorOptions> = {}) {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  const root = mkdtempSync(join(tmpdir(), 'turboflux-coordinator-'))
  directories.push(root)
  const service = new AutomationService(join(root, 'automations.json'))
  const repository = new AutomationRepository(join(root, 'automations-v3'), { now: () => Date.now() })
  const pool = new FakeExecutionPool(service)
  const coordinator = new AutomationCoordinator(service, repository, pool, {
    ownerId: 'desktop-test-host',
    maxConcurrentRuns: 2,
    leaseMs: 30_000,
    now: () => Date.now(),
    ...options,
  })
  coordinator.initialize()
  return { root, service, repository, pool, coordinator }
}

describe('AutomationCoordinator', () => {
  it('disables retired external triggers on startup and preserves their definitions for editing', () => {
    const { root, service, repository } = createHarness(Date.now())
    const external = service.create({
      name: 'Legacy event', prompt: 'Review changes', workspacePath: root, schedule: { kind: 'manual' },
      triggers: [{ id: 'legacy', kind: 'webhook', sourceInstanceId: 'ci', secretRef: 'secret', signature: 'hmac-sha256', maxPayloadBytes: 1000 }],
    }).automations[0]!
    new AutomationCoordinator(service, repository, new FakeExecutionPool(service)).initialize()
    expect(service.get(external.id)).toMatchObject({ enabled: false, lifecycleStatus: 'invalid', name: 'Legacy event' })
    expect(repository.getDefinition(external.id)?.status).toBe('invalid')
  })

  it('ages old queued work until it outranks newly queued high-priority work', () => {
    const now = Date.parse('2026-09-01T04:00:00.000Z')
    expect(automationQueuePriority('recovery', now, now)).toBeGreaterThan(automationQueuePriority('schedule', now, now))
    expect(automationQueuePriority('schedule', now - 2 * 60 * 60_000, now)).toBeGreaterThan(automationQueuePriority('manual', now, now))
  })

  it('does not remigrate a native v3 run when its v2 compatibility store appears after startup', async () => {
    const now = Date.parse('2026-09-01T00:15:00.000Z')
    const { root, service, repository, pool, coordinator } = createHarness(now)
    const automation = service.create({
      name: 'Native before migration marker',
      prompt: 'Create one native durable run',
      workspacePath: join(root, 'workspace'),
      schedule: { kind: 'manual' },
    }).automations[0]!
    const started = await coordinator.runManual(automation.id)
    pool.finishAll()
    await coordinator.waitForIdle()
    expect(repository.listRuns({ definitionId: automation.id })).toHaveLength(1)

    const restarted = new AutomationCoordinator(service, repository, new FakeExecutionPool(service), {
      ownerId: 'desktop-restarted-after-v2-store',
      now: () => Date.now(),
      sourcePath: join(root, 'automations.json'),
    })
    restarted.initialize()

    expect(repository.listRuns({ definitionId: automation.id })).toEqual([
      expect.objectContaining({ id: started.automationRunId, status: 'completed' }),
    ])
  })

  it('persists runtime-limit failures as structured timeout errors', async () => {
    const now = Date.parse('2026-09-01T00:30:00.000Z')
    const { root, service, repository, pool, coordinator } = createHarness(now)
    const automation = service.create({
      name: 'Time bounded',
      prompt: 'Stop at the frozen runtime limit',
      workspacePath: join(root, 'workspace'),
      schedule: { kind: 'manual' },
      retryPolicy: { maxRetries: 0, backoffMinutes: 1 },
    }).automations[0]!
    const started = await coordinator.runManual(automation.id)

    pool.fail(started.automationRunId, 'Exceeded the 60 minute runtime limit.')
    await coordinator.waitForIdle()

    expect(repository.getRun(started.automationRunId)).toMatchObject({
      status: 'failed',
      error: { code: 'automation_execution_timeout', category: 'timeout', retryable: true },
    })
  })

  it('leases and runs due work from two workspaces without changing the foreground workspace', async () => {
    const now = Date.parse('2026-09-01T01:00:00.000Z')
    const { root, service, repository, pool, coordinator } = createHarness(now)
    const workspaceA = join(root, 'workspace-a')
    const workspaceB = join(root, 'workspace-b')
    pool.foreground = workspaceA
    service.create({ name: 'A', prompt: 'Run A', workspacePath: workspaceA, schedule: { kind: 'interval', everyMinutes: 1 } })
    service.create({ name: 'B', prompt: 'Run B', workspacePath: workspaceB, schedule: { kind: 'interval', everyMinutes: 1 } })

    const started = await coordinator.tick(now + 60_000)

    expect(started, JSON.stringify(coordinator.snapshot())).toHaveLength(2)
    expect(pool.claims.map(claim => claim.automation.workspacePath)).toEqual([workspaceA, workspaceB])
    expect(pool.foregroundWorkspacePath()).toBe(workspaceA)
    expect(repository.listRuns()).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'running', lease: expect.objectContaining({ ownerId: 'desktop-test-host' }) }),
      expect.objectContaining({ status: 'running', lease: expect.objectContaining({ ownerId: 'desktop-test-host' }) }),
    ]))

    pool.finishAll()
    await coordinator.waitForIdle()
    expect(repository.listRuns().every(run => run.status === 'completed' && run.lease === undefined)).toBe(true)
  })

  it('pauses dispatch during sleep, renews owned work, and recomputes due work on wake', async () => {
    const now = Date.parse('2026-09-01T01:30:00.000Z')
    const { root, service, repository, pool, coordinator } = createHarness(now)
    const manual = service.create({
      name: 'Sleeping run',
      prompt: 'Remain owned across sleep',
      workspacePath: join(root, 'manual-workspace'),
      schedule: { kind: 'manual' },
      reliabilityPolicy: {
        concurrencyGroup: { id: 'sleep-safe', maxParallel: 1 },
        resourceLocks: [{ key: 'workspace:sleep-safe', mode: 'exclusive' }],
      },
    }).automations[0]!
    service.create({
      name: 'Due after wake',
      prompt: 'Run once after wake',
      workspacePath: join(root, 'scheduled-workspace'),
      schedule: { kind: 'interval', everyMinutes: 1 },
    })
    coordinator.start()
    const started = await coordinator.runManual(manual.id)

    expect(coordinator.suspendForSystemSleep()).toMatchObject({ suspended: true })
    await expect(coordinator.runManual(manual.id)).rejects.toThrow('Desktop host is suspended')
    vi.setSystemTime(now + 60_000)
    expect(await coordinator.tick()).toEqual([])

    const resumed = await coordinator.resumeAfterSystemSleep()
    expect(resumed).toMatchObject({ suspended: false, error: undefined })
    expect(pool.claims).toHaveLength(2)
    expect(repository.getRun(started.automationRunId)).toMatchObject({
      status: 'running',
      lease: { ownerId: 'desktop-test-host', heartbeatAt: now + 60_000, expiresAt: now + 90_000 },
    })
    expect(repository.listExecutionLocks()).toEqual([
      expect.objectContaining({ runId: started.automationRunId, ownerId: 'desktop-test-host', expiresAt: now + 90_000 }),
      expect.objectContaining({ runId: started.automationRunId, ownerId: 'desktop-test-host', expiresAt: now + 90_000 }),
    ])
    expect(repository.listRuns().filter(run => run.status === 'running')).toHaveLength(2)

    pool.finishAll()
    await coordinator.waitForIdle()
    await coordinator.stop()
  })

  it('coalesces duplicate resume events into one ownership renewal and one wake transition', async () => {
    const now = Date.parse('2026-09-01T01:35:00.000Z')
    const { root, service, repository, pool, coordinator } = createHarness(now)
    const automation = service.create({
      name: 'Duplicate resume',
      prompt: 'Renew ownership once',
      workspacePath: join(root, 'duplicate-resume-workspace'),
      schedule: { kind: 'manual' },
      reliabilityPolicy: { resourceLocks: [{ key: 'workspace:duplicate-resume', mode: 'exclusive' }] },
    }).automations[0]!
    await coordinator.runManual(automation.id)
    coordinator.suspendForSystemSleep()
    const renew = vi.spyOn(repository, 'renewOwnedLeasesAfterSleep')

    const [first, second] = await Promise.all([
      coordinator.resumeAfterSystemSleep(),
      coordinator.resumeAfterSystemSleep(),
    ])

    expect(first.suspended).toBe(false)
    expect(second.suspended).toBe(false)
    expect(renew).toHaveBeenCalledTimes(1)
    pool.finishAll()
    await coordinator.waitForIdle()
  })

  it('retries a transient repository conflict before reopening scheduling after wake', async () => {
    const now = Date.parse('2026-09-01T01:36:00.000Z')
    const { repository, coordinator } = createHarness(now)
    coordinator.suspendForSystemSleep()
    const original = repository.renewOwnedLeasesAfterSleep.bind(repository)
    const renew = vi.spyOn(repository, 'renewOwnedLeasesAfterSleep')
      .mockImplementationOnce(() => {
        const conflict = new Error('Automation repository data changed concurrently: indexes/execution-locks.json')
        conflict.name = 'AutomationRepositoryConflictError'
        throw conflict
      })
      .mockImplementation((ownerId, runIds, leaseMs) => original(ownerId, runIds, leaseMs))

    await expect(coordinator.resumeAfterSystemSleep()).resolves.toMatchObject({ suspended: false, error: undefined })
    expect(renew).toHaveBeenCalledTimes(2)
  })

  it('stays suspended and reports health when repository conflicts remain unstable', async () => {
    const now = Date.parse('2026-09-01T01:36:30.000Z')
    const onStateChanged = vi.fn()
    const { repository, coordinator } = createHarness(now, { onStateChanged })
    coordinator.suspendForSystemSleep()
    const renew = vi.spyOn(repository, 'renewOwnedLeasesAfterSleep').mockImplementation(() => {
      const conflict = new Error('Automation repository data changed concurrently: indexes/execution-locks.json')
      conflict.name = 'AutomationRepositoryConflictError'
      throw conflict
    })

    await expect(coordinator.resumeAfterSystemSleep()).rejects.toThrow('changed concurrently')
    expect(renew).toHaveBeenCalledTimes(3)
    expect(coordinator.snapshot()).toMatchObject({
      suspended: true,
      error: expect.stringContaining('lease renewal after sleep failed'),
    })
    expect(onStateChanged).toHaveBeenCalled()
  })

  it('serializes overlapping scheduler ticks while runtime startup is pending', async () => {
    const now = Date.parse('2026-09-01T01:37:00.000Z')
    const { root, service, repository, pool, coordinator } = createHarness(now)
    service.create({
      name: 'Single due occurrence',
      prompt: 'Start only once across overlapping ticks',
      workspacePath: join(root, 'serialized-tick-workspace'),
      schedule: { kind: 'interval', everyMinutes: 1 },
    })
    let releaseStart!: () => void
    pool.startGate = new Promise<void>(resolve => { releaseStart = resolve })
    const recover = vi.spyOn(repository, 'recoverExpiredLeases')

    const first = coordinator.tick(now + 60_000)
    await vi.waitFor(() => expect(pool.events.some(event => event.startsWith('start-enter:'))).toBe(true))
    const second = coordinator.tick(now + 60_000)
    await Promise.resolve()
    expect(recover).toHaveBeenCalledTimes(1)

    releaseStart()
    await expect(first).resolves.toHaveLength(1)
    await expect(second).resolves.toEqual([])
    expect(recover).toHaveBeenCalledTimes(2)
    expect(pool.claims).toHaveLength(1)
    pool.finishAll()
    await coordinator.waitForIdle()
  })

  it('keeps the same durable run queued when execution-lock acquisition loses a repository race', async () => {
    const now = Date.parse('2026-09-01T01:39:00.000Z')
    const { root, service, repository, pool, coordinator } = createHarness(now)
    const automation = service.create({
      name: 'Lock acquisition race',
      prompt: 'Wait without creating a duplicate run',
      workspacePath: join(root, 'lock-race-workspace'),
      schedule: { kind: 'interval', everyMinutes: 1 },
      reliabilityPolicy: { resourceLocks: [{ key: 'workspace:lock-race', mode: 'exclusive' }] },
    }).automations[0]!
    const acquireLocks = repository.acquireExecutionLocks.bind(repository)
    const conflict = new Error('Automation repository data changed concurrently: indexes/execution-locks.json')
    conflict.name = 'AutomationRepositoryConflictError'
    vi.spyOn(repository, 'acquireExecutionLocks')
      .mockImplementationOnce(() => { throw conflict })
      .mockImplementation(acquireLocks)

    await expect(coordinator.tick(now + 60_000)).resolves.toEqual([])
    const queued = repository.listRuns({ definitionId: automation.id })[0]!
    expect(queued.status).toBe('queued')
    expect(service.getRun(automation.id, queued.id)?.status).toBe('queued')

    await expect(coordinator.tick(now + 60_000)).resolves.toEqual([queued.id])
    expect(repository.listRuns({ definitionId: automation.id })).toHaveLength(1)
    pool.finishAll()
    await coordinator.waitForIdle()
    expect(repository.getRun(queued.id)?.status).toBe('completed')
  })

  it('interrupts a dispatch that crosses a system-sleep boundary before it can remain active', async () => {
    const now = Date.parse('2026-09-01T01:40:00.000Z')
    const { root, service, repository, pool, coordinator } = createHarness(now)
    const automation = service.create({
      name: 'Sleep race',
      prompt: 'Do not start across sleep',
      workspacePath: join(root, 'sleep-race-workspace'),
      schedule: { kind: 'manual' },
    }).automations[0]!
    let releaseStart!: () => void
    pool.startGate = new Promise<void>(resolve => { releaseStart = resolve })

    const pending = coordinator.runManual(automation.id)
    await vi.waitFor(() => expect(pool.events.some(event => event.startsWith('start-enter:'))).toBe(true))
    coordinator.suspendForSystemSleep()
    releaseStart()

    await expect(pending).rejects.toThrow('Desktop host is suspended')
    const run = repository.listRuns({ definitionId: automation.id })[0]!
    expect(run.status).toBe('interrupted')
    expect(run).not.toHaveProperty('lease')
    expect(pool.events).toEqual([
      `start-enter:${run.id}`,
      `started:${run.id}`,
      `interrupt-enter:${run.id}`,
      `interrupted:${run.id}`,
    ])
    expect(coordinator.snapshot()).toMatchObject({ suspended: true, runningRunIds: [] })
  })

  it('waits for both runtime startup and its resulting execution before reporting idle', async () => {
    const now = Date.parse('2026-09-01T01:45:00.000Z')
    const { root, service, pool, coordinator } = createHarness(now)
    const automation = service.create({
      name: 'Pending startup',
      prompt: 'Remain part of shutdown accounting',
      workspacePath: join(root, 'pending-startup-workspace'),
      schedule: { kind: 'manual' },
    }).automations[0]!
    let releaseStart!: () => void
    pool.startGate = new Promise<void>(resolve => { releaseStart = resolve })
    const starting = coordinator.runManual(automation.id)
    await vi.waitFor(() => expect(pool.events.some(event => event.startsWith('start-enter:'))).toBe(true))
    let idle = false
    const waiting = coordinator.waitForIdle().then(() => { idle = true })

    await Promise.resolve()
    expect(idle).toBe(false)
    releaseStart()
    await starting
    await Promise.resolve()
    expect(idle).toBe(false)
    pool.finishAll()
    await waiting
    expect(idle).toBe(true)
  })

  it('stops lost-lease work before dispatching newly due work after wake', async () => {
    const now = Date.parse('2026-09-01T01:50:00.000Z')
    const { root, service, repository, pool, coordinator } = createHarness(now)
    const running = service.create({
      name: 'Lease lost during sleep',
      prompt: 'Stop locally before new work starts',
      workspacePath: join(root, 'lost-lease-workspace'),
      schedule: { kind: 'manual' },
      reliabilityPolicy: {
        concurrencyGroup: { id: 'lost-lease', maxParallel: 1 },
        resourceLocks: [{ key: 'workspace:lost-lease', mode: 'exclusive' }],
      },
    }).automations[0]!
    service.create({
      name: 'Due only after ownership check',
      prompt: 'Start after stale work is stopped',
      workspacePath: join(root, 'due-after-wake-workspace'),
      schedule: { kind: 'interval', everyMinutes: 1 },
    })
    coordinator.start()
    const started = await coordinator.runManual(running.id)
    coordinator.suspendForSystemSleep()
    repository.releaseExecutionLocks(started.automationRunId, 'desktop-test-host')
    vi.setSystemTime(now + 60_000)

    const resumed = await coordinator.resumeAfterSystemSleep()

    expect(resumed.error).toContain('lease ownership changed while the host slept')
    expect(repository.getRun(started.automationRunId)?.status).toBe('needs_review')
    expect(pool.claims).toHaveLength(2)
    const interruptIndex = pool.events.indexOf(`interrupt-enter:${started.automationRunId}`)
    const dueStartIndex = pool.events.findIndex((event, index) => index > interruptIndex && event.startsWith('start-enter:'))
    expect(interruptIndex).toBeGreaterThanOrEqual(0)
    expect(dueStartIndex).toBeGreaterThan(interruptIndex)

    pool.finishAll()
    await coordinator.waitForIdle()
    await coordinator.stop()
  })

  it('remains suspended when another suspend arrives during asynchronous resume cleanup', async () => {
    const now = Date.parse('2026-09-01T01:55:00.000Z')
    const { root, service, repository, pool, coordinator } = createHarness(now)
    const running = service.create({
      name: 'Repeated suspend',
      prompt: 'Remain paused after the second suspend',
      workspacePath: join(root, 'repeat-suspend-workspace'),
      schedule: { kind: 'manual' },
      reliabilityPolicy: { resourceLocks: [{ key: 'workspace:repeat-suspend', mode: 'exclusive' }] },
    }).automations[0]!
    service.create({
      name: 'Must remain queued',
      prompt: 'Wait for a later resume',
      workspacePath: join(root, 'queued-after-repeat-suspend'),
      schedule: { kind: 'interval', everyMinutes: 1 },
    })
    coordinator.start()
    const started = await coordinator.runManual(running.id)
    coordinator.suspendForSystemSleep()
    repository.releaseExecutionLocks(started.automationRunId, 'desktop-test-host')
    vi.setSystemTime(now + 60_000)
    let releaseInterrupt!: () => void
    pool.interruptGate = new Promise<void>(resolve => { releaseInterrupt = resolve })

    const resuming = coordinator.resumeAfterSystemSleep()
    await vi.waitFor(() => expect(pool.events).toContain(`interrupt-enter:${started.automationRunId}`))
    coordinator.suspendForSystemSleep()
    releaseInterrupt()
    const snapshot = await resuming

    expect(snapshot).toMatchObject({ suspended: true })
    expect(pool.claims).toHaveLength(1)
    expect(pool.events.filter(event => event.startsWith('start-enter:'))).toHaveLength(1)
    await coordinator.stop()
  })

  it('applies the newest resume after an older resume is invalidated by another suspend', async () => {
    const now = Date.parse('2026-09-01T01:56:00.000Z')
    const { root, service, repository, pool, coordinator } = createHarness(now)
    const running = service.create({
      name: 'Resume generation ordering',
      prompt: 'Only the newest resume may reopen scheduling',
      workspacePath: join(root, 'resume-order-workspace'),
      schedule: { kind: 'manual' },
      reliabilityPolicy: { resourceLocks: [{ key: 'workspace:resume-order', mode: 'exclusive' }] },
    }).automations[0]!
    service.create({
      name: 'Due after latest resume',
      prompt: 'Wait for the latest power event',
      workspacePath: join(root, 'due-after-latest-resume'),
      schedule: { kind: 'interval', everyMinutes: 1 },
    })
    coordinator.start()
    const started = await coordinator.runManual(running.id)
    coordinator.suspendForSystemSleep()
    repository.releaseExecutionLocks(started.automationRunId, 'desktop-test-host')
    vi.setSystemTime(now + 60_000)
    let releaseInterrupt!: () => void
    pool.interruptGate = new Promise<void>(resolve => { releaseInterrupt = resolve })

    const staleResume = coordinator.resumeAfterSystemSleep()
    await vi.waitFor(() => expect(pool.events).toContain(`interrupt-enter:${started.automationRunId}`))
    coordinator.suspendForSystemSleep()
    const latestResume = coordinator.resumeAfterSystemSleep()
    releaseInterrupt()
    const [staleSnapshot, latestSnapshot] = await Promise.all([staleResume, latestResume])

    expect(staleSnapshot.suspended).toBe(true)
    expect(latestSnapshot.suspended).toBe(false)
    expect(pool.claims).toHaveLength(2)
    pool.finishAll()
    await coordinator.waitForIdle()
    await coordinator.stop()
  })

  it('interrupts local execution when lease or lock heartbeat renewal fails', async () => {
    const now = Date.parse('2026-09-01T01:58:00.000Z')
    const { root, service, repository, pool, coordinator } = createHarness(now)
    const automation = service.create({
      name: 'Heartbeat ownership loss',
      prompt: 'Stop as soon as ownership cannot be renewed',
      workspacePath: join(root, 'heartbeat-workspace'),
      schedule: { kind: 'manual' },
      reliabilityPolicy: { resourceLocks: [{ key: 'workspace:heartbeat', mode: 'exclusive' }] },
    }).automations[0]!
    const started = await coordinator.runManual(automation.id)
    repository.releaseExecutionLocks(started.automationRunId, 'desktop-test-host')

    await vi.advanceTimersByTimeAsync(10_000)
    await coordinator.waitForIdle()

    expect(pool.events).toContain(`interrupt-enter:${started.automationRunId}`)
    const interrupted = repository.getRun(started.automationRunId)!
    expect(interrupted.status).toBe('interrupted')
    expect(interrupted).not.toHaveProperty('lease')
  })

  it('fences a completion that races ahead of heartbeat-loss interruption', async () => {
    const now = Date.parse('2026-09-01T01:59:00.000Z')
    const { root, service, repository, pool, coordinator } = createHarness(now)
    const automation = service.create({
      name: 'Heartbeat completion race',
      prompt: 'Never commit after execution ownership is invalidated',
      workspacePath: join(root, 'heartbeat-race-workspace'),
      schedule: { kind: 'manual' },
      reliabilityPolicy: { resourceLocks: [{ key: 'workspace:heartbeat-race', mode: 'exclusive' }] },
    }).automations[0]!
    const started = await coordinator.runManual(automation.id)
    let releaseInterrupt!: () => void
    pool.interruptGate = new Promise<void>(resolve => { releaseInterrupt = resolve })
    repository.releaseExecutionLocks(started.automationRunId, 'desktop-test-host')

    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => expect(pool.events).toContain(`interrupt-enter:${started.automationRunId}`))
    pool.finishAll()
    await vi.waitFor(() => expect(coordinator.snapshot().error).toContain('no longer owns the run'))

    expect(repository.getRun(started.automationRunId)?.status).toBe('running')
    let idleSettled = false
    const idle = coordinator.waitForIdle().then(() => { idleSettled = true })
    await Promise.resolve()
    expect(idleSettled).toBe(false)

    releaseInterrupt()
    await idle
    expect(repository.getRun(started.automationRunId)).toMatchObject({
      status: 'interrupted',
      error: { code: 'automation_ownership_lost' },
    })
    expect(repository.getRun(started.automationRunId)).not.toHaveProperty('lease')
    expect(service.getRun(automation.id, started.automationRunId)?.status).toBe('interrupted')
  })

  it('does not claim a workspace owned by foreground work and runs another ready workspace', async () => {
    const now = Date.parse('2026-09-01T02:00:00.000Z')
    const { root, service, pool, coordinator } = createHarness(now)
    const foregroundWorkspace = join(root, 'foreground')
    const backgroundWorkspace = join(root, 'background')
    pool.foreground = foregroundWorkspace
    pool.blocked.add(foregroundWorkspace)
    const blocked = service.create({ name: 'Blocked', prompt: 'Wait', workspacePath: foregroundWorkspace, schedule: { kind: 'interval', everyMinutes: 1 } }).automations[0]!
    const runnable = service.create({ name: 'Runnable', prompt: 'Run', workspacePath: backgroundWorkspace, schedule: { kind: 'interval', everyMinutes: 1 } }).automations[0]!

    await coordinator.tick(now + 60_000)

    expect(pool.claims.map(claim => claim.automation.id)).toEqual([runnable.id])
    const blockedAfterTick = service.get(blocked.id)!
    expect(blockedAfterTick).toMatchObject({ nextRunAt: now + 60_000 })
    expect(blockedAfterTick).not.toHaveProperty('activeRunId')
    expect(coordinator.snapshot().error).toContain('Foreground work owns')
    pool.finishAll()
    await coordinator.waitForIdle()
  })

  it('records manual runs in v3 before execution and preserves frozen snapshots', async () => {
    const now = Date.parse('2026-09-01T03:00:00.000Z')
    const { root, service, repository, pool, coordinator } = createHarness(now)
    const automation = service.create({
      name: 'Manual',
      prompt: 'Run manually',
      workspacePath: join(root, 'workspace'),
      schedule: { kind: 'manual' },
      approvalPolicy: 'agent',
      capabilityPolicy: { deniedTools: ['git_push'] },
    }).automations[0]!

    const started = await coordinator.runManual(automation.id)
    const durableRun = repository.getRun(started.automationRunId)!

    expect(durableRun).toMatchObject({
      status: 'running',
      definitionRevision: 1,
      permissionSnapshotId: `permission-${started.automationRunId}`,
      contextSnapshotId: `context-${started.automationRunId}`,
    })
    expect(repository.getPermissionSnapshot(durableRun.permissionSnapshotId)).toMatchObject({
      approvalPolicy: 'agent',
      deniedTools: ['git_push'],
    })
    pool.finishAll()
    await coordinator.waitForIdle()
  })

  it('settles coordinator bookkeeping when execution-lock cleanup fails', async () => {
    const now = Date.parse('2026-09-01T03:15:00.000Z')
    const { root, service, repository, pool, coordinator } = createHarness(now)
    const automation = service.create({
      name: 'Cleanup isolation',
      prompt: 'Finish despite cleanup failure',
      workspacePath: join(root, 'workspace'),
      schedule: { kind: 'manual' },
    }).automations[0]!
    const started = await coordinator.runManual(automation.id)
    vi.spyOn(repository, 'releaseExecutionLocks').mockImplementationOnce(() => {
      throw new Error('simulated execution-lock cleanup failure')
    })

    pool.finishAll()
    await coordinator.waitForIdle()

    expect(coordinator.snapshot()).toMatchObject({
      runningRunIds: [],
      error: 'simulated execution-lock cleanup failure',
    })
    expect(repository.getRun(started.automationRunId)).toMatchObject({ status: 'completed' })
  })

  it('recovers the same durable queued run after a crash before the compatibility store commits', async () => {
    const now = Date.parse('2026-09-01T04:00:00.000Z')
    const { root, service, repository, pool, coordinator } = createHarness(now)
    const workspacePath = join(root, 'workspace')
    const automation = service.create({
      name: 'Crash window',
      prompt: 'Run exactly once',
      workspacePath,
      schedule: { kind: 'interval', everyMinutes: 1 },
    }).automations[0]!
    let durableRunId = ''

    expect(() => service.claimDue(workspacePath, {
      now: now + 60_000,
      beforePersist: claims => {
        const record = (coordinator as unknown as {
          recordDurableClaim(claim: AutomationClaim): { id: string }
        }).recordDurableClaim(claims[0]!)
        durableRunId = record.id
        throw new Error('simulated crash before v2 commit')
      },
    })).toThrow('simulated crash before v2 commit')
    expect(repository.getRun(durableRunId)).toMatchObject({ status: 'queued' })
    expect(service.get(automation.id)).toMatchObject({ history: [], nextRunAt: now + 60_000 })

    const started = await coordinator.tick(now + 60_001)

    expect(started).toEqual([durableRunId])
    expect(pool.claims[0]?.run.id).toBe(durableRunId)
    expect(repository.listRuns()).toHaveLength(1)
    pool.finishAll()
    await coordinator.waitForIdle()
    expect(repository.getRun(durableRunId)).toMatchObject({ status: 'completed' })
  })

  it('resumes the same run and conversation from a verified checkpoint without creating another occurrence', async () => {
    const now = Date.parse('2026-09-01T05:00:00.000Z')
    const { root, service, repository, coordinator } = createHarness(now)
    const workspacePath = join(root, 'workspace')
    mkdirSync(workspacePath)
    execFileSync('git', ['-C', workspacePath, 'init', '-q'])
    execFileSync('git', ['-C', workspacePath, 'config', 'user.email', 'automation@test.local'])
    execFileSync('git', ['-C', workspacePath, 'config', 'user.name', 'Automation Test'])
    writeFileSync(join(workspacePath, 'README.md'), 'checkpoint\n')
    execFileSync('git', ['-C', workspacePath, 'add', 'README.md'])
    execFileSync('git', ['-C', workspacePath, 'commit', '-qm', 'checkpoint'])
    const automation = service.create({
      name: 'Recover same run',
      prompt: 'Continue safely',
      workspacePath,
      schedule: { kind: 'manual' },
    }).automations[0]!
    const started = await coordinator.runManual(automation.id)
    const run = repository.getRun(started.automationRunId)!
    const permissionSnapshot = repository.getPermissionSnapshot(run.permissionSnapshotId)!
    const contextSnapshot = repository.getContextSnapshot(run.contextSnapshotId)!
    repository.saveCheckpoint(createAutomationCheckpoint({
      run,
      permissionSnapshot,
      contextSnapshot,
      state: {
        canonicalEventSequence: 9,
        completedToolCallIds: ['tool-read-1'],
        nonReplayableToolCallIds: [],
        toolEffects: [],
        artifactIds: [],
        contextSummary: 'The initial work was durably saved.',
      },
      reason: 'host_exit',
      workspaceIdentity: captureAutomationWorkspaceIdentity(workspacePath),
      now,
    }))
    service.markRunStatus(automation.id, run.id, 'interrupted', { error: 'simulated host exit', now })
    repository.transitionRun(run.id, 'interrupted', { clearLease: true })

    const resumedPool = new FakeExecutionPool(service)
    const resumedCoordinator = new AutomationCoordinator(service, repository, resumedPool, {
      ownerId: 'desktop-recovery-host',
      now: () => Date.now(),
    })
    const resumed = await resumedCoordinator.recover(run.id, 'resume_without_replay')

    expect(resumed.automationRunId).toBe(run.id)
    expect(repository.listRuns()).toHaveLength(1)
    expect(repository.getRun(run.id)).toMatchObject({
      status: 'running',
      attempt: 2,
      conversationId: started.conversationId,
      recovery: { action: 'resume_without_replay' },
    })
    expect(resumedPool.claims[0]?.run).toMatchObject({
      id: run.id,
      trigger: 'recovery',
      conversationId: started.conversationId,
      recovery: { action: 'resume_without_replay' },
    })
    resumedPool.finishAll()
    await resumedCoordinator.waitForIdle()
  })
})

describe('AutomationCoordinator recovery decisions', () => {
  function createGitWorkspace(root: string) {
    const workspacePath = join(root, 'workspace')
    mkdirSync(workspacePath)
    execFileSync('git', ['-C', workspacePath, 'init', '-q'])
    execFileSync('git', ['-C', workspacePath, 'config', 'user.email', 'automation@test.local'])
    execFileSync('git', ['-C', workspacePath, 'config', 'user.name', 'Automation Test'])
    writeFileSync(join(workspacePath, 'README.md'), 'checkpoint\n')
    execFileSync('git', ['-C', workspacePath, 'add', 'README.md'])
    execFileSync('git', ['-C', workspacePath, 'commit', '-qm', 'checkpoint'])
    return workspacePath
  }

  async function createReviewRun(options: {
    secretAvailable?: () => boolean
    classification?: 'idempotent_write' | 'non_idempotent_write'
    status?: 'interrupted' | 'needs_review'
  } = {}) {
    const now = Date.parse('2026-09-01T06:00:00.000Z')
    const harness = createHarness(now, options.secretAvailable ? { hasSecretRef: () => options.secretAvailable!() } : {})
    const workspacePath = createGitWorkspace(harness.root)
    const automation = harness.service.create({
      name: 'Review recovery',
      prompt: 'Continue only after explicit review',
      workspacePath,
      schedule: { kind: 'manual' },
      capabilityPolicy: options.secretAvailable ? { secretRefs: ['release-token'] } : undefined,
      reliabilityPolicy: { resourceLocks: [{ key: 'release:review', mode: 'exclusive' }] },
    }).automations[0]!
    const started = await harness.coordinator.runManual(automation.id)
    const run = harness.repository.getRun(started.automationRunId)!
    harness.repository.saveCheckpoint(createAutomationCheckpoint({
      run,
      permissionSnapshot: harness.repository.getPermissionSnapshot(run.permissionSnapshotId)!,
      contextSnapshot: harness.repository.getContextSnapshot(run.contextSnapshotId)!,
      state: {
        canonicalEventSequence: 4,
        completedToolCallIds: ['read-1'],
        nonReplayableToolCallIds: ['write-1'],
        toolEffects: [],
        inFlightToolEffect: {
          toolCallId: 'write-2',
          toolName: 'publish_release',
          classification: options.classification ?? 'non_idempotent_write',
          idempotencyKey: options.classification === 'idempotent_write' ? 'release-review-v1' : undefined,
          targetSummary: 'release v1.0',
          status: 'uncertain',
          startedAt: now,
        },
        pendingApprovalId: 'approval-review',
        artifactIds: ['artifact-draft'],
      },
      reason: 'approval',
      workspaceIdentity: captureAutomationWorkspaceIdentity(workspacePath),
      now,
    }))
    harness.service.recordApproval({
      id: 'approval-review',
      automationId: automation.id,
      automationName: automation.name,
      runId: run.id,
      definitionRevision: run.definitionRevision,
      permissionSnapshotId: run.permissionSnapshotId,
      conversationId: started.conversationId,
      workspacePath,
      kind: 'permission',
      riskCategory: 'permission',
      question: 'Publish the release?',
      options: ['allow-once', 'deny'],
      requestedAt: now,
      expiresAt: now + 60 * 60_000,
      status: 'pending',
    })
    harness.repository.transitionRun(run.id, options.status ?? 'needs_review', { clearLease: true })
    return { ...harness, automation, run }
  }

  it('validates frozen dependencies before canceling a pending approval', async () => {
    let secretAvailable = true
    const { coordinator, service, run } = await createReviewRun({ secretAvailable: () => secretAvailable })
    secretAvailable = false

    const options = coordinator.recoveryOptions(run.id)
    expect(options.every(option => option.warnings.some(warning => warning.includes('1 pending approval')))).toBe(true)
    await expect(coordinator.recover(run.id, 'resume_without_replay')).rejects.toThrow('secret reference is unavailable')
    expect(service.getApproval('approval-review')).toMatchObject({ status: 'pending' })
  })

  it('stops a review run, closes approvals, releases locks, and preserves its checkpoint', async () => {
    const { coordinator, repository, service, run } = await createReviewRun()

    const canceled = coordinator.abandonRecovery(run.id)

    expect(canceled).toMatchObject({ status: 'canceled', checkpointId: expect.any(String) })
    expect(service.getApproval('approval-review')).toMatchObject({ status: 'canceled', decision: 'deny' })
    expect(service.getRun(run.definitionId, run.id)).toMatchObject({ status: 'canceled' })
    expect(repository.listExecutionLocks().filter(lock => lock.runId === run.id)).toHaveLength(0)
    expect(repository.listCheckpoints(run.id)).toHaveLength(1)
    expect(() => coordinator.abandonRecovery(run.id)).toThrow('Only interrupted or review-required runs can be stopped')
  })

  it('keeps review state and approvals unchanged when the workspace is still owned', async () => {
    const { coordinator, pool, repository, service, run, automation } = await createReviewRun()
    pool.blocked.add(automation.workspacePath)

    await expect(coordinator.recover(run.id, 'resume_without_replay')).rejects.toThrow('Foreground work owns')
    expect(repository.getRun(run.id)).toMatchObject({ status: 'needs_review', attempt: 1 })
    expect(service.getApproval('approval-review')).toMatchObject({ status: 'pending' })
  })

  it('does not let whole-run retry bypass checkpoint review', async () => {
    const { coordinator, repository, service, run, automation } = await createReviewRun()

    await expect(coordinator.retry(automation.id, run.id)).rejects.toThrow('requires checkpoint review')
    expect(repository.getRun(run.id)).toMatchObject({ status: 'needs_review', attempt: 1 })
    expect(service.getApproval('approval-review')).toMatchObject({ status: 'pending' })
  })

  it('holds the compatibility scheduler while a durable run needs review', async () => {
    const { repository, service, pool, run, automation } = await createReviewRun()
    service.markRunStatus(automation.id, run.id, 'interrupted', {
      error: 'simulated compatibility restart',
      now: Date.now(),
    })
    expect(service.getRun(automation.id, run.id)).toMatchObject({ status: 'retry_scheduled' })

    const restarted = new AutomationCoordinator(service, repository, pool, {
      ownerId: 'desktop-restarted-review-host',
      now: () => Date.now(),
    })
    restarted.initialize()

    expect(service.getRun(automation.id, run.id)).toMatchObject({ status: 'needs_review', retryAt: undefined })
    expect(service.get(automation.id)).toMatchObject({ activeRunId: run.id, lastStatus: 'needs_review' })
    await restarted.tick(Date.now() + 24 * 60 * 60_000)
    expect(repository.listRuns({ definitionId: automation.id })).toHaveLength(1)
    expect(pool.claims).toHaveLength(1)
  })

  it('revalidates a queued automatic recovery and fails closed after workspace drift', async () => {
    const { repository, service, pool, run, automation } = await createReviewRun({
      classification: 'idempotent_write',
      status: 'interrupted',
    })
    service.cancelApproval('approval-review', Date.now())
    service.markRunStatus(automation.id, run.id, 'interrupted', {
      error: 'simulated compatibility restart',
      now: Date.now(),
    })
    const restarted = new AutomationCoordinator(service, repository, pool, {
      ownerId: 'desktop-queued-recovery-host',
      now: () => Date.now(),
    })
    restarted.initialize()
    expect(repository.getRun(run.id)).toMatchObject({ status: 'queued', recovery: { action: 'retry_idempotent' } })

    writeFileSync(join(automation.workspacePath, 'README.md'), 'changed after recovery was queued\n')
    await restarted.tick(Date.now())

    expect(repository.getRun(run.id)).toMatchObject({
      status: 'needs_review',
      error: { code: 'automation_recovery_validation_failed', retryable: false },
    })
    expect(service.getRun(automation.id, run.id)).toMatchObject({ status: 'needs_review' })
    expect(pool.claims).toHaveLength(1)
  })
})
