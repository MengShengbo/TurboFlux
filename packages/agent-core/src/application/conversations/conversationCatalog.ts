import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConversationJournalEntry, ConversationMeta, PersistedConversation } from './types'
import { generatedConversationTitle, normalizeConversationTitleText } from './conversationTitle'

const CATALOG_VERSION = 1
const CATALOG_FILENAME = '.conversation-catalog-v1.json'
const CATALOG_SCAN_VERSION = 3
const SCAN_CHUNK_BYTES = 256 * 1024
const SCAN_CONCURRENCY = 16

interface ConversationCatalogRecord {
  meta: ConversationMeta
  visible: boolean
  fingerprint?: string
}

interface PersistedConversationCatalog {
  version: 1
  entries: ConversationCatalogRecord[]
}

interface ConversationSourceFile {
  path: string
  size: number
  mtimeMs: number
}

interface ConversationSource {
  id: string
  files: ConversationSourceFile[]
  fingerprint: string
}

interface CatalogScanState {
  meta: ConversationMeta | null
  visible: boolean
  draftTitle: string
  queued: boolean
  seenEntries: Set<string>
  turnIds: Set<string>
}

export interface ConversationCatalogDiagnostics {
  initialized: boolean
  indexedEntries: number
  scannedFiles: number
  bytesRead: number
}

function cloneMeta(meta: ConversationMeta): ConversationMeta {
  return { ...meta }
}

function normalizeTitle(value: unknown, titleSource: 'custom' | 'generated' = 'generated'): string {
  return titleSource === 'custom'
    ? normalizeConversationTitleText(value, 80)
    : generatedConversationTitle(value, 80)
}

function placeholderTitle(value: string): boolean {
  return !value || ['untitled', 'untitled task', 'new task', '未命名任务', '新任务'].includes(value.trim().toLowerCase())
}

function validMeta(value: unknown): value is ConversationMeta {
  if (!value || typeof value !== 'object') return false
  const meta = value as Partial<ConversationMeta>
  return typeof meta.id === 'string'
    && typeof meta.title === 'string'
    && typeof meta.workspacePath === 'string'
    && typeof meta.createdAt === 'number'
    && typeof meta.updatedAt === 'number'
    && (meta.mode === 'vibe' || meta.mode === 'plan')
    && typeof meta.model === 'string'
    && typeof meta.provider === 'string'
    && typeof meta.turnCount === 'number'
}

function toMeta(value: Partial<PersistedConversation> | Partial<ConversationMeta>, fallback: ConversationMeta): ConversationMeta {
  const titleSource = value.titleSource === 'custom' || value.titleSource === 'generated' ? value.titleSource : fallback.titleSource
  return {
    id: typeof value.id === 'string' && value.id ? value.id : fallback.id,
    title: normalizeTitle(value.title, titleSource) || fallback.title,
    titleSource,
    workspacePath: typeof value.workspacePath === 'string' && value.workspacePath ? value.workspacePath : fallback.workspacePath,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : fallback.createdAt,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : fallback.updatedAt,
    mode: value.mode === 'plan' ? 'plan' : value.mode === 'vibe' ? 'vibe' : fallback.mode,
    model: typeof value.model === 'string' ? value.model : fallback.model,
    provider: typeof value.provider === 'string' ? value.provider : fallback.provider,
    turnCount: typeof value.turnCount === 'number' ? Math.max(0, Math.floor(value.turnCount)) : fallback.turnCount,
  }
}

function fallbackMeta(id: string, updatedAt: number): ConversationMeta {
  return {
    id,
    title: '未命名任务',
    workspacePath: '',
    createdAt: updatedAt,
    updatedAt,
    mode: 'vibe',
    model: '',
    provider: '',
    turnCount: 0,
  }
}

