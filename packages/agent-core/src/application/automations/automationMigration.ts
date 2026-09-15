import { createHash, randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { ApprovalPolicy } from '../../shared/agentTypes'
import type { AutomationRecord, AutomationRunRecord, AutomationRunStatus as AutomationRunStatusV2 } from './automationService'
import { automationSpecDigest, AutomationRepository, type AutomationRunCreation } from './automationRepository'
import {
  AUTOMATION_SCHEMA_VERSION,
  type AutomationDefinition,
  type AutomationDeliveryEventType,
  type AutomationDeliveryPolicy,
  type AutomationPermissionSnapshot,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationTriggerEvent,
} from './automationTypes'

interface AutomationV2Store {
  schemaVersion: 2
  automations: AutomationRecord[]
}

export interface AutomationV2MigrationPlan {
  sourcePath: string
  backupPath: string
  markerPath: string
  definitionCount: number
  runCount: number
  activeRunCount: number
  warnings: string[]
}

export interface AutomationV2MigrationReport extends AutomationV2MigrationPlan {
  alreadyMigrated: boolean
  migratedDefinitionIds: string[]
  migratedRunIds: string[]
  completedAt: number
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`
}

function migrationDeliveryPolicy(policy?: Partial<AutomationDeliveryPolicy>): AutomationDeliveryPolicy {
  const expand = (events: AutomationDeliveryEventType[]) => policy?.eventPolicyVersion === 2 || !events.includes('failed')
    ? events
    : [...new Set([...events, 'timeout' as const, 'budget' as const, 'recovered' as const])]
  return {
    eventPolicyVersion: 2,
    desktop: expand(policy?.desktop ?? ['failed', 'approval', 'invalid']),
    remoteMobile: expand(policy?.remoteMobile ?? ['approval']),
    digest: policy?.digest ?? 'immediate',
    failureCooldownMinutes: policy?.failureCooldownMinutes,
    providerRefs: policy?.providerRefs ?? [],
    providerEvents: expand(policy?.providerEvents ?? ['success', 'no_change', 'partial', 'failed', 'invalid']),
    providerVersions: policy?.providerVersions ?? {},
  }
}

function validV2Store(value: unknown): value is AutomationV2Store {
  if (!value || typeof value !== 'object') return false
  const store = value as Partial<AutomationV2Store>
  if (store.schemaVersion !== 2 || !Array.isArray(store.automations)) return false
  return store.automations.every(automation => Boolean(
    automation
    && typeof automation === 'object'
    && typeof automation.id === 'string'
    && typeof automation.name === 'string'
    && typeof automation.prompt === 'string'
    && typeof automation.workspacePath === 'string'
    && automation.schedule
    && Array.isArray(automation.history),
  ))
}

function readV2Store(path: string): AutomationV2Store {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`Unable to read the v2 automation store: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (!validV2Store(value)) throw new Error('Unable to migrate the v2 automation store: unsupported or invalid schema')
  return value
}

function backupPathFor(sourcePath: string): string {
  return sourcePath.endsWith('.json') ? `${sourcePath.slice(0, -5)}.v2.backup.json` : `${sourcePath}.v2.backup.json`
}

function markerPathFor(repository: AutomationRepository): string {
  return join(repository.rootPath, 'migrations', 'v2.json')
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  const descriptor = openSync(temporaryPath, 'wx', 0o600)
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  renameSync(temporaryPath, path)
}

export function planAutomationV2Migration(repository: AutomationRepository, sourcePath: string): AutomationV2MigrationPlan {
  const normalizedSource = resolve(sourcePath)
  const store = readV2Store(normalizedSource)
  const activeRuns = store.automations.flatMap(automation => automation.history.filter(run => (
    run.id === automation.activeRunId || ['queued', 'running', 'waiting_for_approval', 'waiting_for_workspace'].includes(run.status)
  )))
  const warnings = activeRuns.length > 0
    ? [`${activeRuns.length} active v2 automation run(s) will be migrated as interrupted or queued compatibility records.`]
    : []
  return {
    sourcePath: normalizedSource,
    backupPath: backupPathFor(normalizedSource),
    markerPath: markerPathFor(repository),
    definitionCount: store.automations.length,
    runCount: store.automations.reduce((total, automation) => total + automation.history.length, 0),
    activeRunCount: activeRuns.length,
    warnings,
  }
}

export function migrateAutomationV2Store(repository: AutomationRepository, sourcePath: string, now = Date.now()): AutomationV2MigrationReport {
  const plan = planAutomationV2Migration(repository, sourcePath)
  if (existsSync(plan.markerPath)) {
    const previous = JSON.parse(readFileSync(plan.markerPath, 'utf8')) as AutomationV2MigrationReport
    return { ...previous, alreadyMigrated: true }
  }
  const store = readV2Store(plan.sourcePath)
  if (!existsSync(plan.backupPath)) copyFileSync(plan.sourcePath, plan.backupPath)
  const migratedDefinitionIds: string[] = []
  const migratedRunIds: string[] = []

  for (const legacy of store.automations) {
    const definition = automationDefinitionFromV2Record(legacy)
    const existing = repository.getDefinition(definition.id)
    if (!existing) {
      repository.saveDefinition(definition, {
        source: 'migration',
        changeSummary: 'Migrated from the v2 automation store.',
        validationIssues: legacy.validationIssues,
      })
    } else if (automationSpecDigest(existing) !== automationSpecDigest(definition)) {
      throw new Error(`A different v3 automation definition already exists: ${definition.id}`)
    }
    migratedDefinitionIds.push(definition.id)
    for (const legacyRun of [...legacy.history].reverse()) {
      const existingNativeRun = repository.getRun(legacyRun.id)
      if (existingNativeRun) {
        if (existingNativeRun.definitionId !== legacy.id) {
          throw new Error(`A v3 automation run with the legacy id belongs to a different definition: ${legacyRun.id}`)
        }
        continue
      }
      const creation = migrateRun(legacy, legacyRun)
      const result = repository.importHistoricalRun(creation)
      if (result.created) migratedRunIds.push(result.run.id)
    }
  }

  const report: AutomationV2MigrationReport = {
    ...plan,
    alreadyMigrated: false,
    migratedDefinitionIds,
    migratedRunIds,
    completedAt: now,
  }
  atomicWriteJson(plan.markerPath, report)
  return report
}

export function automationDefinitionFromV2Record(legacy: AutomationRecord, revision = 1): AutomationDefinition {
  const approvalPolicy = normalizeApprovalPolicy(legacy.approvalPolicy)
  const capabilityPolicy = legacy.capabilityPolicy
  const capabilityApprovalPolicy = normalizeApprovalPolicy(capabilityPolicy?.approvalPolicy ?? approvalPolicy)
  return {
    id: legacy.id,
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    revision,
    status: legacy.lifecycleStatus ?? (legacy.enabled ? 'active' : 'paused'),
    name: legacy.name,
    description: legacy.description,
    workspaceRef: { path: resolve(legacy.workspacePath) },
    objective: {
      originalPrompt: legacy.objective?.originalPrompt ?? legacy.prompt,
      goal: legacy.objective?.goal ?? legacy.prompt,
      successCriteria: legacy.objective?.successCriteria ?? [],
      deliverables: legacy.objective?.deliverables ?? [],
      constraints: legacy.objective?.constraints ?? [],
      noChangeBehavior: legacy.objective?.noChangeBehavior,
      failureBehavior: legacy.objective?.failureBehavior,
    },
    triggers: legacy.triggers?.length
      ? JSON.parse(JSON.stringify(legacy.triggers)) as AutomationDefinition['triggers']
      : [{ id: stableId('trigger', `${legacy.id}:schedule`), kind: 'schedule', schedule: legacy.schedule, timezone: legacy.timezone }],
    context: {
      ...legacy.contextPolicy,
      mode: legacy.contextPolicy?.mode ?? legacy.mode ?? 'continuation',
      continuationConversationId: (legacy.contextPolicy?.mode ?? legacy.mode ?? 'continuation') === 'continuation'
        ? legacy.contextPolicy?.continuationConversationId ?? legacy.conversationId
        : undefined,
      includeAutomationMemory: legacy.contextPolicy?.includeAutomationMemory ?? false,
      includePreviousRunSummary: legacy.contextPolicy?.includePreviousRunSummary ?? false,
      fileRefs: legacy.contextPolicy?.fileRefs ?? [],
      skillIds: legacy.contextPolicy?.skillIds ?? [],
    },
    capabilities: {
      approvalPolicy: capabilityApprovalPolicy,
      allowedTools: capabilityPolicy?.allowedTools ?? [],
      deniedTools: capabilityPolicy?.deniedTools ?? [],
      paths: capabilityPolicy?.paths ?? [{ path: resolve(legacy.workspacePath), access: 'write' }],
      networkDomains: capabilityPolicy?.networkDomains ?? [],
      secretRefs: capabilityPolicy?.secretRefs ?? [],
      mcpServerIds: capabilityPolicy?.mcpServerIds ?? [],
      pluginIds: capabilityPolicy?.pluginIds ?? [],
      allowComputerUse: capabilityPolicy?.allowComputerUse ?? capabilityApprovalPolicy === 'full',
      allowBackgroundComputerUse: capabilityPolicy?.allowBackgroundComputerUse ?? false,
    },
    reliability: {
      ...legacy.reliabilityPolicy,
      misfirePolicy: legacy.reliabilityPolicy?.misfirePolicy ?? legacy.misfirePolicy,
      overlapPolicy: legacy.reliabilityPolicy?.overlapPolicy ?? legacy.overlapPolicy,
      maxParallel: legacy.reliabilityPolicy?.maxParallel ?? 1,
      maxQueuedRuns: legacy.reliabilityPolicy?.maxQueuedRuns ?? 1,
      maxRuntimeMinutes: legacy.reliabilityPolicy?.maxRuntimeMinutes ?? legacy.maxRuntimeMinutes,
      maxToolCalls: legacy.reliabilityPolicy?.maxToolCalls ?? 100,
      retry: {
        maxRetries: legacy.reliabilityPolicy?.retry.maxRetries ?? legacy.retryPolicy.maxRetries,
        backoffMinutes: legacy.reliabilityPolicy?.retry.backoffMinutes ?? legacy.retryPolicy.backoffMinutes,
        maxBackoffMinutes: legacy.reliabilityPolicy?.retry.maxBackoffMinutes ?? 1_440,
        jitter: legacy.reliabilityPolicy?.retry.jitter ?? 0.1,
      },
      concurrencyGroup: legacy.reliabilityPolicy?.concurrencyGroup,
      resourceLocks: legacy.reliabilityPolicy?.resourceLocks ?? [],
    },
    routing: legacy.routingPolicy ?? { rules: [], defaultAction: 'run' },
    agents: legacy.agentPolicy ?? { enabled: false, strategies: [] },
    delivery: migrationDeliveryPolicy(legacy.deliveryPolicy),
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
    publishedAt: legacy.createdAt,
  }
}

function migrateRun(legacy: AutomationRecord, legacyRun: AutomationRunRecord): AutomationRunCreation {
  const runId = stableId('automation-run-migrated', `${legacy.id}:${legacyRun.id}`)
  const eventId = stableId('trigger-event-migrated', `${legacy.id}:${legacyRun.id}`)
  const permissionSnapshotId = stableId('permission-migrated', `${legacy.id}:${legacyRun.id}`)
  const contextSnapshotId = stableId('context-migrated', `${legacy.id}:${legacyRun.id}`)
  const occurrenceKey = `migration:${legacy.id}:${legacyRun.id}`
  const status = migrateRunStatus(legacyRun.status)
  const mode = legacyRun.contextSnapshot?.mode ?? legacy.mode ?? 'continuation'
  const approvalPolicy = normalizeApprovalPolicy(
    legacyRun.permissionSnapshot?.approvalPolicy
      ?? legacy.capabilityPolicy?.approvalPolicy
      ?? legacy.approvalPolicy,
  )
  const conversationId = legacyRun.contextSnapshot?.conversationId
    ?? legacyRun.conversationId
    ?? (mode === 'continuation' ? legacy.conversationId : undefined)
  const event: AutomationTriggerEvent = {
    id: eventId,
    source: migrateTrigger(legacyRun.trigger),
    sourceInstanceId: legacyRun.trigger,
    deduplicationKey: occurrenceKey,
    trust: legacyRun.trigger === 'manual' ? 'local_user' : 'system',
    occurredAt: legacyRun.scheduledFor ?? legacyRun.startedAt,
    receivedAt: legacyRun.startedAt,
    definitionId: legacy.id,
    definitionRevision: 1,
    status: 'routed',
  }
  const permissionSnapshot: AutomationPermissionSnapshot = {
    ...legacyRun.permissionSnapshot,
    id: permissionSnapshotId,
    definitionId: legacy.id,
    definitionRevision: 1,
    approvalPolicy,
    allowedTools: legacyRun.permissionSnapshot?.allowedTools ?? [],
    deniedTools: legacyRun.permissionSnapshot?.deniedTools ?? [],
    paths: legacyRun.permissionSnapshot?.paths ?? [{ path: resolve(legacy.workspacePath), access: 'write' }],
    networkDomains: legacyRun.permissionSnapshot?.networkDomains ?? [],
    secretRefs: legacyRun.permissionSnapshot?.secretRefs ?? [],
    mcpServerIds: legacyRun.permissionSnapshot?.mcpServerIds ?? [],
    pluginIds: legacyRun.permissionSnapshot?.pluginIds ?? [],
    allowComputerUse: legacyRun.permissionSnapshot?.allowComputerUse ?? approvalPolicy === 'full',
    allowBackgroundComputerUse: legacyRun.permissionSnapshot?.allowBackgroundComputerUse ?? false,
    maxRuntimeMinutes: legacyRun.permissionSnapshot?.maxRuntimeMinutes ?? legacy.maxRuntimeMinutes,
    maxToolCalls: legacyRun.permissionSnapshot?.maxToolCalls ?? 100,
    riskSummary: legacyRun.permissionSnapshot?.riskSummary
      ?? ['Migrated from the broad v2 approval policy; review before changing this definition.'],
    createdAt: legacyRun.permissionSnapshot?.createdAt ?? legacyRun.startedAt,
  }
  const result = legacyRun.result ?? (status === 'completed'
    ? {
        outcome: 'success' as const,
        summary: legacyRun.resultSummary ?? 'Migrated v2 run completed without a saved summary.',
        successCriteria: [],
        artifactIds: [],
        sideEffectSummary: [],
        durationMs: legacyRun.durationMs ?? Math.max(0, (legacyRun.completedAt ?? legacyRun.updatedAt) - legacyRun.startedAt),
      }
    : undefined)
  const run: AutomationRun = {
    id: runId,
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    definitionId: legacy.id,
    definitionRevision: 1,
    triggerEventId: eventId,
    occurrenceKey,
    mode,
    workspaceRef: { path: resolve(legacy.workspacePath) },
    conversationId,
    status,
    attempt: legacyRun.attempt,
    permissionSnapshotId,
    contextSnapshotId,
    timestamps: {
      createdAt: legacyRun.startedAt,
      queuedAt: legacyRun.startedAt,
      startedAt: legacyRun.startedAt,
      updatedAt: legacyRun.updatedAt,
      completedAt: legacyRun.completedAt,
      retryAt: legacyRun.retryAt,
    },
    result,
    error: migrateRunError(legacyRun, status),
    migration: { schemaVersion: 2, legacyRunId: legacyRun.id, legacyInputId: legacyRun.inputId },
  }
  return {
    event,
    run,
    permissionSnapshot,
    contextSnapshot: {
      ...legacyRun.contextSnapshot,
      id: contextSnapshotId,
      definitionId: legacy.id,
      definitionRevision: 1,
      mode,
      conversationId: run.conversationId,
      fileRefs: legacyRun.contextSnapshot?.fileRefs ?? [],
      skillIds: legacyRun.contextSnapshot?.skillIds ?? [],
      createdAt: legacyRun.contextSnapshot?.createdAt ?? legacyRun.startedAt,
    },
  }
}

function normalizeApprovalPolicy(value: ApprovalPolicy): ApprovalPolicy {
  return value === 'agent' || value === 'full' ? value : 'ask'
}

function migrateTrigger(trigger: AutomationRunRecord['trigger']): AutomationTriggerEvent['source'] {
  if (trigger === 'manual') return 'manual'
  if (trigger === 'recovery') return 'recovery'
  return 'schedule'
}

function migrateRunStatus(status: AutomationRunStatusV2): AutomationRunStatus {
  if (status === 'running') return 'interrupted'
  if (status === 'waiting_for_workspace') return 'queued'
  if (status === 'missed') return 'expired'
  return status
}

function migrateRunError(legacyRun: AutomationRunRecord, status: AutomationRunStatus): AutomationRun['error'] {
  if (!legacyRun.error && !['interrupted', 'queued'].includes(status)) return undefined
  if (legacyRun.status === 'waiting_for_workspace') {
    return {
      code: 'migrated_waiting_for_workspace',
      category: 'configuration',
      message: legacyRun.error ?? 'The v2 run was waiting for its workspace when migrated.',
      retryable: true,
      userAction: 'Open or repair the workspace before retrying.',
    }
  }
  if (status === 'interrupted') {
    return {
      code: 'migrated_active_run_interrupted',
      category: 'host_interrupted',
      message: legacyRun.error ?? 'The v2 run was active when migrated and cannot be assumed complete.',
      retryable: false,
      userAction: 'Review the run before retrying.',
    }
  }
  if (legacyRun.error) {
    return {
      code: 'migrated_v2_error',
      category: 'transient',
      message: legacyRun.error,
      retryable: status === 'failed' || status === 'retry_scheduled',
    }
  }
  return undefined
}
