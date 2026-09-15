import { createHash, randomUUID } from 'node:crypto'
import {
  cpSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ConversationRepositoryV2 } from './conversationRepositoryV2'
import { ConversationInteractionStoreV2 } from './conversationInteractionStoreV2'
import { planConversationV2Migration } from './conversationV2Migration'
import { ConversationStore } from './store'
import type { PersistedConversation } from './types'

const RECEIPT_SCHEMA_VERSION = 2 as const

export interface ConversationV2MigrationReceipt {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION
  migrationId: string
  status: 'completed'
  profileId: string
  startedAt: number
  completedAt: number
  source: {
    schemaVersion: 1
    digest: string
    conversationCount: number
    retained: true
  }
  target: {
    schemaVersion: 2
    conversationCount: number
    eventCount: number
    lastSequences: Record<string, number>
  }
  reconciliation: {
    turns: number
    messageItems: number
    toolCalls: number
    toolResults: number
    runs: number
    approvals: number
    contextCompactions: number
    plans: number
    activities: number
    artifacts: number
    recoveries: number
    canonicalEvents: number
  }
  warnings: string[]
}

export interface ConversationV2MigrationServiceOptions {
  profileId: string
  conversationsRoot: string
  conversationsV2Root: string
  interactionRoot?: string
  workspaceIdForConversation: (conversation: PersistedConversation) => string
  now?: () => number
  createId?: () => string
}

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

function conversationIds(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.startsWith('.'))
    .map(entry => entry.name.slice(0, -'.jsonl'.length))
    .filter(id => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id))
    .sort()
}

function sourceDigest(root: string, ids: readonly string[]): string {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  for (const id of ids) {
    hash.update(id).update('\0')
    const descriptor = openSync(join(root, `${id}.jsonl`), 'r')
    try {
      for (let bytesRead = readSync(descriptor, buffer, 0, buffer.length, null); bytesRead > 0; bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) {
        hash.update(buffer.subarray(0, bytesRead))
      }
    } finally {
      closeSync(descriptor)
    }
    hash.update('\0')
  }
  return hash.digest('hex')
}

function readReceipt(path: string): ConversationV2MigrationReceipt | null {
  if (!existsSync(path)) return null
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ConversationV2MigrationReceipt>
  if ((value as { schemaVersion?: number }).schemaVersion === 1) return null
  if (value.schemaVersion !== RECEIPT_SCHEMA_VERSION) throw new Error('Unsupported Conversation V2 migration receipt version')
  return value.status === 'completed' && typeof value.source?.digest === 'string'
    ? value as ConversationV2MigrationReceipt
    : null
}

function meaningfulConversation(conversation: PersistedConversation): boolean {
  return conversation.turns.length > 0
    || Boolean(conversation.canonicalEvents?.length)
    || Boolean(conversation.workExecution)
    || Boolean(conversation.contextCompactionState)
}

