import { isModelRequestRecord } from '@turboflux/contracts/modelUsage'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { withFileLockSync } from '@turboflux/platform/fileIO'
import { ConversationEventStoreV2, parseConversationEventV2, type ConversationEventAppendReceiptV2 } from './conversationEventStoreV2'
import { createConversationProjector, projectConversationEvents, type ConversationProjectionReducerState } from './conversationProjections'
import { conversationJournalVersion } from './conversationJournalIndex'
import { stableConversationV2Id } from './conversationV2Ids'
import type {
  AnyAppendConversationEventV2Input,
  AnyConversationEventV2,
  ConversationRecordV2,
  ConversationTranscriptProjectionV2,
} from './conversationV2Types'

const CATALOG_SCHEMA_VERSION = 1 as const
const SNAPSHOT_SCHEMA_VERSION = 2 as const
const SEARCH_INDEX_SCHEMA_VERSION = 2 as const
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const MIN_INCREMENTAL_EVENTS = 128
const MAX_DELTA_EVENTS = 64
const MAX_DELTA_BYTES = 256 * 1024

interface ConversationCatalogV2File {
  schemaVersion: typeof CATALOG_SCHEMA_VERSION
  records: ConversationRecordV2[]
  updatedAt: number
}

interface ConversationProjectionSnapshotV2 {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION
  conversationId: string
  throughSeq: number
  journalVersion: string
  createdAt: number
  checksum: string
  projection: ConversationTranscriptProjectionV2
  reducer: ConversationProjectionReducerState
}

interface ProjectionWatermark {
  throughSeq: number
  journalVersion: string
  baseSeq?: number
  snapshotChecksum?: string
  deltaChecksum?: string
}

interface ProjectionDelta {
  schemaVersion: 1
  conversationId: string
  baseSeq: number
  throughSeq: number
  journalVersion: string
  events: AnyConversationEventV2[]
}

interface CachedProjection {
  conversationId: string
  journalVersion: string
  snapshotVersion: string
  deltaVersion: string
  baseSeq: number
  snapshotChecksum: string
  deltaChecksum?: string
  events: AnyConversationEventV2[]
  projector: ReturnType<typeof createConversationProjector>
}

interface ProjectionWatermarks {
  schemaVersion: 1
  conversations: Record<string, ProjectionWatermark>
}

interface ConversationSearchIndexEntryV2 extends ConversationSearchResultV2 {
  text: string
}

interface ConversationSearchIndexV2File {
  schemaVersion: typeof SEARCH_INDEX_SCHEMA_VERSION
  entries: ConversationSearchIndexEntryV2[]
  updatedAt: number
}

interface ConversationCatalogCursorV2 {
  version: 2
  sort: NonNullable<ConversationListQueryV2['sort']>
  queryKey: string
  value: number
  id: string
}

export interface ConversationRepositoryV2Options {
  onRead?: (kind: 'catalog' | 'snapshot' | 'search-index', path: string) => void
  onEventPageRead?: (bytes: number, path: string) => void
  onEventIndexRead?: (bytes: number, path: string) => void
  onProjectionReplay?: (events: number, mode: 'full' | 'delta') => void
}

export interface ConversationListQueryV2 {
  cursor?: string
  limit?: number
  query?: string
  workspaceId?: string
  status?: ConversationRecordV2['status']
  sort?: 'updated_desc' | 'updated_asc' | 'created_desc' | 'created_asc'
}

export interface ConversationPageV2 {
  conversations: ConversationRecordV2[]
  nextCursor: string | null
  total: number
}

export interface ConversationSearchResultV2 {
  conversationId: string
  itemId?: string
  kind: 'title' | 'message' | 'tool' | 'artifact' | 'command'
  title: string
  excerpt: string
  workspaceId: string | null
  occurredAt: number
  updatedAt: number
}

export interface ConversationSearchQueryV2 {
  query: string
  workspaceId?: string
  from?: number
  to?: number
  kinds?: ConversationSearchResultV2['kind'][]
  limit?: number
}

export interface ConversationSearchRepositoryV2 {
  search(query: string | ConversationSearchQueryV2, legacyLimit?: number): ConversationSearchResultV2[]
}

export interface ConversationRepositoryRecoveryReceiptV2 {
  repairedJournals: string[]
  interruptedRuns: number
  interruptedItems: number
  recoveredConversations: string[]
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function syncFile(handle: number): void {
  try { fsyncSync(handle) } catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
  }
}

