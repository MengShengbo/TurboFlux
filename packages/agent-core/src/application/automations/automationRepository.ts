import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'

function syncFile(handle: number): void {
  try { fsyncSync(handle) } catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
  }
}
import { dirname, join, relative, resolve, sep } from 'node:path'
import { assertAutomationRunTransition } from './automationStateMachine'
import {
  AUTOMATION_SCHEMA_VERSION,
  type AutomationContextSnapshot,
  type AutomationDefinition,
  type AutomationDefinitionRevision,
  type AutomationExecutionLock,
  type AutomationMemoryEntry,
  type AutomationPermissionSnapshot,
  type AutomationRun,
  type AutomationRunCheckpoint,
  type AutomationRunStatus,
  type AutomationTriggerEvent,
  type AutomationTriggerPayload,
} from './automationTypes'
import { automationToolEffectNeedsReview } from './automationSideEffects'

interface AutomationDefinitionIndex {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION
  definitions: AutomationDefinition[]
}

interface AutomationDedupIndex {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION
  occurrences: Record<string, string>
}

interface AutomationRunIndex {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION
  runIds: string[]
  definitionRunIds?: Record<string, string[]>
  activeRunIds?: string[]
}

export interface AutomationMemoryDocument {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION
  definitionId: string
  revision: number
  entries: AutomationMemoryEntry[]
}

interface AutomationExecutionLockIndex {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION
  locks: AutomationExecutionLock[]
}

export interface AutomationExecutionLockRequest {
  concurrencyGroup?: { id: string; maxParallel: number }
  resources?: Array<{ key: string; mode: 'shared' | 'exclusive' }>
}

interface NormalizedAutomationExecutionLockRequest {
  concurrencyGroup?: { id: string; maxParallel: number }
  resources: Array<{ key: string; mode: 'shared' | 'exclusive' }>
}

export interface AutomationLeaseResumeResult {
  resumedRunIds: string[]
  lostRunIds: string[]
}

export interface AutomationRetentionPolicy {
  runMetadataDays: number
  successDetailsDays: number
  triggerPayloadDays: number
  conversationDays: number
  screenshotDays: number
  artifactDays: number
  batchSize: number
}

export interface AutomationRetentionPlan {
  payloadIds: string[]
  successDetailRunIds: string[]
  runIds: string[]
  protectedRunIds: string[]
}

export interface AutomationRetentionResult {
  deletedPayloads: number
  prunedSuccessDetails: number
  deletedRuns: number
  protectedRuns: number
  canceled: boolean
  remaining: number
}

export interface AutomationDefinitionDataDeletionResult {
  deletedRuns: number
  deletedMemory: boolean
}

export const DEFAULT_AUTOMATION_RETENTION_POLICY: AutomationRetentionPolicy = {
  runMetadataDays: 180,
  successDetailsDays: 30,
  triggerPayloadDays: 7,
  conversationDays: 90,
  screenshotDays: 14,
  artifactDays: 90,
  batchSize: 100,
}

interface AutomationRepositoryIntentOperation {
  kind: 'set' | 'delete'
  path: string
  value?: unknown
  expectedVersion?: string | null
}

interface AutomationRepositoryIntent {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION
  id: string
  phase: 'pending' | 'committed'
  createdAt: number
  operations: AutomationRepositoryIntentOperation[]
}

export interface AutomationRepositoryOptions {
  now?: () => number
  faultInjector?: (stage: string) => void
}

export interface AutomationDefinitionRevisionInput {
  source: AutomationDefinitionRevision['source']
  changeSummary: string
  parentRevision?: number
  validationIssues?: AutomationDefinitionRevision['validationIssues']
}

export interface AutomationRunCreation {
  event: AutomationTriggerEvent
  run: AutomationRun
  permissionSnapshot: AutomationPermissionSnapshot
  contextSnapshot: AutomationContextSnapshot
  payload?: AutomationTriggerPayload
}

export interface AutomationRunCreationResult {
  created: boolean
  run: AutomationRun
}

export interface AutomationRunTransitionPatch {
  error?: AutomationRun['error']
  result?: AutomationRun['result']
  checkpointId?: string
  conversationId?: string
  retryAt?: number
  clearLease?: boolean
}

const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function validIdentifier(value: string, label: string): string {
  if (!safeIdentifierPattern.test(value)) throw new Error(`Invalid ${label}: ${value}`)
  return value
}

function normalizedExecutionLockRequest(request: AutomationExecutionLockRequest): NormalizedAutomationExecutionLockRequest {
  const groupId = request.concurrencyGroup?.id.trim().slice(0, 180)
  return {
    concurrencyGroup: groupId ? {
      id: groupId,
      maxParallel: Math.max(1, Math.min(32, Math.floor(request.concurrencyGroup?.maxParallel ?? 1))),
    } : undefined,
    resources: (request.resources ?? []).map(resource => ({
      key: resource.key.trim().slice(0, 240),
      mode: resource.mode === 'shared' ? 'shared' as const : 'exclusive' as const,
    })).filter(resource => Boolean(resource.key)),
  }
}

function executionLockIdentity(lock: Pick<AutomationExecutionLock, 'kind' | 'key' | 'mode' | 'limit'>): string {
  return `${lock.kind}\0${lock.key}\0${lock.mode}\0${lock.limit ?? ''}`
}

function expectedExecutionLockIdentities(request: AutomationExecutionLockRequest): string[] {
  const normalized = normalizedExecutionLockRequest(request)
  const identities = normalized.resources.map(resource => executionLockIdentity({
    kind: 'resource',
    key: resource.key,
    mode: resource.mode,
  }))
  if (normalized.concurrencyGroup) {
    identities.push(executionLockIdentity({
      kind: 'concurrency_group',
      key: normalized.concurrencyGroup.id,
      mode: 'slot',
      limit: normalized.concurrencyGroup.maxParallel,
    }))
  }
  return identities.sort()
}

function executionLockSetMatches(locks: readonly AutomationExecutionLock[], request: AutomationExecutionLockRequest): boolean {
  const expected = expectedExecutionLockIdentities(request)
  const actual = locks.map(executionLockIdentity).sort()
  return actual.length === expected.length && actual.every((identity, index) => identity === expected[index])
}

function executionLockMetadataMatches(run: AutomationRun, request: AutomationExecutionLockRequest): boolean {
  const normalized = normalizedExecutionLockRequest(request)
  const expectedResourceKeys = normalized.resources.map(resource => resource.key).sort()
  const recordedResourceKeys = [...(run.resourceLockKeys ?? [])].sort()
  return run.concurrencyGroupId === normalized.concurrencyGroup?.id
    && recordedResourceKeys.length === expectedResourceKeys.length
    && recordedResourceKeys.every((key, index) => key === expectedResourceKeys[index])
}

function definitionExecutionLockRequest(definition: AutomationDefinition): AutomationExecutionLockRequest {
  return {
    concurrencyGroup: definition.reliability.concurrencyGroup,
    resources: definition.reliability.resourceLocks,
  }
}

function normalizedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(normalizedJson).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${normalizedJson(record[key])}`).join(',')}}`
}

class AutomationRepositoryConflictError extends Error {
  constructor(path: string) {
    super(`Automation repository data changed concurrently: ${path}`)
    this.name = 'AutomationRepositoryConflictError'
  }
}

export function automationSpecDigest(definition: AutomationDefinition): string {
  const {
    revision: _revision,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    publishedAt: _publishedAt,
    ...specification
  } = definition
  return createHash('sha256').update(normalizedJson(specification)).digest('hex')
}

function isDefinitionIndex(value: unknown): value is AutomationDefinitionIndex {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AutomationDefinitionIndex>
  return candidate.schemaVersion === AUTOMATION_SCHEMA_VERSION && Array.isArray(candidate.definitions)
}

function isDedupIndex(value: unknown): value is AutomationDedupIndex {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AutomationDedupIndex>
  return candidate.schemaVersion === AUTOMATION_SCHEMA_VERSION && Boolean(candidate.occurrences) && typeof candidate.occurrences === 'object'
}

function isRunIndex(value: unknown): value is AutomationRunIndex {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AutomationRunIndex>
  return candidate.schemaVersion === AUTOMATION_SCHEMA_VERSION && Array.isArray(candidate.runIds)
}

function isExecutionLockIndex(value: unknown): value is AutomationExecutionLockIndex {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AutomationExecutionLockIndex>
  return candidate.schemaVersion === AUTOMATION_SCHEMA_VERSION && Array.isArray(candidate.locks)
}

