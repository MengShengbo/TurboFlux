import type { AgentTurn } from '@turboflux/agent-core/workbench'

export interface HistoryRewriteProjection {
  retainedTurns: AgentTurn[]
  optimisticTurn: AgentTurn
  prompts: string[]
  promptCount: number
  abandonedToolCount: number
  abandonedChangedPaths: string[]
}

function cloneEditedTurnMetadata(turn: AgentTurn): AgentTurn['metadata'] {
  const attachments = turn.metadata?.attachments?.map(attachment => ({ ...attachment }))
  const capabilities = turn.metadata?.capabilities
    ? { items: turn.metadata.capabilities.items.map(capability => ({ ...capability })) }
    : undefined
  return {
    ...(attachments?.length ? { attachments } : {}),
    ...(capabilities?.items.length ? { capabilities } : {}),
    workRunId: turn.id,
  }
}

export function projectHistoryRewrite(
  turns: readonly AgentTurn[],
  turnId: string,
  prompt: string,
  timestamp = Date.now(),
): HistoryRewriteProjection | undefined {
  const turnIndex = turns.findIndex(turn => turn.id === turnId && turn.role === 'user')
  if (turnIndex < 0) return undefined
  const text = prompt.trim()
  if (!text) return undefined
  const original = turns[turnIndex]!
  const retainedTurns = turns.slice(0, turnIndex).map(turn => ({ ...turn }))
  const abandonedTurns = turns.slice(turnIndex + 1)
  const abandonedChangedPaths = [...new Set(abandonedTurns.flatMap(turn => (
    turn.toolResults || []
  )).flatMap(result => result.changeSummary?.path ? [result.changeSummary.path] : []))]
  const prompts = retainedTurns
    .filter(turn => turn.role === 'user' && turn.metadata?.internal !== true)
    .map(turn => turn.content.trim())
    .filter(Boolean)
  prompts.push(text)
  return {
    retainedTurns,
    optimisticTurn: {
      id: original.id,
      role: 'user',
      content: text,
      timestamp,
      metadata: cloneEditedTurnMetadata(original),
    },
    prompts,
    promptCount: prompts.length,
    abandonedToolCount: abandonedTurns.reduce((count, turn) => count + (turn.toolCalls?.length || 0), 0),
    abandonedChangedPaths,
  }
}