function recoveryEventId(kind: string, ...parts: Array<string | number>): string {
  return stableConversationV2Id(`recovery-${kind}`, ...parts)
}

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    const handle = openSync(temporary, 'r')
    try {
      syncFile(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function validCatalog(value: unknown): value is ConversationCatalogV2File {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const catalog = value as Partial<ConversationCatalogV2File>
  return catalog.schemaVersion === CATALOG_SCHEMA_VERSION
    && Array.isArray(catalog.records)
    && catalog.records.every(record => record?.schemaVersion === 2
      && typeof record.id === 'string'
      && typeof record.profileId === 'string'
      && typeof record.title === 'string'
      && Number.isSafeInteger(record.lastEventSeq))
}

function validSearchIndex(value: unknown): value is ConversationSearchIndexV2File {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const index = value as Partial<ConversationSearchIndexV2File>
  return index.schemaVersion === SEARCH_INDEX_SCHEMA_VERSION
    && Array.isArray(index.entries)
    && index.entries.every(entry => typeof entry?.conversationId === 'string'
      && ['title', 'message', 'tool', 'artifact', 'command'].includes(String(entry.kind))
      && typeof entry.title === 'string'
      && typeof entry.text === 'string'
      && (entry.workspaceId === null || typeof entry.workspaceId === 'string')
      && typeof entry.occurredAt === 'number'
      && typeof entry.updatedAt === 'number')
}

function validProjection(value: unknown): value is ConversationTranscriptProjectionV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const projection = value as Partial<ConversationTranscriptProjectionV2>
  return Array.isArray(projection.runs)
    && Array.isArray(projection.turns)
    && Array.isArray(projection.items)
    && Array.isArray(projection.timeline)
    && Array.isArray(projection.artifacts)
    && (projection.workspace === null || typeof projection.workspace === 'object')
    && Array.isArray(projection.queuedInputIds)
    && (projection.modelRequests === undefined || (Array.isArray(projection.modelRequests) && projection.modelRequests.every(isModelRequestRecord)))
    && Number.isSafeInteger(projection.throughSeq)
}

function validReducer(value: ConversationProjectionReducerState | undefined, projection: ConversationTranscriptProjectionV2): value is ConversationProjectionReducerState {
  return Boolean(value && typeof value.workspaceRequired === 'boolean'
    && (value.conversationUpdatedAt === undefined || Number.isFinite(value.conversationUpdatedAt))
    && Array.isArray(value.itemAliases) && value.itemAliases.every(alias => Array.isArray(alias) && alias.length === 2
      && typeof alias[0] === 'string' && Number.isSafeInteger(alias[1]) && alias[1] >= 0 && alias[1] < projection.items.length))
}

function catalogQueryKey(query: ConversationListQueryV2, sort: NonNullable<ConversationListQueryV2['sort']>): string {
  return digest({
    query: query.query?.trim().toLocaleLowerCase() || null,
    workspaceId: query.workspaceId || null,
    status: query.status || null,
    sort,
  })
}

function decodeCursor(
  cursor: string | undefined,
  sort: NonNullable<ConversationListQueryV2['sort']>,
  queryKey: string,
): ConversationCatalogCursorV2 | null {
  if (!cursor) return null
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<ConversationCatalogCursorV2>
    return value.version === 2
      && value.sort === sort
      && value.queryKey === queryKey
      && Number.isFinite(value.value)
      && typeof value.id === 'string'
      ? value as ConversationCatalogCursorV2
      : null
  } catch {
    return null
  }
}

function encodeCursor(cursor: ConversationCatalogCursorV2): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

export class ConversationRepositoryV2 implements ConversationSearchRepositoryV2 {
  readonly eventsRoot: string
  readonly snapshotsRoot: string
  private readonly catalogPath: string
  private readonly searchIndexPath: string
  private readonly watermarksPath: string
  private readonly projectionLockPath: string
  private readonly eventStore: ConversationEventStoreV2
  private cachedProjection?: CachedProjection

  constructor(
    root: string,
    private readonly now: () => number = Date.now,
    private readonly options: ConversationRepositoryV2Options = {},
  ) {
    const normalized = resolve(root)
    this.eventsRoot = join(normalized, 'events')
    this.snapshotsRoot = join(normalized, 'snapshots')
    this.catalogPath = join(normalized, 'catalog.json')
    this.searchIndexPath = join(normalized, 'search-index.json')
    this.watermarksPath = join(normalized, 'projection-watermarks.json')
    mkdirSync(this.eventsRoot, { recursive: true, mode: 0o700 })
    mkdirSync(this.snapshotsRoot, { recursive: true, mode: 0o700 })
    this.projectionLockPath = join(realpathSync.native(normalized), '.projections.lock')
    this.eventStore = new ConversationEventStoreV2(this.eventsRoot, now, undefined, { onPageRead: options.onEventPageRead, onIndexRead: options.onEventIndexRead })
  }

