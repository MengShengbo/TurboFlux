import type { ToolCall, ToolResult } from '../shared/agentTypes'

export const DEFAULT_AGENT_SOFT_TURN_LIMIT = 25

export type AgentTurnBudgetDecision =
  | { kind: 'continue' }
  | { kind: 'extend'; previousLimit: number; nextLimit: number; successfulToolTurns: number }
  | { kind: 'pause'; reason: 'hard_limit' | 'stalled' | 'repeated_tools'; limit: number }

export class AdaptiveAgentTurnBudget {
  readonly softLimit: number
  readonly hardLimit?: number

  private currentLimit: number
  private checkpointStart = 0
  private successfulToolTurns = 0
  private previousToolFingerprint = ''
  private repeatedToolBatches = 0

  constructor(softLimit = DEFAULT_AGENT_SOFT_TURN_LIMIT, hardLimit?: number) {
    this.softLimit = positiveInteger(softLimit, DEFAULT_AGENT_SOFT_TURN_LIMIT)
    this.hardLimit = hardLimit === undefined
      ? undefined
      : Math.max(this.softLimit, positiveInteger(hardLimit, this.softLimit))
    this.currentLimit = this.softLimit
  }

  recordToolBatch(toolCalls: ToolCall[], toolResults: ToolResult[], countsAsProgress = true): void {
    const fingerprint = toolCalls
      .map(call => `${call.name}:${stableSerialize(call.arguments)}`)
      .sort()
      .join('|')
    const hasSuccessfulResult = toolResults.some(result => !result.isError)

    if (fingerprint && fingerprint === this.previousToolFingerprint) {
      this.repeatedToolBatches++
    } else {
      this.previousToolFingerprint = fingerprint
      this.repeatedToolBatches = fingerprint ? 1 : 0
    }

    if (countsAsProgress && hasSuccessfulResult) this.successfulToolTurns++
  }

  beforeModelTurn(totalAssistantTurns: number): AgentTurnBudgetDecision {
    if (totalAssistantTurns < this.currentLimit) return { kind: 'continue' }
    if (this.hardLimit !== undefined && totalAssistantTurns >= this.hardLimit) {
      return { kind: 'pause', reason: 'hard_limit', limit: this.hardLimit }
    }
    if (this.repeatedToolBatches >= 4) {
      return { kind: 'pause', reason: 'repeated_tools', limit: this.currentLimit }
    }

    const windowSize = Math.max(1, this.currentLimit - this.checkpointStart)
    const requiredSuccessfulTurns = Math.max(1, Math.ceil(windowSize * 0.15))
    if (this.successfulToolTurns < requiredSuccessfulTurns) {
      return { kind: 'pause', reason: 'stalled', limit: this.currentLimit }
    }

    const previousLimit = this.currentLimit
    this.currentLimit = this.hardLimit === undefined
      ? this.currentLimit + this.softLimit
      : Math.min(this.hardLimit, this.currentLimit + this.softLimit)
    const decision: AgentTurnBudgetDecision = {
      kind: 'extend',
      previousLimit,
      nextLimit: this.currentLimit,
      successfulToolTurns: this.successfulToolTurns,
    }
    this.checkpointStart = previousLimit
    this.successfulToolTurns = 0
    return decision
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
