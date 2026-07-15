import type { AgentEngine } from '../../core/agentEngine'
import type { TurboFluxConfig } from '../../core/config'
import type { PersistedConversation, ConversationMeta } from './types'
import { saveConversation, loadConversation, listConversations, deleteConversation, sameWorkspacePath } from './store'

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
    saveConversation(conv)
  }

  startNew(): string {
    this.persist()
    this.currentId = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
}