function applyConversation(state: CatalogScanState, value: Partial<PersistedConversation> | Partial<ConversationMeta>): void {
  const next = toMeta(value, state.meta || fallbackMeta(typeof value.id === 'string' ? value.id : '', Date.now()))
  state.meta = next
  if ('turns' in value && Array.isArray(value.turns)) {
    state.turnIds = new Set(value.turns.map(turn => turn.id).filter(Boolean))
  }
  const interaction = 'interactionState' in value ? value.interactionState : undefined
  const draft = interaction?.draft?.text?.trim() || ''
  const queued = (interaction?.queuedInputs?.length || 0) > 0
  state.visible ||= next.turnCount > 0 || !placeholderTitle(next.title) || Boolean(draft) || queued
  if (draft) state.draftTitle = draft
  state.queued ||= queued
}

function applyEntry(state: CatalogScanState, entry: ConversationJournalEntry, identity: string): void {
  if (state.seenEntries.has(identity)) return
  state.seenEntries.add(identity)
  if (entry.type === 'meta') applyConversation(state, entry.meta)
  if (entry.type === 'snapshot') applyConversation(state, entry.conversation)
  if (entry.type === 'turn') {
    const current = state.meta
    if (!current) return
    current.updatedAt = Math.max(current.updatedAt, entry.timestamp, entry.turn.timestamp)
    if (!state.turnIds.has(entry.turn.id)) {
      state.turnIds.add(entry.turn.id)
      current.turnCount += 1
    }
    if (entry.turn.role === 'user') {
      state.visible = true
      const title = generatedConversationTitle(entry.turn.content, 72)
      if (title && placeholderTitle(current.title)) current.title = title
    }
  }
  if (entry.type === 'draft_state') {
    const title = generatedConversationTitle(entry.draft.text, 72)
    if (title) {
      state.visible = true
      state.draftTitle = title
      if (state.meta && placeholderTitle(state.meta.title)) state.meta.title = title.slice(0, 72)
    }
  }
  if (entry.type === 'queue_state' && entry.inputs.length > 0) {
    state.visible = true
    state.queued = true
    const title = generatedConversationTitle(entry.inputs[0]?.prompt, 72)
    if (title && state.meta && placeholderTitle(state.meta.title)) state.meta.title = title.slice(0, 72)
  }
  if (entry.type === 'canonical_event') {
    if (state.meta) state.meta.updatedAt = Math.max(state.meta.updatedAt, entry.timestamp, entry.event.at)
    if (entry.event.type === 'turn.started') {
      const turn = entry.event.payload.turn
      if (state.meta && !state.turnIds.has(turn.id)) {
        state.turnIds.add(turn.id)
        state.meta.turnCount += 1
      }
      if (turn.role === 'user') {
        state.visible = true
        const title = generatedConversationTitle(turn.content, 72)
        if (title && state.meta && placeholderTitle(state.meta.title)) state.meta.title = title
      }
    }
  }
}

