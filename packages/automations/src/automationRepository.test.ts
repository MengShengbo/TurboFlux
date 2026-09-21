import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AutomationRepository } from './automationRepository'
import { assertAutomationRunTransition, canTransitionAutomationRun } from './automationStateMachine'
import {
  AUTOMATION_SCHEMA_VERSION,
  type AutomationContextSnapshot,
  type AutomationDeliveryRecord,
  type AutomationDefinition,
  type AutomationPermissionSnapshot,
  type AutomationRun,
  type AutomationRunCheckpoint,
  type AutomationTriggerEvent,
} from './automationTypes'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-v3-'))
  directories.push(root)
  return root
}

function definition(workspacePath: string, revision = 1): AutomationDefinition {
  const now = 1_788_192_000_000 + revision
  return {
    id: 'automation-definition-1',
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    revision,
    status: 'active',
    name: 'Repository validation',
    workspaceRef: { path: workspacePath },
    objective: {
      originalPrompt: 'Validate the repository.',
      goal: 'Validate the repository.',
      successCriteria: ['The run is persisted exactly once.'],
      deliverables: [],
      constraints: [],
    },
    triggers: [{ id: 'trigger-schedule-1', kind: 'schedule', schedule: { kind: 'daily', time: '09:00' }, timezone: 'Asia/Shanghai' }],
    context: {
      mode: 'isolated',
      includeAutomationMemory: false,
      includePreviousRunSummary: false,
      fileRefs: [],
      skillIds: [],
    },
    capabilities: {
      approvalPolicy: 'ask',
      allowedTools: [],
      deniedTools: [],
      paths: [{ path: workspacePath, access: 'write' }],
      networkDomains: [],
      secretRefs: [],
      mcpServerIds: [],
      pluginIds: [],
      allowComputerUse: false,
      allowBackgroundComputerUse: false,
    },
    reliability: {
      misfirePolicy: 'run-once',
      overlapPolicy: 'skip',
      maxParallel: 1,
      maxQueuedRuns: 1,
      maxRuntimeMinutes: 60,
      maxToolCalls: 100,
      retry: { maxRetries: 2, backoffMinutes: 2, maxBackoffMinutes: 60, jitter: 0.1 },
    },
    delivery: {
      desktop: ['failed', 'approval', 'invalid'],
      remoteMobile: ['approval'],
      digest: 'immediate',
      providerRefs: [],
    },
    createdAt: now,
    updatedAt: now,
    publishedAt: now,
  }
}

function runCreation(workspacePath: string, suffix = '1') {
  const now = 1_788_192_000_000
  const event: AutomationTriggerEvent = {
    id: `trigger-event-${suffix}`,
    source: 'schedule',
    sourceInstanceId: 'trigger-schedule-1',
    deduplicationKey: 'automation-definition-1:1:1788192000000',
    trust: 'system',
    occurredAt: now,
    receivedAt: now,
    definitionId: 'automation-definition-1',
    definitionRevision: 1,
    status: 'routed',
  }
  const permissionSnapshot: AutomationPermissionSnapshot = {
    id: `permission-snapshot-${suffix}`,
    definitionId: 'automation-definition-1',
    definitionRevision: 1,
    approvalPolicy: 'ask',
    allowedTools: [],
    deniedTools: [],
    paths: [{ path: workspacePath, access: 'write' }],
    networkDomains: [],
    secretRefs: [],
    mcpServerIds: [],
    pluginIds: [],
    allowComputerUse: false,
    allowBackgroundComputerUse: false,
    maxRuntimeMinutes: 60,
    maxToolCalls: 100,
    riskSummary: [],
    createdAt: now,
  }
  const contextSnapshot: AutomationContextSnapshot = {
    id: `context-snapshot-${suffix}`,
    definitionId: 'automation-definition-1',
    definitionRevision: 1,
    mode: 'isolated',
    fileRefs: [],
    skillIds: [],
    createdAt: now,
  }
  const run: AutomationRun = {
    id: `automation-run-${suffix}`,
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    definitionId: 'automation-definition-1',
    definitionRevision: 1,
    triggerEventId: event.id,
    occurrenceKey: event.deduplicationKey,
    mode: 'isolated',
    workspaceRef: { path: workspacePath },
    status: 'queued',
    attempt: 1,
    permissionSnapshotId: permissionSnapshot.id,
    contextSnapshotId: contextSnapshot.id,
    timestamps: { createdAt: now, queuedAt: now, updatedAt: now },
  }
  return { event, permissionSnapshot, contextSnapshot, run }
}

function checkpoint(
  workspacePath: string,
  classification: AutomationRunCheckpoint['inFlightToolEffect']['classification'] = 'read_only',
  id = 'checkpoint-1',
): AutomationRunCheckpoint {
  return {
    id,
    runId: 'automation-run-1',
    definitionId: 'automation-definition-1',
    definitionRevision: 1,
    conversationId: 'conversation-1',
    canonicalEventSequence: 12,
    completedToolCallIds: [],
    nonReplayableToolCallIds: [],
    toolEffects: [],
    inFlightToolEffect: {
      toolCallId: 'tool-call-1',
      toolName: classification === 'idempotent_write' ? 'write_file' : 'mcp__send_payment',
      classification,
      idempotencyKey: classification === 'idempotent_write' ? 'stable-effect-key' : undefined,
      targetSummary: workspacePath,
      status: 'proposed',
      startedAt: 1_788_192_000_100,
    },
    pendingApprovalId: undefined,
    artifactIds: [],
    workspaceFingerprint: 'workspace-fingerprint-1',
    permissionDigest: 'permission-digest-1',
    contextSnapshotId: 'context-snapshot-1',
    resumable: classification === 'read_only' || classification === 'idempotent_write',
    nonResumableReason: classification === 'read_only' || classification === 'idempotent_write'
      ? undefined
      : 'The external effect may already have happened.',
    reason: 'before_tool',
    createdAt: 1_788_192_000_200,
  }
}

