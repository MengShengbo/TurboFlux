import type { AgentTurn, ToolCall, ToolResult } from '@turboflux/contracts/agentTypes'

/** Index once when data arrives, never scan the full transcript for each rendered node. */
export class TranscriptIndex {
  readonly turns = new Map<string, AgentTurn>()
  readonly calls = new Map<string, ToolCall>()
  readonly results = new Map<string, ToolResult>()
  private readonly versions = new Map<string, { content: string; revision: number }>()
  private revision = 0

  setTurn(turn: AgentTurn): void {
    this.turns.set(turn.id, turn)
    this.record(`turn:${turn.id}`, turn)
    for (const call of turn.toolCalls || []) this.setCall(call)
    for (const result of turn.toolResults || []) this.setResult(result)
  }

  setCall(call: ToolCall): void {
    this.calls.set(call.id, call)
    this.record(`call:${call.id}`, call)
  }

  setResult(result: ToolResult): void {
    this.results.set(result.toolCallId, result)
    this.record(`result:${result.toolCallId}`, result)
  }

  turnVersion(id: string): number { return this.versions.get(`turn:${id}`)?.revision || 0 }

  toolVersion(id: string): number {
    return Math.max(this.versions.get(`call:${id}`)?.revision || 0, this.versions.get(`result:${id}`)?.revision || 0)
  }

  reset(turns: readonly AgentTurn[] = []): void {
    this.turns.clear()
    this.calls.clear()
    this.results.clear()
    this.versions.clear()
    for (const turn of turns) this.setTurn(turn)
  }

  private record(key: string, value: unknown): void {
    const content = JSON.stringify(value)
    if (this.versions.get(key)?.content === content) return
    this.versions.set(key, { content, revision: ++this.revision })
  }
}
