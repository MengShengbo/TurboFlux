import { createHash } from 'node:crypto'
import type { AgentEngine, AgentEventType } from '@turboflux/agent-runtime/agentEngine'
import type { TurboFluxConfig } from '@turboflux/models/config'
import { mergeModelRequest, summarizeModelRequests, type ModelUsageSummary } from '@turboflux/contracts/modelUsage'
import type { AgentTurn, ModelRequestRecord } from '@turboflux/contracts/agentTypes'
import type { AnyConversationEvent } from '../events/index'
import type {
  ConversationDraftState,
  ConversationInteractionState,
  ConversationJournalEntry,
  ConversationMeta,
  ConversationQueuedInput,
  PersistedConversation,
} from './types'
import type { WorkflowInstanceState } from '@turboflux/contracts/workflowSurfaceTypes'
import {
  deleteConversation,
  deleteConversationAsync,
  getConversationsDir,
  listConversations,
  listConversationsAsync,
  loadConversation,
  loadConversationAsync,
  sameWorkspacePath,
  saveConversation,
} from './store'
import { ConversationCatalog } from './conversationCatalog'
import { ConversationJournalWriter, type ConversationJournalWriterStats, type JournalDurability } from './journalWriter'
import { SessionRegistry } from '@turboflux/agent-runtime/runtime/sessionRegistry'
import { writeConversationRecoveryBundle } from './recoveryExport'
import { redactComputerAgentEvent, redactComputerConversation } from '../privacy/computerPrivacy'
import { ConversationInteractionStoreV2 } from './conversationInteractionStoreV2'
import { ConversationRuntimeRepositoryV2 } from './conversationRuntimeRepositoryV2'
import { generatedConversationTitle, normalizeConversationTitleText } from '@turboflux/presentation/conversationTitle'

export type ConversationPersistenceStatusHandler = (error: Error | null) => void

export interface ConversationManagerOptions {
  batchJournalStreaming?: boolean
  conversationsRoot?: string
  now?: () => number
  profileId?: string
  interactionRoot?: string
  conversationV2Root?: string
  workspaceId?: string
}

export interface ConversationPersistenceHealth {
  status: 'healthy' | 'degraded'
  error: string | null
  degradedAt: number | null
  pendingRecoveryEntries: number
  pendingStreamingEntries: number
}

function conversationSnapshotHash(conversation: PersistedConversation): string {
  return createHash('sha256').update(JSON.stringify(conversation)).digest('hex')
}

function snapshotRevisionHash(revision: number): string {
  return createHash('sha256').update(String(revision)).digest('hex')
}

function createEmptyInteractionState(): ConversationInteractionState {
  return { queuedInputs: [], draft: { text: '' }, pendingSteering: [], pendingApprovals: [] }
}

export class ConversationManager {
  private currentId: string
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private journalInitialized = false
  private lastPersistedSnapshotHash = ''
  private snapshotRevision = 0
  private persistedSnapshotRevision = -1
  private persistenceError: Error | null = null
  private persistenceDegradedAt: number | null = null
  private readonly journalWriter: ConversationJournalWriter
  private readonly sessionRegistry: SessionRegistry
  private readonly unsubscribeSessionIdentity: () => void
  private readonly now: () => number
  private interactionState = createEmptyInteractionState()
  private canonicalEvents: AnyConversationEvent[] = []
  private readonly modelRequests = new Map<string, ModelRequestRecord>()
  private modelUsageSummary: ModelUsageSummary | undefined
  private readonly canonicalEventIds = new Set<string>()
  private canonicalLastSeq = 0
  private canonicalPersistenceActive = false
  private readonly customTitles = new Map<string, string>()
  private readonly generatedTitles = new Map<string, string>()
  private readonly conversationCatalog: ConversationCatalog
  private readonly conversationsRoot?: string
  private readonly interactionStore?: ConversationInteractionStoreV2
  private readonly runtimeRepositoryV2?: ConversationRuntimeRepositoryV2
  private conversationCatalogInitialization: Promise<void> | null = null

