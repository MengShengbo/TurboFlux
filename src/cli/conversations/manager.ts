import type { AgentEngine } from '../../core/agentEngine'
import type { TurboFluxConfig } from '../../core/config'
import type { PersistedConversation, ConversationMeta } from './types'
import { saveConversation, loadConversation, listConversations, deleteConversation } from './store'

export class ConversationManager {
  private currentId: string
  private saveTimer: ReturnType<typeof setTimeout> | null = null

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

  persist(): void {
    const session = this.engine.getSession()
    if (session.turns.length === 0) return

    const firstUserMsg = session.turns.find(t => t.role === 'user')
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
      turnCount: session.turns.length,
      turns: session.turns,
      contextSegments: this.engine.getContextSegments(),
    }
    saveConversation(conv)
  }

  startNew(): string {
    this.persist()
    this.currentId = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return this.currentId
  }

  list(): ConversationMeta[] {
    return listConversations()
  }

  switchTo(id: string): PersistedConversation | null {
    this.persist()
    const conv = loadConversation(id)
    if (!conv) return null
    this.currentId = id
    return conv
  }

  delete(id: string): boolean {
    return deleteConversation(id)
  }

  resumeLast(): PersistedConversation | null {
    const all = listConversations()
    if (all.length === 0) return null
    return this.switchTo(all[0].id)
  }

  destroy(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.persist()
  }
}
