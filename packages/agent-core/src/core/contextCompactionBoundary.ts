import type { AgentTurn } from '../shared/agentTypes'
import type { ContextSegment } from '../state/types'

export interface ContextCompactionPlan {
  oldTurns: AgentTurn[]
  recentTurns: AgentTurn[]
  startMessageId: string
  endMessageId: string
  originalCharCount: number
  existingSegment?: ContextSegment
}

export interface ContextCompactionPlanOptions {
  turns: readonly AgentTurn[]
  keepRecent: number
  segments: readonly ContextSegment[]
  countTurnChars(turn: AgentTurn): number
}

function cloneTurnForModelContext(turn: AgentTurn): AgentTurn {
  return {
    ...turn,
    toolCalls: turn.toolCalls?.map(toolCall => ({
      ...toolCall,
      arguments: { ...toolCall.arguments },
    })),
    toolResults: turn.toolResults?.map(toolResult => ({
      ...toolResult,
      attachments: toolResult.attachments?.map(attachment => ({ ...attachment })),
      changeSummary: toolResult.changeSummary ? { ...toolResult.changeSummary } : undefined,
    })),
    metadata: turn.metadata ? {
      ...turn.metadata,
      attachments: turn.metadata.attachments?.map(attachment => ({ ...attachment })),
      capabilities: turn.metadata.capabilities ? {
        items: turn.metadata.capabilities.items.map(item => ({ ...item })),
      } : undefined,
      thinking: turn.metadata.thinking ? { ...turn.metadata.thinking } : undefined,
      tokens: turn.metadata.tokens ? { ...turn.metadata.tokens } : undefined,
    } : undefined,
  }
}

export function projectTurnsForModelContext(turns: readonly AgentTurn[]): AgentTurn[] {
  return turns.map(cloneTurnForModelContext)
}

export function splitTurnsForCompaction(
  turns: readonly AgentTurn[],
  keepRecent: number,
): { oldTurns: AgentTurn[]; recentTurns: AgentTurn[] } {
  let splitIndex = Math.max(0, turns.length - Math.max(1, keepRecent))
  while (splitIndex > 0 && turns[splitIndex]?.role === 'tool_result') splitIndex -= 1
  return {
    oldTurns: turns.slice(0, splitIndex),
    recentTurns: turns.slice(splitIndex),
  }
}

export function planContextCompaction(
  options: ContextCompactionPlanOptions,
): ContextCompactionPlan | null {
  const nonSystemTurns = options.turns.filter(turn => turn.role !== 'system')
  if (nonSystemTurns.length <= options.keepRecent) return null

  const { oldTurns, recentTurns } = splitTurnsForCompaction(nonSystemTurns, options.keepRecent)
  if (oldTurns.length === 0) return null

  const firstVisible = oldTurns.find(turn => turn.role === 'user' || turn.role === 'assistant')
  const lastVisible = [...oldTurns].reverse().find(turn => turn.role === 'user' || turn.role === 'assistant')
  if (!firstVisible || !lastVisible) return null

  const existingSegment = options.segments.find(segment =>
    segment.isValid
    && segment.summary.trim().length > 0
    && segment.startMessageId === firstVisible.id
    && segment.endMessageId === lastVisible.id
  )

  return {
    oldTurns,
    recentTurns,
    startMessageId: firstVisible.id,
    endMessageId: lastVisible.id,
    originalCharCount: oldTurns.reduce((sum, turn) => sum + options.countTurnChars(turn), 0),
    existingSegment,
  }
}
