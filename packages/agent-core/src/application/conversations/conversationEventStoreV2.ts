import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  AnyAppendConversationEventV2Input,
  AnyConversationEventV2,
  ConversationEventPageV2,
} from './conversationV2Types'
import { CONVERSATION_DATA_SCHEMA_VERSION } from './conversationV2Types'
import { isConversationV2Id } from './conversationV2Ids'

const DEFAULT_PAGE_LIMIT = 200
const MAX_PAGE_LIMIT = 2_000
const MAX_EVENT_LINE_BYTES = 8 * 1024 * 1024
const PAGE_READ_CHUNK_BYTES = 64 * 1024
const LOCK_TIMEOUT_MS = 5_000
const STALE_LOCK_MS = 30_000
const EVENT_TYPES = new Set([
  'conversation.created', 'conversation.renamed', 'conversation.configuration_changed', 'conversation.rewritten',
  'conversation.archived', 'conversation.restored', 'conversation.workspace_changed',
  'run.started', 'run.state_changed', 'run.completed', 'run.recovered', 'turn.started', 'turn.completed',
  'item.created', 'item.updated', 'item.completed', 'item.redacted', 'input.queued', 'input.committed', 'input.removed',
  'approval.requested', 'approval.resolved', 'approval.cancelled', 'context.compaction_started', 'context.compaction_committed',
  'context.compaction_failed', 'artifact.registered', 'artifact.linked', 'artifact.missing', 'workspace.binding_changed',
  'workspace.verification_changed', 'recovery.detected', 'recovery.applied',
])
const ITEM_KINDS = new Set([
  'user_message', 'assistant_message', 'reasoning', 'tool_call', 'tool_result', 'approval', 'file_change', 'command_execution',
  'browser_activity', 'computer_activity', 'subagent', 'artifact', 'plan', 'context_compaction', 'notification', 'recovery',
])
const EVENT_SOURCES = new Set(['user', 'agent', 'flow', 'runtime', 'migration', 'recovery'])
const EVENT_PROVENANCE = new Set(['live', 'restored', 'migrated', 'imported'])
const AGENT_MODES = new Set(['vibe', 'plan'])
const APPROVAL_POLICIES = new Set(['ask', 'agent', 'full'])
const CONVERSATION_STATUSES = new Set(['active', 'idle', 'needs_workspace', 'archived'])
const RUN_STATUSES = new Set(['pending', 'running', 'waiting', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'])
const COMPLETED_RUN_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted'])
const ITEM_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'redacted'])
const COMPLETED_ITEM_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function finiteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value)
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || finiteNumber(value)
}

function validRunTiming(value: Record<string, unknown>): boolean {
  if (value.responseMode !== undefined && value.responseMode !== 'chat' && value.responseMode !== 'task') return false
  if (value.executionSegments === undefined) return true
  return Array.isArray(value.executionSegments) && value.executionSegments.every((value, index, segments) => {
    const segment = objectRecord(value)
    if (!segment || !finiteNumber(segment.startedAt) || !optionalNumber(segment.endedAt)) return false
    if (segment.endedAt !== undefined && Number(segment.endedAt) < Number(segment.startedAt)) return false
    if (segment.endedAt === undefined && index !== segments.length - 1) return false
    if (index > 0 && Number(segment.startedAt) < Number(objectRecord(segments[index - 1])?.endedAt)) return false
    return segment.outcome === undefined || ['paused', 'stopped', 'completed', 'interrupted', 'failed'].includes(String(segment.outcome))
  })
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function portablePath(value: unknown): boolean {
  const path = objectRecord(value)
  if (!path || typeof path.scheme !== 'string') return false
  if (path.scheme === 'workspace') return typeof path.workspaceId === 'string' && typeof path.relativePath === 'string'
  if (path.scheme === 'artifact') return typeof path.artifactId === 'string'
  if (path.scheme === 'profile') return typeof path.relativePath === 'string'
  return path.scheme === 'external' && typeof path.displayPath === 'string' && (path.portability === 'redacted' || path.portability === 'unavailable')
}

function optionalPortablePaths(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(portablePath))
}

