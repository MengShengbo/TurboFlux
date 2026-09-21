import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { automationDefinitionFromV2Record, migrateAutomationV2Store } from './automationMigration'
import { validateAutomationRecovery } from './automationRecovery'
import {
  automationSpecDigest,
  AutomationRepository,
  type AutomationExecutionLockRequest,
  type AutomationLeaseResumeResult,
  type AutomationRunCreation,
} from './automationRepository'
import { automationRunErrorFromFailure } from './automationFailure'
import type { AutomationClaim, AutomationRecord, AutomationRunRecord, AutomationService } from './automationService'
import { AUTOMATION_SCHEMA_VERSION, type AutomationRecoveryAction, type AutomationRun, type AutomationRunStatus, type AutomationTriggerEvent } from './automationTypes'

export interface AutomationExecutionStarted {
  status: 'started' | 'queued' | 'steering'
  inputId: string
  automationId: string
  automationRunId: string
  conversationId: string
  [key: string]: unknown
}

export interface AutomationExecutionHandle {
  started: AutomationExecutionStarted
  completion: Promise<AutomationRunRecord>
}

export interface AutomationExecutionPool {
  canStart(automation: AutomationRecord): { ok: true } | { ok: false; reason: string }
  start(claim: AutomationClaim): Promise<AutomationExecutionHandle>
  interrupt(runId: string, reason: string): Promise<boolean>
  foregroundWorkspacePath(): string | undefined
}

export interface AutomationCoordinatorOptions {
  sourcePath?: string
  ownerId?: string
  maxConcurrentRuns?: number
  leaseMs?: number
  now?: () => number
  minimumWakeMs?: number
  maxQueuedRuns?: number
  onStateChanged?: () => void
  hasSecretRef?: (id: string) => boolean
  resolvePluginVersion?: (id: string) => string | undefined
}

export interface AutomationCoordinatorSnapshot {
  ownerId: string
  startedAt: number
  runningRunIds: string[]
  recoveredRunIds: string[]
  suspended: boolean
  lastTickAt?: number
  nextWakeAt?: number
  error?: string
}

interface AutomationExecutionOwnership {
  valid: boolean
  reason?: string
}

const ACTIVE_V3_STATUSES = new Set<AutomationRunStatus>([
  'preparing',
  'running',
  'waiting_for_approval',
  'checkpointed',
])

function triggerSource(trigger: AutomationRunRecord['trigger']): AutomationTriggerEvent['source'] {
  if (trigger === 'manual') return 'manual'
  if (trigger === 'recovery') return 'recovery'
  return 'schedule'
}

export function automationQueuePriority(source: AutomationTriggerEvent['source'] | undefined, queuedAt: number, now: number): number {
  const base = source === 'recovery' ? 30 : source === 'manual' ? 20 : source === 'schedule' ? 0 : 10
  const aging = Math.min(100, Math.floor(Math.max(0, now - queuedAt) / (5 * 60_000)))
  return base + aging
}

function occurrenceKey(claim: AutomationClaim): string {
  const run = claim.run
  if (run.trigger === 'manual') return `manual:${claim.automation.id}:${run.id}`
  if (run.trigger === 'retry') return `retry:${claim.automation.id}:${run.scheduledFor ?? run.startedAt}:${run.attempt}`
  return `schedule:${claim.automation.id}:${run.scheduledFor ?? run.startedAt}`
}

function runCreation(claim: AutomationClaim): AutomationRunCreation {
  const key = occurrenceKey(claim)
  const eventId = `trigger-${claim.run.id}`
  const event: AutomationTriggerEvent = {
    id: eventId,
    source: triggerSource(claim.run.trigger),
    sourceInstanceId: claim.run.trigger,
    deduplicationKey: key,
    trust: claim.run.trigger === 'manual' ? 'local_user' : 'system',
    occurredAt: claim.run.scheduledFor ?? claim.run.startedAt,
    receivedAt: claim.run.startedAt,
    definitionId: claim.automation.id,
    definitionRevision: claim.run.definitionRevision,
    status: 'routed',
  }
  const run: AutomationRun = {
    id: claim.run.id,
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    definitionId: claim.automation.id,
    definitionRevision: claim.run.definitionRevision,
    triggerEventId: eventId,
    occurrenceKey: key,
    mode: claim.run.contextSnapshot.mode,
    workspaceRef: { path: resolve(claim.automation.workspacePath) },
    conversationId: claim.run.contextSnapshot.conversationId ?? claim.run.conversationId,
    dryRun: claim.run.dryRun === true,
    status: 'queued',
    attempt: claim.run.attempt,
    permissionSnapshotId: claim.run.permissionSnapshot.id,
    contextSnapshotId: claim.run.contextSnapshot.id,
    timestamps: {
      createdAt: claim.run.startedAt,
      queuedAt: claim.run.startedAt,
      updatedAt: claim.run.updatedAt,
      retryAt: claim.run.retryAt,
    },
  }
  return {
    event,
    run,
    permissionSnapshot: JSON.parse(JSON.stringify(claim.run.permissionSnapshot)),
    contextSnapshot: JSON.parse(JSON.stringify(claim.run.contextSnapshot)),
  }
}

function legacyRunTerminal(status: AutomationRunRecord['status']): boolean {
  return ['completed', 'failed', 'canceled', 'interrupted', 'needs_review', 'skipped', 'missed', 'retry_scheduled'].includes(status)
}

function executionLockRequest(automation: AutomationRecord): AutomationExecutionLockRequest {
  return {
    concurrencyGroup: automation.reliabilityPolicy.concurrencyGroup,
    resources: automation.reliabilityPolicy.resourceLocks ?? [],
  }
}