export function migrateConversationStoreV1ToV2(options: ConversationV2MigrationServiceOptions): ConversationV2MigrationReceipt {
  const now = options.now ?? Date.now
  const createId = options.createId ?? randomUUID
  const targetRoot = resolve(options.conversationsV2Root)
  const receiptPath = join(targetRoot, 'migration-receipt.json')
  const ids = conversationIds(options.conversationsRoot)
  const digest = sourceDigest(options.conversationsRoot, ids)
  const previousReceipt = readReceipt(receiptPath)
  if (previousReceipt?.source.digest === digest) return previousReceipt

  const migrationId = `conversation-v2-${createId()}`
  const startedAt = now()
  const stagingRoot = `${targetRoot}.migrating-${migrationId}`
  const backupRoot = `${targetRoot}.backup-${migrationId}`
  const interactionRoot = resolve(options.interactionRoot ?? join(dirname(targetRoot), 'interaction'))
  const stagingInteractionRoot = `${interactionRoot}.migrating-${migrationId}`
  const backupInteractionRoot = `${interactionRoot}.backup-${migrationId}`
  const failureReceiptPath = join(dirname(targetRoot), 'conversation-v2-migration-failure.json')
  rmSync(stagingRoot, { recursive: true, force: true })
  rmSync(backupRoot, { recursive: true, force: true })
  rmSync(stagingInteractionRoot, { recursive: true, force: true })
  rmSync(backupInteractionRoot, { recursive: true, force: true })
  mkdirSync(dirname(targetRoot), { recursive: true, mode: 0o700 })
  if (existsSync(targetRoot)) cpSync(targetRoot, stagingRoot, { recursive: true, force: false, errorOnExist: true })
  else mkdirSync(stagingRoot, { recursive: true, mode: 0o700 })
  if (existsSync(interactionRoot)) cpSync(interactionRoot, stagingInteractionRoot, { recursive: true, force: false, errorOnExist: true })
  else mkdirSync(stagingInteractionRoot, { recursive: true, mode: 0o700 })

  try {
    const repository = new ConversationRepositoryV2(stagingRoot, now)
    const interactionStore = new ConversationInteractionStoreV2(stagingInteractionRoot, options.profileId, now)
    const lastSequences: Record<string, number> = {}
    const warnings: string[] = []
    let eventCount = 0
    let turns = 0
    let messageItems = 0
    let toolCalls = 0
    let toolResults = 0
    let runs = 0
    let approvals = 0
    let contextCompactions = 0
    let plans = 0
    let activities = 0
    let artifacts = 0
    let recoveries = 0
    let canonicalEvents = 0
    const migratedIds = new Set<string>()
    const legacyStore = new ConversationStore(options.conversationsRoot)
    for (const id of ids) {
      const conversation = legacyStore.load(id)
      if (!conversation || !meaningfulConversation(conversation)) continue
      migratedIds.add(conversation.id)
      const workspaceId = options.workspaceIdForConversation(conversation)
      const plan = planConversationV2Migration(options.profileId, conversation, { workspaceId })
      repository.append(plan.events)
      const projection = repository.projection(conversation.id)
      const expectedItems = plan.counts.messageItems + plan.counts.toolCalls + plan.counts.toolResults
      if (!projection.conversation
        || projection.conversation.profileId !== options.profileId
        || projection.turns.length < plan.counts.turns
        || projection.items.length < expectedItems
        || projection.runs.length < plan.counts.runs
        || projection.items.filter(item => item.kind === 'approval').length < plan.counts.approvals
        || projection.items.filter(item => item.kind === 'context_compaction').length < plan.counts.contextCompactions
        || projection.items.filter(item => item.kind === 'plan').length < plan.counts.plans
        || projection.artifacts.length < plan.counts.artifacts
        || projection.items.filter(item => item.kind === 'recovery').length < plan.counts.recoveries) {
        throw new Error(`Conversation V2 reconciliation failed: ${conversation.id}`)
      }
      if (conversation.interactionState) {
        interactionStore.save(conversation.id, {
          queuedInputs: conversation.interactionState.queuedInputs,
          draft: conversation.interactionState.draft,
          pendingSteering: conversation.interactionState.pendingSteering,
          pendingApprovals: [],
          workflow: conversation.interactionState.workflow,
        })
      }
      eventCount += projection.throughSeq
      lastSequences[conversation.id] = projection.throughSeq
      turns += plan.counts.turns
      messageItems += plan.counts.messageItems
      toolCalls += plan.counts.toolCalls
      toolResults += plan.counts.toolResults
      runs += plan.counts.runs
      approvals += plan.counts.approvals
      contextCompactions += plan.counts.contextCompactions
      plans += plan.counts.plans
      activities += plan.counts.activities
      artifacts += plan.counts.artifacts
      recoveries += plan.counts.recoveries
      canonicalEvents += plan.counts.canonicalEvents
      warnings.push(...plan.warnings.map(warning => `${conversation.id}: ${warning}`))
    }
    const catalog = repository.rebuildCatalog()
    if (catalog.records.filter(record => migratedIds.has(record.id)).length !== migratedIds.size) {
      throw new Error('Conversation V2 catalog reconciliation failed')
    }
    const receipt: ConversationV2MigrationReceipt = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      migrationId,
      status: 'completed',
      profileId: options.profileId,
      startedAt,
      completedAt: now(),
      source: { schemaVersion: 1, digest, conversationCount: migratedIds.size, retained: true },
      target: { schemaVersion: 2, conversationCount: catalog.records.length, eventCount, lastSequences },
      reconciliation: { turns, messageItems, toolCalls, toolResults, runs, approvals, contextCompactions, plans, activities, artifacts, recoveries, canonicalEvents },
      warnings,
    }
    atomicJson(join(stagingRoot, 'migration-receipt.json'), receipt)
    let targetBackedUp = false
    let interactionBackedUp = false
    let targetCommitted = false
    let interactionCommitted = false
    try {
      if (existsSync(targetRoot)) {
        renameSync(targetRoot, backupRoot)
        targetBackedUp = true
      }
      if (existsSync(interactionRoot)) {
        renameSync(interactionRoot, backupInteractionRoot)
        interactionBackedUp = true
      }
      renameSync(stagingRoot, targetRoot)
      targetCommitted = true
      renameSync(stagingInteractionRoot, interactionRoot)
      interactionCommitted = true
    } catch (error) {
      if (targetCommitted) rmSync(targetRoot, { recursive: true, force: true })
      if (interactionCommitted) rmSync(interactionRoot, { recursive: true, force: true })
      if (targetBackedUp && existsSync(backupRoot)) renameSync(backupRoot, targetRoot)
      if (interactionBackedUp && existsSync(backupInteractionRoot)) renameSync(backupInteractionRoot, interactionRoot)
      throw error
    }
    rmSync(backupRoot, { recursive: true, force: true })
    rmSync(backupInteractionRoot, { recursive: true, force: true })
    rmSync(failureReceiptPath, { force: true })
    return receipt
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true })
    rmSync(stagingInteractionRoot, { recursive: true, force: true })
    atomicJson(failureReceiptPath, {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      migrationId,
      status: 'failed',
      profileId: options.profileId,
      startedAt,
      failedAt: now(),
      sourceDigest: digest,
      error: error instanceof Error ? error.message : String(error),
      sourceRetained: true,
    })
    throw error
  }
}