function validItemPayload(kind: string, value: unknown): boolean {
  const payload = objectRecord(value)
  if (!payload) return false
  switch (kind) {
    case 'user_message': return typeof payload.text === 'string' && stringArray(payload.attachmentIds)
    case 'assistant_message': return typeof payload.text === 'string' && (payload.citations === undefined || stringArray(payload.citations))
    case 'reasoning': return typeof payload.omitted === 'boolean' && optionalString(payload.text) && optionalString(payload.summary)
    case 'tool_call': return typeof payload.toolCallId === 'string' && typeof payload.toolName === 'string'
      && Boolean(objectRecord(payload.arguments)) && optionalPortablePaths(payload.pathRefs)
      && (payload.requiresReview === undefined || typeof payload.requiresReview === 'boolean')
    case 'tool_result': return typeof payload.toolCallId === 'string' && typeof payload.toolName === 'string'
      && typeof payload.output === 'string' && typeof payload.isError === 'boolean' && optionalPortablePaths(payload.pathRefs)
    case 'approval': return typeof payload.requestId === 'string' && (payload.requestKind === 'permission' || payload.requestKind === 'input')
      && typeof payload.question === 'string' && optionalString(payload.decision)
      && (payload.policy === undefined || APPROVAL_POLICIES.has(String(payload.policy)))
    case 'file_change': return portablePath(payload.path) && ['created', 'modified', 'deleted', 'renamed'].includes(String(payload.change))
      && (payload.previousPath === undefined || portablePath(payload.previousPath))
    case 'command_execution': return typeof payload.command === 'string' && (payload.cwd === undefined || portablePath(payload.cwd))
      && optionalNumber(payload.exitCode) && optionalString(payload.output) && typeof payload.requiresReview === 'boolean'
    case 'browser_activity': return typeof payload.action === 'string' && optionalString(payload.url) && optionalString(payload.title) && optionalString(payload.result)
    case 'computer_activity': return typeof payload.action === 'string' && optionalString(payload.application) && optionalString(payload.result)
    case 'subagent': return typeof payload.agentId === 'string' && typeof payload.task === 'string' && optionalString(payload.result)
    case 'artifact': return typeof payload.artifactId === 'string' && typeof payload.name === 'string' && optionalString(payload.mime)
      && (payload.path === undefined || portablePath(payload.path)) && optionalString(payload.digest) && optionalNumber(payload.size)
    case 'plan': return Array.isArray(payload.steps) && payload.steps.every(value => {
      const step = objectRecord(value)
      return Boolean(step && typeof step.id === 'string' && typeof step.title === 'string' && typeof step.status === 'string')
    })
    case 'context_compaction': return stringArray(payload.sourceItemIds) && optionalString(payload.summary) && optionalString(payload.model) && optionalString(payload.error)
    case 'notification': return ['info', 'success', 'warning', 'error'].includes(String(payload.level)) && typeof payload.message === 'string'
    case 'recovery': return typeof payload.reason === 'string' && Number.isSafeInteger(payload.repairedThroughSeq)
      && Number(payload.repairedThroughSeq) >= 0 && optionalString(payload.preservedCorruptCopy)
    default: return false
  }
}