export class AutomationCoordinator {
  private readonly ownerId: string
  private readonly maxConcurrentRuns: number
  private readonly leaseMs: number
  private readonly now: () => number
  private readonly minimumWakeMs: number
  private readonly maxQueuedRuns: number
  private readonly startedAt: number
  private readonly running = new Map<string, Promise<void>>()
  private readonly dispatching = new Set<string>()
  private readonly pendingDispatches = new Set<Promise<AutomationExecutionStarted>>()
  private readonly pendingInterruptions = new Set<Promise<void>>()
  private readonly executionOwnership = new Map<string, AutomationExecutionOwnership>()
  private tickTail: Promise<void> = Promise.resolve()
  private resumeTail: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private suspended = false
  private suspensionEpoch = 0
  private initialized = false
  private lastTickAt?: number
  private nextWakeAt?: number
  private error?: string
  private recoveredRunIds: string[] = []
  private lastMaintenanceAt = 0

  constructor(
    readonly service: AutomationService,
    readonly repository: AutomationRepository,
    private readonly pool: AutomationExecutionPool,
    private readonly options: AutomationCoordinatorOptions = {},
  ) {
    this.ownerId = options.ownerId ?? `desktop-${randomUUID()}`
    this.maxConcurrentRuns = Math.max(1, Math.min(8, Math.floor(options.maxConcurrentRuns ?? 2)))
    this.leaseMs = Math.max(3_000, Math.floor(options.leaseMs ?? 30_000))
    this.now = options.now ?? Date.now
    this.minimumWakeMs = Math.max(100, Math.floor(options.minimumWakeMs ?? 1_000))
    this.maxQueuedRuns = Math.max(1, Math.min(10_000, Math.floor(options.maxQueuedRuns ?? 500)))
    this.startedAt = this.now()

  }

  initialize(): AutomationCoordinatorSnapshot {
    if (this.initialized) return this.snapshot()
    this.repository.initialize()
    this.repository.runRetentionMaintenance({ now: this.now() })
    this.lastMaintenanceAt = this.now()
    if (this.options.sourcePath && existsSync(this.options.sourcePath)) {
      migrateAutomationV2Store(this.repository, this.options.sourcePath, this.now())
    }
    for (const definition of this.service.list().automations) {
      if (definition.enabled && definition.triggers.some(trigger => !['manual', 'schedule', 'cron'].includes(trigger.kind))) {
        this.service.update(definition.id, { enabled: false, lifecycleStatus: 'invalid' })
        this.service.recordValidation(definition.id, [{ code: 'unsupported_trigger', severity: 'error', path: 'triggers', message: '此触发方式已停用，请编辑计划并选择定时或手动运行。' }], [])
      }
    }
    this.syncDefinitions()
    const recovered = this.repository.recoverExpiredLeases()
    this.recoveredRunIds = recovered.map(run => run.id)
    this.synchronizeRecoveryStates()
    this.initialized = true
    return this.snapshot()
  }

