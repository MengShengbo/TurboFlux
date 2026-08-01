import { createHash } from 'node:crypto'
import type { AgentEngine, AgentEventType } from '../../core/agentEngine'
import type { TurboFluxConfig } from '../../core/config'
import type { AgentTurn } from '../../shared/agentTypes'
import type {
  ConversationDraftState,
  ConversationInteractionState,
  ConversationJournalEntry,
  ConversationMeta,
  ConversationQueuedInput,
  PersistedConversation,
} from './types'
import {
  deleteConversation,
  deleteConversationAsync,
  listConversations,
  listConversationsAsync,
  loadConversation,
  loadConversationAsync,
  sameWorkspacePath,
  saveConversation,
} from './store'
import { ConversationJournalWriter, type ConversationJournalWriterStats, type JournalDurability } from './journalWriter'
import { SessionRegistry } from '../../core/runtime/sessionRegistry'
import { writeConversationRecoveryBundle } from './recoveryExport'

export type ConversationPersistenceStatusHandler = (error: Error | null) => void

export interface ConversationManagerOptions {
  batchJournalStreaming?: boolean
  now?: () => number
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

function createEmptyInteractionState(): ConversationInteractionState {
  return { queuedInputs: [], draft: { text: '' }, pendingSteering: [], pendingApprovals: [] }
}

export class ConversationManager {
  private currentId: string
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private journalInitialized = false
  private lastPersistedSnapshotHash = ''
  private persistenceError: Error | null = null
  private persistenceDegradedAt: number | null = null
  private readonly journalWriter: ConversationJournalWriter
  private readonly sessionRegistry: SessionRegistry
  private readonly unsubscribeSessionIdentity: () => void
  private readonly now: () => number
  private interactionState = createEmptyInteractionState()

  constructor(
    private engine: AgentEngine,
    private config: TurboFluxConfig,
    private workspacePath: string,
    private onPersistenceStatus?: ConversationPersistenceStatusHandler,
    sessionRegistry?: SessionRegistry,
    options: ConversationManagerOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.sessionRegistry = sessionRegistry || new SessionRegistry()
    this.currentId = this.sessionRegistry.getCurrentId()
    this.journalWriter = new ConversationJournalWriter(this.currentId, {
      batchStreaming: options.batchJournalStreaming,
      onStatus: error => error ? this.reportPersistenceFailure(error) : this.reportPersistenceSuccess(),
    })
    this.unsubscribeSessionIdentity = this.sessionRegistry.subscribe(({ currentId }) => {
      this.journalWriter.switchConversation(currentId)
      this.currentId = currentId
      this.journalInitialized = false
      this.lastPersistedSnapshotHash = ''
      this.interactionState = createEmptyInteractionState()
    })
  }

  getCurrentId(): string {
    return this.currentId
  }

  updateConfig(config: TurboFluxConfig): void {
    this.config = config
  }

  scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.persist(), 500)
  }

  recordEvent(event: AgentEventType): void {
    if (this.shouldInitializeJournalForEvent(event)) this.ensureJournal()
    const timestamp = Date.now()
    switch (event.type) {
      case 'turn:start':
        this.append({ version: 1, type: 'turn', timestamp, turn: event.turn }, 'critical')
        break
      case 'turn:complete':
        this.append({ version: 1, type: 'turn', timestamp, turn: event.turn }, 'terminal')
        break
      case 'stream:start':
        this.append({ version: 1, type: 'stream_start', timestamp }, 'terminal')
        break
      case 'stream:delta':
        if (event.text) this.append({ version: 1, type: 'stream_delta', timestamp, text: event.text }, 'streaming')
        break
      case 'stream:thinking_delta':
        if (event.text) this.append({ version: 1, type: 'stream_thinking_delta', timestamp, text: event.text }, 'streaming')
        break
      case 'stream:end':
        this.append({ version: 1, type: 'stream_end', timestamp, interrupted: event.interrupted === true }, 'terminal')
        break
      case 'tool:call':
        this.append({ version: 1, type: 'tool_call', timestamp, toolCall: event.toolCall }, 'critical')
        break
      case 'tool:result':
        this.append({ version: 1, type: 'tool_result', timestamp, toolResult: event.toolResult }, 'terminal')
        break
      case 'input:state': {
        const index = this.interactionState.pendingSteering.findIndex(input => input.id === event.inputId)
        if (event.state === 'accepted') {
          const pending = { id: event.inputId, text: event.text }
          if (index >= 0) this.interactionState.pendingSteering[index] = pending
          else this.interactionState.pendingSteering.push(pending)
        } else if (index >= 0) {
          this.interactionState.pendingSteering.splice(index, 1)
        }
        this.append({
          version: 2,
          type: 'input_state',
          timestamp,
          inputId: event.inputId,
          intent: event.intent,
          state: event.state,
          text: event.text,
          reason: event.reason,
        }, event.state === 'accepted' ? 'critical' : 'terminal')
        break
      }
      case 'approval:state': {
        const index = this.interactionState.pendingApprovals.findIndex(request => request.requestId === event.requestId)
        if (event.state === 'requested') {
          const pending = {
            requestId: event.requestId,
            requestKind: event.requestKind,
            question: event.question,
            toolName: event.toolName,
            path: event.path,
          }
          if (index >= 0) this.interactionState.pendingApprovals[index] = pending
          else this.interactionState.pendingApprovals.push(pending)
        } else if (index >= 0) {
          this.interactionState.pendingApprovals.splice(index, 1)
        }
        this.append({
          version: 2,
          type: 'approval_state',
          timestamp,
          requestId: event.requestId,
          requestKind: event.requestKind,
          state: event.state,
          decision: event.decision,
          question: event.question,
          toolName: event.toolName,
          path: event.path,
        }, 'critical')
        break
      }
      case 'context:segment_created':
        this.append({
          version: 1,
          type: 'state',
          timestamp,
          activeTurns: this.engine.getSession().turns,
          contextSegments: this.engine.getContextSegments(),
          contextReservoir: this.engine.getContextReservoir(),
        }, 'terminal')
        break
      case 'mode:change':
        if (!this.hasPersistableConversationState()) break
        this.append({ version: 1, type: 'meta', timestamp, meta: this.buildMeta() }, 'critical')
        break
      case 'error':
        if (!this.hasPersistableConversationState()) break
        this.append({ version: 1, type: 'stream_end', timestamp, interrupted: true }, 'terminal')
        break
      case 'session:complete':
        this.persist(true)
        break
    }
  }

  persist(compact = false): void {
    if (!this.hasPersistableConversationState()) return
    const conv = this.buildConversation()
    const snapshotHash = conversationSnapshotHash(conv)
    if (!compact && snapshotHash === this.lastPersistedSnapshotHash) return
    try {
      this.ensureJournal()
      this.journalWriter.flush(true)
      if (compact) {
        saveConversation(conv, { compact: true })
      } else {
        this.journalWriter.append({ version: 1, type: 'snapshot', timestamp: Date.now(), conversation: conv }, 'terminal')
      }
      this.lastPersistedSnapshotHash = snapshotHash
      this.reportPersistenceSuccess()
    } catch (error) {
      this.reportPersistenceFailure(error)
    }
  }

  startNew(): string {
    if (!this.isPersistenceHealthy()) throw new Error('Conversation persistence is degraded; retry or export before starting a new session')
    this.persist(true)
    if (!this.isPersistenceHealthy()) throw new Error('Conversation persistence degraded while saving; retry or export before starting a new session')
    return this.sessionRegistry.createAndActivate('conv')
  }

  list(): ConversationMeta[] {
    return listConversations(this.workspacePath)
  }

  listAsync(): Promise<ConversationMeta[]> {
    return listConversationsAsync(this.workspacePath)
  }

  switchTo(id: string): PersistedConversation | null {
    if (!this.isPersistenceHealthy()) return null
    this.persist(true)
    if (!this.isPersistenceHealthy()) return null
    const conv = loadConversation(id)
    return conv ? this.activateConversation(conv) : null
  }

  async switchToAsync(id: string): Promise<PersistedConversation | null> {
    if (!this.isPersistenceHealthy()) return null
    this.persist(true)
    if (!this.isPersistenceHealthy()) return null
    const conv = await loadConversationAsync(id)
    return conv ? this.activateConversation(conv) : null
  }

  delete(id: string): boolean {
    if (!this.isPersistenceHealthy()) return false
    if (id === this.currentId) return false
    const conv = loadConversation(id)
    if (!conv || !sameWorkspacePath(conv.workspacePath, this.workspacePath)) return false
    return deleteConversation(id)
  }

  async deleteAsync(id: string): Promise<boolean> {
    if (!this.isPersistenceHealthy()) return false
    if (id === this.currentId) return false
    const conv = await loadConversationAsync(id)
    if (!conv || !sameWorkspacePath(conv.workspacePath, this.workspacePath)) return false
    return deleteConversationAsync(id)
  }

  resumeLast(): PersistedConversation | null {
    const all = listConversations(this.workspacePath)
    if (all.length === 0) return null
    return this.switchTo(all[0].id)
  }

  async resumeLastAsync(): Promise<PersistedConversation | null> {
    const all = await listConversationsAsync(this.workspacePath)
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
    this.interactionState.queuedInputs = inputs.map(input => ({
      ...input,
      attachments: input.attachments ? [...input.attachments] : undefined,
    }))
    if (!this.journalInitialized && !this.hasPersistableConversationState()) return true
    try {
      this.ensureJournal()
      return this.append({
        version: 2,
        type: 'queue_state',
        timestamp: this.now(),
        inputs: this.interactionState.queuedInputs,
      }, 'critical')
    } catch {
      return false
    }
  }

  recordDraftState(draft: ConversationDraftState): boolean {
    this.interactionState.draft = {
      ...draft,
      attachments: draft.attachments ? [...draft.attachments] : undefined,
      pendingPastes: draft.pendingPastes
        ? draft.pendingPastes.map(pending => ({ ...pending }))
        : undefined,
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
    return {
      id: this.currentId,
      title: this.buildTitle(fullTurns),
      workspacePath: this.workspacePath,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt ?? this.now(),
      mode: session.mode,
      model: this.config.model,
      provider: this.config.provider,
      turnCount: fullTurns.length,
      turns: fullTurns,
      ...(activeTurnsMatchFullConversation ? {} : { activeTurns: session.turns }),
      contextSegments: this.engine.getContextSegments(),
      contextReservoir: this.engine.getContextReservoir(),
      interactionState: JSON.parse(JSON.stringify(this.interactionState)) as ConversationInteractionState,
    }
  }

  private activateConversation(conv: PersistedConversation): PersistedConversation | null {
    if (!sameWorkspacePath(conv.workspacePath, this.workspacePath)) return null
    this.sessionRegistry.activate(conv.id)
    this.interactionState = conv.interactionState
      ? JSON.parse(JSON.stringify(conv.interactionState)) as ConversationInteractionState
      : createEmptyInteractionState()
    this.engine.restoreFromTurns(conv.activeTurns ?? conv.turns)
    this.engine.setContextSegments(conv.contextSegments ?? [])
    this.engine.setContextReservoir(conv.contextReservoir ?? [])
    const session = this.engine.getSession()
    session.createdAt = conv.createdAt
    session.updatedAt = conv.updatedAt
    if (this.engine.getMode() !== conv.mode) this.engine.setMode(conv.mode)
    this.lastPersistedSnapshotHash = conversationSnapshotHash(conv)
    return conv
  }

  private buildMeta(): ConversationMeta {
    const session = this.engine.getSession()
    const fullTurns = this.engine.getFullConversationTurns()
    return {
      id: this.currentId,
      title: this.buildTitle(fullTurns),
      workspacePath: this.workspacePath,
      createdAt: session.createdAt,
      updatedAt: Date.now(),
      mode: session.mode,
      model: this.config.model,
      provider: this.config.provider,
      turnCount: fullTurns.length,
    }
  }

  private buildTitle(turns: AgentTurn[]): string {
    const source = turns.find(turn => turn.role === 'user')?.content
      || this.interactionState.queuedInputs[0]?.prompt
      || this.interactionState.draft.text
      || this.interactionState.pendingSteering[0]?.text
      || ''
    const title = source.trim().slice(0, 60).replace(/\n/g, ' ')
    return title || 'Untitled'
  }

  private hasPersistableConversationState(): boolean {
    const hasTurns = this.engine.getSession().turns.some(turn => turn.role !== 'system')
      || this.engine.getContextReservoir().some(entry => entry.turns.length > 0)
    if (hasTurns) return true
    const draft = this.interactionState.draft
    return this.interactionState.queuedInputs.length > 0
      || Boolean(draft.text.trim())
      || Boolean(draft.attachments?.length)
      || Boolean(draft.pendingPastes?.length)
      || this.interactionState.pendingSteering.length > 0
      || this.interactionState.pendingApprovals.length > 0
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
      case 'input:state':
      case 'approval:state':
      case 'context:segment_created':
        return true
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