  constructor(
    private engine: AgentEngine,
    private config: TurboFluxConfig,
    private workspacePath: string,
    private onPersistenceStatus?: ConversationPersistenceStatusHandler,
    sessionRegistry?: SessionRegistry,
    options: ConversationManagerOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.conversationsRoot = options.conversationsRoot
    if (options.profileId && options.interactionRoot) {
      this.interactionStore = new ConversationInteractionStoreV2(options.interactionRoot, options.profileId, this.now)
    }
    if (options.profileId && options.conversationV2Root && options.workspaceId) {
      this.runtimeRepositoryV2 = new ConversationRuntimeRepositoryV2(
        options.conversationV2Root,
        options.profileId,
        options.workspaceId,
        this.workspacePath,
        this.now,
      )
    }
    this.conversationCatalog = new ConversationCatalog(getConversationsDir(this.conversationsRoot))
    this.sessionRegistry = sessionRegistry || new SessionRegistry()
    this.currentId = this.sessionRegistry.getCurrentId()
    this.journalWriter = new ConversationJournalWriter(this.currentId, {
      batchStreaming: options.batchJournalStreaming,
      conversationsRoot: this.conversationsRoot,
      onStatus: error => error ? this.reportPersistenceFailure(error) : this.reportPersistenceSuccess(),
    })
    this.unsubscribeSessionIdentity = this.sessionRegistry.subscribe(({ currentId }) => {
      this.journalWriter.switchConversation(currentId)
      this.currentId = currentId
      this.journalInitialized = false
      this.lastPersistedSnapshotHash = ''
      this.snapshotRevision += 1
      this.persistedSnapshotRevision = -1
      this.interactionState = this.interactionStore?.load(currentId) ?? createEmptyInteractionState()
      this.modelRequests.clear()
      this.modelUsageSummary = undefined
      this.canonicalEvents = []
      this.canonicalEventIds.clear()
      this.canonicalLastSeq = 0
      this.canonicalPersistenceActive = false
    })
  }

  getCurrentId(): string {
    return this.currentId
  }

  getInteractionState(): ConversationInteractionState {
    return JSON.parse(JSON.stringify(this.interactionState)) as ConversationInteractionState
  }

  getCatalogMeta(updatedAt = this.currentActivityAt()): ConversationMeta {
    return { ...this.buildMeta(), updatedAt }
  }

  hasCatalogContent(): boolean {
    return this.hasPersistableConversationState()
  }

  getModelUsageSummary(): ModelUsageSummary | undefined {
    if (this.modelRequests.size === 0) return undefined
    this.modelUsageSummary ??= summarizeModelRequests([...this.modelRequests.values()])
    return structuredClone(this.modelUsageSummary)
  }

  private recordModelRequest(event: AnyConversationEvent): void {
    if (event.type !== 'model.request_updated') return
    const request = event.payload.request
    this.modelRequests.set(request.id, mergeModelRequest(this.modelRequests.get(request.id), request))
    this.modelUsageSummary = undefined
  }

  private restoreModelRequests(events: readonly AnyConversationEvent[]): void {
    this.modelRequests.clear()
    this.modelUsageSummary = undefined
    for (const event of events) this.recordModelRequest(event)
  }

  getCanonicalEvents(): readonly AnyConversationEvent[] {
    return this.canonicalEvents.map(event => structuredClone(event))
  }

  recordCanonicalEvent(event: AnyConversationEvent): boolean {
    if (event.schemaVersion !== 1) throw new Error(`Unsupported conversation event schema: ${event.schemaVersion}`)
    if (event.conversationId !== this.currentId || event.threadId !== this.currentId) {
      throw new Error(`Canonical conversation event belongs to ${event.conversationId}/${event.threadId}, expected ${this.currentId}/${this.currentId}`)
    }
    if (!Number.isInteger(event.seq) || event.seq < 1) throw new Error(`Invalid canonical conversation event sequence: ${event.seq}`)
    if (this.canonicalEventIds.has(event.eventId)) return false
    if (this.canonicalLastSeq > 0 && event.seq !== this.canonicalLastSeq + 1) {
      throw new Error(`Canonical conversation event expected seq ${this.canonicalLastSeq + 1}, received ${event.seq}`)
    }
    const persistEvent = this.hasPersistableConversationState() || event.type === 'run.started'
    this.canonicalEventIds.add(event.eventId)
    this.canonicalEvents.push(structuredClone(event))
    this.recordModelRequest(event)
    this.canonicalLastSeq = event.seq
    this.markSnapshotDirty()
    if (!persistEvent) return true
    this.canonicalPersistenceActive = Boolean(this.runtimeRepositoryV2)
    if (this.runtimeRepositoryV2) {
      this.runtimeRepositoryV2.appendCanonical(event, this.buildConversation())
      return true
    }
    this.ensureJournal()
    const streaming = event.type === 'stream.delta' || event.type === 'tool.delta'
    return this.append({ version: 3, type: 'canonical_event', timestamp: event.at, event }, streaming ? 'streaming' : 'terminal')
  }

  replaceCanonicalEvents(events: readonly AnyConversationEvent[]): void {
    let previousSeq: number | undefined
    const next = events.map(event => {
      if (event.schemaVersion !== 1) throw new Error(`Unsupported conversation event schema: ${event.schemaVersion}`)
      if (event.conversationId !== this.currentId || event.threadId !== this.currentId) {
        throw new Error(`Canonical conversation event belongs to ${event.conversationId}/${event.threadId}, expected ${this.currentId}/${this.currentId}`)
      }
      if (!Number.isInteger(event.seq) || event.seq < 1) throw new Error(`Invalid canonical conversation event sequence: ${event.seq}`)
      if (previousSeq !== undefined && event.seq !== previousSeq + 1) {
        throw new Error(`Canonical conversation event expected seq ${previousSeq + 1}, received ${event.seq}`)
      }
      previousSeq = event.seq
      return structuredClone(event)
    })
    this.canonicalEvents = next
    this.restoreModelRequests(next)
    this.canonicalEventIds.clear()
    for (const event of next) this.canonicalEventIds.add(event.eventId)
    this.canonicalLastSeq = next.at(-1)?.seq ?? 0
    this.canonicalPersistenceActive = Boolean(this.runtimeRepositoryV2 && next.length > 0)
    this.markSnapshotDirty()
  }