describe('AutomationRepository', () => {
  it('persists immutable definition revisions and restores the latest definition', () => {
    const root = createRoot()
    const repository = new AutomationRepository(join(root, 'automations'))
    repository.initialize()
    const first = definition(root)
    repository.saveDefinition(first, { source: 'user', changeSummary: 'Initial definition' })
    const second = { ...definition(root, 2), name: 'Updated repository validation' }
    repository.saveDefinition(second, { source: 'user', changeSummary: 'Rename', parentRevision: 1 })

    const restored = new AutomationRepository(join(root, 'automations'))
    restored.initialize()
    expect(restored.getDefinition(first.id)).toMatchObject({ revision: 2, name: 'Updated repository validation' })
    expect(restored.getRevision(first.id, 1)).toMatchObject({ source: 'user', changeSummary: 'Initial definition' })
    expect(restored.getRevision(first.id, 2)).toMatchObject({ parentRevision: 1 })
    expect(() => restored.saveDefinition(second, { source: 'user', changeSummary: 'Overwrite' })).toThrow('revision conflict')
  })

  it('creates a trigger event and run exactly once for an occurrence', () => {
    const root = createRoot()
    const repository = new AutomationRepository(join(root, 'automations'))
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })

    const first = repository.createRun(runCreation(root, '1'))
    const duplicate = repository.createRun(runCreation(root, '2'))

    expect(first).toMatchObject({ created: true, run: { id: 'automation-run-1' } })
    expect(duplicate).toMatchObject({ created: false, run: { id: 'automation-run-1' } })
    expect(repository.listRuns()).toHaveLength(1)
    expect(repository.getEvent('trigger-event-1')).toMatchObject({ status: 'routed' })
    expect(repository.getEvent('trigger-event-2')).toBeNull()
    expect(repository.recordRunExecution('automation-run-1', { provider: 'openai', model: 'gpt-test' })).toMatchObject({
      execution: { provider: 'openai', model: 'gpt-test', recordedAt: expect.any(Number) },
    })
    expect(repository.triggerEventStatusCounts()).toMatchObject({ routed: 1, deduplicated: 0, rejected: 0 })
  })

  it('rejects an occurrence key collision across different definition identities', () => {
    const root = createRoot()
    const repository = new AutomationRepository(join(root, 'automations'))
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    repository.createRun(runCreation(root, '1'))
    const colliding = runCreation(root, '2')
    colliding.event.definitionId = 'automation-definition-2'
    colliding.run.definitionId = 'automation-definition-2'
    colliding.permissionSnapshot.definitionId = 'automation-definition-2'
    colliding.contextSnapshot.definitionId = 'automation-definition-2'

    expect(() => repository.createRun(colliding)).toThrow('Automation occurrence identity collision')
    expect(repository.listRuns()).toEqual([expect.objectContaining({ id: 'automation-run-1' })])
  })

  it('returns the winning run when another repository commits the occurrence before lock acquisition', () => {
    const root = createRoot()
    const repositoryRoot = join(root, 'automations')
    const competing = new AutomationRepository(repositoryRoot)
    let compete = false
    const repository = new AutomationRepository(repositoryRoot, {
      faultInjector(stage) {
        if (!compete || stage !== 'before-lock') return
        compete = false
        competing.createRun(runCreation(root, '2'))
      },
    })
    repository.initialize()
    competing.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    compete = true

    const result = repository.createRun(runCreation(root, '1'))

    expect(result).toMatchObject({ created: false, run: { id: 'automation-run-2' } })
    expect(repository.listRuns()).toEqual([expect.objectContaining({ id: 'automation-run-2' })])
    expect(repository.getEvent('trigger-event-1')).toBeNull()
    expect(repository.getEvent('trigger-event-2')).toMatchObject({ status: 'routed' })
  })

  it('persists concurrency groups and resource locks with lease expiry', () => {
    const root = createRoot()
    let now = 1_788_192_000_000
    const repositoryRoot = join(root, 'automations')
    const repository = new AutomationRepository(repositoryRoot, { now: () => now })
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    repository.createRun(runCreation(root, '1'))
    const second = runCreation(root, '2')
    second.event.deduplicationKey = 'automation-definition-1:1:1788192000001'
    second.run.occurrenceKey = second.event.deduplicationKey
    repository.createRun(second)
    const request = {
      concurrencyGroup: { id: 'reports', maxParallel: 1 },
      resources: [{ key: 'workspace:report.md', mode: 'exclusive' as const }],
    }

    repository.acquireExecutionLocks('automation-run-1', 'desktop-host-1', request, 3_000)
    expect(repository.canAcquireExecutionLocks(request)).toEqual({ ok: false, reason: 'Automation concurrency group is busy: reports' })
    expect(() => repository.acquireExecutionLocks('automation-run-2', 'desktop-host-1', request, 3_000)).toThrow('concurrency group is busy')
    expect(repository.getRun('automation-run-1')).toMatchObject({ concurrencyGroupId: 'reports', resourceLockKeys: ['workspace:report.md'] })

    const restored = new AutomationRepository(repositoryRoot, { now: () => now })
    restored.initialize()
    expect(restored.listExecutionLocks()).toHaveLength(2)
    now += 3_001
    expect(restored.canAcquireExecutionLocks(request)).toEqual({ ok: true })
    expect(restored.acquireExecutionLocks('automation-run-2', 'desktop-host-2', request, 3_000)).toHaveLength(2)
    expect(restored.releaseExecutionLocks('automation-run-2', 'desktop-host-2')).toBe(2)
    expect(restored.listExecutionLocks()).toEqual([])
  })

  it('rejects a stale lock-index write instead of overwriting another repository owner', () => {
    const root = createRoot()
    const repositoryRoot = join(root, 'automations')
    const setup = new AutomationRepository(repositoryRoot)
    setup.initialize()
    setup.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    setup.createRun(runCreation(root, '1'))
    const secondCreation = runCreation(root, '2')
    secondCreation.event.deduplicationKey = 'automation-definition-1:1:1788192000001'
    secondCreation.run.occurrenceKey = secondCreation.event.deduplicationKey
    setup.createRun(secondCreation)
    const competing = new AutomationRepository(repositoryRoot)
    competing.initialize()
    let injected = false
    const stale = new AutomationRepository(repositoryRoot, {
      faultInjector: stage => {
        if (stage !== 'before-lock' || injected) return
        injected = true
        competing.acquireExecutionLocks('automation-run-2', 'desktop-host-2', {
          resources: [{ key: 'workspace:report.md', mode: 'exclusive' }],
        }, 10_000)
      },
    })
    stale.initialize()

    expect(() => stale.acquireExecutionLocks('automation-run-1', 'desktop-host-1', {
      resources: [{ key: 'workspace:report.md', mode: 'exclusive' }],
    }, 10_000)).toThrow('changed concurrently')
    const restored = new AutomationRepository(repositoryRoot)
    restored.initialize()
    expect(restored.listExecutionLocks()).toEqual([
      expect.objectContaining({ runId: 'automation-run-2', ownerId: 'desktop-host-2', key: 'workspace:report.md' }),
    ])
  })

  it('runs bounded retention maintenance without deleting pinned or memory-backed runs', () => {
    const root = createRoot()
    let now = 1_788_192_000_000
    const repository = new AutomationRepository(join(root, 'automations'), { now: () => now })
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    const creations = ['1', '2', '3'].map(suffix => runCreation(root, suffix))
    creations[1]!.event.deduplicationKey = 'automation-definition-1:1:1788192000001'
    creations[1]!.run.occurrenceKey = creations[1]!.event.deduplicationKey
    creations[2]!.event.deduplicationKey = 'automation-definition-1:1:1788192000002'
    creations[2]!.run.occurrenceKey = creations[2]!.event.deduplicationKey
    for (const creation of creations) repository.createRun(creation)
    for (const suffix of ['1', '2', '3']) {
      repository.acquireLease(`automation-run-${suffix}`, 'desktop-host-1', 10_000)
      repository.transitionRun(`automation-run-${suffix}`, 'running')
      repository.transitionRun(`automation-run-${suffix}`, 'completed', {
        clearLease: true,
        result: { outcome: 'success', summary: `Done ${suffix}`, successCriteria: [], artifactIds: [], sideEffectSummary: [], durationMs: 10 },
      })
    }
    repository.saveCheckpoint(checkpoint(root))
    repository.setRunPinned('automation-run-2', true)
    writeFileSync(join(root, 'automations', 'memory', 'automation-definition-1.json'), JSON.stringify({
      schemaVersion: 3, definitionId: 'automation-definition-1', revision: 1,
      entries: [{ id: 'legacy-memory', sourceRunId: 'automation-run-3', evidence: [] }],
    }))

    now += 31 * 24 * 60 * 60_000
    expect(repository.runRetentionMaintenance({ now })).toMatchObject({ prunedSuccessDetails: 1, deletedRuns: 0, canceled: false })
    expect(repository.getRun('automation-run-1')).toMatchObject({ detailsPrunedAt: now })
    expect(repository.getRun('automation-run-1')).not.toHaveProperty('checkpointId')
    expect(repository.listCheckpoints('automation-run-1')).toEqual([])

    now = 1_788_192_000_000 + 181 * 24 * 60 * 60_000
    const plan = repository.planRetention({}, now)
    expect(plan.runIds).toEqual(['automation-run-1'])
    expect(plan.protectedRunIds).toContain('automation-run-3')
    expect(repository.runRetentionMaintenance({ now })).toMatchObject({ deletedRuns: 1, protectedRuns: 1 })
    expect(repository.getRun('automation-run-1')).toBeNull()
    expect(repository.getEvent('trigger-event-1')).toBeNull()
    expect(repository.getPermissionSnapshot('permission-snapshot-1')).toBeNull()
    expect(repository.getContextSnapshot('context-snapshot-1')).toBeNull()
    expect(repository.getRun('automation-run-2')).toMatchObject({ pinned: true })
    expect(repository.getRun('automation-run-3')).toMatchObject({ status: 'completed' })
  })

  it('persists and normalizes independent retention periods', () => {
    const root = createRoot()
    const path = join(root, 'automations')
    const repository = new AutomationRepository(path)
    repository.initialize()

    expect(repository.getRetentionPolicy()).toMatchObject({
      runMetadataDays: 180,
      successDetailsDays: 30,
      triggerPayloadDays: 7,
      conversationDays: 90,
      screenshotDays: 14,
      artifactDays: 90,
    })
    expect(repository.saveRetentionPolicy({ triggerPayloadDays: 90, screenshotDays: 0, artifactDays: 400 })).toMatchObject({
      triggerPayloadDays: 30,
      screenshotDays: 1,
      artifactDays: 400,
    })

    const restored = new AutomationRepository(path)
    restored.initialize()
    expect(restored.getRetentionPolicy()).toMatchObject({ triggerPayloadDays: 30, screenshotDays: 1, artifactDays: 400 })
  })

  it('can cancel a due retention batch before its durable transaction', () => {
    const root = createRoot()
    let now = 1_788_192_000_000
    const creation = runCreation(root)
    creation.event.payloadRef = 'payload-1'
    creation.event.payloadDigest = 'digest-1'
    creation.contextSnapshot.triggerPayloadRef = 'payload-1'
    const repository = new AutomationRepository(join(root, 'automations'), { now: () => now })
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    repository.createRun({
      ...creation,
      payload: {
        id: 'payload-1',
        digest: 'digest-1',
        trust: 'verified_connector',
        source: 'webhook',
        contentType: 'application/json',
        normalizedData: { ok: true },
        summary: 'Verified payload',
        redactedHeaders: {},
        receivedAt: now,
        expiresAt: now + 7 * 24 * 60 * 60_000,
        rawStored: false,
      },
    })
    now += 8 * 24 * 60 * 60_000

    expect(repository.runRetentionMaintenance({ now, shouldCancel: () => true })).toMatchObject({
      canceled: true,
      deletedPayloads: 0,
      remaining: 1,
    })
    expect(repository.getPayload('payload-1')).not.toBeNull()
    expect(repository.runRetentionMaintenance({ now, policy: { batchSize: 1 } })).toMatchObject({ deletedPayloads: 1, remaining: 0 })
    expect(repository.getPayload('payload-1')).toBeNull()
  })

  it('deletes selected definition data without deleting the archived definition history', () => {
    const root = createRoot()
    const repository = new AutomationRepository(join(root, 'automations'))
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    const creation = runCreation(root)
    creation.event.payloadRef = 'payload-delete'
    creation.event.payloadDigest = 'digest-delete'
    creation.contextSnapshot.triggerPayloadRef = 'payload-delete'
    repository.createRun({
      ...creation,
      payload: {
        id: 'payload-delete',
        digest: 'digest-delete',
        trust: 'verified_connector',
        source: 'webhook',
        contentType: 'application/json',
        normalizedData: { event: 'safe' },
        summary: 'safe event',
        redactedHeaders: {},
        receivedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        rawStored: false,
      },
    })
    writeFileSync(join(root, 'automations', 'memory', 'automation-definition-1.json'), JSON.stringify({
      schemaVersion: 3, definitionId: 'automation-definition-1', revision: 1, entries: [],
    }))

    expect(repository.deleteDefinitionData('automation-definition-1', { runs: true, memory: true })).toEqual({ deletedRuns: 1, deletedMemory: true })
    expect(repository.getDefinition('automation-definition-1')).not.toBeNull()
    expect(repository.getRevision('automation-definition-1', 1)).not.toBeNull()
    expect(repository.getRun('automation-run-1')).toBeNull()
    expect(repository.getPayload('payload-delete')).toBeNull()
    expect(repository.listMemory('automation-definition-1')).toMatchObject({ revision: 0, entries: [] })
  })

  it('atomically renews the same host lease and execution locks after system sleep', () => {
    const root = createRoot()
    let now = 1_788_192_000_000
    const repository = new AutomationRepository(join(root, 'automations'), { now: () => now })
    repository.initialize()
    const automationDefinition = definition(root)
    automationDefinition.reliability.concurrencyGroup = { id: 'reports', maxParallel: 1 }
    automationDefinition.reliability.resourceLocks = [{ key: 'workspace:report.md', mode: 'exclusive' }]
    repository.saveDefinition(automationDefinition, { source: 'user', changeSummary: 'Initial definition' })
    repository.createRun(runCreation(root))
    repository.acquireExecutionLocks('automation-run-1', 'desktop-host-1', {
      concurrencyGroup: { id: 'reports', maxParallel: 1 },
      resources: [{ key: 'workspace:report.md', mode: 'exclusive' }],
    }, 3_000)
    repository.acquireLease('automation-run-1', 'desktop-host-1', 3_000)
    repository.transitionRun('automation-run-1', 'running')
    now += 60_000

    expect(repository.renewOwnedLeasesAfterSleep('desktop-host-1', ['automation-run-1'], 30_000)).toEqual({
      resumedRunIds: ['automation-run-1'],
      lostRunIds: [],
    })
    expect(repository.getRun('automation-run-1')).toMatchObject({
      status: 'running',
      lease: { ownerId: 'desktop-host-1', heartbeatAt: now, expiresAt: now + 30_000 },
    })
    expect(repository.listExecutionLocks()).toEqual([
      expect.objectContaining({ runId: 'automation-run-1', ownerId: 'desktop-host-1', expiresAt: now + 30_000 }),
      expect.objectContaining({ runId: 'automation-run-1', ownerId: 'desktop-host-1', expiresAt: now + 30_000 }),
    ])
    expect(repository.recoverExpiredLeases()).toEqual([])
  })

  it('fails lock heartbeat renewal when the expected lock set is incomplete', () => {
    const root = createRoot()
    let now = 1_788_192_000_000
    const repository = new AutomationRepository(join(root, 'automations'), { now: () => now })
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    repository.createRun(runCreation(root))
    repository.acquireExecutionLocks('automation-run-1', 'desktop-host-1', {
      resources: [{ key: 'workspace:report.md', mode: 'exclusive' }],
    }, 30_000)
    repository.acquireLease('automation-run-1', 'desktop-host-1', 30_000)
    repository.transitionRun('automation-run-1', 'running')
    repository.releaseExecutionLocks('automation-run-1', 'desktop-host-1')
    const originalLease = repository.getRun('automation-run-1')!.lease
    now += 1_000

    expect(() => repository.renewOwnedLeaseAndExecutionLocks('automation-run-1', 'desktop-host-1', 30_000, {
      resources: [{ key: 'workspace:report.md', mode: 'exclusive' }],
    }))
      .toThrow('execution lock ownership was lost')
    expect(repository.getRun('automation-run-1')?.lease).toEqual(originalLease)
  })

  it('atomically renews a live heartbeat lease and its exact execution lock set', () => {
    const root = createRoot()
    let now = 1_788_192_000_000
    const repository = new AutomationRepository(join(root, 'automations'), { now: () => now })
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    repository.createRun(runCreation(root))
    const request = {
      concurrencyGroup: { id: 'reports', maxParallel: 2 },
      resources: [{ key: 'workspace:report.md', mode: 'shared' as const }],
    }
    repository.acquireExecutionLocks('automation-run-1', 'desktop-host-1', request, 30_000)
    repository.acquireLease('automation-run-1', 'desktop-host-1', 30_000)
    repository.transitionRun('automation-run-1', 'running')
    now += 1_000

    const renewed = repository.renewOwnedLeaseAndExecutionLocks('automation-run-1', 'desktop-host-1', 30_000, request)

    expect(renewed.run.lease).toMatchObject({ heartbeatAt: now, expiresAt: now + 30_000 })
    expect(renewed.locks).toEqual([
      expect.objectContaining({ kind: 'concurrency_group', key: 'reports', mode: 'slot', limit: 2, expiresAt: now + 30_000 }),
      expect.objectContaining({ kind: 'resource', key: 'workspace:report.md', mode: 'shared', expiresAt: now + 30_000 }),
    ])
    expect(repository.getRun('automation-run-1')?.lease?.expiresAt).toBe(now + 30_000)
    expect(repository.listExecutionLocks()).toHaveLength(2)
  })

  it('leaves both heartbeat lease and locks unchanged when failure occurs before intent durability', () => {
    const root = createRoot()
    let now = 1_788_192_000_000
    let fail = false
    const repositoryRoot = join(root, 'automations')
    const repository = new AutomationRepository(repositoryRoot, {
      now: () => now,
      faultInjector(stage) {
        if (fail && stage === 'before-intent') throw new Error('heartbeat intent was not durable')
      },
    })
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    repository.createRun(runCreation(root))
    const request = { resources: [{ key: 'workspace:report.md', mode: 'exclusive' as const }] }
    repository.acquireExecutionLocks('automation-run-1', 'desktop-host-1', request, 30_000)
    repository.acquireLease('automation-run-1', 'desktop-host-1', 30_000)
    repository.transitionRun('automation-run-1', 'running')
    const previousLease = repository.getRun('automation-run-1')!.lease
    const previousLocks = repository.listExecutionLocks()
    now += 1_000
    fail = true

    expect(() => repository.renewOwnedLeaseAndExecutionLocks('automation-run-1', 'desktop-host-1', 30_000, request))
      .toThrow('heartbeat intent was not durable')

    const restored = new AutomationRepository(repositoryRoot, { now: () => now })
    restored.initialize()
    expect(restored.getRun('automation-run-1')?.lease).toEqual(previousLease)
    expect(restored.listExecutionLocks()).toEqual(previousLocks)
  })

  it.each([
    'after-intent',
    'before-operation:0',
    'after-operation:0',
    'before-operation:1',
    'after-operation:1',
    'before-commit',
    'after-commit',
  ])('recovers both heartbeat lease and locks when renewal is interrupted at %s', stage => {
    const root = createRoot()
    let now = 1_788_192_000_000
    let failureStage: string | undefined
    const repositoryRoot = join(root, 'automations')
    const repository = new AutomationRepository(repositoryRoot, {
      now: () => now,
      faultInjector(currentStage) {
        if (currentStage === failureStage) throw new Error(`heartbeat interrupted at ${currentStage}`)
      },
    })
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    repository.createRun(runCreation(root))
    const request = {
      concurrencyGroup: { id: 'reports', maxParallel: 2 },
      resources: [{ key: 'workspace:report.md', mode: 'shared' as const }],
    }
    repository.acquireExecutionLocks('automation-run-1', 'desktop-host-1', request, 30_000)
    repository.acquireLease('automation-run-1', 'desktop-host-1', 30_000)
    repository.transitionRun('automation-run-1', 'running')
    now += 1_000
    failureStage = stage

    expect(() => repository.renewOwnedLeaseAndExecutionLocks('automation-run-1', 'desktop-host-1', 30_000, request))
      .toThrow(`heartbeat interrupted at ${stage}`)

    const restored = new AutomationRepository(repositoryRoot, { now: () => now })
    restored.initialize()
    expect(restored.warnings).toContainEqual(expect.stringContaining('Recovered automation transaction'))
    expect(restored.getRun('automation-run-1')?.lease).toMatchObject({ heartbeatAt: now, expiresAt: now + 30_000 })
    expect(restored.listExecutionLocks()).toEqual([
      expect.objectContaining({ kind: 'concurrency_group', key: 'reports', limit: 2, expiresAt: now + 30_000 }),
      expect.objectContaining({ kind: 'resource', key: 'workspace:report.md', mode: 'shared', expiresAt: now + 30_000 }),
    ])
  })

  it('rejects a stale heartbeat transaction instead of overwriting a competing lock-index commit', () => {
    const root = createRoot()
    const now = 1_788_192_000_000
    const repositoryRoot = join(root, 'automations')
    const setup = new AutomationRepository(repositoryRoot, { now: () => now })
    setup.initialize()
    setup.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    setup.createRun(runCreation(root, '1'))
    const secondCreation = runCreation(root, '2')
    secondCreation.event.deduplicationKey = 'automation-definition-1:1:1788192000001'
    secondCreation.run.occurrenceKey = secondCreation.event.deduplicationKey
    setup.createRun(secondCreation)
    const heartbeatRequest = { resources: [{ key: 'workspace:report.md', mode: 'exclusive' as const }] }
    setup.acquireExecutionLocks('automation-run-1', 'desktop-host-1', heartbeatRequest, 30_000)
    setup.acquireLease('automation-run-1', 'desktop-host-1', 30_000)
    setup.transitionRun('automation-run-1', 'running')
    const previousLease = setup.getRun('automation-run-1')!.lease
    const competing = new AutomationRepository(repositoryRoot, { now: () => now })
    competing.initialize()
    let injected = false
    const stale = new AutomationRepository(repositoryRoot, {
      now: () => now,
      faultInjector(stage) {
        if (stage !== 'before-lock' || injected) return
        injected = true
        competing.acquireExecutionLocks('automation-run-2', 'desktop-host-2', {
          resources: [{ key: 'workspace:other.md', mode: 'exclusive' }],
        }, 30_000)
      },
    })
    stale.initialize()

    expect(() => stale.renewOwnedLeaseAndExecutionLocks('automation-run-1', 'desktop-host-1', 30_000, heartbeatRequest))
      .toThrow('changed concurrently')

    const restored = new AutomationRepository(repositoryRoot, { now: () => now })
    restored.initialize()
    expect(restored.getRun('automation-run-1')?.lease).toEqual(previousLease)
    expect(restored.listExecutionLocks()).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: 'automation-run-1', ownerId: 'desktop-host-1', key: 'workspace:report.md' }),
      expect.objectContaining({ runId: 'automation-run-2', ownerId: 'desktop-host-2', key: 'workspace:other.md' }),
    ]))
    expect(restored.listExecutionLocks()).toHaveLength(2)
  })

  it('rejects stale sleep renewal when another repository commits a lock after its read', () => {
    const root = createRoot()
    const now = 1_788_192_000_000
    const repositoryRoot = join(root, 'automations')
    const setup = new AutomationRepository(repositoryRoot, { now: () => now })
    setup.initialize()
    const automationDefinition = definition(root)
    automationDefinition.reliability.resourceLocks = [{ key: 'workspace:report.md', mode: 'exclusive' }]
    setup.saveDefinition(automationDefinition, { source: 'user', changeSummary: 'Initial definition' })
    setup.createRun(runCreation(root, '1'))
    const secondCreation = runCreation(root, '2')
    secondCreation.event.deduplicationKey = 'automation-definition-1:1:1788192000001'
    secondCreation.run.occurrenceKey = secondCreation.event.deduplicationKey
    setup.createRun(secondCreation)
    setup.acquireExecutionLocks('automation-run-1', 'desktop-host-1', {
      resources: [{ key: 'workspace:report.md', mode: 'exclusive' }],
    }, 30_000)
    setup.acquireLease('automation-run-1', 'desktop-host-1', 30_000)
    setup.transitionRun('automation-run-1', 'running')
    const previousLease = setup.getRun('automation-run-1')!.lease
    const competing = new AutomationRepository(repositoryRoot, { now: () => now })
    competing.initialize()
    let injected = false
    const stale = new AutomationRepository(repositoryRoot, {
      now: () => now,
      faultInjector(stage) {
        if (stage !== 'before-lock' || injected) return
        injected = true
        competing.acquireExecutionLocks('automation-run-2', 'desktop-host-2', {
          resources: [{ key: 'workspace:other.md', mode: 'exclusive' }],
        }, 30_000)
      },
    })
    stale.initialize()

    expect(() => stale.renewOwnedLeasesAfterSleep('desktop-host-1', ['automation-run-1'], 30_000))
      .toThrow('changed concurrently')

    const restored = new AutomationRepository(repositoryRoot, { now: () => now })
    restored.initialize()
    expect(restored.getRun('automation-run-1')?.lease).toEqual(previousLease)
    expect(restored.listExecutionLocks()).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: 'automation-run-1', key: 'workspace:report.md' }),
      expect.objectContaining({ runId: 'automation-run-2', key: 'workspace:other.md' }),
    ]))
    expect(restored.listExecutionLocks()).toHaveLength(2)
  })

  it('rejects an equal-sized lock set whose resource identity was replaced', () => {
    const root = createRoot()
    let now = 1_788_192_000_000
    const repositoryRoot = join(root, 'automations')
    const repository = new AutomationRepository(repositoryRoot, { now: () => now })
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    repository.createRun(runCreation(root))
    const request = { resources: [{ key: 'workspace:report.md', mode: 'exclusive' as const }] }
    repository.acquireExecutionLocks('automation-run-1', 'desktop-host-1', request, 30_000)
    repository.acquireLease('automation-run-1', 'desktop-host-1', 30_000)
    repository.transitionRun('automation-run-1', 'running')
    const lockPath = join(repositoryRoot, 'indexes', 'execution-locks.json')
    const lockIndex = JSON.parse(readFileSync(lockPath, 'utf8')) as { locks: Array<{ key: string; mode: string }> }
    lockIndex.locks[0]!.key = 'workspace:forged.md'
    writeFileSync(lockPath, JSON.stringify(lockIndex))
    const originalLease = repository.getRun('automation-run-1')!.lease
    now += 1_000

    expect(() => repository.renewOwnedLeaseAndExecutionLocks('automation-run-1', 'desktop-host-1', 30_000, request))
      .toThrow('execution lock ownership was lost')
    expect(repository.getRun('automation-run-1')?.lease).toEqual(originalLease)
    expect(repository.listExecutionLocks()[0]?.key).toBe('workspace:forged.md')
  })

  it('fails sleep recovery closed when an equal-sized persisted lock set has the wrong identity', () => {
    const root = createRoot()
    let now = 1_788_192_000_000
    const repositoryRoot = join(root, 'automations')
    const repository = new AutomationRepository(repositoryRoot, { now: () => now })
    repository.initialize()
    const automationDefinition = definition(root)
    automationDefinition.reliability.resourceLocks = [{ key: 'workspace:report.md', mode: 'exclusive' }]
    repository.saveDefinition(automationDefinition, { source: 'user', changeSummary: 'Initial definition' })
    repository.createRun(runCreation(root))
    repository.acquireExecutionLocks('automation-run-1', 'desktop-host-1', {
      resources: [{ key: 'workspace:report.md', mode: 'exclusive' }],
    }, 3_000)
    repository.acquireLease('automation-run-1', 'desktop-host-1', 3_000)
    repository.transitionRun('automation-run-1', 'running')
    const lockPath = join(repositoryRoot, 'indexes', 'execution-locks.json')
    const lockIndex = JSON.parse(readFileSync(lockPath, 'utf8')) as { locks: Array<{ key: string; mode: string }> }
    lockIndex.locks[0]!.mode = 'shared'
    writeFileSync(lockPath, JSON.stringify(lockIndex))
    now += 60_000

    expect(repository.renewOwnedLeasesAfterSleep('desktop-host-1', ['automation-run-1'], 30_000)).toEqual({
      resumedRunIds: [],
      lostRunIds: ['automation-run-1'],
    })
    expect(repository.getRun('automation-run-1')?.lease).toMatchObject({ expiresAt: 1_788_192_003_000 })
  })

  it('does not reclaim an active lease owned by another host after sleep', () => {
    const root = createRoot()
    let now = 1_788_192_000_000
    const repository = new AutomationRepository(join(root, 'automations'), { now: () => now })
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    repository.createRun(runCreation(root))
    repository.acquireLease('automation-run-1', 'desktop-host-2', 30_000)
    repository.transitionRun('automation-run-1', 'running')
    now += 5_000

    expect(repository.renewOwnedLeasesAfterSleep('desktop-host-1', ['automation-run-1'], 30_000)).toEqual({
      resumedRunIds: [],
      lostRunIds: ['automation-run-1'],
    })
    expect(repository.getRun('automation-run-1')?.lease).toMatchObject({ ownerId: 'desktop-host-2' })
  })

  it('shares one persistent budget across parent and child work', () => {
    const root = createRoot()
    const repositoryRoot = join(root, 'automations')
    const creation = runCreation(root)
    creation.permissionSnapshot.maxToolCalls = 2
    creation.permissionSnapshot.maxInputTokens = 100
    creation.permissionSnapshot.maxOutputTokens = 50
    creation.contextSnapshot.agentPolicy = {
      strategyId: 'bounded-review',
      allowedAgentTypes: ['reviewer'],
      maxSubtasks: 1,
      maxParallel: 1,
    }
    const repository = new AutomationRepository(repositoryRoot)
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    repository.createRun(creation)

    repository.consumeRunBudget('automation-run-1', { toolCalls: 1, inputTokens: 40, outputTokens: 10 })
    const childUsage = repository.consumeRunBudget('automation-run-1', { toolCalls: 1, inputTokens: 50, outputTokens: 30, subtasks: 1 })
    expect(childUsage.budgetUsage).toMatchObject({ toolCalls: 2, inputTokens: 90, outputTokens: 40, subtasks: 1 })
    expect(() => repository.consumeRunBudget('automation-run-1', { toolCalls: 1 })).toThrow('total tool-call budget')
    expect(() => repository.consumeRunBudget('automation-run-1', { inputTokens: 11 })).toThrow('total input-token budget')
    expect(() => repository.consumeRunBudget('automation-run-1', { subtasks: 1 })).toThrow('total subtask budget')

    const restored = new AutomationRepository(repositoryRoot)
    restored.initialize()
    expect(restored.getRun('automation-run-1')?.budgetUsage).toMatchObject({ toolCalls: 2, inputTokens: 90, outputTokens: 40, subtasks: 1 })
  })

  it.runIf(process.platform !== 'win32')('recovers a lease and locks after the owning process is forcibly killed', async () => {
    const root = createRoot()
    const repositoryRoot = join(root, 'automations')
    const repository = new AutomationRepository(repositoryRoot)
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    repository.createRun(runCreation(root))
    const workerPath = fileURLToPath(new URL('./fixtures/automationLeaseWorker.ts', import.meta.url))
    const child = spawn(process.execPath, ['--import', 'tsx', workerPath, repositoryRoot, 'automation-run-1'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    await new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => rejectReady(new Error(`Lease worker did not become ready: ${stderr}`)), 10_000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        if (!String(chunk).includes('READY')) return
        clearTimeout(timeout)
        resolveReady()
      })
      child.once('exit', code => {
        clearTimeout(timeout)
        rejectReady(new Error(`Lease worker exited before ready with code ${code}: ${stderr}`))
      })
    })

    expect(child.kill('SIGKILL')).toBe(true)
    await once(child, 'exit')
    const restored = new AutomationRepository(repositoryRoot, { now: () => Date.now() + 60_000 })
    restored.initialize()

    expect(restored.recoverExpiredLeases()).toEqual([
      expect.objectContaining({
        id: 'automation-run-1',
        status: 'needs_review',
        error: expect.objectContaining({ code: 'automation_side_effect_uncertain', category: 'side_effect_unknown' }),
      }),
    ])
    expect(restored.listExecutionLocks()).toEqual([])
  })

  it('recovers an interrupted multi-file definition transaction', () => {
    const root = createRoot()
    let failed = false
    const repository = new AutomationRepository(join(root, 'automations'), {
      faultInjector(stage) {
        if (!failed && stage === 'after-operation:0') {
          failed = true
          throw new Error('simulated process interruption')
        }
      },
    })
    repository.initialize()
    expect(() => repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })).toThrow('simulated process interruption')

    const restored = new AutomationRepository(join(root, 'automations'))
    restored.initialize()
    expect(restored.warnings).toContainEqual(expect.stringContaining('Recovered automation transaction'))
    expect(restored.getDefinition('automation-definition-1')).toMatchObject({ revision: 1 })
    expect(restored.getRevision('automation-definition-1', 1)).toMatchObject({ source: 'user' })
  })

  it.each([
    'after-intent',
    'before-operation:0',
    'after-operation:0',
    'after-operation:1',
    'after-operation:2',
    'after-operation:3',
    'after-operation:4',
    'after-operation:5',
    'before-commit',
    'after-commit',
  ])('recovers run creation interrupted at %s', stage => {
    const root = createRoot()
    let failureStage: string | undefined
    const repository = new AutomationRepository(join(root, 'automations'), {
      faultInjector(currentStage) {
        if (currentStage === failureStage) throw new Error(`interrupted at ${currentStage}`)
      },
    })
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    failureStage = stage
    expect(() => repository.createRun(runCreation(root))).toThrow(`interrupted at ${stage}`)

    const restored = new AutomationRepository(join(root, 'automations'))
    restored.initialize()
    expect(restored.listRuns()).toEqual([expect.objectContaining({ id: 'automation-run-1', occurrenceKey: expect.any(String) })])
    expect(restored.getEvent('trigger-event-1')).toMatchObject({ status: 'routed' })
    expect(restored.getPermissionSnapshot('permission-snapshot-1')).toMatchObject({ definitionId: 'automation-definition-1' })
    expect(restored.getContextSnapshot('context-snapshot-1')).toMatchObject({ mode: 'isolated' })
    expect(restored.createRun(runCreation(root, '2'))).toMatchObject({ created: false, run: { id: 'automation-run-1' } })
  })

  it('does not create partial records when a transaction fails before its intent is durable', () => {
    const root = createRoot()
    let fail = false
    const repository = new AutomationRepository(join(root, 'automations'), {
      faultInjector(stage) {
        if (fail && stage === 'before-intent') throw new Error('intent was not durable')
      },
    })
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    fail = true
    expect(() => repository.createRun(runCreation(root))).toThrow('intent was not durable')

    const restored = new AutomationRepository(join(root, 'automations'))
    restored.initialize()
    expect(restored.listRuns()).toEqual([])
    expect(restored.getEvent('trigger-event-1')).toBeNull()
  })

  it('rebuilds corrupt indexes from immutable revision and run records', () => {
    const root = createRoot()
    const repositoryRoot = join(root, 'automations')
    const repository = new AutomationRepository(repositoryRoot)
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    repository.createRun(runCreation(root))
    writeFileSync(join(repositoryRoot, 'definitions.json'), '{broken')
    writeFileSync(join(repositoryRoot, 'indexes', 'runs.json'), '{broken')
    writeFileSync(join(repositoryRoot, 'indexes', 'dedup-ledger.json'), '{broken')

    const restored = new AutomationRepository(repositoryRoot)
    restored.initialize()
    expect(restored.getDefinition('automation-definition-1')).toMatchObject({ revision: 1 })
    expect(restored.listRuns()).toEqual([expect.objectContaining({ id: 'automation-run-1' })])
    expect(restored.createRun(runCreation(root, '2'))).toMatchObject({ created: false, run: { id: 'automation-run-1' } })
    expect(restored.warnings).toContain('Rebuilt the automation definition index from revision records.')
  })

  it('quarantines duplicate run facts while rebuilding indexes', () => {
    const root = createRoot()
    const repositoryRoot = join(root, 'automations')
    const repository = new AutomationRepository(repositoryRoot)
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    repository.createRun(runCreation(root, '1'))
    const duplicateRun = runCreation(root, '2').run
    writeFileSync(join(repositoryRoot, 'runs', `${duplicateRun.id}.json`), `${JSON.stringify(duplicateRun, null, 2)}\n`)

    const restored = new AutomationRepository(repositoryRoot)
    restored.initialize()

    expect(restored.listRuns()).toEqual([
      expect.objectContaining({ id: 'automation-run-1', status: 'invalid', error: expect.objectContaining({ code: 'automation_occurrence_collision' }) }),
      expect.objectContaining({ id: 'automation-run-2', status: 'invalid', error: expect.objectContaining({ code: 'automation_occurrence_collision' }) }),
    ])
    expect(restored.listActiveRuns()).toEqual([])
    expect(restored.createRun(runCreation(root, '3'))).toMatchObject({ created: false, run: { id: 'automation-run-1', status: 'invalid' } })
    expect(restored.warnings).toContainEqual(expect.stringContaining('Quarantined duplicate automation occurrence'))
  })

  it('recovers a stale repository lock before replaying work', () => {
    const root = createRoot()
    const repositoryRoot = join(root, 'automations')
    const first = new AutomationRepository(repositoryRoot)
    first.initialize()
    writeFileSync(join(repositoryRoot, '.repository.lock'), `${JSON.stringify({ pid: process.pid, acquiredAt: 1 })}\n`)

    const restored = new AutomationRepository(repositoryRoot)
    restored.initialize()
    expect(restored.warnings).toContain('Recovered a stale automation repository lock.')
    expect(() => restored.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })).not.toThrow()
  })

  it('leases queued runs and enforces legal state transitions', () => {
    const root = createRoot()
    let now = 1_788_192_000_000
    const repository = new AutomationRepository(join(root, 'automations'), { now: () => now })
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    repository.createRun(runCreation(root))

    const leased = repository.acquireLease('automation-run-1', 'desktop-host-1', 10_000)
    expect(leased).toMatchObject({ status: 'preparing', lease: { ownerId: 'desktop-host-1', expiresAt: now + 10_000 } })
    expect(repository.listActiveRuns()).toEqual([expect.objectContaining({ id: 'automation-run-1', status: 'preparing' })])
    now += 1_000
    expect(repository.renewLease('automation-run-1', 'desktop-host-1', 10_000).lease?.expiresAt).toBe(now + 10_000)
    expect(repository.transitionRun('automation-run-1', 'running')).toMatchObject({ status: 'running' })
    const completed = repository.transitionRun('automation-run-1', 'completed', {
      clearLease: true,
      result: { outcome: 'success', summary: 'Done', successCriteria: [], artifactIds: [], sideEffectSummary: [], durationMs: 1_000 },
    })
    expect(completed.status).toBe('completed')
    expect(completed.lease).toBeUndefined()
    expect(repository.listActiveRuns()).toEqual([])
    expect(() => repository.transitionRun('automation-run-1', 'running')).toThrow('Invalid automation run transition')
  })

  it('fails closed when an expired host lease has no durable checkpoint', () => {
    const root = createRoot()
    let now = 1_788_192_000_000
    const repositoryRoot = join(root, 'automations')
    const repository = new AutomationRepository(repositoryRoot, { now: () => now })
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    repository.createRun(runCreation(root))
    repository.acquireLease('automation-run-1', 'desktop-host-1', 3_000)
    repository.transitionRun('automation-run-1', 'running')
    now += 3_001

    const restored = new AutomationRepository(repositoryRoot, { now: () => now })
    restored.initialize()
    const recovered = restored.recoverExpiredLeases()
    expect(recovered).toEqual([
      expect.objectContaining({
        id: 'automation-run-1',
        status: 'needs_review',
        error: expect.objectContaining({
          code: 'automation_side_effect_uncertain',
          category: 'side_effect_unknown',
          retryable: false,
        }),
      }),
    ])
    expect(recovered[0]).not.toHaveProperty('lease')
  })

  it.each(['after-intent', 'after-operation:0', 'before-commit', 'after-commit'])(
    'atomically restores a checkpoint transaction interrupted at %s',
    stage => {
      const root = createRoot()
      let failureStage: string | undefined
      const repositoryRoot = join(root, 'automations')
      const repository = new AutomationRepository(repositoryRoot, {
        faultInjector(currentStage) {
          if (currentStage === failureStage) throw new Error(`interrupted at ${currentStage}`)
        },
      })
      repository.initialize()
      repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
      repository.createRun(runCreation(root))
      failureStage = stage
      expect(() => repository.saveCheckpoint(checkpoint(root))).toThrow(`interrupted at ${stage}`)

      const restored = new AutomationRepository(repositoryRoot)
      restored.initialize()
      expect(restored.getLatestCheckpoint('automation-run-1')).toMatchObject({
        id: 'checkpoint-1',
        inFlightToolEffect: { classification: 'read_only' },
      })
      expect(restored.getRun('automation-run-1')).toMatchObject({ checkpointId: 'checkpoint-1' })
    },
  )

  it('uses the durable run pointer when multiple checkpoints share a timestamp', () => {
    const root = createRoot()
    const repository = new AutomationRepository(join(root, 'automations'))
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    repository.createRun(runCreation(root))
    const beforeTool = checkpoint(root, 'idempotent_write', 'checkpoint-z')
    const afterTool: AutomationRunCheckpoint = {
      ...checkpoint(root, 'idempotent_write', 'checkpoint-a'),
      canonicalEventSequence: beforeTool.canonicalEventSequence + 1,
      completedToolCallIds: ['tool-call-1'],
      toolEffects: [{ ...beforeTool.inFlightToolEffect!, status: 'completed', completedAt: beforeTool.createdAt }],
      inFlightToolEffect: undefined,
      reason: 'after_tool',
      createdAt: beforeTool.createdAt,
    }

    repository.saveCheckpoint(beforeTool)
    repository.saveCheckpoint(afterTool)

    expect(repository.getRun('automation-run-1')).toMatchObject({ checkpointId: 'checkpoint-a' })
    expect(repository.getLatestCheckpoint('automation-run-1')).toMatchObject({
      id: 'checkpoint-a',
      reason: 'after_tool',
      completedToolCallIds: ['tool-call-1'],
    })
  })

  it('treats a checkpoint with corrupted run identity as missing during lease recovery', () => {
    const root = createRoot()
    let now = 1_788_192_000_000
    const repositoryRoot = join(root, 'automations')
    const repository = new AutomationRepository(repositoryRoot, { now: () => now })
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    repository.createRun(runCreation(root))
    repository.acquireLease('automation-run-1', 'desktop-host-1', 3_000)
    repository.transitionRun('automation-run-1', 'running')
    repository.saveCheckpoint(checkpoint(root, 'idempotent_write'))
    const checkpointPath = join(repositoryRoot, 'checkpoints', 'automation-run-1', 'checkpoint-1.json')
    const corrupted = JSON.parse(readFileSync(checkpointPath, 'utf8')) as AutomationRunCheckpoint
    corrupted.runId = 'automation-run-other'
    writeFileSync(checkpointPath, `${JSON.stringify(corrupted, null, 2)}\n`)
    now += 3_001

    const restored = new AutomationRepository(repositoryRoot, { now: () => now })
    restored.initialize()

    expect(restored.getLatestCheckpoint('automation-run-1')).toBeNull()
    expect(restored.recoverExpiredLeases()).toEqual([
      expect.objectContaining({
        id: 'automation-run-1',
        status: 'needs_review',
        error: expect.objectContaining({ code: 'automation_side_effect_uncertain', retryable: false }),
      }),
    ])
    expect(restored.warnings).toContain('Ignored corrupt automation checkpoint automation-run-1/checkpoint-1.')
  })

  it('replays a residual checkpoint intent before an idempotent same-process retry', () => {
    const root = createRoot()
    let failureStage: string | undefined
    const repository = new AutomationRepository(join(root, 'automations'), {
      faultInjector(stage) {
        if (stage === failureStage) throw new Error(`interrupted at ${stage}`)
      },
    })
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    repository.createRun(runCreation(root))

    failureStage = 'after-operation:0'
    expect(() => repository.saveCheckpoint(checkpoint(root, 'read_only', 'checkpoint-1')))
      .toThrow('interrupted at after-operation:0')
    failureStage = undefined
    expect(repository.saveCheckpoint(checkpoint(root, 'read_only', 'checkpoint-1')))
      .toMatchObject({ id: 'checkpoint-1' })
    expect(repository.getRun('automation-run-1')).toMatchObject({ checkpointId: 'checkpoint-1' })
    repository.saveCheckpoint(checkpoint(root, 'read_only', 'checkpoint-2'))
    expect(repository.getLatestCheckpoint('automation-run-1')).toMatchObject({ id: 'checkpoint-2' })
  })

  it('recovers an in-flight idempotent write as interrupted and safely retryable', () => {
    const root = createRoot()
    let now = 1_788_192_000_000
    const repositoryRoot = join(root, 'automations')
    const repository = new AutomationRepository(repositoryRoot, { now: () => now })
    repository.initialize()
    repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
    repository.createRun(runCreation(root))
    repository.acquireLease('automation-run-1', 'desktop-host-1', 3_000)
    repository.transitionRun('automation-run-1', 'running')
    repository.saveCheckpoint(checkpoint(root, 'idempotent_write'))
    now += 3_001

    const restored = new AutomationRepository(repositoryRoot, { now: () => now })
    restored.initialize()
    expect(restored.recoverExpiredLeases()).toEqual([
      expect.objectContaining({
        status: 'interrupted',
        error: expect.objectContaining({ retryable: true, category: 'host_interrupted' }),
      }),
    ])
  })

  it.each(['non_idempotent_write', 'unknown_external_effect'] as const)(
    'requires review after an uncertain %s tool effect',
    classification => {
      const root = createRoot()
      let now = 1_788_192_000_000
      const repositoryRoot = join(root, 'automations')
      const repository = new AutomationRepository(repositoryRoot, { now: () => now })
      repository.initialize()
      repository.saveDefinition(definition(root), { source: 'user', changeSummary: 'Initial definition' })
      repository.createRun(runCreation(root))
      repository.acquireLease('automation-run-1', 'desktop-host-1', 3_000)
      repository.transitionRun('automation-run-1', 'running')
      repository.saveCheckpoint(checkpoint(root, classification))
      now += 3_001

      const restored = new AutomationRepository(repositoryRoot, { now: () => now })
      restored.initialize()
      expect(restored.recoverExpiredLeases()).toEqual([
        expect.objectContaining({
          status: 'needs_review',
          error: expect.objectContaining({
            code: 'automation_side_effect_uncertain',
            category: 'side_effect_unknown',
            retryable: false,
          }),
        }),
      ])
    },
  )
})

describe('automation run state machine', () => {
  it('accepts resumable transitions and rejects terminal rewrites', () => {
    expect(canTransitionAutomationRun('running', 'waiting_for_approval')).toBe(true)
    expect(canTransitionAutomationRun('queued', 'needs_review')).toBe(true)
    expect(canTransitionAutomationRun('preparing', 'needs_review')).toBe(true)
    expect(canTransitionAutomationRun('interrupted', 'needs_review')).toBe(true)
    expect(canTransitionAutomationRun('completed', 'running')).toBe(false)
    expect(() => assertAutomationRunTransition('completed', 'running')).toThrow('completed -> running')
  })
})