function extractJsonString(source: string, field: string): string | undefined {
  const match = source.match(new RegExp(`"${field}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`))
  if (!match) return undefined
  try {
    const parsed = JSON.parse(match[1])
    return typeof parsed === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

function extractJsonNumber(source: string, field: string): number | undefined {
  const match = source.match(new RegExp(`"${field}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`))
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

function applyPrefixMetadata(state: CatalogScanState, source: string, id: string, updatedAt: number): void {
  const conversationOffset = source.indexOf('"conversation":{')
  const start = conversationOffset >= 0 ? conversationOffset : 0
  const turnsOffset = source.indexOf('"turns":', start)
  const metadata = source.slice(start, turnsOffset >= 0 ? turnsOffset : source.length)
  const fallback = state.meta || fallbackMeta(id, updatedAt)
  const titleSource = extractJsonString(metadata, 'titleSource')
  applyConversation(state, {
    id: extractJsonString(metadata, 'id') || id,
    title: extractJsonString(metadata, 'title') || fallback.title,
    titleSource: titleSource === 'custom' || titleSource === 'generated' ? titleSource : fallback.titleSource,
    workspacePath: extractJsonString(metadata, 'workspacePath') || fallback.workspacePath,
    createdAt: extractJsonNumber(metadata, 'createdAt') ?? fallback.createdAt,
    updatedAt: extractJsonNumber(metadata, 'updatedAt') ?? updatedAt,
    mode: extractJsonString(metadata, 'mode') === 'plan' ? 'plan' : fallback.mode,
    model: extractJsonString(metadata, 'model') || fallback.model,
    provider: extractJsonString(metadata, 'provider') || fallback.provider,
    turnCount: extractJsonNumber(metadata, 'turnCount') ?? fallback.turnCount,
  })
}

function parseCompleteLines(state: CatalogScanState, source: string): void {
  for (const line of source.split('\n')) {
    const identity = line.trim()
    if (!identity) continue
    try {
      applyEntry(state, JSON.parse(identity) as ConversationJournalEntry, identity)
    } catch {}
  }
}

async function readSlice(file: ConversationSourceFile, position: number, length: number): Promise<Buffer> {
  const descriptor = await open(file.path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    const result = await descriptor.read(buffer, 0, length, position)
    return buffer.subarray(0, result.bytesRead)
  } finally {
    await descriptor.close()
  }
}

async function inspectSource(source: ConversationSource, diagnostics: ConversationCatalogDiagnostics): Promise<ConversationCatalogRecord | null> {
  const state: CatalogScanState = {
    meta: null,
    visible: false,
    draftTitle: '',
    queued: false,
    seenEntries: new Set(),
    turnIds: new Set(),
  }
  for (const file of source.files) {
    const prefixLength = Math.min(file.size, SCAN_CHUNK_BYTES)
    const prefix = await readSlice(file, 0, prefixLength)
    diagnostics.bytesRead += prefix.length
    diagnostics.scannedFiles += 1
    const prefixText = prefix.toString('utf8')
    applyPrefixMetadata(state, prefixText, source.id, file.mtimeMs)
    parseCompleteLines(state, prefixText)
    if (file.size > prefixLength) {
      const tailLength = Math.min(file.size - prefixLength, SCAN_CHUNK_BYTES)
      const tail = await readSlice(file, file.size - tailLength, tailLength)
      diagnostics.bytesRead += tail.length
      const tailText = tail.toString('utf8')
      const firstNewline = tailText.indexOf('\n')
      parseCompleteLines(state, firstNewline >= 0 ? tailText.slice(firstNewline + 1) : '')
    }
  }
  if (!state.meta) return null
  if (state.draftTitle && placeholderTitle(state.meta.title)) state.meta.title = state.draftTitle.slice(0, 72)
  return { meta: state.meta, visible: state.visible || state.queued, fingerprint: source.fingerprint }
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      results[index] = await mapper(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

export class ConversationCatalog {
  private readonly entries = new Map<string, ConversationCatalogRecord>()
  private initialized = false
  private initializePromise: Promise<void> | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private persistPromise = Promise.resolve()
  private diagnostics: ConversationCatalogDiagnostics = {
    initialized: false,
    indexedEntries: 0,
    scannedFiles: 0,
    bytesRead: 0,
  }

  constructor(private readonly directory: string) {}

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initializePromise) return this.initializePromise
    this.initializePromise = this.initializeOnce()
    try {
      await this.initializePromise
    } finally {
      this.initializePromise = null
    }
  }

  private async initializeOnce(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const persisted = await this.readPersisted()
    const cached = new Map((persisted?.entries || [])
      .filter(entry => validMeta(entry.meta))
      .map(entry => [entry.meta.id, { ...entry, meta: toMeta(entry.meta, entry.meta) }]))
    const sources = await this.discoverSources()
    const records = await mapConcurrent(sources, SCAN_CONCURRENCY, async source => {
      const existing = cached.get(source.id)
      return existing?.fingerprint === source.fingerprint
        ? existing
        : inspectSource(source, this.diagnostics)
    })
    this.entries.clear()
    for (const record of records) {
      if (record) this.entries.set(record.meta.id, { ...record, meta: cloneMeta(record.meta) })
    }
    this.initialized = true
    this.refreshDiagnostics()
    await this.persist()
  }

  listAll(): ConversationMeta[] {
    return [...this.entries.values()]
      .filter(entry => entry.visible)
      .map(entry => cloneMeta(entry.meta))
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  get(id: string): ConversationMeta | undefined {
    const entry = this.entries.get(id)
    return entry?.visible ? cloneMeta(entry.meta) : undefined
  }

  upsert(meta: ConversationMeta, visible = true): void {
    const normalized = toMeta(meta, meta)
    const existing = this.entries.get(normalized.id)
    if (existing && existing.visible === visible && JSON.stringify(existing.meta) === JSON.stringify(normalized)) return
    this.entries.set(normalized.id, { meta: normalized, visible })
    this.refreshDiagnostics()
    this.schedulePersist()
  }

  updateTitle(id: string, title: string, titleSource: 'custom' | 'generated', updatedAt = Date.now()): boolean {
    const existing = this.entries.get(id)
    const normalizedTitle = normalizeTitle(title, titleSource)
    if (!existing || !normalizedTitle) return false
    this.upsert({ ...existing.meta, title: normalizedTitle, titleSource, updatedAt: Math.max(existing.meta.updatedAt, updatedAt) }, true)
    return true
  }

  remove(id: string): boolean {
    const removed = this.entries.delete(id)
    if (removed) {
      this.refreshDiagnostics()
      this.schedulePersist()
    }
    return removed
  }

  getDiagnostics(): ConversationCatalogDiagnostics {
    return { ...this.diagnostics }
  }

  async flush(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = null
    await this.persist()
    await this.persistPromise
  }

  private async discoverSources(): Promise<ConversationSource[]> {
    const files = (await readdir(this.directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')) && entry.name !== CATALOG_FILENAME)
    const grouped = new Map<string, string[]>()
    for (const file of files) {
      const id = file.name.replace(/\.(json|jsonl)$/, '')
      const names = grouped.get(id) || []
      names.push(file.name)
      grouped.set(id, names)
    }
    return mapConcurrent([...grouped.entries()], SCAN_CONCURRENCY, async ([id, names]) => {
      const sourceFiles = await Promise.all(names.sort().map(async name => {
        const path = join(this.directory, name)
        const info = await stat(path)
        return { path, size: info.size, mtimeMs: info.mtimeMs }
      }))
      return {
        id,
        files: sourceFiles,
        fingerprint: `${CATALOG_SCAN_VERSION}|${sourceFiles.map(file => `${file.path}:${file.size}:${file.mtimeMs}`).join('|')}`,
      }
    })
  }

  private async readPersisted(): Promise<PersistedConversationCatalog | null> {
    try {
      const parsed = JSON.parse(await readFile(join(this.directory, CATALOG_FILENAME), 'utf8')) as PersistedConversationCatalog
      return parsed.version === CATALOG_VERSION && Array.isArray(parsed.entries) ? parsed : null
    } catch {
      return null
    }
  }

  private schedulePersist(): void {
    if (!this.initialized || this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persist()
    }, 50)
    this.persistTimer.unref?.()
  }

  private async persist(): Promise<void> {
    if (!this.initialized) return
    const snapshot: PersistedConversationCatalog = {
      version: CATALOG_VERSION,
      entries: [...this.entries.values()].map(entry => ({ ...entry, meta: cloneMeta(entry.meta) })),
    }
    const target = join(this.directory, CATALOG_FILENAME)
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    this.persistPromise = this.persistPromise.catch(() => undefined).then(async () => {
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, target)
    })
    await this.persistPromise
  }

  private refreshDiagnostics(): void {
    this.diagnostics.initialized = this.initialized
    this.diagnostics.indexedEntries = this.entries.size
  }
}