  updateConfig(config: TurboFluxConfig): void {
    this.config = config
    this.snapshotRevision += 1
  }

  scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.persist(true)
    }, 500)
  }

  recordEvent(event: AgentEventType): void {
    const persistedEvent = redactComputerAgentEvent(event, this.engine.getFullConversationTurns())
    if (this.shouldInitializeJournalForEvent(persistedEvent)) this.ensureJournal()
    const timestamp = Date.now()
    switch (persistedEvent.type) {
      case 'turn:start':
        this.markSnapshotDirty()
        this.append({ version: 1, type: 'turn', timestamp, turn: persistedEvent.turn }, 'critical')
        break
      case 'turn:complete':
        this.markSnapshotDirty()
        this.append({ version: 1, type: 'turn', timestamp, turn: persistedEvent.turn }, 'terminal')
        break
      case 'stream:start':
        this.append({ version: 1, type: 'stream_start', timestamp }, 'terminal')
        break
      case 'stream:delta':
        if (persistedEvent.text) this.append({ version: 1, type: 'stream_delta', timestamp, text: persistedEvent.text }, 'streaming')
        break
      case 'stream:thinking_delta':
        if (persistedEvent.text) this.append({ version: 1, type: 'stream_thinking_delta', timestamp, text: persistedEvent.text }, 'streaming')
        break
      case 'stream:end':
        this.append({ version: 1, type: 'stream_end', timestamp, interrupted: persistedEvent.interrupted === true }, 'terminal')
        break
      case 'tool:call':
        this.markSnapshotDirty()
        this.append({ version: 1, type: 'tool_call', timestamp, toolCall: persistedEvent.toolCall }, 'critical')
        break
      case 'tool:result':
        this.markSnapshotDirty()
        this.append({ version: 1, type: 'tool_result', timestamp, toolResult: persistedEvent.toolResult }, 'terminal')
        break
      case 'input:state': {
        this.markSnapshotDirty()
        const previousPendingSteering = this.interactionState.pendingSteering.map(input => ({ ...input }))
        const index = this.interactionState.pendingSteering.findIndex(input => input.id === persistedEvent.inputId)
        if (persistedEvent.state === 'accepted') {
          const pending = { id: persistedEvent.inputId, text: persistedEvent.text }
          if (index >= 0) this.interactionState.pendingSteering[index] = pending
          else this.interactionState.pendingSteering.push(pending)
        } else if (index >= 0) {
          this.interactionState.pendingSteering.splice(index, 1)
        }
        if (this.interactionStore) {
          try {
            this.interactionStore.save(this.currentId, this.interactionState)
            this.reportPersistenceSuccess()
            break
          } catch (error) {
            this.interactionState.pendingSteering = previousPendingSteering
            this.reportPersistenceFailure(error)
            throw (error instanceof Error ? error : new Error(String(error)))
          }
        }
        try {
          this.append({
            version: 2,
            type: 'input_state',
            timestamp,
            inputId: persistedEvent.inputId,
            intent: persistedEvent.intent,
            state: persistedEvent.state,
            text: persistedEvent.text,
            reason: persistedEvent.reason,
          }, persistedEvent.state === 'accepted' ? 'critical' : 'terminal')
        } catch (error) {
          this.interactionState.pendingSteering = previousPendingSteering
          throw error
        }
        break
      }
      case 'approval:state': {
        this.markSnapshotDirty()
        const previousPendingApprovals = this.interactionState.pendingApprovals.map(request => ({ ...request }))
        const index = this.interactionState.pendingApprovals.findIndex(request => request.requestId === persistedEvent.requestId)
        if (persistedEvent.state === 'requested') {
          const pending = {
            requestId: persistedEvent.requestId,
            requestKind: persistedEvent.requestKind,
            question: persistedEvent.question,
            toolName: persistedEvent.toolName,
            path: persistedEvent.path,
          }
          if (index >= 0) this.interactionState.pendingApprovals[index] = pending
          else this.interactionState.pendingApprovals.push(pending)
        } else if (index >= 0) {
          this.interactionState.pendingApprovals.splice(index, 1)
        }
        if (this.interactionStore) break
        try {
          this.append({
            version: 2,
            type: 'approval_state',
            timestamp,
            requestId: persistedEvent.requestId,
            requestKind: persistedEvent.requestKind,
            state: persistedEvent.state,
            decision: persistedEvent.decision,
            question: persistedEvent.question,
            toolName: persistedEvent.toolName,
            path: persistedEvent.path,
          }, 'critical')
        } catch (error) {
          this.interactionState.pendingApprovals = previousPendingApprovals
          throw error
        }
        break
      }
      case 'context:segment_created':
        this.markSnapshotDirty()
        this.append({
          version: 1,
          type: 'state',
          timestamp,
          activeTurns: this.engine.getSession().turns,
          contextSegments: this.engine.getContextSegments(),
          contextReservoir: this.engine.getContextReservoir(),
        }, 'terminal')
        break
      case 'context:compaction_started':
      case 'context:compaction_summarizing':
      case 'context:compaction_fallback':
      case 'context:compaction_committing':
      case 'context:compaction_progress':
      case 'context:compaction_interrupted':
      case 'context:compaction_failed':
      case 'context:compaction_completed': {
        this.markSnapshotDirty()
        const completed = persistedEvent.type === 'context:compaction_completed'
        this.append({
          version: 2,
          type: 'context_compaction',
          timestamp,
          state: persistedEvent.state,
          ...(completed ? {
            activeTurns: this.engine.getSession().turns,
            contextSegments: this.engine.getContextSegments?.() ?? [],
            contextReservoir: this.engine.getContextReservoir?.() ?? [],
          } : {}),
        }, persistedEvent.type === 'context:compaction_progress' ? 'streaming' : 'critical')
        break
      }
      case 'mode:change':
        if (!this.hasPersistableConversationState()) break
        this.markSnapshotDirty()
        this.append({ version: 1, type: 'meta', timestamp, meta: this.buildMeta() }, 'critical')
        break
      case 'error':
        if (!this.hasPersistableConversationState()) break
        this.markSnapshotDirty()
        this.append({ version: 1, type: 'stream_end', timestamp, interrupted: true }, 'terminal')
        break
      case 'session:complete':
        this.persist(true)
        break
    }
  }

  persist(compact = false): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.hasPersistableConversationState()) return
    if (!compact && this.snapshotRevision === this.persistedSnapshotRevision) return
    const conv = this.buildConversation()
    if (this.runtimeRepositoryV2) {
      try {
        if (this.canonicalPersistenceActive) this.runtimeRepositoryV2.synchronizeMetadata(conv)
        else this.runtimeRepositoryV2.persist(conv)
        this.persistedSnapshotRevision = this.snapshotRevision
        this.lastPersistedSnapshotHash = snapshotRevisionHash(this.snapshotRevision)
        this.reportPersistenceSuccess()
      } catch (error) {
        this.reportPersistenceFailure(error)
      }
      return
    }
    try {
      this.ensureJournal()
      this.journalWriter.flush(true)
      if (compact) {
        saveConversation(conv, { compact: true }, this.conversationsRoot)
      } else {
        this.journalWriter.append({ version: 1, type: 'snapshot', timestamp: Date.now(), conversation: conv }, 'terminal')
      }
      this.lastPersistedSnapshotHash = snapshotRevisionHash(this.snapshotRevision)
      this.persistedSnapshotRevision = this.snapshotRevision
      this.reportPersistenceSuccess()
    } catch (error) {
      this.reportPersistenceFailure(error)
    }
  }

  rewriteCurrentSnapshot(): void {
    if (!this.isPersistenceHealthy()) throw new Error('Conversation persistence is degraded')
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    const conversation = this.buildConversation()
    if (this.runtimeRepositoryV2) {
      try {
        this.runtimeRepositoryV2.rewrite(conversation)
        this.snapshotRevision += 1
        this.persistedSnapshotRevision = this.snapshotRevision
        this.lastPersistedSnapshotHash = snapshotRevisionHash(this.snapshotRevision)
        this.reportPersistenceSuccess()
        return
      } catch (error) {
        this.reportPersistenceFailure(error)
        throw (error instanceof Error ? error : new Error(String(error)))
      }
    }
    try {
      this.ensureJournal()
      this.journalWriter.flush(true)
      saveConversation(conversation, { compact: true }, this.conversationsRoot)
      this.snapshotRevision += 1
      this.persistedSnapshotRevision = this.snapshotRevision
      this.lastPersistedSnapshotHash = snapshotRevisionHash(this.snapshotRevision)
      this.reportPersistenceSuccess()
    } catch (error) {
      this.reportPersistenceFailure(error)
      throw (error instanceof Error ? error : new Error(String(error)))
    }
  }

  startNew(): string {
    if (!this.isPersistenceHealthy()) throw new Error('Conversation persistence is degraded; retry or export before starting a new session')
    this.persist(true)
    if (!this.isPersistenceHealthy()) throw new Error('Conversation persistence degraded while saving; retry or export before starting a new session')
    return this.sessionRegistry.createAndActivate('conv')
  }

  list(): ConversationMeta[] {
    if (this.runtimeRepositoryV2) return this.runtimeRepositoryV2.list()
    return listConversations(this.workspacePath, this.conversationsRoot)
  }

  listAll(): ConversationMeta[] {
    if (this.runtimeRepositoryV2) return this.runtimeRepositoryV2.list()
    return listConversations(undefined, this.conversationsRoot)
  }

  listAsync(): Promise<ConversationMeta[]> {
    if (this.runtimeRepositoryV2) return Promise.resolve(this.runtimeRepositoryV2.list())
    return this.listFromCatalogAsync()
  }

  private async listFromCatalogAsync(): Promise<ConversationMeta[]> {
    this.conversationCatalogInitialization ||= this.conversationCatalog.initialize()
    await this.conversationCatalogInitialization
    this.conversationCatalog.upsert(this.getCatalogMeta(), this.hasCatalogContent())
    await this.conversationCatalog.flush()
    return this.conversationCatalog.listAll()
      .filter(conversation => sameWorkspacePath(conversation.workspacePath, this.workspacePath))
  }

  switchTo(id: string): PersistedConversation | null {
    if (!this.isPersistenceHealthy()) return null
    this.persist(true)
    if (!this.isPersistenceHealthy()) return null
    const conv = this.runtimeRepositoryV2
      ? this.runtimeRepositoryV2.load(id)
      : loadConversation(id, this.conversationsRoot)
    return conv ? this.activateConversation(conv) : null
  }

  async switchToAsync(id: string): Promise<PersistedConversation | null> {
    if (!this.isPersistenceHealthy()) return null
    this.persist(true)
    if (!this.isPersistenceHealthy()) return null
    const conv = this.runtimeRepositoryV2
      ? this.runtimeRepositoryV2.load(id)
      : await loadConversationAsync(id, this.conversationsRoot)
    return conv ? this.activateConversation(conv) : null
  }

  async loadCurrentAsync(): Promise<PersistedConversation | null> {
    if (!this.isPersistenceHealthy()) return null
    const conv = this.runtimeRepositoryV2
      ? this.runtimeRepositoryV2.load(this.currentId)
      : await loadConversationAsync(this.currentId, this.conversationsRoot)
    return conv ? this.activateConversation(conv) : null
  }

  delete(id: string): boolean {
    if (!this.isPersistenceHealthy()) return false
    if (id === this.currentId) return false
    if (this.runtimeRepositoryV2) return this.runtimeRepositoryV2.archive(id)
    const conv = loadConversation(id, this.conversationsRoot)
    if (!conv || !sameWorkspacePath(conv.workspacePath, this.workspacePath)) return false
    return deleteConversation(id, this.conversationsRoot)
  }

  async deleteAsync(id: string): Promise<boolean> {
    if (!this.isPersistenceHealthy()) return false
    if (id === this.currentId) return false
    if (this.runtimeRepositoryV2) return this.runtimeRepositoryV2.archive(id)
    const conv = await loadConversationAsync(id, this.conversationsRoot)
    if (!conv || !sameWorkspacePath(conv.workspacePath, this.workspacePath)) return false
    const deleted = await deleteConversationAsync(id, this.conversationsRoot)
    if (deleted) {
      this.conversationCatalog.remove(id)
      await this.conversationCatalog.flush()
    }
    return deleted
  }

  async renameAsync(id: string, requestedTitle: string, source: 'custom' | 'generated' = 'custom'): Promise<boolean> {
    if (!this.isPersistenceHealthy()) return false
    const title = source === 'custom'
      ? normalizeConversationTitleText(requestedTitle, 80)
      : generatedConversationTitle(requestedTitle, 80)
    if (!title) return false
    if (id === this.currentId) {
      const previousCustomTitle = this.customTitles.get(id)
      const previousGeneratedTitle = this.generatedTitles.get(id)
      const session = this.engine.getSession()
      const previousUpdatedAt = session.updatedAt
      const updatedAt = this.now()
      if (source === 'custom') {
        this.customTitles.set(id, title)
        this.generatedTitles.delete(id)
      } else {
        this.customTitles.delete(id)
        this.generatedTitles.set(id, title)
      }
      try {
        session.updatedAt = updatedAt
        if (this.journalInitialized) {
          this.append({ version: 1, type: 'meta', timestamp: updatedAt, meta: this.buildMeta() }, 'critical')
        } else {
          this.ensureJournal()
        }
        this.markSnapshotDirty()
        return true
      } catch (error) {
        if (previousCustomTitle === undefined) this.customTitles.delete(id)
        else this.customTitles.set(id, previousCustomTitle)
        if (previousGeneratedTitle === undefined) this.generatedTitles.delete(id)
        else this.generatedTitles.set(id, previousGeneratedTitle)
        session.updatedAt = previousUpdatedAt
        throw error
      }
    }
    if (this.runtimeRepositoryV2) {
      const renamed = this.runtimeRepositoryV2.rename(id, title, source, this.now())
      if (renamed) {
        if (source === 'custom') this.customTitles.set(id, title)
        else this.generatedTitles.set(id, title)
      }
      return renamed
    }
    const conversation = await loadConversationAsync(id, this.conversationsRoot)
    if (!conversation || !sameWorkspacePath(conversation.workspacePath, this.workspacePath)) return false
    conversation.title = title
    conversation.titleSource = source
    conversation.updatedAt = this.now()
    saveConversation(conversation, { compact: true }, this.conversationsRoot)
    if (source === 'custom') {
      this.customTitles.set(id, title)
      this.generatedTitles.delete(id)
    } else {
      this.customTitles.delete(id)
      this.generatedTitles.set(id, title)
    }
    this.markSnapshotDirty()
    return true
  }

  resumeLast(): PersistedConversation | null {
    const all = this.list()
    if (all.length === 0) return null
    return this.switchTo(all[0].id)
  }

  async resumeLastAsync(): Promise<PersistedConversation | null> {
    const all = this.runtimeRepositoryV2 ? this.runtimeRepositoryV2.list() : await listConversationsAsync(this.workspacePath, this.conversationsRoot)
    if (all.length === 0) return null
    return this.switchToAsync(all[0].id)
  }

  destroy(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.persist()
    this.journalWriter.close()
    this.unsubscribeSessionIdentity()
  }

  flushJournal(): void {
    this.journalWriter.flush(true)
  }

  getJournalStats(): ConversationJournalWriterStats {
    return this.journalWriter.getStats()
  }

  getPersistenceHealth(): ConversationPersistenceHealth {
    const writerHealth = this.journalWriter.getHealth()
    const error = this.persistenceError?.message ?? writerHealth.error
    return {
      status: error ? 'degraded' : 'healthy',
      error,
      degradedAt: this.persistenceDegradedAt ?? writerHealth.failedAt,
      pendingRecoveryEntries: writerHealth.pendingRecoveryEntries,
      pendingStreamingEntries: writerHealth.pendingStreamingEntries,
    }
  }

  isPersistenceHealthy(): boolean {
    return this.getPersistenceHealth().status === 'healthy'
  }

  retryPersistence(): ConversationPersistenceHealth {
    if (this.runtimeRepositoryV2) {
      try {
        const conversation = this.buildConversation()
        if (this.canonicalPersistenceActive) this.runtimeRepositoryV2.synchronizeMetadata(conversation)
        else this.runtimeRepositoryV2.persist(conversation)
        this.reportPersistenceSuccess()
      } catch (error) {
        this.reportPersistenceFailure(error)
      }
      return this.getPersistenceHealth()
    }
    const probe: ConversationJournalEntry = {
      version: 1,
      type: 'meta',
      timestamp: this.now(),
      meta: this.buildMeta(),
    }
    try {
      this.journalWriter.retry(probe)
      this.journalInitialized = true
      this.lastPersistedSnapshotHash = ''
      this.reportPersistenceSuccess()
      this.persist(true)
    } catch (error) {
      this.reportPersistenceFailure(error)
    }
    return this.getPersistenceHealth()
  }

  exportRecoveryBundle(requestedPath?: string): string {
    const health = this.getPersistenceHealth()
    return writeConversationRecoveryBundle(this.workspacePath, {
      schemaVersion: 1,
      exportedAt: this.now(),
      readOnlyRecovery: true,
      conversation: this.buildConversation(),
      persistence: {
        status: health.status,
        error: health.error,
        degradedAt: health.degradedAt,
        pendingRecoveryEntries: health.pendingRecoveryEntries,
      },
      journalStats: this.journalWriter.getStats(),
    }, requestedPath)
  }

  recordQueueState(inputs: ConversationQueuedInput[]): boolean {
    const previous = this.interactionState.queuedInputs
    const next = inputs.map(input => ({
      ...input,
      attachments: input.attachments ? [...input.attachments] : undefined,
      capabilities: input.capabilities
        ? { items: input.capabilities.items.map(item => ({ ...item })) }
        : undefined,
    }))
    this.interactionState.queuedInputs = next
    this.markSnapshotDirty()
    if (this.interactionStore) {
      try {
        this.interactionStore.save(this.currentId, this.interactionState)
        return true
      } catch (error) {
        this.interactionState.queuedInputs = previous
        this.reportPersistenceFailure(error)
        return false
      }
    }
    if (!this.journalInitialized && !this.hasPersistableConversationState()) return true
    try {
      this.ensureJournal()
      return this.append({
        version: 2,
        type: 'queue_state',
        timestamp: this.now(),
        inputs: next,
      }, 'critical')
    } catch {
      this.interactionState.queuedInputs = previous
      return false
    }
  }

  recordWorkflowState(workflow: WorkflowInstanceState | null): boolean {
    const previous = this.interactionState.workflow
    this.interactionState.workflow = workflow ? structuredClone(workflow) : undefined
    this.markSnapshotDirty()
    if (this.interactionStore) {
      try {
        this.interactionStore.save(this.currentId, this.interactionState)
        return true
      } catch (error) {
        this.interactionState.workflow = previous
        this.reportPersistenceFailure(error)
        return false
      }
    }
    try {
      this.ensureJournal()
      return this.append({
        version: 4,
        type: 'workflow_state',
        timestamp: this.now(),
        workflow: workflow ? structuredClone(workflow) : null,
      }, 'critical')
    } catch {
      this.interactionState.workflow = previous
      return false
    }
  }

  recordDraftState(draft: ConversationDraftState): boolean {
    this.interactionState.draft = {
      ...draft,
      attachments: draft.attachments ? [...draft.attachments] : undefined,
      files: draft.files ? draft.files.map(file => ({ ...file })) : undefined,
      pendingPastes: draft.pendingPastes
        ? draft.pendingPastes.map(pending => ({ ...pending }))
        : undefined,
      capabilities: draft.capabilities
        ? { items: draft.capabilities.items.map(item => ({ ...item })) }
        : undefined,
    }
    this.markSnapshotDirty()
    if (this.interactionStore) {
      try {
        this.interactionStore.save(this.currentId, this.interactionState)
        return true
      } catch (error) {
        this.reportPersistenceFailure(error)
        return false
      }
    }
    if (!this.journalInitialized && !this.hasPersistableConversationState()) return true
    try {
      this.ensureJournal()
      return this.append({
        version: 2,
        type: 'draft_state',
        timestamp: this.now(),
        draft: this.interactionState.draft,
      }, 'streaming')
    } catch {
      return false
    }
  }

  private buildConversation(): PersistedConversation {
    const session = this.engine.getSession()
    const fullTurns = this.engine.getFullConversationTurns()
    const activeTurnsMatchFullConversation = session.turns.length === fullTurns.length
      && session.turns.every((turn, index) => turn === fullTurns[index])
    return redactComputerConversation({
      id: this.currentId,
      title: this.customTitles.get(this.currentId) || this.generatedTitles.get(this.currentId) || this.buildTitle(fullTurns),
      titleSource: this.customTitles.has(this.currentId) ? 'custom' : 'generated',
      workspacePath: this.workspacePath,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt ?? this.now(),
      mode: session.mode,
      model: this.config.model,
      provider: this.config.provider,
      turnCount: fullTurns.length,
      turns: fullTurns,
      canonicalEvents: this.canonicalEvents.map(event => structuredClone(event)),
      ...(activeTurnsMatchFullConversation ? {} : { activeTurns: session.turns }),
      contextSegments: this.engine.getContextSegments(),
      contextReservoir: this.engine.getContextReservoir(),
      contextCompactionState: this.engine.getContextCompactionState?.() ?? null,
      workExecution: this.engine.getWorkExecutionSnapshot?.(),
      modelSurface: this.engine.getModelSurfaceState?.(),
      interactionState: JSON.parse(JSON.stringify(this.interactionState)) as ConversationInteractionState,
    })
  }

  private activateConversation(conv: PersistedConversation): PersistedConversation | null {
    if (!sameWorkspacePath(conv.workspacePath, this.workspacePath)) return null
    this.sessionRegistry.activate(conv.id)
    this.interactionState = this.interactionStore?.load(conv.id)
      ?? (conv.interactionState
        ? JSON.parse(JSON.stringify(conv.interactionState)) as ConversationInteractionState
        : createEmptyInteractionState())
    this.canonicalEvents = conv.canonicalEvents ? conv.canonicalEvents.map(event => structuredClone(event)) : []
    this.restoreModelRequests(this.canonicalEvents)
    this.canonicalEventIds.clear()
    for (const event of this.canonicalEvents) this.canonicalEventIds.add(event.eventId)
    this.canonicalLastSeq = this.canonicalEvents.at(-1)?.seq ?? 0
    this.canonicalPersistenceActive = Boolean(this.runtimeRepositoryV2 && this.canonicalEvents.length > 0)
    if (conv.titleSource === 'custom') {
      this.customTitles.set(conv.id, conv.title)
      this.generatedTitles.delete(conv.id)
    } else {
      this.customTitles.delete(conv.id)
      this.generatedTitles.set(conv.id, conv.title)
    }
    this.engine.restoreFromTurns(conv.activeTurns ?? conv.turns, {
      emitRunState: false,
      emitRuntimeEvents: false,
    })
    this.engine.restoreModelSurfaceState?.(conv.modelSurface, conv.activeTurns ?? conv.turns)
    this.engine.setContextSegments(conv.contextSegments ?? [])
    this.engine.setContextReservoir(conv.contextReservoir ?? [])
    this.engine.setContextCompactionState?.(conv.contextCompactionState ?? null)
    this.engine.restoreWorkExecutionSnapshot?.(conv.workExecution, { emitRuntimeEvent: false })
    const session = this.engine.getSession()
    session.createdAt = conv.createdAt
    session.updatedAt = conv.updatedAt
    if (this.engine.getMode() !== conv.mode) this.engine.setMode(conv.mode, { emitRuntimeEvent: false })
    this.snapshotRevision += 1
    this.persistedSnapshotRevision = this.snapshotRevision
    this.lastPersistedSnapshotHash = conversationSnapshotHash(conv)
    return conv
  }

  private buildMeta(): ConversationMeta {
    const session = this.engine.getSession()
    const fullTurns = this.engine.getFullConversationTurns()
    return {
      id: this.currentId,
      title: this.customTitles.get(this.currentId) || this.generatedTitles.get(this.currentId) || this.buildTitle(fullTurns),
      titleSource: this.customTitles.has(this.currentId) ? 'custom' : 'generated',
      workspacePath: this.workspacePath,
      createdAt: session.createdAt,
      updatedAt: this.currentActivityAt(),
      mode: session.mode,
      model: this.config.model,
      provider: this.config.provider,
      turnCount: fullTurns.length,
    }
  }

  private currentActivityAt(): number {
    const session = this.engine.getSession()
    return session.updatedAt ?? session.createdAt ?? this.now()
  }

  private buildTitle(turns: AgentTurn[]): string {
    const canonicalObjective = this.canonicalEvents.find(event => event.type === 'run.started')?.payload.objective
    const source = turns.find(turn => turn.role === 'user')?.content
      || canonicalObjective
      || this.interactionState.queuedInputs[0]?.prompt
      || this.interactionState.draft.text
      || this.interactionState.pendingSteering[0]?.text
      || ''
    const title = generatedConversationTitle(source, 60)
    return title || '未命名任务'
  }

  private hasPersistableConversationState(): boolean {
    const hasTurns = this.engine.getSession().turns.some(turn => turn.role !== 'system')
      || this.engine.getContextReservoir().some(entry => entry.turns.length > 0)
    if (hasTurns) return true
    const draft = this.interactionState.draft
    return this.interactionState.queuedInputs.length > 0
      || Boolean(draft.text.trim())
      || Boolean(draft.attachments?.length)
      || Boolean(draft.files?.length)
      || Boolean(draft.capabilities?.items.length)
      || Boolean(draft.pendingPastes?.length)
      || this.interactionState.pendingSteering.length > 0
      || (!this.interactionStore && this.interactionState.pendingApprovals.length > 0)
  }

  private shouldInitializeJournalForEvent(event: AgentEventType): boolean {
    switch (event.type) {
      case 'turn:start':
      case 'turn:complete':
      case 'stream:start':
      case 'stream:delta':
      case 'stream:thinking_delta':
      case 'stream:end':
      case 'tool:call':
      case 'tool:result':
      case 'context:segment_created':
      case 'context:compaction_started':
      case 'context:compaction_summarizing':
      case 'context:compaction_fallback':
      case 'context:compaction_committing':
      case 'context:compaction_progress':
      case 'context:compaction_interrupted':
      case 'context:compaction_failed':
      case 'context:compaction_completed':
        return true
      case 'input:state':
      case 'approval:state':
        return !this.interactionStore
      case 'mode:change':
      case 'error':
        return this.hasPersistableConversationState()
      default:
        return false
    }
  }

  private ensureJournal(): void {
    if (this.journalInitialized) return
    const entry: ConversationJournalEntry = {
      version: 1,
      type: 'meta',
      timestamp: this.now(),
      meta: this.buildMeta(),
    }
    if (this.append(entry, 'critical')) this.journalInitialized = true
  }

  private append(entry: ConversationJournalEntry, durability: JournalDurability): boolean {
    if (this.runtimeRepositoryV2) {
      if (durability === 'streaming') return true
      try {
        const conversation = this.buildConversation()
        if (this.canonicalPersistenceActive) this.runtimeRepositoryV2.synchronizeMetadata(conversation)
        else this.runtimeRepositoryV2.persist(conversation)
        this.reportPersistenceSuccess()
        return true
      } catch (error) {
        this.reportPersistenceFailure(error)
        if (durability === 'critical') throw (error instanceof Error ? error : new Error(String(error)))
        return false
      }
    }
    try {
      this.journalWriter.append(entry, durability)
      this.reportPersistenceSuccess()
      return true
    } catch (error) {
      this.reportPersistenceFailure(error)
      if (durability === 'critical') throw (error instanceof Error ? error : new Error(String(error)))
      return false
    }
  }

  private markSnapshotDirty(): void {
    this.snapshotRevision += 1
  }

  private reportPersistenceFailure(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error))
    if (this.persistenceError?.message === normalized.message) return
    this.persistenceError = normalized
    this.persistenceDegradedAt = this.persistenceDegradedAt ?? this.now()
    this.onPersistenceStatus?.(normalized)
  }

  private reportPersistenceSuccess(): void {
    if (!this.persistenceError) return
    this.persistenceError = null
    this.persistenceDegradedAt = null
    this.onPersistenceStatus?.(null)
  }
}