function assertEventPayload(event: Partial<AnyConversationEventV2>): void {
  const payload = objectRecord(event.payload)
  if (!payload) throw new Error('Invalid Conversation V2 event payload')
  const string = (key: string) => typeof payload[key] === 'string'
  const number = (key: string) => finiteNumber(payload[key])
  const optional = (key: string) => optionalString(payload[key])
  let valid = false
  switch (event.type) {
    case 'conversation.created': {
      const record = objectRecord(payload.record)
      valid = Boolean(record && record.schemaVersion === 2 && typeof record.id === 'string' && typeof record.profileId === 'string'
        && (record.workspaceId === null || typeof record.workspaceId === 'string') && typeof record.title === 'string'
        && ['generated', 'custom'].includes(String(record.titleSource)) && AGENT_MODES.has(String(record.mode))
        && typeof record.provider === 'string' && typeof record.model === 'string' && CONVERSATION_STATUSES.has(String(record.status))
        && finiteNumber(record.createdAt) && finiteNumber(record.updatedAt) && optionalNumber(record.archivedAt)
        && Number.isSafeInteger(record.lastEventSeq) && Number(record.lastEventSeq) >= 0
        && Number.isSafeInteger(record.turnCount) && Number(record.turnCount) >= 0
        && Number.isSafeInteger(record.runCount) && Number(record.runCount) >= 0 && stringArray(record.tags))
      break
    }
    case 'conversation.renamed': valid = string('title') && ['generated', 'custom'].includes(String(payload.titleSource)); break
    case 'conversation.configuration_changed': valid = AGENT_MODES.has(String(payload.mode)) && string('provider') && string('model'); break
    case 'conversation.rewritten': valid = stringArray(payload.retainedTurnIds) && number('rewrittenAt'); break
    case 'conversation.archived': valid = number('archivedAt'); break
    case 'conversation.restored': valid = Object.keys(payload).length === 0; break
    case 'conversation.workspace_changed': valid = (payload.workspaceId === null || string('workspaceId')) && CONVERSATION_STATUSES.has(String(payload.status)); break
    case 'run.started': {
      const run = objectRecord(payload.run)
      valid = Boolean(run && stringValue(run.id) && stringValue(run.conversationId) && (run.workspaceId === null || stringValue(run.workspaceId))
        && stringValue(run.objective) && RUN_STATUSES.has(String(run.status)) && optionalString(run.provider) && optionalString(run.model)
        && finiteNumber(run.startedAt) && finiteNumber(run.updatedAt) && optionalNumber(run.completedAt) && optionalString(run.outcome)
        && (run.recoveredFromPersistence === undefined || typeof run.recoveredFromPersistence === 'boolean') && validRunTiming(run))
      break
    }
    case 'run.state_changed': valid = RUN_STATUSES.has(String(payload.status)) && number('updatedAt') && optional('outcome') && validRunTiming(payload); break
    case 'run.completed': valid = COMPLETED_RUN_STATUSES.has(String(payload.status)) && number('completedAt') && optional('outcome') && validRunTiming(payload); break
    case 'run.recovered': valid = string('reason') && number('recoveredAt'); break
    case 'turn.started': {
      const turn = objectRecord(payload.turn)
      valid = Boolean(turn && stringValue(turn.id) && stringValue(turn.conversationId) && optionalString(turn.runId)
        && ['user', 'assistant', 'system'].includes(String(turn.role)) && ['started', 'completed', 'interrupted'].includes(String(turn.status))
        && finiteNumber(turn.createdAt) && optionalNumber(turn.completedAt))
      break
    }
    case 'turn.completed': valid = number('completedAt') && (payload.interrupted === undefined || typeof payload.interrupted === 'boolean'); break
    case 'item.created': {
      const item = objectRecord(payload.item)
      valid = Boolean(item && item.schemaVersion === 1 && stringValue(item.id) && stringValue(item.conversationId)
        && optionalString(item.runId) && optionalString(item.turnId) && ITEM_KINDS.has(String(item.kind))
        && ITEM_STATUSES.has(String(item.status)) && finiteNumber(item.createdAt) && finiteNumber(item.updatedAt)
        && validItemPayload(String(item.kind), item.payload))
      break
    }
    case 'item.updated': valid = (payload.status === undefined || ITEM_STATUSES.has(String(payload.status))) && number('updatedAt')
      && (payload.payload === undefined || Boolean(objectRecord(payload.payload))); break
    case 'item.completed': valid = COMPLETED_ITEM_STATUSES.has(String(payload.status)) && number('completedAt'); break
    case 'item.redacted': valid = string('reason') && number('redactedAt'); break
    case 'input.queued': valid = string('inputId') && string('text'); break
    case 'input.committed': valid = string('inputId'); break
    case 'input.removed': valid = string('inputId') && string('reason'); break
    case 'approval.requested': valid = string('requestId') && ['permission', 'input'].includes(String(payload.requestKind)) && string('question'); break
    case 'approval.resolved': valid = string('requestId') && optional('decision'); break
    case 'approval.cancelled': valid = string('requestId') && string('reason'); break
    case 'context.compaction_started': valid = string('compactionId') && stringArray(payload.sourceItemIds); break
    case 'context.compaction_committed': valid = string('compactionId') && string('itemId') && optional('summary') && optional('model'); break
    case 'context.compaction_failed': valid = string('compactionId') && string('error'); break
    case 'artifact.registered':
    case 'artifact.linked': valid = string('artifactId') && string('itemId'); break
    case 'artifact.missing': valid = string('artifactId') && string('reason'); break
    case 'workspace.binding_changed': valid = string('workspaceId') && ['bound', 'unbound', 'missing', 'mismatch'].includes(String(payload.state)) && number('at'); break
    case 'workspace.verification_changed': valid = string('workspaceId') && ['verifying', 'bound', 'missing', 'mismatch'].includes(String(payload.state)) && number('at'); break
    case 'recovery.detected': valid = string('reason') && Number.isSafeInteger(payload.throughSeq) && Number(payload.throughSeq) >= 0 && optional('preservedCorruptCopy'); break
    case 'recovery.applied': valid = string('reason') && Number.isSafeInteger(payload.throughSeq) && Number(payload.throughSeq) >= 0; break
  }
  if (!valid) throw new Error(`Invalid Conversation V2 payload for ${String(event.type)}`)
}