  append(events: readonly AnyAppendConversationEventV2Input[]): ConversationEventAppendReceiptV2 {
    return withFileLockSync(this.projectionLockPath, () => {
      const conversationId = events[0]?.conversationId
      if (!conversationId) return this.eventStore.append(events)
      this.snapshotPath(conversationId)
      return withFileLockSync(join(this.eventsRoot, `.${conversationId}.lock`), () => {
        const watermark = this.loadWatermarks().conversations[conversationId]
        const previous = watermark?.journalVersion === this.journalVersion(conversationId)
          ? this.loadProjection(conversationId, watermark) : undefined
        try {
          const receipt = this.eventStore.append(events)
          if (receipt.appended === 0) {
            this.ensureProjectionsCurrent(conversationId)
            return receipt
          }
          if (!previous || previous.projector.projection.throughSeq !== receipt.firstSeq - 1) {
            this.rebuildLocked(conversationId)
            return receipt
          }
          const appended: AnyConversationEventV2[] = []
          for (let cursor = receipt.firstSeq - 1; cursor < receipt.lastSeq;) {
            const page = this.eventStore.read(conversationId, cursor, Math.min(2000, receipt.lastSeq - cursor))
            if (!page.events.length) throw new Error('Committed conversation events are missing')
            appended.push(...page.events)
            cursor = page.events.at(-1)!.seq
          }
          previous.projector.apply(appended)
          this.options.onProjectionReplay?.(appended.length, 'delta')
          const pending = [...previous.events, ...appended]
          if (previous.baseSeq >= MIN_INCREMENTAL_EVENTS && pending.length <= MAX_DELTA_EVENTS
            && Buffer.byteLength(JSON.stringify(pending)) <= MAX_DELTA_BYTES
            && !appended.some(event => ['item.redacted', 'conversation.rewritten', 'conversation.archived'].includes(event.type))) {
            this.commitDelta(previous, pending)
          } else {
            this.commitProjection(conversationId, previous.projector)
          }
          return receipt
        } catch (error) {
          this.cachedProjection = undefined
          throw error
        }
      })
    })
  }

  read(conversationId: string, afterSeq = 0, limit = 200) {
    return this.eventStore.read(conversationId, afterSeq, limit)
  }

