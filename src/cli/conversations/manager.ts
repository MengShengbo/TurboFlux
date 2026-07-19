import type { AgentEngine, AgentEventType } from '../../core/agentEngine'
import type { TurboFluxConfig } from '../../core/config'
import type { ConversationJournalEntry, PersistedConversation, ConversationMeta } from './types'
import { appendConversationJournal, saveConversation, loadConversation, listConversations, deleteConversation, sameWorkspacePath } from './store'

export class ConversationManager {
  private currentId: string
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private journalInitialized = false
  private lastPersistedSnapshot = ''

  constructor(
    private engine: AgentEngine,
    private config: TurboFluxConfig,
    private workspacePath: string,
  ) {
    this.currentId = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
    this.ensureJournal()
    const timestamp = Date.now()
    switch (event.type) {
      case 'turn:start':
      case 'turn:complete':
        this.append({ version: 1, type: 'turn', timestamp, turn: event.turn })
        break
      case 'stream:start':
        this.append({ version: 1, type: 'stream_start', timestamp })
        break
      case 'stream:delta':
        if (event.text) this.append({ version: 1, type: 'stream_delta', timestamp, text: event.text })
        break
      case 'stream:end':
        this.append({ version: 1, type: 'stream_end', timestamp, interrupted: event.interrupted === true })
        break
      case 'tool:call':
        this.append({ version: 1, type: 'tool_call', timestamp, toolCall: event.toolCall })
        break
      case 'tool:result':
        this.append({ version: 1, type: 'tool_result', timestamp, toolResult: event.toolResult })
        break
      case 'context:segment_created':
        this.append({
          version: 1,
          type: 'state',
          timestamp,
          activeTurns: this.engine.getSession().turns,
          contextSegments: this.engine.getContextSegments(),
          contextReservoir: this.engine.getContextReservoir(),
        })
        break
      case 'mode:change':
        this.append({ version: 1, type: 'meta', timestamp, meta: this.buildMeta() })
        break
      case 'error':
        this.append({ version: 1, type: 'stream_end', timestamp, interrupted: true })
        break
      case 'session:complete':
        this.persist()
        break
    }
  }

  persist(): void {
    const session = this.engine.getSession()
    const fullTurns = this.engine.getFullConversationTurns()
    if (fullTurns.length === 0) return

    const firstUserMsg = fullTurns.find(t => t.role === 'user')
    const title = firstUserMsg
      ? firstUserMsg.content.slice(0, 60).replace(/\n/g, ' ')
      : 'Untitled'

    const conv: PersistedConversation = {
      id: this.currentId,
      title,
      workspacePath: this.workspacePath,
      createdAt: session.createdAt,
      updatedAt: Date.now(),
      mode: session.mode,
      model: this.config.model,
      provider: this.config.provider,
      turnCount: fullTurns.length,
      turns: fullTurns,
      activeTurns: session.turns,
      contextSegments: this.engine.getContextSegments(),
      contextReservoir: this.engine.getContextReservoir(),
    }
    const snapshot = JSON.stringify(conv)
    if (snapshot === this.lastPersistedSnapshot) return
    try {
      this.ensureJournal()
      saveConversation(conv)
      this.lastPersistedSnapshot = snapshot
    } catch {}
  }

  startNew(): string {
    this.persist()
    this.currentId = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.journalInitialized = false
    this.lastPersistedSnapshot = ''
    return this.currentId
  }

  list(): ConversationMeta[] {
    return listConversations(this.workspacePath)
  }

  switchTo(id: string): PersistedConversation | null {
    this.persist()
    const conv = loadConversation(id)
    if (!conv) return null
    if (!sameWorkspacePath(conv.workspacePath, this.workspacePath)) return null
    this.currentId = id
    this.journalInitialized = false
    this.lastPersistedSnapshot = JSON.stringify(conv)
    return conv
  }

  delete(id: string): boolean {
    const conv = loadConversation(id)
    if (!conv || !sameWorkspacePath(conv.workspacePath, this.workspacePath)) return false
    return deleteConversation(id)
  }

  resumeLast(): PersistedConversation | null {
    const all = listConversations(this.workspacePath)
    if (all.length === 0) return null
    return this.switchTo(all[0].id)
  }

  destroy(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.persist()
  }

  private buildMeta(): ConversationMeta {
    const session = this.engine.getSession()
    const fullTurns = this.engine.getFullConversationTurns()
    const firstUserMsg = fullTurns.find(turn => turn.role === 'user')
    return {
      id: this.currentId,
      title: firstUserMsg ? firstUserMsg.content.slice(0, 60).replace(/\n/g, ' ') : 'Untitled',
      workspacePath: this.workspacePath,
      createdAt: session.createdAt,
      updatedAt: Date.now(),
      mode: session.mode,
      model: this.config.model,
      provider: this.config.provider,
      turnCount: fullTurns.length,
    }
  }

  private ensureJournal(): void {
    if (this.journalInitialized) return
    const entry: ConversationJournalEntry = {
      version: 1,
      type: 'meta',
      timestamp: Date.now(),
      meta: this.buildMeta(),
    }
    if (this.append(entry)) this.journalInitialized = true
  }

  private append(entry: ConversationJournalEntry): boolean {
    try {
      appendConversationJournal(this.currentId, entry)
      return true
    } catch {
      return false
    }
  }
}