function stringValue(value: unknown): boolean {
  return typeof value === 'string'
}

export interface ConversationEventAppendReceiptV2 {
  conversationId: string
  firstSeq: number
  lastSeq: number
  appended: number
  duplicateEventIds: string[]
}

export interface ConversationEventRecoveryV2 {
  conversationId: string
  repaired: boolean
  throughSeq: number
  corruptCopyPath?: string
}

export interface ConversationEventStoreV2Options {
  onPageRead?: (bytes: number, path: string) => void
}

function requireId(label: string, value: string): void {
  if (!isConversationV2Id(value)) throw new Error(`Invalid ${label}: ${value}`)
}

export function parseConversationEventV2(value: unknown): AnyConversationEventV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Conversation V2 event')
  const event = value as Partial<AnyConversationEventV2>
  if (event.schemaVersion !== CONVERSATION_DATA_SCHEMA_VERSION
    || typeof event.eventId !== 'string'
    || typeof event.profileId !== 'string'
    || typeof event.conversationId !== 'string'
    || !Number.isSafeInteger(event.seq)
    || Number(event.seq) <= 0
    || !finiteNumber(event.at)
    || typeof event.source !== 'string'
    || !EVENT_SOURCES.has(event.source)
    || typeof event.provenance !== 'string'
    || !EVENT_PROVENANCE.has(event.provenance)
    || (event.legacyEventId !== undefined && typeof event.legacyEventId !== 'string')
    || typeof event.type !== 'string'
    || !EVENT_TYPES.has(event.type)
    || !event.payload
    || typeof event.payload !== 'object') throw new Error('Invalid Conversation V2 event')
  requireId('event id', event.eventId)
  requireId('profile id', event.profileId)
  requireId('conversation id', event.conversationId)
  if (event.workspaceId !== undefined) requireId('workspace id', event.workspaceId)
  if (event.runId !== undefined) requireId('run id', event.runId)
  if (event.turnId !== undefined) requireId('turn id', event.turnId)
  if (event.itemId !== undefined) requireId('item id', event.itemId)
  if (event.type === 'conversation.created') {
    const record = (event.payload as { record?: unknown }).record
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid Conversation V2 record')
    const candidate = record as { id?: unknown; profileId?: unknown; workspaceId?: unknown }
    if (typeof candidate.id !== 'string' || typeof candidate.profileId !== 'string') throw new Error('Invalid Conversation V2 record')
    requireId('conversation id', candidate.id)
    requireId('profile id', candidate.profileId)
    if (typeof candidate.workspaceId === 'string') requireId('workspace id', candidate.workspaceId)
    if (candidate.id !== event.conversationId
      || candidate.profileId !== event.profileId
      || (event.workspaceId !== undefined && candidate.workspaceId !== event.workspaceId)) {
      throw new Error('Conversation V2 record identity does not match its event envelope')
    }
  }
  if (event.type === 'run.started') {
    const run = (event.payload as { run?: unknown }).run
    if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error('Invalid Conversation V2 run')
    const candidate = run as { id?: unknown; conversationId?: unknown; workspaceId?: unknown }
    if (typeof candidate.id !== 'string' || typeof candidate.conversationId !== 'string') throw new Error('Invalid Conversation V2 run')
    requireId('run id', candidate.id)
    if (typeof candidate.workspaceId === 'string') requireId('workspace id', candidate.workspaceId)
    if (candidate.id !== event.runId
      || candidate.conversationId !== event.conversationId
      || (event.workspaceId !== undefined && candidate.workspaceId !== event.workspaceId)) {
      throw new Error('Conversation V2 run identity does not match its event envelope')
    }
  }
  if (event.type === 'turn.started') {
    const turn = (event.payload as { turn?: unknown }).turn
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) throw new Error('Invalid Conversation V2 turn')
    const candidate = turn as { id?: unknown; conversationId?: unknown; runId?: unknown }
    if (typeof candidate.id !== 'string' || typeof candidate.conversationId !== 'string') throw new Error('Invalid Conversation V2 turn')
    requireId('turn id', candidate.id)
    if (typeof candidate.runId === 'string') requireId('run id', candidate.runId)
    if (candidate.id !== event.turnId
      || candidate.conversationId !== event.conversationId
      || (event.runId !== undefined && candidate.runId !== event.runId)) {
      throw new Error('Conversation V2 turn identity does not match its event envelope')
    }
  }
  if (event.type === 'item.created') {
    const item = (event.payload as { item?: unknown }).item
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid Conversation V2 item')
    const candidate = item as { schemaVersion?: unknown; id?: unknown; conversationId?: unknown; runId?: unknown; turnId?: unknown; kind?: unknown; payload?: unknown }
    if (candidate.schemaVersion !== 1
      || typeof candidate.id !== 'string'
      || candidate.conversationId !== event.conversationId
      || typeof candidate.kind !== 'string'
      || !ITEM_KINDS.has(candidate.kind)
      || !candidate.payload
      || typeof candidate.payload !== 'object') throw new Error('Invalid Conversation V2 item')
    requireId('item id', candidate.id)
    if (typeof candidate.runId === 'string') requireId('run id', candidate.runId)
    if (typeof candidate.turnId === 'string') requireId('turn id', candidate.turnId)
    if (event.itemId !== candidate.id
      || (event.runId !== undefined && event.runId !== candidate.runId)
      || (event.turnId !== undefined && event.turnId !== candidate.turnId)) {
      throw new Error('Conversation V2 item identity does not match its event envelope')
    }
  }
  assertEventPayload(event)
  return event as AnyConversationEventV2
}