function isAutomationRunCheckpoint(value: unknown): value is AutomationRunCheckpoint {
  if (!value || typeof value !== 'object') return false
  const checkpoint = value as Partial<AutomationRunCheckpoint>
  return typeof checkpoint.id === 'string'
    && typeof checkpoint.runId === 'string'
    && typeof checkpoint.definitionId === 'string'
    && Number.isInteger(checkpoint.definitionRevision)
    && typeof checkpoint.canonicalEventSequence === 'number'
    && Array.isArray(checkpoint.completedToolCallIds)
    && Array.isArray(checkpoint.nonReplayableToolCallIds)
    && Array.isArray(checkpoint.toolEffects)
    && Array.isArray(checkpoint.artifactIds)
    && typeof checkpoint.workspaceFingerprint === 'string'
    && typeof checkpoint.permissionDigest === 'string'
    && typeof checkpoint.contextSnapshotId === 'string'
    && typeof checkpoint.resumable === 'boolean'
    && typeof checkpoint.reason === 'string'
    && typeof checkpoint.createdAt === 'number'
}

function isRetentionPolicyFile(value: unknown): value is { schemaVersion: 1; policy: Partial<AutomationRetentionPolicy> } {
  return Boolean(value && typeof value === 'object'
    && (value as { schemaVersion?: unknown }).schemaVersion === 1
    && (value as { policy?: unknown }).policy
    && typeof (value as { policy?: unknown }).policy === 'object')
}

function readJson<T>(path: string, validate: (value: unknown) => value is T): T | null {
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return validate(value) ? value : null
  } catch {
    return null
  }
}

function readUnknownJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

export class AutomationRepository {
  readonly rootPath: string
  readonly warnings: string[] = []

  private readonly now: () => number
  private readonly faultInjector?: (stage: string) => void
  private initialized = false

  constructor(rootPath: string, options: AutomationRepositoryOptions = {}) {
    this.rootPath = resolve(rootPath)
    this.now = options.now ?? Date.now
    this.faultInjector = options.faultInjector
  }

  initialize(): void {
    this.ensureDirectories()
    this.recoverStaleLock()
    this.recoverIntents()
    this.rebuildIndexes()
    this.initialized = true
  }

  listDefinitions(): AutomationDefinition[] {
    this.requireInitialized()
    return this.loadDefinitionIndex().definitions.map(clone)
  }

  getDefinition(id: string): AutomationDefinition | null {
    validIdentifier(id, 'automation definition ID')
    return this.listDefinitions().find(definition => definition.id === id) ?? null
  }

  getRevision(definitionId: string, revision: number): AutomationDefinitionRevision | null {
    this.requireInitialized()
    const path = this.revisionPath(definitionId, revision)
    if (!existsSync(path)) return null
    return clone(readUnknownJson(path) as AutomationDefinitionRevision)
  }

  saveDefinition(definition: AutomationDefinition, input: AutomationDefinitionRevisionInput): AutomationDefinitionRevision {
    this.requireInitialized()
    this.validateDefinition(definition)
    const index = this.loadDefinitionIndex()
    const existingIndex = index.definitions.findIndex(item => item.id === definition.id)
    const existing = existingIndex >= 0 ? index.definitions[existingIndex] : undefined
    if (!existing && definition.revision !== 1) throw new Error('The first automation definition revision must be 1')
    if (existing && definition.revision !== existing.revision + 1) {
      throw new Error(`Automation definition revision conflict: expected ${existing.revision + 1}, received ${definition.revision}`)
    }
    if (existsSync(this.revisionPath(definition.id, definition.revision))) {
      throw new Error(`Automation definition revision already exists: ${definition.id}@${definition.revision}`)
    }
    const revision: AutomationDefinitionRevision = {
      definitionId: definition.id,
      revision: definition.revision,
      specDigest: automationSpecDigest(definition),
      source: input.source,
      changeSummary: input.changeSummary.trim().slice(0, 1_000),
      parentRevision: input.parentRevision,
      validationIssues: clone(input.validationIssues ?? []),
      definition: clone(definition),
      createdAt: this.now(),
    }
    if (existingIndex >= 0) index.definitions[existingIndex] = clone(definition)
    else index.definitions.push(clone(definition))
    index.definitions.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    this.executeTransaction([
      this.setOperation(this.relativePath(this.definitionsPath), index),
      this.setOperation(this.relativePath(this.revisionPath(definition.id, definition.revision)), revision),
    ])
    return clone(revision)
  }

  createRun(input: AutomationRunCreation): AutomationRunCreationResult {
    return this.createRunRecord(input, false)
  }

  importHistoricalRun(input: AutomationRunCreation): AutomationRunCreationResult {
    return this.createRunRecord(input, true)
  }

  private createRunRecord(input: AutomationRunCreation, historical: boolean): AutomationRunCreationResult {
    this.requireInitialized()
    this.validateRunCreation(input, historical)
    const dedup = this.loadDedupIndex()
    const existingRunId = dedup.occurrences[input.run.occurrenceKey]
    if (existingRunId) {
      return { created: false, run: this.requireMatchingOccurrenceWinner(input, existingRunId) }
    }
    if (existsSync(this.runPath(input.run.id))) throw new Error(`Automation run already exists: ${input.run.id}`)
    if (existsSync(this.eventPath(input.event.id))) throw new Error(`Automation trigger event already exists: ${input.event.id}`)
    const runIndex = this.loadRunIndex()
    runIndex.runIds.unshift(input.run.id)
    runIndex.definitionRunIds ??= {}
    ;(runIndex.definitionRunIds[input.run.definitionId] ??= []).unshift(input.run.id)
    runIndex.activeRunIds ??= []
    dedup.occurrences[input.run.occurrenceKey] = input.run.id
    const operations = [
      this.setOperation(this.relativePath(this.eventPath(input.event.id)), input.event),
      this.setOperation(this.relativePath(this.permissionPath(input.permissionSnapshot.id)), input.permissionSnapshot),
      this.setOperation(this.relativePath(this.contextPath(input.contextSnapshot.id)), input.contextSnapshot),
      this.setOperation(this.relativePath(this.runPath(input.run.id)), input.run),
      this.setOperation(this.relativePath(this.runIndexPath), runIndex),
      this.setOperation(this.relativePath(this.dedupIndexPath), dedup),
    ]
    if (input.payload) operations.unshift(this.setOperation(this.relativePath(this.payloadPath(input.payload.id)), input.payload))
    try {
      this.executeTransaction(operations)
    } catch (error) {
      if (error instanceof AutomationRepositoryConflictError) {
        const concurrentRunId = this.loadDedupIndex().occurrences[input.run.occurrenceKey]
        const concurrentRun = concurrentRunId ? this.requireMatchingOccurrenceWinner(input, concurrentRunId) : null
        if (concurrentRun) return { created: false, run: concurrentRun }
      }
      throw error
    }
    return { created: true, run: clone(input.run) }
  }

  getRun(id: string): AutomationRun | null {
    this.requireInitialized()
    const path = this.runPath(id)
    if (!existsSync(path)) return null
    return clone(readUnknownJson(path) as AutomationRun)
  }

  getRunByOccurrenceKey(occurrenceKey: string): AutomationRun | null {
    this.requireInitialized()
    const runId = this.loadDedupIndex().occurrences[occurrenceKey]
    return runId ? this.getRun(runId) : null
  }