  start(): void {
    this.initialize()
    if (!this.stopped) return
    this.stopped = false
    this.schedule(0)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  suspendForSystemSleep(): AutomationCoordinatorSnapshot {
    this.initialize()
    this.suspensionEpoch += 1
    this.suspended = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.nextWakeAt = undefined
    return this.snapshot()
  }

  resumeAfterSystemSleep(): Promise<AutomationCoordinatorSnapshot> {
    this.initialize()
    if (!this.suspended) return Promise.resolve(this.snapshot())
    const resumeEpoch = this.suspensionEpoch
    const operation = this.resumeTail.then(() => {
      if (!this.suspended || this.suspensionEpoch !== resumeEpoch) return this.snapshot()
      return this.performResumeAfterSystemSleep(resumeEpoch)
    })
    this.resumeTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async performResumeAfterSystemSleep(resumeEpoch: number): Promise<AutomationCoordinatorSnapshot> {
    let renewal: AutomationLeaseResumeResult
    try {
      renewal = this.renewOwnedLeasesAfterSleep()
    } catch (error) {
      this.error = `Automation lease renewal after sleep failed: ${error instanceof Error ? error.message : String(error)}`
      this.options.onStateChanged?.()
      throw error
    }
    let resumeError: string | undefined
    if (renewal.lostRunIds.length > 0) {
      resumeError = `Automation lease ownership changed while the host slept: ${renewal.lostRunIds.join(', ')}`
      for (const runId of renewal.lostRunIds) this.invalidateExecutionOwnership(runId, resumeError)
      const interruptions = await Promise.allSettled(renewal.lostRunIds.map(runId => this.pool.interrupt(runId, resumeError!)))
      const failedInterruptions = interruptions.filter(result => result.status === 'rejected')
      if (failedInterruptions.length > 0) {
        resumeError += ` ${failedInterruptions.length} local execution(s) could not be stopped cleanly.`
      }
      this.error = resumeError
      this.options.onStateChanged?.()
    }
    if (this.suspensionEpoch !== resumeEpoch) return this.snapshot()
    this.suspended = false
    if (!this.stopped) await this.tick(this.now())
    if (resumeError) {
      this.error = this.error && this.error !== resumeError ? `${resumeError} ${this.error}` : resumeError
      this.options.onStateChanged?.()
    }
    return this.snapshot()
  }

  private renewOwnedLeasesAfterSleep(): AutomationLeaseResumeResult {
    let lastConflict: Error | undefined
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return this.repository.renewOwnedLeasesAfterSleep(this.ownerId, this.ownedRunIds(), this.leaseMs)
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'AutomationRepositoryConflictError') throw error
        lastConflict = error
      }
    }
    throw lastConflict ?? new Error('Automation lease renewal after sleep could not acquire a stable repository version.')
  }

  notifyDefinitionsChanged(): void {
    this.initialize()
    this.syncDefinitions()
    this.options.onStateChanged?.()
    if (!this.stopped) this.schedule(0)
  }

  snapshot(): AutomationCoordinatorSnapshot {
    return {
      ownerId: this.ownerId,
      startedAt: this.startedAt,
      runningRunIds: this.ownedRunIds(),
      recoveredRunIds: [...this.recoveredRunIds],
      suspended: this.suspended,
      lastTickAt: this.lastTickAt,
      nextWakeAt: this.nextWakeAt,
      error: this.error,
    }
  }

  syncDefinitions(): void {
    const legacyDefinitions = this.service.list().automations
    const legacyIds = new Set(legacyDefinitions.map(definition => definition.id))
    for (const legacy of legacyDefinitions) this.syncDefinition(legacy)
    for (const existing of this.repository.listDefinitions()) {
      if (legacyIds.has(existing.id) || existing.status === 'archived') continue
      this.repository.saveDefinition({
        ...existing,
        revision: existing.revision + 1,
        status: 'archived',
        updatedAt: this.now(),
      }, {
        source: 'migration',
        parentRevision: existing.revision,
        changeSummary: 'Archived after removal from the compatibility definition store.',
      })
    }
  }

  tick(now?: number): Promise<string[]> {
    this.initialize()
    const dispatchEpoch = this.suspensionEpoch
    const requestedWhileSuspended = this.suspended
    const operation = this.tickTail.then(() => {
      if (requestedWhileSuspended || !this.canDispatch(dispatchEpoch)) return []
      return this.performTick(now ?? this.now(), dispatchEpoch)
    })
    this.tickTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async performTick(now: number, dispatchEpoch: number): Promise<string[]> {
    this.lastTickAt = now
    this.error = undefined
    const recovered = this.repository.recoverExpiredLeases()
    this.recoveredRunIds = recovered.map(run => run.id)
    this.synchronizeRecoveryStates()
    if (now - this.lastMaintenanceAt >= 60 * 60_000) {
      this.repository.runRetentionMaintenance({ now })
      this.lastMaintenanceAt = now
    }
    this.syncDefinitions()
    const repositoryActive = this.repository.listActiveRuns().filter(run => ACTIVE_V3_STATUSES.has(run.status)).length
    let capacity = Math.max(0, this.maxConcurrentRuns - Math.max(repositoryActive, this.running.size))
    const started: string[] = []
    const queued = this.repository.listRuns({ limit: 500 }).filter(run => run.status === 'queued').sort((left, right) => {
      const priority = (run: AutomationRun) => {
        const event = this.repository.getEvent(run.triggerEventId)
        return automationQueuePriority(event?.source, run.timestamps.queuedAt, now)
      }
      return priority(right) - priority(left) || left.timestamps.queuedAt - right.timestamps.queuedAt || left.id.localeCompare(right.id)
    })
    for (const durable of queued) {
      if (!this.canDispatch(dispatchEpoch)) break
      if (capacity <= 0 || this.running.has(durable.id)) break
      if (durable.recovery) {
        const checkpoint = this.repository.getCheckpoint(durable.id, durable.recovery.checkpointId)
        const validation = checkpoint
          ? this.validateRecovery(durable, checkpoint, durable.recovery.action, false)
          : { valid: false, issues: ['The prepared recovery checkpoint is unavailable.'] }
        if (!validation.valid) {
          const reviewed = this.repository.transitionRun(durable.id, 'needs_review', {
            error: {
              code: 'automation_recovery_validation_failed',
              category: 'configuration',
              message: `Queued recovery validation failed: ${validation.issues.join(' ')}`,
              retryable: false,
              userAction: 'Inspect the recovery blockers in Run details and choose whether to continue or stop.',
            },
          })
          this.holdLegacyRunForReview(reviewed)
          continue
        }
      }
      const claim = this.restoreDurableClaim(durable)
      if (!claim) continue
      const permission = this.pool.canStart(claim.automation)
      if (!permission.ok) {
        this.error = permission.reason
        if (permission.reason === 'Automation workspace is missing or is not a directory.') {
          this.repository.transitionRun(durable.id, 'invalid', {
            error: {
              code: 'automation_workspace_missing',
              category: 'configuration',
              message: permission.reason,
              retryable: false,
              userAction: 'Restore the workspace or edit and republish the automation.',
            },
          })
          this.service.markRunStatus(claim.automation.id, claim.run.id, 'invalid', { error: permission.reason, now })
          this.syncDefinitions()
        }
        continue
      }
      const lockPermission = this.repository.canAcquireExecutionLocks(executionLockRequest(claim.automation), now)
      if (!lockPermission.ok) {
        this.error = lockPermission.reason
        continue
      }
      if (!this.canDispatch(dispatchEpoch)) break
      await this.dispatchClaim(claim, dispatchEpoch)
      started.push(durable.id)
      capacity -= 1
    }
    const foreground = this.pool.foregroundWorkspacePath()
    const workspaces = [...new Set(this.service.list().automations.map(automation => automation.workspacePath))]
      .filter(workspacePath => this.service.due(workspacePath, now).length > 0)
      .sort((left, right) => Number(right === foreground) - Number(left === foreground)
        || (this.service.nextWakeAt(left, now) ?? now) - (this.service.nextWakeAt(right, now) ?? now)
        || left.localeCompare(right))

    for (const workspacePath of workspaces) {
      if (!this.canDispatch(dispatchEpoch)) break
      if (capacity <= 0) break
      const candidate = this.service.due(workspacePath, now)[0]
      if (!candidate) continue
      const permission = this.pool.canStart(candidate)
      if (!permission.ok) {
        this.error = permission.reason
        continue
      }
      const lockPermission = this.repository.canAcquireExecutionLocks(executionLockRequest(candidate), now)
      if (!lockPermission.ok) {
        this.error = lockPermission.reason
        continue
      }
      if (!this.canDispatch(dispatchEpoch)) break
      const claim = this.service.claimDue(workspacePath, {
        now,
        limit: 1,
        beforePersist: claims => claims.forEach(claimToRecord => { this.recordDurableClaim(claimToRecord) }),
      })[0]
      if (!claim) continue
      try {
        await this.dispatchClaim(claim, dispatchEpoch)
        started.push(claim.run.id)
        capacity -= 1
      } catch (dispatchError) {
        this.error = dispatchError instanceof Error ? dispatchError.message : String(dispatchError)
      }
    }
    this.recordHealth(now)
    this.options.onStateChanged?.()
    if (!this.stopped) this.scheduleNext()
    return started
  }

  async runManual(id: string, dryRun = false): Promise<AutomationExecutionStarted> {
    this.initialize()
    this.assertAwake()
    const dispatchEpoch = this.suspensionEpoch
    const automation = this.service.get(id)
    if (!automation) throw new Error(`Automation not found: ${id}`)
    const permission = this.pool.canStart(automation)
    if (!permission.ok) throw new Error(permission.reason)
    const lockPermission = this.repository.canAcquireExecutionLocks(executionLockRequest(automation))
    if (!lockPermission.ok) throw new Error(lockPermission.reason)
    this.assertCapacity()
    const claim = this.service.claimManual(id, this.now(), dryRun, claims => {
      claims.forEach(claimToRecord => { this.recordDurableClaim(claimToRecord) })
    })
    return this.dispatchClaim(claim, dispatchEpoch)
  }

  async retry(id: string, runId: string): Promise<AutomationExecutionStarted> {
    this.initialize()
    this.assertAwake()
    const dispatchEpoch = this.suspensionEpoch
    const durablePrevious = this.repository.getRun(runId)
    if (durablePrevious && ['interrupted', 'needs_review'].includes(durablePrevious.status)) {
      throw new Error('This run requires checkpoint review; use a recovery decision instead of retrying the whole run.')
    }
    const automation = this.service.get(id)
    if (!automation) throw new Error(`Automation not found: ${id}`)
    const lockPermission = this.repository.canAcquireExecutionLocks(executionLockRequest(automation))
    if (!lockPermission.ok) throw new Error(lockPermission.reason)
    this.assertCapacity()
    const claim = this.service.retryNow(id, runId, this.now(), claims => {
      claims.forEach(claimToRecord => { this.recordDurableClaim(claimToRecord) })
    })
    return this.dispatchClaim(claim, dispatchEpoch)
  }

  async recover(runId: string, action: AutomationRecoveryAction): Promise<AutomationExecutionStarted> {
    this.initialize()
    this.assertAwake()
    const dispatchEpoch = this.suspensionEpoch
    this.assertCapacity()
    const run = this.repository.getRun(runId)
    if (!run) throw new Error(`Automation run not found: ${runId}`)
    const checkpoint = this.repository.getLatestCheckpoint(runId)
    if (!checkpoint) throw new Error('Automation recovery requires a durable checkpoint')
    const automation = this.service.get(run.definitionId)
    if (!automation) throw new Error(`Automation not found: ${run.definitionId}`)
    const workspacePermission = this.pool.canStart(automation)
    if (!workspacePermission.ok) throw new Error(workspacePermission.reason)
    const lockPermission = this.repository.canAcquireExecutionLocks(executionLockRequest(automation), this.now(), run.id)
    if (!lockPermission.ok) throw new Error(lockPermission.reason)
    if (run.status === 'queued' && run.recovery) {
      if (run.recovery.action !== action) throw new Error(`Automation recovery is already queued with action: ${run.recovery.action}`)
      const queuedValidation = this.validateRecovery(run, checkpoint, action, true)
      if (!queuedValidation.valid) {
        const reviewed = this.repository.transitionRun(run.id, 'needs_review', {
          error: {
            code: 'automation_recovery_validation_failed',
            category: 'configuration',
            message: `Queued recovery validation failed: ${queuedValidation.issues.join(' ')}`,
            retryable: false,
            userAction: 'Inspect the recovery blockers and choose again.',
          },
        })
        this.holdLegacyRunForReview(reviewed)
        throw new Error(`Automation recovery blocked: ${queuedValidation.issues.join(' ')}`)
      }
      const queuedClaim = this.restoreDurableClaim(run)
      if (!queuedClaim) throw new Error('Automation recovery could not restore its frozen run data')
      return this.dispatchClaim(queuedClaim, dispatchEpoch)
    }
    const pendingApprovals = this.service.listApprovals(run.id).filter(approval => approval.status === 'pending')
    const validation = this.validateRecovery(run, checkpoint, action, true, true)
    if (!validation.valid || !validation.workspaceIdentity) {
      throw new Error(`Automation recovery blocked: ${validation.issues.join(' ')}`)
    }
    for (const approval of pendingApprovals) {
      if (approval.status === 'pending') this.service.cancelApproval(approval.id, this.now())
    }
    const finalValidation = this.validateRecovery(run, checkpoint, action, true)
    if (!finalValidation.valid || !finalValidation.workspaceIdentity) {
      throw new Error(`Automation recovery blocked: ${finalValidation.issues.join(' ')}`)
    }
    const warnings = [...new Set([
      ...finalValidation.warnings,
      ...(pendingApprovals.length > 0 ? [`${pendingApprovals.length} pending approval request(s) were canceled before recovery.`] : []),
    ])]
    const prepared = this.repository.prepareRunRecovery(run.id, {
      action,
      checkpointId: checkpoint.id,
      requestedAt: this.now(),
      verifiedAt: this.now(),
      workspaceFingerprint: finalValidation.workspaceIdentity.fingerprint,
      warnings,
      skipToolCallIds: action === 'resume_without_replay' && checkpoint.inFlightToolEffect
        ? [...new Set([...checkpoint.nonReplayableToolCallIds, checkpoint.inFlightToolEffect.toolCallId])]
        : [...checkpoint.nonReplayableToolCallIds],
      unresolvedTool: checkpoint.inFlightToolEffect ? {
        toolCallId: checkpoint.inFlightToolEffect.toolCallId,
        toolName: checkpoint.inFlightToolEffect.toolName,
        classification: checkpoint.inFlightToolEffect.classification,
        targetSummary: checkpoint.inFlightToolEffect.targetSummary,
      } : undefined,
    })
    const claim = this.restoreDurableClaim(prepared)
    if (!claim) throw new Error('Automation recovery could not restore its frozen run data')
    return this.dispatchClaim(claim, dispatchEpoch)
  }

  recoveryOptions(runId: string): Array<{ action: AutomationRecoveryAction; enabled: boolean; issues: string[]; warnings: string[] }> {
    this.initialize()
    const run = this.repository.getRun(runId)
    const checkpoint = this.repository.getLatestCheckpoint(runId)
    if (!run || !checkpoint || !['interrupted', 'needs_review'].includes(run.status)) return []
    const pendingApprovalCount = this.service.listApprovals(run.id).filter(approval => approval.status === 'pending').length
    return (['resume_without_replay', 'retry_idempotent'] as const).map(action => {
      const validation = this.validateRecovery(run, checkpoint, action, true, true)
      const warnings = [...validation.warnings]
      if (pendingApprovalCount > 0) warnings.push(`${pendingApprovalCount} pending approval request(s) will be canceled before recovery.`)
      return { action, enabled: validation.valid, issues: validation.issues, warnings }
    })
  }

  abandonRecovery(runId: string): AutomationRun {
    this.initialize()
    const run = this.repository.getRun(runId)
    if (!run) throw new Error(`Automation run not found: ${runId}`)
    if (!['interrupted', 'needs_review'].includes(run.status)) {
      throw new Error(`Only interrupted or review-required runs can be stopped: ${run.status}`)
    }
    for (const approval of this.service.listApprovals(run.id)) {
      if (approval.status === 'pending') this.service.cancelApproval(approval.id, this.now())
    }
    const legacy = this.service.getRun(run.definitionId, run.id)
    if (legacy && !['completed', 'canceled', 'skipped', 'missed'].includes(legacy.status)) {
      this.service.markRunStatus(run.definitionId, run.id, 'canceled', {
        error: 'Recovery was stopped by the user after reviewing the checkpoint.',
        now: this.now(),
      })
    }
    this.repository.releaseExecutionLocks(run.id)
    const canceled = this.repository.transitionRun(run.id, 'canceled', { clearLease: true })
    this.options.onStateChanged?.()
    return canceled
  }

  async waitForIdle(): Promise<void> {
    await this.tickTail
    while (this.pendingDispatches.size > 0 || this.pendingInterruptions.size > 0 || this.running.size > 0) {
      await Promise.allSettled([
        ...this.pendingDispatches,
        ...this.pendingInterruptions,
        ...this.running.values(),
      ])
    }
  }

  private syncDefinition(legacy: AutomationRecord): void {
    let existing = this.repository.getDefinition(legacy.id)
    if (!existing) {
      const first = automationDefinitionFromV2Record(legacy, 1)
      this.repository.saveDefinition(first, {
        source: 'migration',
        changeSummary: 'Imported from the compatibility automation service.',
        validationIssues: legacy.validationIssues,
      })
      existing = first
    }
    for (let revision = existing.revision + 1; revision <= legacy.revision; revision += 1) {
      const definition = automationDefinitionFromV2Record(legacy, revision)
      this.repository.saveDefinition(definition, {
        source: 'user',
        parentRevision: revision - 1,
        changeSummary: 'Synchronized from the compatibility automation service.',
        validationIssues: legacy.validationIssues,
      })
      existing = definition
    }
    const expected = automationDefinitionFromV2Record(legacy, existing.revision)
    expected.context.continuationConversationId = existing.context.continuationConversationId
    if (automationSpecDigest(existing) !== automationSpecDigest(expected)) {
      throw new Error(`Automation definition changed without a new revision: ${legacy.id}`)
    }
  }

  private dispatchClaim(claim: AutomationClaim, dispatchEpoch: number): Promise<AutomationExecutionStarted> {
    const dispatch = this.performDispatchClaim(claim, dispatchEpoch)
    this.pendingDispatches.add(dispatch)
    void dispatch.then(
      () => { this.pendingDispatches.delete(dispatch) },
      () => { this.pendingDispatches.delete(dispatch) },
    )
    return dispatch
  }

  private async performDispatchClaim(claim: AutomationClaim, dispatchEpoch: number): Promise<AutomationExecutionStarted> {
    this.syncDefinition(claim.automation)
    this.freezeAndValidateDependencies(claim)
    const durable = this.repository.getRun(claim.run.id) ?? this.recordDurableClaim(claim)
    if (durable.status !== 'queued') throw new Error(`Automation run is not dispatchable: ${durable.status}`)
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let locksAcquired = false
    let poolStarted = false
    const ownership: AutomationExecutionOwnership = { valid: true }
    this.executionOwnership.set(durable.id, ownership)
    this.dispatching.add(durable.id)
    try {
      this.assertDispatchEpoch(dispatchEpoch)
      this.repository.acquireExecutionLocks(durable.id, this.ownerId, executionLockRequest(claim.automation), this.leaseMs)
      locksAcquired = true
      this.assertDispatchEpoch(dispatchEpoch)
      this.repository.acquireLease(durable.id, this.ownerId, this.leaseMs)
      this.assertDispatchEpoch(dispatchEpoch)
      const handle = await this.pool.start(claim)
      poolStarted = true
      this.assertDispatchEpoch(dispatchEpoch)
      this.repository.transitionRun(durable.id, 'running', { conversationId: handle.started.conversationId })
      this.dispatching.delete(durable.id)
      heartbeat = setInterval(() => {
        if (this.suspended) return
        try {
          this.repository.renewOwnedLeaseAndExecutionLocks(
            durable.id,
            this.ownerId,
            this.leaseMs,
            executionLockRequest(claim.automation),
          )
          this.syncActiveRunStatus(durable.id, claim)
        } catch (heartbeatError) {
          this.error = heartbeatError instanceof Error ? heartbeatError.message : String(heartbeatError)
          ownership.valid = false
          ownership.reason = `Automation ownership heartbeat failed: ${this.error}`
          if (heartbeat) clearInterval(heartbeat)
          heartbeat = null
          this.trackInterruption(this.interruptAfterHeartbeatFailure(durable.id, claim, ownership))
        }
      }, Math.max(1_000, Math.floor(this.leaseMs / 3)))
      heartbeat.unref?.()
      const completion = handle.completion.then(run => this.finishRun(durable.id, run, ownership)).catch(error => {
        const current = this.service.getRun(claim.automation.id, claim.run.id)
        if (current && !legacyRunTerminal(current.status)) {
          this.service.markRunStatus(claim.automation.id, claim.run.id, 'failed', {
            error: error instanceof Error ? error.message : String(error),
            now: this.now(),
          })
        }
        const failed = this.service.getRun(claim.automation.id, claim.run.id)
        if (failed) this.finishRun(durable.id, failed, ownership)
      }).finally(() => {
        if (heartbeat) clearInterval(heartbeat)
        try {
          this.repository.releaseExecutionLocks(durable.id, this.ownerId)
        } catch (releaseError) {
          this.error = releaseError instanceof Error ? releaseError.message : String(releaseError)
        } finally {
          if (this.executionOwnership.get(durable.id) === ownership) this.executionOwnership.delete(durable.id)
          this.running.delete(durable.id)
          this.options.onStateChanged?.()
          if (!this.stopped) this.schedule(this.minimumWakeMs)
        }
      })
      this.running.set(durable.id, completion)
      this.options.onStateChanged?.()
      return handle.started
    } catch (error) {
      this.dispatching.delete(durable.id)
      if (heartbeat) clearInterval(heartbeat)
      if (poolStarted) {
        try {
          await this.pool.interrupt(durable.id, error instanceof Error ? error.message : String(error))
        } catch (interruptError) {
          this.error = interruptError instanceof Error ? interruptError.message : String(interruptError)
        }
      }
      if (locksAcquired) {
        try {
          this.repository.releaseExecutionLocks(durable.id, this.ownerId)
        } catch (releaseError) {
          this.error = releaseError instanceof Error ? releaseError.message : String(releaseError)
        }
      }
      const durableAfterFailure = this.repository.getRun(durable.id)
      if (!poolStarted && durableAfterFailure?.status === 'queued') {
        if (this.executionOwnership.get(durable.id) === ownership) this.executionOwnership.delete(durable.id)
        throw error
      }
      const current = this.service.getRun(claim.automation.id, claim.run.id)
      if (current && !legacyRunTerminal(current.status)) {
        this.service.markRunStatus(claim.automation.id, claim.run.id, 'failed', {
          error: error instanceof Error ? error.message : String(error),
          now: this.now(),
        })
      }
      const failed = this.service.getRun(claim.automation.id, claim.run.id)
      if (failed) this.finishRun(durable.id, failed, ownership)
      if (this.executionOwnership.get(durable.id) === ownership) this.executionOwnership.delete(durable.id)
      throw error
    }
  }

  private recordDurableClaim(claim: AutomationClaim): AutomationRun {
    this.syncDefinition(claim.automation)
    this.freezeAndValidateDependencies(claim)
    const result = this.repository.createRun(runCreation(claim))
    if (!result.created) {
      if (result.run.status !== 'queued') throw new Error(`Duplicate automation occurrence is already ${result.run.status}: ${result.run.occurrenceKey}`)
      const permissionSnapshot = this.repository.getPermissionSnapshot(result.run.permissionSnapshotId)
      const contextSnapshot = this.repository.getContextSnapshot(result.run.contextSnapshotId)
      if (!permissionSnapshot || !contextSnapshot) throw new Error(`Durable automation run snapshots are missing: ${result.run.id}`)
      claim.run = {
        ...claim.run,
        id: result.run.id,
        definitionRevision: result.run.definitionRevision,
        conversationId: result.run.conversationId,
        attempt: result.run.attempt,
        startedAt: result.run.timestamps.createdAt,
        updatedAt: result.run.timestamps.updatedAt,
        permissionSnapshot,
        contextSnapshot,
      }
    }
    return result.run
  }

  private restoreDurableClaim(run: AutomationRun): AutomationClaim | null {
    const automation = this.service.get(run.definitionId)
    const permissionSnapshot = this.repository.getPermissionSnapshot(run.permissionSnapshotId)
    const contextSnapshot = this.repository.getContextSnapshot(run.contextSnapshotId)
    const event = this.repository.getEvent(run.triggerEventId)
    const payload = event?.payloadRef ? this.repository.getPayload(event.payloadRef) : null
    if (!automation || !permissionSnapshot || !contextSnapshot || !event || event.payloadRef && !payload) {
      this.repository.transitionRun(run.id, 'invalid', {
        error: {
          code: 'automation_recovery_data_missing',
          category: 'configuration',
          message: 'A queued automation run could not be restored because its definition or snapshots are missing.',
          retryable: false,
          userAction: 'Repair or recreate the automation definition.',
        },
      })
      return null
    }
    if (automation.activeRunId && automation.activeRunId !== run.id) return null
    const trigger: AutomationRunRecord['trigger'] = run.recovery
      ? 'recovery'
      : event.source === 'manual'
      ? 'manual'
      : event.source === 'recovery' ? 'recovery' : run.attempt > 1 ? 'retry' : 'scheduled'
    return this.service.restoreQueuedRun(automation.id, {
      id: run.id,
      definitionRevision: run.definitionRevision,
      conversationId: run.conversationId,
      dryRun: run.dryRun === true,
      trigger,
      status: 'queued',
      scheduledFor: event.source === 'manual' ? undefined : event.occurredAt,
      attempt: run.attempt,
      startedAt: run.timestamps.createdAt,
      updatedAt: this.now(),
      retryAt: run.timestamps.retryAt,
      permissionSnapshot,
      contextSnapshot,
      triggerData: payload ? {
        source: payload.source,
        trust: payload.trust === 'system' ? 'system' : payload.trust === 'verified_connector' ? 'verified_connector' : 'untrusted_external',
        summary: payload.summary,
        serializedData: JSON.stringify(payload.normalizedData).slice(0, 64 * 1024),
      } : undefined,
      recovery: run.recovery ? {
        action: run.recovery.action,
        checkpointId: run.recovery.checkpointId,
        warnings: [...run.recovery.warnings],
        skipToolCallIds: [...run.recovery.skipToolCallIds],
        unresolvedTool: run.recovery.unresolvedTool ? { ...run.recovery.unresolvedTool } : undefined,
      } : undefined,
    })
  }

  private freezeAndValidateDependencies(claim: AutomationClaim): void {
    const snapshot = claim.run.permissionSnapshot
    if (snapshot.secretRefs.some(id => !this.options.hasSecretRef?.(id))) {
      throw new Error('Automation run requires an unavailable secret reference')
    }
    const pluginVersions: Record<string, string> = { ...(snapshot.pluginVersions ?? {}) }
    for (const pluginId of snapshot.pluginIds) {
      const currentVersion = this.options.resolvePluginVersion?.(pluginId)
      if (!currentVersion) throw new Error(`Automation run requires an unavailable plugin: ${pluginId}`)
      const frozenVersion = pluginVersions[pluginId]
      if (frozenVersion && frozenVersion !== currentVersion) {
        throw new Error(`Automation plugin version changed before execution: ${pluginId}`)
      }
      pluginVersions[pluginId] = currentVersion
    }
    snapshot.pluginVersions = pluginVersions
  }

  private validateRecovery(
    run: AutomationRun,
    checkpoint: NonNullable<ReturnType<AutomationRepository['getLatestCheckpoint']>>,
    action: AutomationRecoveryAction,
    explicitUserChoice: boolean,
    ignorePendingApproval = false,
  ) {
    const pendingApproval = this.service.listApprovals(run.id).some(approval => approval.status === 'pending')
    return validateAutomationRecovery({
      action,
      explicitUserChoice,
      run,
      checkpoint,
      definition: this.repository.getRevision(run.definitionId, run.definitionRevision)?.definition ?? null,
      permissionSnapshot: this.repository.getPermissionSnapshot(run.permissionSnapshotId),
      contextSnapshot: this.repository.getContextSnapshot(run.contextSnapshotId),
      workspacePath: run.workspaceRef.path,
      pendingApproval: ignorePendingApproval ? false : pendingApproval,
      hasSecretRef: this.options.hasSecretRef,
      resolvePluginVersion: this.options.resolvePluginVersion,
    })
  }

  private prepareAutomaticRecovery(run: AutomationRun): void {
    if (run.status === 'needs_review') {
      this.holdLegacyRunForReview(run)
      return
    }
    if (run.status !== 'interrupted') return
    const checkpoint = this.repository.getLatestCheckpoint(run.id)
    if (!checkpoint) {
      const reviewed = this.repository.transitionRun(run.id, 'needs_review', {
        error: {
          code: 'automation_recovery_checkpoint_missing',
          category: 'side_effect_unknown',
          message: 'Automatic recovery is blocked because the durable checkpoint is missing.',
          retryable: false,
          userAction: 'Review the workspace and stop this run before starting a new one.',
        },
      })
      this.holdLegacyRunForReview(reviewed)
      return
    }
    const action: AutomationRecoveryAction = checkpoint.inFlightToolEffect
      ? 'retry_idempotent'
      : 'resume_without_replay'
    const validation = this.validateRecovery(run, checkpoint, action, false)
    if (!validation.valid || !validation.workspaceIdentity) {
      const reviewed = this.repository.transitionRun(run.id, 'needs_review', {
        error: {
          code: 'automation_recovery_validation_failed',
          category: 'configuration',
          message: `Automatic recovery validation failed: ${validation.issues.join(' ')}`,
          retryable: false,
          userAction: 'Inspect the recovery blockers in Run details and choose whether to skip or stop.',
        },
      })
      this.holdLegacyRunForReview(reviewed)
      return
    }
    this.repository.prepareRunRecovery(run.id, {
      action,
      checkpointId: checkpoint.id,
      requestedAt: this.now(),
      verifiedAt: this.now(),
      workspaceFingerprint: validation.workspaceIdentity.fingerprint,
      warnings: validation.warnings,
      skipToolCallIds: [...checkpoint.nonReplayableToolCallIds],
      unresolvedTool: checkpoint.inFlightToolEffect ? {
        toolCallId: checkpoint.inFlightToolEffect.toolCallId,
        toolName: checkpoint.inFlightToolEffect.toolName,
        classification: checkpoint.inFlightToolEffect.classification,
        targetSummary: checkpoint.inFlightToolEffect.targetSummary,
      } : undefined,
    })
  }

  private holdLegacyRunForReview(run: AutomationRun): void {
    const legacy = this.service.getRun(run.definitionId, run.id)
    if (!legacy || legacy.status === 'needs_review') return
    this.service.markRunStatus(run.definitionId, run.id, 'needs_review', {
      error: run.error?.message ?? 'This run requires checkpoint review before it can continue.',
      now: this.now(),
    })
  }

  private synchronizeRecoveryStates(): void {
    const total = this.repository.countRuns()
    for (let offset = 0; offset < total; offset += 500) {
      for (const run of this.repository.listRuns({ offset, limit: 500 })) {
        if (run.status === 'interrupted' || run.status === 'needs_review') this.prepareAutomaticRecovery(run)
      }
    }
  }

  private assertCapacity(): void {
    const active = this.repository.listActiveRuns().filter(run => ACTIVE_V3_STATUSES.has(run.status)).length
    if (Math.max(active, this.running.size) >= this.maxConcurrentRuns) {
      throw new Error('The global automation concurrency limit has been reached.')
    }
  }

  private assertAwake(): void {
    if (this.suspended) throw new Error('Automation dispatch is paused while the Desktop host is suspended.')
  }

  private canDispatch(dispatchEpoch: number): boolean {
    return !this.suspended && this.suspensionEpoch === dispatchEpoch
  }

  private assertDispatchEpoch(dispatchEpoch: number): void {
    if (!this.canDispatch(dispatchEpoch)) this.assertAwake()
    if (this.suspensionEpoch !== dispatchEpoch) {
      throw new Error('Automation dispatch crossed a Desktop power lifecycle boundary and was interrupted.')
    }
  }

  private invalidateExecutionOwnership(runId: string, reason: string): void {
    const ownership = this.executionOwnership.get(runId)
    if (!ownership) return
    ownership.valid = false
    ownership.reason = reason
  }

  private trackInterruption(interruption: Promise<void>): void {
    this.pendingInterruptions.add(interruption)
    void interruption.finally(() => { this.pendingInterruptions.delete(interruption) })
  }

  private async interruptAfterHeartbeatFailure(
    runId: string,
    claim: AutomationClaim,
    ownership: AutomationExecutionOwnership,
  ): Promise<void> {
    const reason = ownership.reason ?? 'Automation ownership heartbeat failed.'
    try {
      const interrupted = await this.pool.interrupt(runId, reason)
      if (!interrupted) {
        this.error = `${reason} Local execution could not be stopped cleanly.`
        return
      }
      const currentOwnership = this.executionOwnership.get(runId)
      if (currentOwnership && currentOwnership !== ownership) return
      const current = this.repository.getRun(runId)
      if (!current || !ACTIVE_V3_STATUSES.has(current.status) || current.lease?.ownerId !== this.ownerId) return
      this.repository.transitionRun(runId, 'interrupted', {
        clearLease: true,
        error: {
          code: 'automation_ownership_lost',
          category: 'host_interrupted',
          message: reason,
          retryable: true,
          userAction: 'Review the latest checkpoint before retrying this run.',
        },
      })
      const legacy = this.service.getRun(claim.automation.id, claim.run.id)
      if (legacy && !['canceled', 'needs_review', 'skipped', 'missed'].includes(legacy.status)) {
        this.service.markRunStatus(claim.automation.id, claim.run.id, 'interrupted', {
          error: reason,
          suppressRetry: true,
          now: this.now(),
        })
      }
    } catch (interruptError) {
      this.error = `${reason} Local execution stop failed: ${interruptError instanceof Error ? interruptError.message : String(interruptError)}`
    } finally {
      this.options.onStateChanged?.()
    }
  }

  private ownedRunIds(): string[] {
    return [...new Set([...this.running.keys(), ...this.dispatching])]
  }

  private finishRun(runId: string, legacy: AutomationRunRecord, ownership: AutomationExecutionOwnership): void {
    const current = this.repository.getRun(runId)
    if (!current || ['completed', 'failed', 'canceled', 'interrupted', 'needs_review', 'skipped', 'expired', 'invalid'].includes(current.status)) return
    if (!ownership.valid || this.executionOwnership.get(runId) !== ownership) {
      this.error = `Ignored a stale completion for automation run ${runId} because this execution no longer owns the run.`
      this.options.onStateChanged?.()
      return
    }
    if (ACTIVE_V3_STATUSES.has(current.status)
      && (!current.lease || current.lease.ownerId !== this.ownerId || current.lease.expiresAt < this.now())) {
      this.error = `Ignored a stale completion for automation run ${runId} because this host no longer owns its lease.`
      this.options.onStateChanged?.()
      return
    }
    const error = legacy.error
      ? legacy.status === 'interrupted'
        ? { code: 'host_interrupted', category: 'host_interrupted' as const, message: legacy.error, retryable: true }
        : automationRunErrorFromFailure(legacy.error)
      : undefined
    const transition = (status: AutomationRunStatus) => {
      const latest = this.repository.getRun(runId)
      if (latest?.status === status) return latest
      return this.repository.transitionRun(runId, status, {
        conversationId: legacy.conversationId,
        result: legacy.result,
        error,
        retryAt: legacy.retryAt,
        clearLease: true,
      })
    }
    if (legacy.status === 'completed') {
      transition('completed')

    }
    else if (legacy.status === 'canceled') transition('canceled')
    else if (legacy.status === 'skipped') transition('skipped')
    else if (legacy.status === 'missed') transition('expired')
    else if (legacy.status === 'retry_scheduled') {
      transition('failed')
      transition('retry_scheduled')
    } else if (legacy.status === 'interrupted') transition('interrupted')
    else if (legacy.status === 'invalid') transition('invalid')
    else transition('failed')
  }

  private syncActiveRunStatus(runId: string, claim: AutomationClaim): void {
    const legacy = this.service.getRun(claim.automation.id, claim.run.id)
    const durable = this.repository.getRun(runId)
    if (!legacy || !durable) return
    if (legacy.status === 'waiting_for_approval' && durable.status === 'running') {
      this.repository.transitionRun(runId, 'waiting_for_approval')
      this.options.onStateChanged?.()
    } else if (legacy.status === 'running' && durable.status === 'waiting_for_approval') {
      this.repository.transitionRun(runId, 'running')
      this.options.onStateChanged?.()
    }
  }

  private recordHealth(now: number): void {
    const activeRuns = this.repository.listActiveRuns().filter(run => ACTIVE_V3_STATUSES.has(run.status)).length
    this.nextWakeAt = this.computeNextWake(now)
    this.service.recordSchedulerHealth({
      status: this.error ? 'degraded' : activeRuns > 0 ? 'running' : this.nextWakeAt === undefined ? 'idle' : 'watching',
      lastTickAt: now,
      nextWakeAt: this.nextWakeAt,
      activeRuns,
      error: this.error,
    })
  }

  private computeNextWake(now: number): number | undefined {
    const workspaces = [...new Set(this.service.list().automations.map(automation => automation.workspacePath))]
    const times = workspaces.map(workspacePath => this.service.nextWakeAt(workspacePath, now)).filter((value): value is number => value !== undefined)
    return times.length > 0 ? Math.min(...times) : undefined
  }

  private scheduleNext(): void {
    if (this.suspended) return
    const now = this.now()
    const next = this.computeNextWake(now)
    if (next === undefined) return
    this.schedule(Math.max(this.minimumWakeMs, next - now))
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.suspended) return
    if (this.timer) clearTimeout(this.timer)
    const delay = Math.max(0, Math.min(2_147_000_000, delayMs))
    this.nextWakeAt = this.now() + delay
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick().catch(error => {
        this.error = error instanceof Error ? error.message : String(error)
        if (!this.stopped) this.schedule(this.minimumWakeMs)
      })
    }, delay)
    this.timer.unref?.()
  }
}