function parseJournal(content: string, conversationId: string): { events: AnyConversationEventV2[]; validBytes: number; truncated: boolean } {
  const events: AnyConversationEventV2[] = []
  let byteOffset = 0
  let validBytes = 0
  let previousSeq = 0
  let profileId: string | undefined
  const eventIds = new Set<string>()
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const lineBytes = Buffer.byteLength(line) + (index < lines.length - 1 ? 1 : 0)
    if (!line.trim()) {
      byteOffset += lineBytes
      validBytes = byteOffset
      continue
    }
    try {
      if (Buffer.byteLength(line) > MAX_EVENT_LINE_BYTES) throw new Error('Conversation event exceeds size budget')
      const event = parseConversationEventV2(JSON.parse(line))
      if (event.conversationId !== conversationId) throw new Error('Conversation event identity does not match its journal')
      if (profileId !== undefined && event.profileId !== profileId) throw new Error('Conversation event profile identity changed within its journal')
      if (eventIds.has(event.eventId)) throw new Error('Conversation event identity is duplicated within its journal')
      if (event.seq !== previousSeq + 1) throw new Error('Conversation event sequence is not contiguous')
      events.push(event)
      profileId = event.profileId
      eventIds.add(event.eventId)
      previousSeq = event.seq
      byteOffset += lineBytes
      validBytes = byteOffset
    } catch {
      return { events, validBytes, truncated: true }
    }
  }
  return { events, validBytes, truncated: false }
}

