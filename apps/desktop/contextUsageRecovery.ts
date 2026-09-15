import type { AgentTurn, TokenUsage } from '@turboflux/agent-core/workbench'

function finiteTokenCount(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0
}

export function contextUsageTokenCount(usage: TokenUsage | undefined): number {
  if (!usage) return 0
  const total = finiteTokenCount(usage.total)
  return total > 0 ? total : finiteTokenCount(usage.input) + finiteTokenCount(usage.output)
}

export function recoverContextUsage(liveUsage: TokenUsage, turns: AgentTurn[]): TokenUsage {
  if (contextUsageTokenCount(liveUsage) > 0) return liveUsage
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const persisted = turns[index]?.metadata?.tokens
    if (contextUsageTokenCount(persisted) <= 0) continue
    return {
      ...persisted,
      total: contextUsageTokenCount(persisted),
      source: persisted?.source || 'provider',
    }
  }
  return liveUsage
}