  list(query: ConversationListQueryV2 = {}): ConversationPageV2 {
    this.ensureProjectionsCurrent()
    const catalog = this.loadCatalog()
    const needle = query.query?.trim().toLocaleLowerCase() ?? ''
    let records = catalog.records.filter(record => (
      (!query.workspaceId || record.workspaceId === query.workspaceId)
      && (!query.status || record.status === query.status)
      && (!needle || record.title.toLocaleLowerCase().includes(needle) || record.tags.some(tag => tag.toLocaleLowerCase().includes(needle)))
    ))
    const sort = query.sort ?? 'updated_desc'
    const field = sort.startsWith('created') ? 'createdAt' : 'updatedAt'
    const direction = sort.endsWith('asc') ? 1 : -1
    const queryKey = catalogQueryKey(query, sort)
    const compareValues = (leftValue: number, leftId: string, rightValue: number, rightId: string) => (
      direction * (leftValue - rightValue) || leftId.localeCompare(rightId)
    )
    records = records.sort((left, right) => compareValues(left[field], left.id, right[field], right.id))
    const cursor = decodeCursor(query.cursor, sort, queryKey)
    const eligible = cursor
      ? records.filter(record => compareValues(record[field], record.id, cursor.value, cursor.id) > 0)
      : records
    const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_LIMIT), MAX_LIMIT)
    const conversations = eligible.slice(0, limit).map(clone)
    const last = conversations.at(-1)
    const nextCursor = last && eligible.length > limit
      ? encodeCursor({ version: 2, sort, queryKey, value: last[field], id: last.id })
      : null
    return { conversations, nextCursor, total: records.length }
  }

  projection(conversationId: string): ConversationTranscriptProjectionV2 {
    this.snapshotPath(conversationId)
    return withFileLockSync(this.projectionLockPath, () =>
      withFileLockSync(join(this.eventsRoot, `.${conversationId}.lock`), () => {
        const watermark = this.ensureProjectionsCurrent(conversationId).conversations[conversationId]
        const state = watermark && this.loadProjection(conversationId, watermark)
        return state ? clone(state.projector.projection) : this.rebuildLocked(conversationId)
      }))
  }

  rebuild(conversationId: string): ConversationTranscriptProjectionV2 {
    this.snapshotPath(conversationId)
    return withFileLockSync(this.projectionLockPath, () =>
      withFileLockSync(join(this.eventsRoot, `.${conversationId}.lock`), () => this.rebuildLocked(conversationId)))
  }

  private rebuildLocked(conversationId: string): ConversationTranscriptProjectionV2 {
    this.cachedProjection = undefined
    const events = this.eventStore.readAll(conversationId)
    const projector = createConversationProjector()
    const projection = projector.apply(events)
    this.options.onProjectionReplay?.(events.length, 'full')
    this.commitProjection(conversationId, projector)
    return clone(projection)
  }

  private commitProjection(conversationId: string, projector: ReturnType<typeof createConversationProjector>): void {
    this.cachedProjection = undefined
    const { projection, reducer } = projector.snapshot()
    const journalVersion = this.journalVersion(conversationId)
    const snapshot: ConversationProjectionSnapshotV2 = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      conversationId,
      throughSeq: projection.throughSeq,
      journalVersion,
      createdAt: this.now(),
      checksum: digest({ projection, reducer }),
      projection,
      reducer,
    }
    atomicJson(this.snapshotPath(conversationId), snapshot)
    if (projection.conversation) this.updateCatalog(projection.conversation)
    this.updateSearchIndex(conversationId, projection)
    const watermarks = this.loadWatermarks()
    watermarks.conversations[conversationId] = { throughSeq: projection.throughSeq, journalVersion, baseSeq: projection.throughSeq, snapshotChecksum: snapshot.checksum }
    // Publish the checkpoint only after every derived view has been committed.
    atomicJson(this.watermarksPath, watermarks)
    this.cacheProjection(conversationId, projector, watermarks.conversations[conversationId]!, [])
  }

  private commitDelta(previous: CachedProjection, events: AnyConversationEventV2[]): void {
    this.cachedProjection = undefined
    const conversationId = previous.conversationId
    const projection = previous.projector.projection
    const journalVersion = this.journalVersion(conversationId)
    const delta: ProjectionDelta = { schemaVersion: 1, conversationId, baseSeq: previous.baseSeq, throughSeq: projection.throughSeq, journalVersion, events }
    const deltaChecksum = digest(delta)
    atomicJson(this.deltaPath(conversationId), { ...delta, checksum: deltaChecksum })
    if (projection.conversation) this.updateCatalog(projection.conversation)
    const watermarks = this.loadWatermarks()
    watermarks.conversations[conversationId] = {
      throughSeq: projection.throughSeq, journalVersion, baseSeq: previous.baseSeq,
      snapshotChecksum: previous.snapshotChecksum, deltaChecksum,
    }
    // Search overlays this committed delta on its base index until the next full checkpoint.
    atomicJson(this.watermarksPath, watermarks)
    this.cacheProjection(conversationId, previous.projector, watermarks.conversations[conversationId]!, events)
  }

  private cacheProjection(conversationId: string, projector: ReturnType<typeof createConversationProjector>, watermark: ProjectionWatermark, events: AnyConversationEventV2[]): CachedProjection {
    this.cachedProjection = {
      conversationId, projector, events, journalVersion: watermark.journalVersion,
      baseSeq: watermark.baseSeq!, snapshotChecksum: watermark.snapshotChecksum!, deltaChecksum: watermark.deltaChecksum,
      snapshotVersion: conversationJournalVersion(this.snapshotPath(conversationId)),
      deltaVersion: watermark.deltaChecksum ? conversationJournalVersion(this.deltaPath(conversationId)) : 'unused',
    }
    return this.cachedProjection
  }

  private loadProjection(conversationId: string, watermark: ProjectionWatermark): CachedProjection | undefined {
    if (!Number.isSafeInteger(watermark.baseSeq) || watermark.baseSeq! < 0 || watermark.baseSeq! > watermark.throughSeq
      || typeof watermark.snapshotChecksum !== 'string') return undefined
    const cached = this.cachedProjection
    const path = this.snapshotPath(conversationId)
    const deltaPath = this.deltaPath(conversationId)
    try {
      if (cached?.conversationId === conversationId && cached.journalVersion === watermark.journalVersion
        && cached.baseSeq === watermark.baseSeq && cached.snapshotChecksum === watermark.snapshotChecksum
        && cached.deltaChecksum === watermark.deltaChecksum
        && cached.projector.projection.throughSeq === watermark.throughSeq
        && cached.snapshotVersion === conversationJournalVersion(path)
        && cached.deltaVersion === (watermark.deltaChecksum ? conversationJournalVersion(deltaPath) : 'unused')) return cached
      this.cachedProjection = undefined
      this.options.onRead?.('snapshot', path)
      const snapshot = JSON.parse(readFileSync(path, 'utf8')) as ConversationProjectionSnapshotV2
      if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || snapshot.conversationId !== conversationId
        || !validProjection(snapshot.projection) || !validReducer(snapshot.reducer, snapshot.projection)
        || snapshot.throughSeq !== watermark.baseSeq || snapshot.throughSeq !== snapshot.projection.throughSeq
        || snapshot.checksum !== watermark.snapshotChecksum || snapshot.checksum !== digest({ projection: snapshot.projection, reducer: snapshot.reducer })) return undefined
      const projector = createConversationProjector({ projection: snapshot.projection, reducer: snapshot.reducer })
      let events: AnyConversationEventV2[] = []
      if (watermark.baseSeq !== watermark.throughSeq) {
        if (statSync(deltaPath).size > MAX_DELTA_BYTES + 4096) return undefined
        const { checksum, ...delta } = JSON.parse(readFileSync(deltaPath, 'utf8')) as ProjectionDelta & { checksum: string }
        if (delta.schemaVersion !== 1 || delta.conversationId !== conversationId || delta.baseSeq !== watermark.baseSeq
          || delta.throughSeq !== watermark.throughSeq || delta.journalVersion !== watermark.journalVersion
          || checksum !== watermark.deltaChecksum || checksum !== digest(delta) || !Array.isArray(delta.events)
          || delta.events.length !== watermark.throughSeq - watermark.baseSeq! || delta.events.length > MAX_DELTA_EVENTS) return undefined
        events = delta.events.map(parseConversationEventV2)
        if (events.some((event, index) => event.conversationId !== conversationId || event.seq !== watermark.baseSeq! + index + 1
          || (snapshot.projection.conversation && event.profileId !== snapshot.projection.conversation.profileId))) return undefined
        projector.apply(events)
        this.options.onProjectionReplay?.(events.length, 'delta')
      } else if (snapshot.journalVersion !== watermark.journalVersion || watermark.deltaChecksum !== undefined) return undefined
      return this.cacheProjection(conversationId, projector, watermark, events)
    } catch {
      this.cachedProjection = undefined
      return undefined
    }
  }

  private deltaPath(conversationId: string): string {
    return join(this.snapshotsRoot, `${conversationId}.delta.json`)
  }

  rebuildCatalog(): ConversationCatalogV2File {
    return withFileLockSync(this.projectionLockPath, () => this.rebuildCatalogLocked())
  }

  private rebuildCatalogLocked(): ConversationCatalogV2File {
    const records: ConversationRecordV2[] = []
    for (const entry of readdirSync(this.eventsRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const conversationId = entry.name.slice(0, -'.jsonl'.length)
      const projection = withFileLockSync(join(this.eventsRoot, `.${conversationId}.lock`), () =>
        projectConversationEvents(this.eventStore.readAll(conversationId)))
      if (projection.conversation) records.push(projection.conversation)
    }
    const catalog = { schemaVersion: CATALOG_SCHEMA_VERSION, records, updatedAt: this.now() } satisfies ConversationCatalogV2File
    atomicJson(this.catalogPath, catalog)
    return clone(catalog)
  }

  rebuildAllProjections(): { conversations: number; events: number; searchEntries: number } {
    return withFileLockSync(this.projectionLockPath, () => this.rebuildAllProjectionsLocked())
  }

  private rebuildAllProjectionsLocked(): { conversations: number; events: number; searchEntries: number } {
    this.cachedProjection = undefined
    const records: ConversationRecordV2[] = []
    const searchEntries: ConversationSearchIndexEntryV2[] = []
    const watermarks: ProjectionWatermarks = { schemaVersion: 1, conversations: {} }
    let eventCount = 0
    for (const entry of readdirSync(this.eventsRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const conversationId = entry.name.slice(0, -'.jsonl'.length)
      const { projection, reducer, journalVersion } = withFileLockSync(join(this.eventsRoot, `.${conversationId}.lock`), () => {
        const projector = createConversationProjector()
        projector.apply(this.eventStore.readAll(conversationId))
        return { ...projector.snapshot(), journalVersion: this.journalVersion(conversationId) }
      })
      eventCount += projection.throughSeq
      const snapshot: ConversationProjectionSnapshotV2 = {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        conversationId,
        throughSeq: projection.throughSeq,
        journalVersion,
        createdAt: this.now(),
        checksum: digest({ projection, reducer }),
        projection,
        reducer,
      }
      watermarks.conversations[conversationId] = { throughSeq: projection.throughSeq, journalVersion, baseSeq: projection.throughSeq, snapshotChecksum: snapshot.checksum }
      atomicJson(this.snapshotPath(conversationId), snapshot)
      if (projection.conversation) records.push(projection.conversation)
      searchEntries.push(...this.searchEntries(projection))
    }
    atomicJson(this.catalogPath, { schemaVersion: CATALOG_SCHEMA_VERSION, records, updatedAt: this.now() } satisfies ConversationCatalogV2File)
    atomicJson(this.searchIndexPath, { schemaVersion: SEARCH_INDEX_SCHEMA_VERSION, entries: searchEntries, updatedAt: this.now() } satisfies ConversationSearchIndexV2File)
    atomicJson(this.watermarksPath, watermarks)
    return { conversations: records.length, events: eventCount, searchEntries: searchEntries.length }
  }

  search(query: string | ConversationSearchQueryV2, legacyLimit = 50): ConversationSearchResultV2[] {
    const request = typeof query === 'string' ? { query, limit: legacyLimit } : query
    const needle = request.query.trim().toLocaleLowerCase()
    if (!needle) return []
    if (request.from !== undefined && !Number.isFinite(request.from)) throw new Error('Invalid Conversation search start time')
    if (request.to !== undefined && !Number.isFinite(request.to)) throw new Error('Invalid Conversation search end time')
    if (request.from !== undefined && request.to !== undefined && request.from > request.to) {
      throw new Error('Conversation search start time must not be after its end time')
    }
    const allowedKinds = request.kinds?.length ? new Set(request.kinds) : undefined
    const limit = Math.min(Math.max(1, request.limit ?? 50), 200)
    return withFileLockSync(this.projectionLockPath, () => {
      const watermarks = this.ensureProjectionsCurrent()
      let entries = this.loadSearchIndex().entries
      const pending = Object.entries(watermarks.conversations).filter(([, mark]) => mark.baseSeq !== undefined && mark.baseSeq < mark.throughSeq)
      const ids = new Set(pending.map(([id]) => id))
      if (ids.size) {
        entries = entries.filter(entry => !ids.has(entry.conversationId))
        for (const id of ids) entries.push(...this.searchEntries(this.projection(id)))
      }
      return entries
        .filter(entry => entry.text.includes(needle)
          && (!request.workspaceId || entry.workspaceId === request.workspaceId)
          && (request.from === undefined || entry.occurredAt >= request.from)
          && (request.to === undefined || entry.occurredAt <= request.to)
          && (!allowedKinds || allowedKinds.has(entry.kind)))
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, limit)
        .map(({ text: _text, ...entry }) => clone(entry))
    })
  }

  recoverInterruptedConversations(): ConversationRepositoryRecoveryReceiptV2 {
    const repairedJournals: string[] = []
    const recoveredConversations: string[] = []
    let interruptedRuns = 0
    let interruptedItems = 0
    for (const entry of readdirSync(this.eventsRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const conversationId = entry.name.slice(0, -'.jsonl'.length)
      const recovery = this.eventStore.recover(conversationId)
      if (recovery.repaired) repairedJournals.push(conversationId)
      const projection = projectConversationEvents(this.eventStore.readAll(conversationId))
      if (!projection.conversation) continue
      const activeRuns = projection.runs.filter(run => ['pending', 'running', 'waiting'].includes(run.status))
      const activeItems = projection.items.filter(item => ['pending', 'running'].includes(item.status))
      if (!recovery.repaired && activeRuns.length === 0 && activeItems.length === 0) continue
      const at = this.now()
      const reason = recovery.repaired ? 'Conversation journal tail was repaired after an interrupted write.' : 'Conversation runtime stopped before active work completed.'
      const inputs: AnyAppendConversationEventV2Input[] = [{
        eventId: recoveryEventId('recovery-detected', conversationId, projection.throughSeq),
        profileId: projection.conversation.profileId,
        conversationId,
        workspaceId: projection.conversation.workspaceId ?? undefined,
        source: 'recovery',
        provenance: 'restored',
        type: 'recovery.detected',
        at,
        payload: {
          reason,
          throughSeq: recovery.throughSeq,
          preservedCorruptCopy: recovery.corruptCopyPath ? recovery.corruptCopyPath.split(/[\\/]/u).at(-1) : undefined,
        },
      }]
      for (const run of activeRuns) {
        inputs.push({
          eventId: recoveryEventId('run-recovered', conversationId, run.id, projection.throughSeq),
          profileId: projection.conversation.profileId,
          conversationId,
          workspaceId: projection.conversation.workspaceId ?? undefined,
          runId: run.id,
          source: 'recovery',
          provenance: 'restored',
          type: 'run.recovered',
          at,
          payload: { reason, recoveredAt: at },
        })
      }
      for (const item of activeItems) {
        if (item.kind === 'approval') {
          inputs.push({
            eventId: recoveryEventId('approval-cancelled', conversationId, item.payload.requestId, projection.throughSeq),
            profileId: projection.conversation.profileId,
            conversationId,
            workspaceId: projection.conversation.workspaceId ?? undefined,
            runId: item.runId,
            turnId: item.turnId,
            itemId: item.id,
            source: 'recovery',
            provenance: 'restored',
            type: 'approval.cancelled',
            at,
            payload: { requestId: item.payload.requestId, reason: 'Pending approval was cancelled because the previous runtime stopped.' },
          })
          continue
        }
        inputs.push({
          eventId: recoveryEventId('item-recovered', conversationId, item.id, projection.throughSeq),
          profileId: projection.conversation.profileId,
          conversationId,
          workspaceId: projection.conversation.workspaceId ?? undefined,
          runId: item.runId,
          turnId: item.turnId,
          itemId: item.id,
          source: 'recovery',
          provenance: 'restored',
          type: 'item.completed',
          at,
          payload: { status: 'interrupted', completedAt: at },
        })
      }
      inputs.push({
        eventId: recoveryEventId('recovery-applied', conversationId, projection.throughSeq),
        profileId: projection.conversation.profileId,
        conversationId,
        workspaceId: projection.conversation.workspaceId ?? undefined,
        source: 'recovery',
        provenance: 'restored',
        type: 'recovery.applied',
        at,
        payload: { reason, throughSeq: recovery.throughSeq },
      })
      this.append(inputs)
      interruptedRuns += activeRuns.length
      interruptedItems += activeItems.length
      recoveredConversations.push(conversationId)
    }
    this.rebuildCatalog()
    return { repairedJournals, interruptedRuns, interruptedItems, recoveredConversations }
  }

  private loadCatalog(): ConversationCatalogV2File {
    if (!existsSync(this.catalogPath)) return this.rebuildCatalog()
    try {
      this.options.onRead?.('catalog', this.catalogPath)
      const value: unknown = JSON.parse(readFileSync(this.catalogPath, 'utf8'))
      if (validCatalog(value)) return value
    } catch {}
    return this.rebuildCatalog()
  }

  private journalVersion(conversationId: string): string {
    try {
      const info = statSync(join(this.eventsRoot, `${conversationId}.jsonl`), { bigint: true })
      return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      throw error
    }
  }

  private loadWatermarks(): ProjectionWatermarks {
    try {
      const value = JSON.parse(readFileSync(this.watermarksPath, 'utf8')) as ProjectionWatermarks
      if (value?.schemaVersion === 1 && value.conversations && typeof value.conversations === 'object'
        && !Array.isArray(value.conversations)
        && Object.values(value.conversations).every(entry => entry && Number.isSafeInteger(entry.throughSeq)
          && entry.throughSeq >= 0 && typeof entry.journalVersion === 'string')) return value
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return { schemaVersion: 1, conversations: {} }
  }

  private ensureProjectionsCurrent(conversationId?: string): ProjectionWatermarks {
    return withFileLockSync(this.projectionLockPath, () => {
      let watermarks = this.loadWatermarks()
      const ids = conversationId === undefined
        ? readdirSync(this.eventsRoot, { withFileTypes: true })
          .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
          .map(entry => entry.name.slice(0, -'.jsonl'.length))
        : [conversationId]
      for (const id of ids) {
        this.snapshotPath(id)
        if (watermarks.conversations[id]?.journalVersion === this.journalVersion(id)) continue
        this.rebuild(id)
        watermarks = this.loadWatermarks()
      }
      return watermarks
    })
  }

  private updateCatalog(record: ConversationRecordV2): void {
    const catalog = this.loadCatalog()
    const index = catalog.records.findIndex(candidate => candidate.id === record.id)
    if (index >= 0) catalog.records[index] = clone(record)
    else catalog.records.push(clone(record))
    catalog.updatedAt = this.now()
    atomicJson(this.catalogPath, catalog)
  }

  private loadSearchIndex(): ConversationSearchIndexV2File {
    if (!existsSync(this.searchIndexPath)) {
      this.rebuildSearchIndex()
    }
    try {
      this.options.onRead?.('search-index', this.searchIndexPath)
      const value: unknown = JSON.parse(readFileSync(this.searchIndexPath, 'utf8'))
      if (validSearchIndex(value)) return value
    } catch {}
    return this.rebuildSearchIndex()
  }

  private rebuildSearchIndex(): ConversationSearchIndexV2File {
    return withFileLockSync(this.projectionLockPath, () => this.rebuildSearchIndexLocked())
  }

  private rebuildSearchIndexLocked(): ConversationSearchIndexV2File {
    const entries: ConversationSearchIndexEntryV2[] = []
    for (const entry of readdirSync(this.eventsRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const conversationId = entry.name.slice(0, -'.jsonl'.length)
      entries.push(...withFileLockSync(join(this.eventsRoot, `.${conversationId}.lock`), () =>
        this.searchEntries(projectConversationEvents(this.eventStore.readAll(conversationId)))))
    }
    const index = { schemaVersion: SEARCH_INDEX_SCHEMA_VERSION, entries, updatedAt: this.now() } satisfies ConversationSearchIndexV2File
    atomicJson(this.searchIndexPath, index)
    return index
  }

  private updateSearchIndex(conversationId: string, projection: ConversationTranscriptProjectionV2): void {
    const entries = this.loadSearchIndex().entries.filter(entry => entry.conversationId !== conversationId)
    entries.push(...this.searchEntries(projection))
    atomicJson(this.searchIndexPath, { schemaVersion: SEARCH_INDEX_SCHEMA_VERSION, entries, updatedAt: this.now() } satisfies ConversationSearchIndexV2File)
  }

  private searchEntries(projection: ConversationTranscriptProjectionV2): ConversationSearchIndexEntryV2[] {
    const conversation = projection.conversation
    if (!conversation || conversation.status === 'archived') return []
    const entries: ConversationSearchIndexEntryV2[] = [{
      conversationId: conversation.id,
      kind: 'title',
      title: conversation.title,
      excerpt: conversation.title,
      text: conversation.title.toLocaleLowerCase(),
      workspaceId: conversation.workspaceId,
      occurredAt: conversation.updatedAt,
      updatedAt: conversation.updatedAt,
    }]
    for (const item of projection.items) {
      if (item.status === 'redacted') continue
      let text = ''
      let kind: ConversationSearchResultV2['kind'] = 'message'
      if (item.kind === 'user_message' || item.kind === 'assistant_message') text = item.payload.text
      else if (item.kind === 'tool_call') { text = `${item.payload.toolName} ${JSON.stringify(item.payload.arguments)} ${JSON.stringify(item.payload.pathRefs ?? [])}`; kind = 'tool' }
      else if (item.kind === 'tool_result') { text = `${item.payload.toolName} ${item.payload.output} ${JSON.stringify(item.payload.pathRefs ?? [])}`; kind = 'tool' }
      else if (item.kind === 'file_change') { text = JSON.stringify(item.payload.path); kind = 'tool' }
      else if (item.kind === 'artifact') { text = `${item.payload.name} ${JSON.stringify(item.payload.path ?? '')}`; kind = 'artifact' }
      else if (item.kind === 'command_execution') { text = `${item.payload.command} ${item.payload.output ?? ''} ${JSON.stringify(item.payload.cwd ?? '')}`; kind = 'command' }
      if (!text) continue
      entries.push({
        conversationId: conversation.id,
        itemId: item.id,
        kind,
        title: conversation.title,
        excerpt: text.slice(0, 240),
        text: text.toLocaleLowerCase(),
        workspaceId: conversation.workspaceId,
        occurredAt: item.updatedAt,
        updatedAt: item.updatedAt,
      })
    }
    return entries
  }

  private snapshotPath(conversationId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(conversationId)) throw new Error('Invalid conversation identity')
    return join(this.snapshotsRoot, `${conversationId}.json`)
  }
}