export class ConversationEventStoreV2 {
  private readonly root: string

  constructor(
    root: string,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID,
    private readonly options: ConversationEventStoreV2Options = {},
  ) {
    this.root = resolve(root)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }

  append(inputs: readonly AnyAppendConversationEventV2Input[]): ConversationEventAppendReceiptV2 {
    if (inputs.length === 0) throw new Error('At least one Conversation V2 event is required')
    const conversationId = inputs[0]!.conversationId
    const profileId = inputs[0]!.profileId
    requireId('conversation id', conversationId)
    requireId('profile id', profileId)
    if (inputs.some(input => input.conversationId !== conversationId)) throw new Error('A single append batch cannot span conversations')
    if (inputs.some(input => input.profileId !== profileId)) throw new Error('A single Conversation V2 journal cannot span profiles')
    return this.withConversationLock(conversationId, () => {
      const existing = this.readAll(conversationId)
      if (existing.some(event => event.profileId !== profileId)) throw new Error('Conversation V2 profile identity does not match its journal')
      const existingIds = new Set(existing.map(event => event.eventId))
      const duplicateEventIds: string[] = []
      const batchIds = new Set<string>()
      const pending: AnyConversationEventV2[] = []
      let nextSeq = existing.length + 1
      for (const input of inputs) {
        requireId('profile id', input.profileId)
        const eventId = input.eventId ?? this.createId()
        requireId('event id', eventId)
        if (existingIds.has(eventId) || batchIds.has(eventId)) {
          duplicateEventIds.push(eventId)
          continue
        }
        batchIds.add(eventId)
        const candidate = {
          ...input,
          schemaVersion: CONVERSATION_DATA_SCHEMA_VERSION,
          eventId,
          seq: nextSeq,
          at: input.at ?? this.now(),
        }
        pending.push(parseConversationEventV2(candidate))
        nextSeq += 1
      }
      if (pending.length > 0) {
        const payload = pending.map(event => JSON.stringify(event)).join('\n') + '\n'
        const handle = openSync(this.pathFor(conversationId), 'a', 0o600)
        try {
          writeSync(handle, payload)
          fsyncSync(handle)
        } finally {
          closeSync(handle)
        }
      }
      return {
        conversationId,
        firstSeq: pending[0]?.seq ?? existing.length,
        lastSeq: pending.at(-1)?.seq ?? existing.length,
        appended: pending.length,
        duplicateEventIds,
      }
    })
  }