  listRuns(options: { definitionId?: string; limit?: number; offset?: number } = {}): AutomationRun[] {
    this.requireInitialized()
    const offset = Math.max(0, Math.floor(options.offset ?? 0))
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)))
    const index = this.loadRunIndex()
    const runIds = options.definitionId
      ? index.definitionRunIds?.[options.definitionId] ?? index.runIds.filter(id => this.getRun(id)?.definitionId === options.definitionId)
      : index.runIds
    return runIds.slice(offset, offset + limit)
      .map(id => this.getRun(id))
      .filter((run): run is AutomationRun => Boolean(run))
  }

  countRuns(definitionId?: string): number {
    this.requireInitialized()
    const index = this.loadRunIndex()
    if (!definitionId) return index.runIds.length
    if (index.definitionRunIds) return index.definitionRunIds[definitionId]?.length ?? 0
    return index.runIds.reduce((count, id) => count + Number(this.getRun(id)?.definitionId === definitionId), 0)
  }

  countRunsByStatus(statuses: AutomationRunStatus[], definitionId?: string): number {
    this.requireInitialized()
    const selected = new Set(statuses)
    const index = this.loadRunIndex()
    const runIds = definitionId ? index.definitionRunIds?.[definitionId] ?? index.runIds : index.runIds
    return runIds.reduce((count, id) => count + Number(selected.has(this.getRun(id)?.status as AutomationRunStatus)), 0)
  }

  deleteDefinitionData(definitionId: string, options: { runs?: boolean; memory?: boolean }): AutomationDefinitionDataDeletionResult {
    this.requireInitialized()
    validIdentifier(definitionId, 'automation definition ID')
    const runIds = options.runs
      ? this.loadRunIndex().runIds.filter(id => this.getRun(id)?.definitionId === definitionId)
      : []
    const operations: AutomationRepositoryIntentOperation[] = []
    if (runIds.length > 0) operations.push(...this.deleteRunOperations(runIds))
    const memoryPath = this.memoryPath(definitionId)
    const deletedMemory = options.memory === true && existsSync(memoryPath)
    if (options.memory) operations.push({ kind: 'delete', path: this.relativePath(memoryPath) })
    if (operations.length > 0) this.executeTransaction(operations)
    return { deletedRuns: runIds.length, deletedMemory }
  }

  listActiveRuns(): AutomationRun[] {
    this.requireInitialized()
    const index = this.loadRunIndex()
    const activeRunIds = index.activeRunIds ?? index.runIds.filter(id => {
      const status = this.getRun(id)?.status
      return status !== undefined && ['preparing', 'running', 'waiting_for_approval', 'checkpointed'].includes(status)
    })
    return activeRunIds.map(id => this.getRun(id)).filter((run): run is AutomationRun => Boolean(run))
  }

  getEvent(id: string): AutomationTriggerEvent | null {
    this.requireInitialized()
    const path = this.eventPath(id)
    if (!existsSync(path)) return null
    return clone(readUnknownJson(path) as AutomationTriggerEvent)
  }

  triggerEventStatusCounts(): Record<AutomationTriggerEvent['status'], number> {
    this.requireInitialized()
    const counts: Record<AutomationTriggerEvent['status'], number> = { accepted: 0, deduplicated: 0, rejected: 0, expired: 0, routed: 0 }
    for (const filename of readdirSync(join(this.rootPath, 'events')).filter(name => name.endsWith('.json'))) {
      try {
        const event = readUnknownJson(join(this.rootPath, 'events', filename)) as AutomationTriggerEvent
        if (event.status in counts) counts[event.status] += 1
      } catch {}
    }
    return counts
  }

  saveRejectedEvent(event: AutomationTriggerEvent): AutomationTriggerEvent {
    this.requireInitialized()
    if (!['rejected', 'expired', 'deduplicated'].includes(event.status)) throw new Error('Only non-routed trigger events can be saved directly')
    validIdentifier(event.id, 'automation trigger event ID')
    if (existsSync(this.eventPath(event.id))) return this.getEvent(event.id)!
    this.executeTransaction([this.setOperation(this.relativePath(this.eventPath(event.id)), event)])
    return clone(event)
  }

  getPayload(id: string): AutomationTriggerPayload | null {
    this.requireInitialized()
    const path = this.payloadPath(id)
    if (!existsSync(path)) return null
    return clone(readUnknownJson(path) as AutomationTriggerPayload)
  }

  purgeExpiredPayloads(now = this.now()): number {
    this.requireInitialized()
    const operations: AutomationRepositoryIntentOperation[] = []
    for (const filename of readdirSync(join(this.rootPath, 'payloads')).filter(name => name.endsWith('.json'))) {
      try {
        const payload = readUnknownJson(join(this.rootPath, 'payloads', filename)) as AutomationTriggerPayload
        if (payload.expiresAt <= now) operations.push({ kind: 'delete', path: join('payloads', filename) })
      } catch {}
    }
    if (operations.length > 0) this.executeTransaction(operations)
    return operations.length
  }

  getRetentionPolicy(): AutomationRetentionPolicy {
    this.requireInitialized()
    const stored = readJson(this.retentionPolicyPath, isRetentionPolicyFile)?.policy ?? {}
    return this.normalizeRetentionPolicy(stored)
  }

  saveRetentionPolicy(policy: Partial<AutomationRetentionPolicy>): AutomationRetentionPolicy {
    this.requireInitialized()
    const saved = this.normalizeRetentionPolicy({ ...this.getRetentionPolicy(), ...policy })
    this.executeTransaction([this.setOperation(this.relativePath(this.retentionPolicyPath), { schemaVersion: 1, policy: saved })])
    return saved
  }

  planRetention(
    policy: Partial<AutomationRetentionPolicy> = {},
    now = this.now(),
  ): AutomationRetentionPlan {
    this.requireInitialized()
    const normalized = this.normalizeRetentionPolicy({ ...this.getRetentionPolicy(), ...policy })
    const protectedRunIds = new Set<string>()
    for (const definition of this.listDefinitions()) {
      for (const entry of this.listMemory(definition.id).entries) {
        if (entry.sourceRunId) protectedRunIds.add(entry.sourceRunId)
        for (const evidence of entry.evidence) if (evidence.kind === 'run') protectedRunIds.add(evidence.ref)
      }
    }
    const payloadCutoff = now - normalized.triggerPayloadDays * 24 * 60 * 60_000
    const payloadIds: string[] = []
    for (const filename of readdirSync(join(this.rootPath, 'payloads')).filter(name => name.endsWith('.json')).sort()) {
      try {
        const payload = readUnknownJson(join(this.rootPath, 'payloads', filename)) as AutomationTriggerPayload
        if (payload.expiresAt <= now || payload.receivedAt <= payloadCutoff) payloadIds.push(payload.id)
      } catch {}
    }
    const runs = this.loadRunIndex().runIds
      .map(id => this.getRun(id))
      .filter((run): run is AutomationRun => Boolean(run))
    const detailCutoff = now - normalized.successDetailsDays * 24 * 60 * 60_000
    const runCutoff = now - normalized.runMetadataDays * 24 * 60 * 60_000
    const successDetailRunIds = runs
      .filter(run => run.status === 'completed'
        && !run.pinned
        && !run.detailsPrunedAt
        && (run.timestamps.completedAt ?? run.timestamps.updatedAt) <= detailCutoff
        && this.listCheckpoints(run.id).length > 0)
      .map(run => run.id)
    const runIds = runs
      .filter(run => !run.pinned
        && !protectedRunIds.has(run.id)
        && !['queued', 'preparing', 'running', 'waiting_for_approval', 'checkpointed', 'retry_scheduled'].includes(run.status)
        && (run.timestamps.completedAt ?? run.timestamps.updatedAt) <= runCutoff)
      .map(run => run.id)
    return { payloadIds, successDetailRunIds, runIds, protectedRunIds: [...protectedRunIds] }
  }

  runRetentionMaintenance(options: {
    policy?: Partial<AutomationRetentionPolicy>
    now?: number
    shouldCancel?: () => boolean
  } = {}): AutomationRetentionResult {
    this.requireInitialized()
    const now = options.now ?? this.now()
    const policy = this.normalizeRetentionPolicy(options.policy ?? {})
    const plan = this.planRetention(policy, now)
    const candidates = [
      ...plan.payloadIds.map(id => ({ kind: 'payload' as const, id })),
      ...plan.successDetailRunIds.map(id => ({ kind: 'details' as const, id })),
      ...plan.runIds.map(id => ({ kind: 'run' as const, id })),
    ]
    const selected = candidates.slice(0, policy.batchSize)
    const canceled = selected.length > 0 && options.shouldCancel?.() === true
    if (selected.length === 0 || canceled) {
      return {
        deletedPayloads: 0,
        prunedSuccessDetails: 0,
        deletedRuns: 0,
        protectedRuns: plan.protectedRunIds.length,
        canceled,
        remaining: candidates.length,
      }
    }
    const payloadIds = selected.filter(item => item.kind === 'payload').map(item => item.id)
    const detailRunIds = selected.filter(item => item.kind === 'details').map(item => item.id)
    const runIds = selected.filter(item => item.kind === 'run').map(item => item.id)
    const operations: AutomationRepositoryIntentOperation[] = payloadIds.map(id => ({ kind: 'delete', path: this.relativePath(this.payloadPath(id)) }))
    for (const id of detailRunIds) {
      if (runIds.includes(id)) continue
      const run = this.getRun(id)
      if (!run || run.pinned || run.status !== 'completed') continue
      run.checkpointId = undefined
      run.detailsPrunedAt = now
      operations.push({ kind: 'delete', path: join('checkpoints', id) })
      operations.push(this.setOperation(this.relativePath(this.runPath(id)), run))
    }
    if (runIds.length > 0) operations.push(...this.deleteRunOperations(runIds))
    if (operations.length > 0) this.executeTransaction(operations)
    return {
      deletedPayloads: payloadIds.length,
      prunedSuccessDetails: detailRunIds.filter(id => !runIds.includes(id)).length,
      deletedRuns: runIds.length,
      protectedRuns: plan.protectedRunIds.length,
      canceled: false,
      remaining: Math.max(0, candidates.length - selected.length),
    }
  }

  getPermissionSnapshot(id: string): AutomationPermissionSnapshot | null {
    this.requireInitialized()
    const path = this.permissionPath(id)
    if (!existsSync(path)) return null
    return clone(readUnknownJson(path) as AutomationPermissionSnapshot)
  }

  getContextSnapshot(id: string): AutomationContextSnapshot | null {
    this.requireInitialized()
    const path = this.contextPath(id)
    if (!existsSync(path)) return null
    return clone(readUnknownJson(path) as AutomationContextSnapshot)
  }

  listMemory(definitionId: string): AutomationMemoryDocument {
    this.requireInitialized()
    validIdentifier(definitionId, 'automation definition ID')
    const stored = readJson(this.memoryPath(definitionId), (value): value is AutomationMemoryDocument => {
      if (!value || typeof value !== 'object') return false
      const candidate = value as Partial<AutomationMemoryDocument>
      return candidate.schemaVersion === AUTOMATION_SCHEMA_VERSION
        && candidate.definitionId === definitionId
        && Number.isInteger(candidate.revision)
        && Array.isArray(candidate.entries)
    })
    return clone(stored ?? { schemaVersion: AUTOMATION_SCHEMA_VERSION, definitionId, revision: 0, entries: [] })
  }

  acquireExecutionLocks(runId: string, ownerId: string, request: AutomationExecutionLockRequest, leaseMs: number): AutomationExecutionLock[] {
    this.requireInitialized()
    validIdentifier(runId, 'automation run ID')
    validIdentifier(ownerId, 'automation lock owner ID')
    const run = this.getRun(runId)
    if (!run || !['queued', 'preparing'].includes(run.status)) throw new Error('Execution locks require a queued or preparing automation run')
    const now = this.now()
    const expiresAt = now + Math.max(3_000, Math.floor(leaseMs))
    const index = this.loadExecutionLockIndex()
    index.locks = index.locks.filter(lock => lock.expiresAt > now && lock.runId !== runId)
    const group = request.concurrencyGroup?.id.trim().slice(0, 180)
    if (group) {
      const maxParallel = Math.max(1, Math.min(32, Math.floor(request.concurrencyGroup?.maxParallel ?? 1)))
      const occupied = index.locks.filter(lock => lock.kind === 'concurrency_group' && lock.key === group)
      if (occupied.length >= maxParallel) throw new Error(`Automation concurrency group is busy: ${group}`)
    }
    const resources = (request.resources ?? []).map(resource => ({
      key: resource.key.trim().slice(0, 240),
      mode: resource.mode === 'shared' ? 'shared' as const : 'exclusive' as const,
    })).filter(resource => Boolean(resource.key))
    for (const resource of resources) {
      const conflicting = index.locks.find(lock => lock.kind === 'resource'
        && lock.key === resource.key
        && (resource.mode === 'exclusive' || lock.mode === 'exclusive'))
      if (conflicting) throw new Error(`Automation resource is locked by another run: ${resource.key}`)
    }
    const locks: AutomationExecutionLock[] = []
    if (group) {
      locks.push({
        id: `lock-${randomUUID()}`,
        runId,
        ownerId,
        kind: 'concurrency_group',
        key: group,
        mode: 'slot',
        limit: Math.max(1, Math.min(32, Math.floor(request.concurrencyGroup?.maxParallel ?? 1))),
        acquiredAt: now,
        expiresAt,
      })
    }
    for (const resource of resources) {
      locks.push({ id: `lock-${randomUUID()}`, runId, ownerId, kind: 'resource', key: resource.key, mode: resource.mode, acquiredAt: now, expiresAt })
    }
    index.locks.push(...locks)
    run.concurrencyGroupId = group || undefined
    run.resourceLockKeys = resources.map(resource => resource.key)
    this.executeTransaction([
      this.setOperation(this.relativePath(this.executionLocksPath), index),
      this.setOperation(this.relativePath(this.runPath(runId)), run),
    ])
    return clone(locks)
  }

  canAcquireExecutionLocks(request: AutomationExecutionLockRequest, now = this.now(), ignoreRunId?: string): { ok: true } | { ok: false; reason: string } {
    this.requireInitialized()
    const locks = this.loadExecutionLockIndex().locks.filter(lock => lock.expiresAt > now && lock.runId !== ignoreRunId)
    const group = request.concurrencyGroup?.id.trim().slice(0, 180)
    if (group) {
      const maxParallel = Math.max(1, Math.min(32, Math.floor(request.concurrencyGroup?.maxParallel ?? 1)))
      if (locks.filter(lock => lock.kind === 'concurrency_group' && lock.key === group).length >= maxParallel) {
        return { ok: false, reason: `Automation concurrency group is busy: ${group}` }
      }
    }
    for (const resource of request.resources ?? []) {
      const key = resource.key.trim().slice(0, 240)
      if (locks.some(lock => lock.kind === 'resource' && lock.key === key && (resource.mode === 'exclusive' || lock.mode === 'exclusive'))) {
        return { ok: false, reason: `Automation resource is locked by another run: ${key}` }
      }
    }
    return { ok: true }
  }

  renewExecutionLocks(runId: string, ownerId: string, leaseMs: number, expectedRequest?: AutomationExecutionLockRequest): AutomationExecutionLock[] {
    this.requireInitialized()
    const index = this.loadExecutionLockIndex()
    const now = this.now()
    const locks = index.locks.filter(lock => lock.runId === runId)
    if ((expectedRequest !== undefined && !executionLockSetMatches(locks, expectedRequest))
      || locks.some(lock => lock.ownerId !== ownerId || lock.expiresAt <= now)) {
      throw new Error('Automation execution lock ownership was lost')
    }
    const expiresAt = now + Math.max(3_000, Math.floor(leaseMs))
    locks.forEach(lock => { lock.expiresAt = expiresAt })
    index.locks = index.locks.filter(lock => lock.expiresAt > now)
    if (locks.length > 0) this.executeTransaction([this.setOperation(this.relativePath(this.executionLocksPath), index)])
    return clone(locks)
  }

  renewOwnedLeaseAndExecutionLocks(
    runId: string,
    ownerId: string,
    leaseMs: number,
    expectedRequest: AutomationExecutionLockRequest,
  ): { run: AutomationRun; locks: AutomationExecutionLock[] } {
    this.requireInitialized()
    validIdentifier(runId, 'automation run ID')
    validIdentifier(ownerId, 'automation lease owner ID')
    const run = this.getRun(runId)
    const now = this.now()
    if (!run?.lease
      || run.lease.ownerId !== ownerId
      || run.lease.expiresAt <= now
      || !['preparing', 'running', 'waiting_for_approval', 'checkpointed'].includes(run.status)) {
      throw new Error('Automation run lease ownership was lost')
    }
    const lockIndex = this.loadExecutionLockIndex()
    const runLocks = lockIndex.locks.filter(lock => lock.runId === runId)
    if (!executionLockSetMatches(runLocks, expectedRequest)
      || !executionLockMetadataMatches(run, expectedRequest)
      || runLocks.some(lock => lock.ownerId !== ownerId || lock.expiresAt <= now)) {
      throw new Error('Automation execution lock ownership was lost')
    }
    const expiresAt = now + Math.max(3_000, Math.floor(leaseMs))
    run.lease.heartbeatAt = now
    run.lease.expiresAt = expiresAt
    run.timestamps.updatedAt = now
    runLocks.forEach(lock => { lock.expiresAt = expiresAt })
    const operations = [this.setOperation(this.relativePath(this.runPath(runId)), run)]
    if (runLocks.length > 0) operations.push(this.setOperation(this.relativePath(this.executionLocksPath), lockIndex))
    this.executeTransaction(operations)
    return { run: clone(run), locks: clone(runLocks) }
  }

  releaseExecutionLocks(runId: string, ownerId?: string): number {
    this.requireInitialized()
    const index = this.loadExecutionLockIndex()
    const removed = index.locks.filter(lock => lock.runId === runId && (!ownerId || lock.ownerId === ownerId)).length
    if (removed === 0) return 0
    index.locks = index.locks.filter(lock => lock.runId !== runId || Boolean(ownerId && lock.ownerId !== ownerId))
    this.executeTransaction([this.setOperation(this.relativePath(this.executionLocksPath), index)])
    return removed
  }

  listExecutionLocks(now = this.now()): AutomationExecutionLock[] {
    this.requireInitialized()
    return this.loadExecutionLockIndex().locks.filter(lock => lock.expiresAt > now).map(clone)
  }

  consumeRunBudget(runId: string, delta: { toolCalls?: number; inputTokens?: number; outputTokens?: number; subtasks?: number }): AutomationRun {
    this.requireInitialized()
    const run = this.getRun(runId)
    if (!run) throw new Error(`Automation run not found: ${runId}`)
    const permission = this.getPermissionSnapshot(run.permissionSnapshotId)
    if (!permission) throw new Error(`Automation permission snapshot not found: ${run.permissionSnapshotId}`)
    const current = run.budgetUsage ?? { toolCalls: 0, inputTokens: 0, outputTokens: 0, subtasks: 0, updatedAt: this.now() }
    const next = {
      toolCalls: current.toolCalls + Math.max(0, Math.floor(delta.toolCalls ?? 0)),
      inputTokens: current.inputTokens + Math.max(0, Math.floor(delta.inputTokens ?? 0)),
      outputTokens: current.outputTokens + Math.max(0, Math.floor(delta.outputTokens ?? 0)),
      subtasks: (current.subtasks ?? 0) + Math.max(0, Math.floor(delta.subtasks ?? 0)),
      updatedAt: this.now(),
    }
    if (next.toolCalls > permission.maxToolCalls) throw new Error(`Automation run exceeded its total tool-call budget of ${permission.maxToolCalls}`)
    if (permission.maxInputTokens !== undefined && next.inputTokens > permission.maxInputTokens) {
      throw new Error(`Automation run exceeded its total input-token budget of ${permission.maxInputTokens}`)
    }
    if (permission.maxOutputTokens !== undefined && next.outputTokens > permission.maxOutputTokens) {
      throw new Error(`Automation run exceeded its total output-token budget of ${permission.maxOutputTokens}`)
    }
    const context = this.getContextSnapshot(run.contextSnapshotId)
    const maxSubtasks = context?.agentPolicy?.maxSubtasks ?? 0
    if (next.subtasks > maxSubtasks) {
      throw new Error(`Automation run exceeded its total subtask budget of ${maxSubtasks}`)
    }
    run.budgetUsage = next
    run.timestamps.updatedAt = next.updatedAt
    this.executeTransaction([this.setOperation(this.relativePath(this.runPath(runId)), run)])
    return clone(run)
  }

  saveCheckpoint(checkpoint: AutomationRunCheckpoint): AutomationRunCheckpoint {
    this.requireInitialized()
    validIdentifier(checkpoint.id, 'automation checkpoint ID')
    validIdentifier(checkpoint.runId, 'automation run ID')
    this.recoverResidualIntents()
    const run = this.getRun(checkpoint.runId)
    if (!run) throw new Error(`Automation run not found for checkpoint: ${checkpoint.runId}`)
    if (checkpoint.definitionId !== run.definitionId || checkpoint.definitionRevision !== run.definitionRevision) {
      throw new Error('Automation checkpoint definition version does not match its run')
    }
    if (existsSync(this.checkpointPath(checkpoint.runId, checkpoint.id))) {
      const existing = this.getCheckpoint(checkpoint.runId, checkpoint.id)
      if (normalizedJson(existing) !== normalizedJson(checkpoint)) throw new Error(`Automation checkpoint already exists: ${checkpoint.id}`)
      return existing!
    }
    run.checkpointId = checkpoint.id
    run.timestamps.updatedAt = this.now()
    this.executeTransaction([
      this.setOperation(this.relativePath(this.checkpointPath(checkpoint.runId, checkpoint.id)), checkpoint),
      this.setOperation(this.relativePath(this.runPath(run.id)), run),
    ])
    return clone(checkpoint)
  }

  getCheckpoint(runId: string, checkpointId: string): AutomationRunCheckpoint | null {
    this.requireInitialized()
    const path = this.checkpointPath(runId, checkpointId)
    if (!existsSync(path)) return null
    const run = this.getRun(runId)
    try {
      const checkpoint = readUnknownJson(path)
      if (run
        && isAutomationRunCheckpoint(checkpoint)
        && checkpoint.id === checkpointId
        && checkpoint.runId === run.id
        && checkpoint.definitionId === run.definitionId
        && checkpoint.definitionRevision === run.definitionRevision
        && checkpoint.contextSnapshotId === run.contextSnapshotId) return clone(checkpoint)
    } catch {}
    const warning = `Ignored corrupt automation checkpoint ${runId}/${checkpointId}.`
    if (!this.warnings.includes(warning)) this.warnings.push(warning)
    return null
  }

  listCheckpoints(runId: string): AutomationRunCheckpoint[] {
    this.requireInitialized()
    const directory = join(this.rootPath, 'checkpoints', validIdentifier(runId, 'automation run ID'))
    if (!existsSync(directory)) return []
    return readdirSync(directory).filter(name => name.endsWith('.json')).map(filename => {
      try { return this.getCheckpoint(runId, filename.slice(0, -'.json'.length)) } catch { return null }
    }).filter((checkpoint): checkpoint is AutomationRunCheckpoint => Boolean(checkpoint))
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(clone)
  }

  getLatestCheckpoint(runId: string): AutomationRunCheckpoint | null {
    const run = this.getRun(runId)
    if (run?.checkpointId) return this.getCheckpoint(runId, run.checkpointId)
    return this.listCheckpoints(runId).at(-1) ?? null
  }

  prepareRunRecovery(id: string, recovery: NonNullable<AutomationRun['recovery']>): AutomationRun {
    this.requireInitialized()
    const run = this.getRun(id)
    if (!run) throw new Error(`Automation run not found: ${id}`)
    if (!['interrupted', 'needs_review'].includes(run.status)) {
      throw new Error(`Only interrupted or review-required runs can be recovered: ${run.status}`)
    }
    assertAutomationRunTransition(run.status, 'queued')
    const now = this.now()
    run.status = 'queued'
    run.attempt += 1
    run.recovery = clone(recovery)
    run.lease = undefined
    run.error = undefined
    run.timestamps.queuedAt = now
    run.timestamps.updatedAt = now
    run.timestamps.preparingAt = undefined
    run.timestamps.startedAt = undefined
    run.timestamps.completedAt = undefined
    run.timestamps.retryAt = undefined
    const runIndex = this.loadRunIndex()
    runIndex.activeRunIds = this.nextActiveRunIds(runIndex.activeRunIds ?? [], run)
    this.executeTransaction([
      this.setOperation(this.relativePath(this.runPath(id)), run),
      this.setOperation(this.relativePath(this.runIndexPath), runIndex),
    ])
    return clone(run)
  }

  transitionRun(id: string, status: AutomationRunStatus, patch: AutomationRunTransitionPatch = {}): AutomationRun {
    this.requireInitialized()
    const run = this.getRun(id)
    if (!run) throw new Error(`Automation run not found: ${id}`)
    assertAutomationRunTransition(run.status, status)
    const now = this.now()
    run.status = status
    run.timestamps.updatedAt = now
    if (status === 'preparing' && run.timestamps.preparingAt === undefined) run.timestamps.preparingAt = now
    if (status === 'running' && run.timestamps.startedAt === undefined) run.timestamps.startedAt = now
    if (['completed', 'canceled', 'skipped', 'expired'].includes(status)) run.timestamps.completedAt = now
    if (patch.retryAt !== undefined) run.timestamps.retryAt = patch.retryAt
    if (patch.error !== undefined) run.error = clone(patch.error)
    if (patch.result !== undefined) run.result = clone(patch.result)
    if (patch.checkpointId !== undefined) run.checkpointId = patch.checkpointId
    if (patch.conversationId !== undefined) run.conversationId = patch.conversationId
    if (patch.clearLease) run.lease = undefined
    const runIndex = this.loadRunIndex()
    runIndex.activeRunIds = this.nextActiveRunIds(runIndex.activeRunIds ?? [], run)
    this.executeTransaction([
      this.setOperation(this.relativePath(this.runPath(id)), run),
      this.setOperation(this.relativePath(this.runIndexPath), runIndex),
    ])
    return clone(run)
  }

  setRunPinned(id: string, pinned: boolean): AutomationRun {
    this.requireInitialized()
    const run = this.getRun(id)
    if (!run) throw new Error(`Automation run not found: ${id}`)
    const now = this.now()
    run.pinned = pinned || undefined
    run.pinnedAt = pinned ? now : undefined
    run.timestamps.updatedAt = now
    this.executeTransaction([this.setOperation(this.relativePath(this.runPath(id)), run)])
    return clone(run)
  }

  recordRunExecution(id: string, execution: { provider: string; model: string }): AutomationRun {
    this.requireInitialized()
    const run = this.getRun(id)
    if (!run) throw new Error(`Automation run not found: ${id}`)
    run.execution = {
      provider: execution.provider.trim().slice(0, 120),
      model: execution.model.trim().slice(0, 240),
      recordedAt: this.now(),
    }
    this.executeTransaction([this.setOperation(this.relativePath(this.runPath(id)), run)])
    return clone(run)
  }

  acquireLease(id: string, ownerId: string, leaseMs: number): AutomationRun {
    const run = this.getRun(id)
    if (!run) throw new Error(`Automation run not found: ${id}`)
    if (run.status !== 'queued') throw new Error(`Only queued automation runs can be leased: ${run.status}`)
    const now = this.now()
    run.lease = {
      ownerId: validIdentifier(ownerId, 'automation lease owner ID'),
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: now + Math.max(1_000, leaseMs),
    }
    run.status = 'preparing'
    run.timestamps.preparingAt = now
    run.timestamps.updatedAt = now
    const runIndex = this.loadRunIndex()
    runIndex.activeRunIds = this.nextActiveRunIds(runIndex.activeRunIds ?? [], run)
    this.executeTransaction([
      this.setOperation(this.relativePath(this.runPath(id)), run),
      this.setOperation(this.relativePath(this.runIndexPath), runIndex),
    ])
    return clone(run)
  }

  renewLease(id: string, ownerId: string, leaseMs: number): AutomationRun {
    const run = this.getRun(id)
    if (!run?.lease) throw new Error(`Automation run has no active lease: ${id}`)
    if (run.lease.ownerId !== ownerId) throw new Error(`Automation run lease is owned by another host: ${id}`)
    const now = this.now()
    if (run.lease.expiresAt < now) throw new Error(`Automation run lease has expired: ${id}`)
    run.lease.heartbeatAt = now
    run.lease.expiresAt = now + Math.max(1_000, leaseMs)
    run.timestamps.updatedAt = now
    this.executeTransaction([this.setOperation(this.relativePath(this.runPath(id)), run)])
    return clone(run)
  }

  renewOwnedLeasesAfterSleep(ownerId: string, runIds: readonly string[], leaseMs: number): AutomationLeaseResumeResult {
    this.requireInitialized()
    validIdentifier(ownerId, 'automation lease owner ID')
    const ids = [...new Set(runIds.map(id => validIdentifier(id, 'automation run ID')))]
    const now = this.now()
    const expiresAt = now + Math.max(3_000, Math.floor(leaseMs))
    const lockIndex = this.loadExecutionLockIndex()
    const resumedRunIds: string[] = []
    const lostRunIds: string[] = []
    const operations: AutomationRepositoryIntentOperation[] = []

    for (const id of ids) {
      const run = this.getRun(id)
      if (!run?.lease
        || run.lease.ownerId !== ownerId
        || !['preparing', 'running', 'waiting_for_approval', 'checkpointed'].includes(run.status)) {
        lostRunIds.push(id)
        continue
      }
      const runLocks = lockIndex.locks.filter(lock => lock.runId === id)
      const revision = this.getRevision(run.definitionId, run.definitionRevision)
      const expectedRequest = revision ? definitionExecutionLockRequest(revision.definition) : undefined
      if (!expectedRequest
        || !executionLockSetMatches(runLocks, expectedRequest)
        || !executionLockMetadataMatches(run, expectedRequest)
        || runLocks.some(lock => lock.ownerId !== ownerId)) {
        lostRunIds.push(id)
        continue
      }
      const otherLiveLocks = lockIndex.locks.filter(lock => lock.runId !== id && lock.expiresAt > now)
      const conflicts = runLocks.some(lock => lock.kind === 'concurrency_group'
        ? otherLiveLocks.filter(other => other.kind === 'concurrency_group' && other.key === lock.key).length >= (lock.limit ?? 1)
        : otherLiveLocks.some(other => other.kind === 'resource'
          && other.key === lock.key
          && (lock.mode === 'exclusive' || other.mode === 'exclusive')))
      if (conflicts) {
        lostRunIds.push(id)
        continue
      }
      run.lease.heartbeatAt = now
      run.lease.expiresAt = expiresAt
      run.timestamps.updatedAt = now
      runLocks.forEach(lock => { lock.expiresAt = expiresAt })
      operations.push(this.setOperation(this.relativePath(this.runPath(id)), run))
      resumedRunIds.push(id)
    }

    lockIndex.locks = lockIndex.locks.filter(lock => lock.expiresAt > now || resumedRunIds.includes(lock.runId))
    if (ids.length > 0) operations.push(this.setOperation(this.relativePath(this.executionLocksPath), lockIndex))
    if (operations.length > 0) this.executeTransaction(operations)
    return { resumedRunIds, lostRunIds }
  }

  recoverExpiredLeases(): AutomationRun[] {
    this.requireInitialized()
    const now = this.now()
    const recovered: AutomationRun[] = []
    for (const run of this.listActiveRuns()) {
      if (!run.lease || run.lease.expiresAt > now) continue
      if (!['preparing', 'running', 'waiting_for_approval', 'checkpointed'].includes(run.status)) continue
      const checkpoint = this.getLatestCheckpoint(run.id)
      const uncertainEffect = checkpoint?.inFlightToolEffect
      const needsReview = !checkpoint
        || run.status === 'waiting_for_approval'
        || Boolean(uncertainEffect && automationToolEffectNeedsReview(uncertainEffect.classification))
        || checkpoint?.resumable === false
      recovered.push(this.transitionRun(run.id, needsReview ? 'needs_review' : 'interrupted', {
        clearLease: true,
        error: {
          code: needsReview ? 'automation_side_effect_uncertain' : 'automation_lease_expired',
          category: needsReview ? 'side_effect_unknown' : 'host_interrupted',
          message: needsReview
            ? !checkpoint
              ? 'The host stopped without a durable checkpoint, so prior side effects cannot be proven safe.'
              : `The host stopped while ${uncertainEffect?.toolName ?? 'an approval or non-replayable effect'} was unresolved.`
            : 'The Desktop host stopped renewing this automation run lease.',
          retryable: !needsReview,
          userAction: needsReview
            ? 'Inspect the last checkpoint and workspace before choosing retry or cancel.'
            : 'Review the last checkpoint and retry the run.',
        },
      }))
    }
    return recovered
  }

  private requireMatchingOccurrenceWinner(input: AutomationRunCreation, runId: string): AutomationRun {
    const existing = this.getRun(runId)
    if (!existing) throw new Error(`Automation dedup index references a missing run: ${runId}`)
    const event = this.getEvent(existing.triggerEventId)
    const matches = existing.occurrenceKey === input.run.occurrenceKey
      && existing.definitionId === input.run.definitionId
      && event?.definitionId === input.event.definitionId
      && event.deduplicationKey === input.event.deduplicationKey
      && event.source === input.event.source
      && event.sourceInstanceId === input.event.sourceInstanceId
    if (!matches) throw new Error(`Automation occurrence identity collision: ${input.run.occurrenceKey}`)
    return existing
  }

  private validateDefinition(definition: AutomationDefinition): void {
    validIdentifier(definition.id, 'automation definition ID')
    if (definition.schemaVersion !== AUTOMATION_SCHEMA_VERSION) throw new Error('Unsupported automation definition schema')
    if (!Number.isInteger(definition.revision) || definition.revision < 1) throw new Error('Automation definition revision must be a positive integer')
    if (!definition.name.trim() || !definition.objective.goal.trim() || !definition.objective.originalPrompt.trim()) {
      throw new Error('Automation definition name and objective are required')
    }
    if (!resolve(definition.workspaceRef.path)) throw new Error('Automation definition workspace is required')
  }

  private validateRunCreation(input: AutomationRunCreation, historical: boolean): void {
    validIdentifier(input.event.id, 'automation trigger event ID')
    validIdentifier(input.run.id, 'automation run ID')
    validIdentifier(input.permissionSnapshot.id, 'automation permission snapshot ID')
    validIdentifier(input.contextSnapshot.id, 'automation context snapshot ID')
    if (!input.run.occurrenceKey.trim() || input.run.occurrenceKey.length > 500) throw new Error('Automation occurrence key is required and must be bounded')
    if (input.event.definitionId !== input.run.definitionId || input.event.definitionRevision !== input.run.definitionRevision) {
      throw new Error('Automation trigger event and run definition versions must match')
    }
    if (input.run.triggerEventId !== input.event.id) throw new Error('Automation run must reference its trigger event')
    if (input.run.permissionSnapshotId !== input.permissionSnapshot.id) throw new Error('Automation run must reference its permission snapshot')
    if (input.run.contextSnapshotId !== input.contextSnapshot.id) throw new Error('Automation run must reference its context snapshot')
    if (input.event.payloadRef !== input.contextSnapshot.triggerPayloadRef) throw new Error('Automation trigger and context payload references must match')
    if (input.payload) {
      validIdentifier(input.payload.id, 'automation trigger payload ID')
      if (input.event.payloadRef !== input.payload.id || input.event.payloadDigest !== input.payload.digest) {
        throw new Error('Automation trigger payload identity does not match its event')
      }
    } else if (input.event.payloadRef) {
      throw new Error('Automation trigger payload record is missing')
    }
    if (!historical && input.run.status !== 'queued') throw new Error('A new automation run must start queued')
    if (input.run.schemaVersion !== AUTOMATION_SCHEMA_VERSION) throw new Error('Unsupported automation run schema')
  }

  private ensureDirectories(): void {
    for (const directory of [
      this.rootPath,
      join(this.rootPath, 'revisions'),
      join(this.rootPath, 'events'),
      join(this.rootPath, 'runs'),
      join(this.rootPath, 'permissions'),
      join(this.rootPath, 'contexts'),
      join(this.rootPath, 'checkpoints'),
      join(this.rootPath, 'payloads'),
      join(this.rootPath, 'memory'),
      join(this.rootPath, 'indexes'),
      join(this.rootPath, 'intents'),
    ]) mkdirSync(directory, { recursive: true, mode: 0o700 })
  }

  private recoverIntents(): void {
    const intentDirectory = join(this.rootPath, 'intents')
    for (const filename of readdirSync(intentDirectory).filter(name => name.endsWith('.json')).sort()) {
      const path = join(intentDirectory, filename)
      try {
        const intent = readUnknownJson(path) as AutomationRepositoryIntent
        if (intent.schemaVersion !== AUTOMATION_SCHEMA_VERSION || !Array.isArray(intent.operations)) throw new Error('invalid intent')
        for (const operation of intent.operations) this.applyOperation(operation)
        rmSync(path, { force: true })
        this.warnings.push(`Recovered automation transaction ${intent.id}.`)
      } catch (error) {
        throw new Error(`Unable to recover automation transaction ${filename}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
    }
  }

  private recoverStaleLock(): void {
    if (!existsSync(this.lockPath)) return
    let ownerPid: number | undefined
    try {
      const lock = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { pid?: unknown }
      if (typeof lock.pid === 'number' && Number.isInteger(lock.pid)) ownerPid = lock.pid
    } catch {}
    if (ownerPid !== undefined && ownerPid !== process.pid) {
      try {
        process.kill(ownerPid, 0)
        throw new Error(`Automation repository is owned by active process ${ownerPid}`)
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Automation repository is owned')) throw error
      }
    }
    rmSync(this.lockPath, { force: true })
    this.warnings.push('Recovered a stale automation repository lock.')
  }

  private rebuildIndexes(): void {
    let definitions = readJson(this.definitionsPath, isDefinitionIndex)
    if (!definitions) {
      const latest = new Map<string, AutomationDefinition>()
      const revisionsRoot = join(this.rootPath, 'revisions')
      for (const definitionDirectory of readdirSync(revisionsRoot, { withFileTypes: true })) {
        if (!definitionDirectory.isDirectory()) continue
        const path = join(revisionsRoot, definitionDirectory.name)
        for (const filename of readdirSync(path).filter(name => name.endsWith('.json'))) {
          try {
            const revision = readUnknownJson(join(path, filename)) as AutomationDefinitionRevision
            const current = latest.get(revision.definitionId)
            if (!current || revision.definition.revision > current.revision) latest.set(revision.definitionId, revision.definition)
          } catch {}
        }
      }
      definitions = { schemaVersion: AUTOMATION_SCHEMA_VERSION, definitions: [...latest.values()] }
      this.atomicWriteJson(this.definitionsPath, definitions)
      if (latest.size > 0) this.warnings.push('Rebuilt the automation definition index from revision records.')
    }

    const runs: AutomationRun[] = []
    const runsRoot = join(this.rootPath, 'runs')
    for (const filename of readdirSync(runsRoot).filter(name => name.endsWith('.json'))) {
      try {
        const run = readUnknownJson(join(runsRoot, filename)) as AutomationRun
        if (run.schemaVersion === AUTOMATION_SCHEMA_VERSION && run.id) runs.push(run)
      } catch {}
    }
    runs.sort((left, right) => right.timestamps.createdAt - left.timestamps.createdAt)
    const occurrenceWinners = this.quarantineDuplicateOccurrences(runs)
    const definitionRunIds: Record<string, string[]> = {}
    for (const run of runs) (definitionRunIds[run.definitionId] ??= []).push(run.id)
    const runIndex: AutomationRunIndex = {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      runIds: runs.map(run => run.id),
      definitionRunIds,
      activeRunIds: runs
        .filter(run => ['preparing', 'running', 'waiting_for_approval', 'checkpointed'].includes(run.status))
        .map(run => run.id),
    }
    const dedup: AutomationDedupIndex = {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      occurrences: Object.fromEntries(occurrenceWinners),
    }
    const previousRunIndex = readJson(this.runIndexPath, isRunIndex)
    const previousDedup = readJson(this.dedupIndexPath, isDedupIndex)
    if (normalizedJson(previousRunIndex) !== normalizedJson(runIndex)) this.atomicWriteJson(this.runIndexPath, runIndex)
    if (normalizedJson(previousDedup) !== normalizedJson(dedup)) this.atomicWriteJson(this.dedupIndexPath, dedup)


  }

  private quarantineDuplicateOccurrences(runs: AutomationRun[]): Array<[string, string]> {
    const groups = new Map<string, AutomationRun[]>()
    for (const run of runs) (groups.get(run.occurrenceKey) ?? groups.set(run.occurrenceKey, []).get(run.occurrenceKey)!).push(run)
    const winners: Array<[string, string]> = []
    for (const [occurrenceKey, group] of groups) {
      const ordered = [...group].sort((left, right) => left.timestamps.createdAt - right.timestamps.createdAt || left.id.localeCompare(right.id))
      winners.push([occurrenceKey, ordered[0]!.id])
      if (ordered.length < 2) continue
      const ids = ordered.map(run => run.id)
      for (const run of ordered) {
        if (run.status === 'invalid' && run.error?.code === 'automation_occurrence_collision') continue
        run.status = 'invalid'
        run.lease = undefined
        run.error = {
          code: 'automation_occurrence_collision',
          category: 'configuration',
          message: `Multiple durable runs claim occurrence ${occurrenceKey}.`,
          retryable: false,
          userAction: 'Export diagnostics, delete the conflicting definition run data, and republish before running again.',
        }
        run.timestamps.updatedAt = this.now()
        this.atomicWriteJson(this.runPath(run.id), run)
      }
      this.warnings.push(`Quarantined duplicate automation occurrence ${occurrenceKey}: ${ids.join(', ')}.`)
    }
    return winners
  }

  private executeTransaction(operations: AutomationRepositoryIntentOperation[]): void {
    this.injectFault('before-lock')
    const lock = this.acquireLock()
    const id = `intent-${randomUUID()}`
    const path = join(this.rootPath, 'intents', `${id}.json`)
    const intent: AutomationRepositoryIntent = {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id,
      phase: 'pending',
      createdAt: this.now(),
      operations: clone(operations),
    }
    try {
      if (readdirSync(join(this.rootPath, 'intents')).some(filename => filename.endsWith('.json'))) this.recoverIntents()
      for (const operation of operations) {
        if (!Object.prototype.hasOwnProperty.call(operation, 'expectedVersion')) continue
        if (this.fileVersion(operation.path) !== operation.expectedVersion) throw new AutomationRepositoryConflictError(operation.path)
      }
      this.injectFault('before-intent')
      this.atomicWriteJson(path, intent)
      this.injectFault('after-intent')
      for (const [index, operation] of operations.entries()) {
        this.injectFault(`before-operation:${index}`)
        this.applyOperation(operation)
        this.injectFault(`after-operation:${index}`)
      }
      this.injectFault('before-commit')
      intent.phase = 'committed'
      this.atomicWriteJson(path, intent)
      this.injectFault('after-commit')
      unlinkSync(path)
    } finally {
      closeSync(lock)
      rmSync(this.lockPath, { force: true })
    }
  }

  private recoverResidualIntents(): void {
    const intentDirectory = join(this.rootPath, 'intents')
    if (!readdirSync(intentDirectory).some(filename => filename.endsWith('.json'))) return
    const lock = this.acquireLock()
    try {
      this.recoverIntents()
    } finally {
      closeSync(lock)
      rmSync(this.lockPath, { force: true })
    }
  }

  private applyOperation(operation: AutomationRepositoryIntentOperation): void {
    const target = this.absolutePath(operation.path)
    if (operation.kind === 'delete') rmSync(target, { recursive: true, force: true })
    else this.atomicWriteJson(target, operation.value)
  }

  private atomicWriteJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
    const descriptor = openSync(temporaryPath, 'wx', 0o600)
    try {
      writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      syncFile(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporaryPath, path)
    try {
      const directory = openSync(dirname(path), 'r')
      try { syncFile(directory) } finally { closeSync(directory) }
    } catch {}
  }

  private acquireLock(): number {
    let descriptor: number | undefined
    try {
      descriptor = openSync(this.lockPath, 'wx', 0o600)
      writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, acquiredAt: this.now() })}\n`, 'utf8')
      syncFile(descriptor)
      return descriptor
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor)
        rmSync(this.lockPath, { force: true })
      }
      throw new Error(`Automation repository is busy: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  private setOperation(path: string, value: unknown): AutomationRepositoryIntentOperation {
    return { kind: 'set', path, value: clone(value), expectedVersion: this.fileVersion(path) }
  }

  private fileVersion(path: string): string | null {
    const target = this.absolutePath(path)
    if (!existsSync(target)) return null
    return createHash('sha256').update(readFileSync(target)).digest('hex')
  }

  private relativePath(path: string): string {
    const normalized = resolve(path)
    const value = relative(this.rootPath, normalized)
    if (!value || value === '..' || value.startsWith(`..${sep}`)) throw new Error(`Automation repository path is outside the root: ${path}`)
    return value
  }

  private absolutePath(path: string): string {
    if (path.includes('\0')) throw new Error('Automation repository path contains a null byte')
    const target = resolve(this.rootPath, path)
    const value = relative(this.rootPath, target)
    if (!value || value === '..' || value.startsWith(`..${sep}`)) throw new Error(`Automation repository path is outside the root: ${path}`)
    return target
  }

  private injectFault(stage: string): void {
    this.faultInjector?.(stage)
  }

  private loadDefinitionIndex(): AutomationDefinitionIndex {
    return readJson(this.definitionsPath, isDefinitionIndex) ?? { schemaVersion: AUTOMATION_SCHEMA_VERSION, definitions: [] }
  }

  private loadDedupIndex(): AutomationDedupIndex {
    return readJson(this.dedupIndexPath, isDedupIndex) ?? { schemaVersion: AUTOMATION_SCHEMA_VERSION, occurrences: {} }
  }

  private loadRunIndex(): AutomationRunIndex {
    return readJson(this.runIndexPath, isRunIndex) ?? { schemaVersion: AUTOMATION_SCHEMA_VERSION, runIds: [] }
  }

  private loadExecutionLockIndex(): AutomationExecutionLockIndex {
    return readJson(this.executionLocksPath, isExecutionLockIndex) ?? { schemaVersion: AUTOMATION_SCHEMA_VERSION, locks: [] }
  }

  private normalizeRetentionPolicy(policy: Partial<AutomationRetentionPolicy>): AutomationRetentionPolicy {
    return {
      runMetadataDays: Math.max(1, Math.min(3_650, Math.floor(policy.runMetadataDays ?? DEFAULT_AUTOMATION_RETENTION_POLICY.runMetadataDays))),
      successDetailsDays: Math.max(1, Math.min(3_650, Math.floor(policy.successDetailsDays ?? DEFAULT_AUTOMATION_RETENTION_POLICY.successDetailsDays))),
      triggerPayloadDays: Math.max(1, Math.min(30, Math.floor(policy.triggerPayloadDays ?? DEFAULT_AUTOMATION_RETENTION_POLICY.triggerPayloadDays))),
      conversationDays: Math.max(1, Math.min(3_650, Math.floor(policy.conversationDays ?? DEFAULT_AUTOMATION_RETENTION_POLICY.conversationDays))),
      screenshotDays: Math.max(1, Math.min(365, Math.floor(policy.screenshotDays ?? DEFAULT_AUTOMATION_RETENTION_POLICY.screenshotDays))),
      artifactDays: Math.max(1, Math.min(3_650, Math.floor(policy.artifactDays ?? DEFAULT_AUTOMATION_RETENTION_POLICY.artifactDays))),
      batchSize: Math.max(1, Math.min(500, Math.floor(policy.batchSize ?? DEFAULT_AUTOMATION_RETENTION_POLICY.batchSize))),
    }
  }

  private deleteRunOperations(runIds: string[]): AutomationRepositoryIntentOperation[] {
    const selected = new Set(runIds)
    const runs = runIds.map(id => this.getRun(id)).filter((run): run is AutomationRun => Boolean(run))
    const events = runs.map(run => this.getEvent(run.triggerEventId)).filter((event): event is AutomationTriggerEvent => Boolean(event))
    const runIndex = this.loadRunIndex()
    runIndex.runIds = runIndex.runIds.filter(id => !selected.has(id))
    runIndex.activeRunIds = (runIndex.activeRunIds ?? []).filter(id => !selected.has(id))
    if (runIndex.definitionRunIds) {
      for (const definitionId of Object.keys(runIndex.definitionRunIds)) {
        runIndex.definitionRunIds[definitionId] = runIndex.definitionRunIds[definitionId]!.filter(id => !selected.has(id))
      }
    }
    const dedup = this.loadDedupIndex()
    for (const [key, id] of Object.entries(dedup.occurrences)) if (selected.has(id)) delete dedup.occurrences[key]
    const locks = this.loadExecutionLockIndex()
    locks.locks = locks.locks.filter(lock => !selected.has(lock.runId))
    return [
      ...runs.flatMap(run => [
        { kind: 'delete' as const, path: this.relativePath(this.runPath(run.id)) },
        { kind: 'delete' as const, path: this.relativePath(this.eventPath(run.triggerEventId)) },
        { kind: 'delete' as const, path: this.relativePath(this.permissionPath(run.permissionSnapshotId)) },
        { kind: 'delete' as const, path: this.relativePath(this.contextPath(run.contextSnapshotId)) },
        { kind: 'delete' as const, path: join('checkpoints', run.id) },
      ]),
      ...events.filter(event => event.payloadRef).map(event => ({ kind: 'delete' as const, path: this.relativePath(this.payloadPath(event.payloadRef!)) })),
      this.setOperation(this.relativePath(this.runIndexPath), runIndex),
      this.setOperation(this.relativePath(this.dedupIndexPath), dedup),
      this.setOperation(this.relativePath(this.executionLocksPath), locks),
    ]
  }

  private nextActiveRunIds(activeRunIds: string[], run: AutomationRun): string[] {
    const withoutRun = activeRunIds.filter(id => id !== run.id)
    return ['preparing', 'running', 'waiting_for_approval', 'checkpointed'].includes(run.status)
      ? [run.id, ...withoutRun]
      : withoutRun
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error('Automation repository must be initialized before use')
  }

  private revisionPath(definitionId: string, revision: number): string {
    return join(this.rootPath, 'revisions', validIdentifier(definitionId, 'automation definition ID'), `${revision}.json`)
  }

  private eventPath(id: string): string {
    return join(this.rootPath, 'events', `${validIdentifier(id, 'automation trigger event ID')}.json`)
  }

  private payloadPath(id: string): string {
    return join(this.rootPath, 'payloads', `${validIdentifier(id, 'automation trigger payload ID')}.json`)
  }

  private runPath(id: string): string {
    return join(this.rootPath, 'runs', `${validIdentifier(id, 'automation run ID')}.json`)
  }

  private permissionPath(id: string): string {
    return join(this.rootPath, 'permissions', `${validIdentifier(id, 'automation permission snapshot ID')}.json`)
  }

  private contextPath(id: string): string {
    return join(this.rootPath, 'contexts', `${validIdentifier(id, 'automation context snapshot ID')}.json`)
  }

  private checkpointPath(runId: string, checkpointId: string): string {
    return join(
      this.rootPath,
      'checkpoints',
      validIdentifier(runId, 'automation run ID'),
      `${validIdentifier(checkpointId, 'automation checkpoint ID')}.json`,
    )
  }

  private memoryPath(definitionId: string): string {
    return join(this.rootPath, 'memory', `${validIdentifier(definitionId, 'automation definition ID')}.json`)
  }

  private get definitionsPath(): string {
    return join(this.rootPath, 'definitions.json')
  }

  private get dedupIndexPath(): string {
    return join(this.rootPath, 'indexes', 'dedup-ledger.json')
  }

  private get runIndexPath(): string {
    return join(this.rootPath, 'indexes', 'runs.json')
  }

  private get executionLocksPath(): string {
    return join(this.rootPath, 'indexes', 'execution-locks.json')
  }

  private get retentionPolicyPath(): string {
    return join(this.rootPath, 'retention-policy.json')
  }

  private get lockPath(): string {
    return join(this.rootPath, '.repository.lock')
  }
}