  read(conversationId: string, afterSeq = 0, limit = DEFAULT_PAGE_LIMIT): ConversationEventPageV2 {
    requireId('conversation id', conversationId)
    const path = this.pathFor(conversationId)
    if (!existsSync(path)) return { events: [], nextSeq: null }
    const pageLimit = Math.min(Math.max(1, limit), MAX_PAGE_LIMIT)
    const events: AnyConversationEventV2[] = []
    const handle = openSync(path, 'r')
    const readBuffer = Buffer.allocUnsafe(PAGE_READ_CHUNK_BYTES)
    let pending = Buffer.alloc(0)
    let previousSeq = 0
    let profileId: string | undefined
    const eventIds = new Set<string>()
    let hasMore = false
    const consume = (line: Buffer): boolean => {
      if (!line.toString('utf8').trim()) return false
      try {
        if (line.length > MAX_EVENT_LINE_BYTES) throw new Error('Conversation event exceeds size budget')
        const event = parseConversationEventV2(JSON.parse(line.toString('utf8')))
        if (event.conversationId !== conversationId) throw new Error('Conversation event identity does not match its journal')
        if (profileId !== undefined && event.profileId !== profileId) throw new Error('Conversation event profile identity changed within its journal')
        if (eventIds.has(event.eventId)) throw new Error('Conversation event identity is duplicated within its journal')
        if (event.seq !== previousSeq + 1) throw new Error('Conversation event sequence is not contiguous')
        previousSeq = event.seq
        profileId = event.profileId
        eventIds.add(event.eventId)
        if (event.seq <= afterSeq) return false
        if (events.length < pageLimit) {
          events.push(event)
          return false
        }
        hasMore = true
        return true
      } catch {
        throw new Error(`Conversation V2 journal requires recovery: ${conversationId}`)
      }
    }
    try {
      while (!hasMore) {
        const bytesRead = readSync(handle, readBuffer, 0, readBuffer.length, null)
        if (bytesRead === 0) break
        this.options.onPageRead?.(bytesRead, path)
        const chunk = readBuffer.subarray(0, bytesRead)
        const content = pending.length ? Buffer.concat([pending, chunk]) : chunk
        let lineStart = 0
        let lineEnd = content.indexOf(10, lineStart)
        while (lineEnd >= 0) {
          if (consume(content.subarray(lineStart, lineEnd))) break
          lineStart = lineEnd + 1
          lineEnd = content.indexOf(10, lineStart)
        }
        if (hasMore) break
        pending = Buffer.from(content.subarray(lineStart))
        if (pending.length > MAX_EVENT_LINE_BYTES) throw new Error(`Conversation V2 journal requires recovery: ${conversationId}`)
      }
      if (!hasMore && pending.length > 0) consume(pending)
      return { events, nextSeq: hasMore ? events.at(-1)!.seq : null }
    } finally {
      closeSync(handle)
    }
  }

  readAll(conversationId: string): AnyConversationEventV2[] {
    requireId('conversation id', conversationId)
    const path = this.pathFor(conversationId)
    if (!existsSync(path)) return []
    const parsed = parseJournal(readFileSync(path, 'utf8'), conversationId)
    if (parsed.truncated) throw new Error(`Conversation V2 journal requires recovery: ${conversationId}`)
    return parsed.events
  }

  recover(conversationId: string): ConversationEventRecoveryV2 {
    requireId('conversation id', conversationId)
    const path = this.pathFor(conversationId)
    if (!existsSync(path)) return { conversationId, repaired: false, throughSeq: 0 }
    const content = readFileSync(path, 'utf8')
    const parsed = parseJournal(content, conversationId)
    if (!parsed.truncated) return { conversationId, repaired: false, throughSeq: parsed.events.length }
    const corruptCopyPath = `${path}.corrupt-${this.now()}`
    writeFileSync(corruptCopyPath, content, { mode: 0o600 })
    const repairedPath = `${path}.repair-${this.createId()}`
    writeFileSync(repairedPath, Buffer.from(content).subarray(0, parsed.validBytes), { mode: 0o600 })
    renameSync(repairedPath, path)
    return { conversationId, repaired: true, throughSeq: parsed.events.length, corruptCopyPath }
  }

  private pathFor(conversationId: string): string {
    return join(this.root, `${conversationId}.jsonl`)
  }

  private withConversationLock<T>(conversationId: string, action: () => T): T {
    const lockPath = join(this.root, `.${conversationId}.lock`)
    const startedAt = Date.now()
    let handle: number | undefined
    while (handle === undefined) {
      try {
        handle = openSync(lockPath, 'wx', 0o600)
        writeSync(handle, `${process.pid}\n${Date.now()}\n`)
        fsyncSync(handle)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw error
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
            rmSync(lockPath, { force: true })
            continue
          }
        } catch {}
        if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
          throw new Error(`Conversation V2 writer lock timed out: ${conversationId}`, { cause: error })
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    try {
      return action()
    } finally {
      closeSync(handle)
      rmSync(lockPath, { force: true })
    }
  }
}
