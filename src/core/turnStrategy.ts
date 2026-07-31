import type { AgentMode, AgentSession, AgentTurn, ToolResult } from '../shared/agentTypes'

export type TurnIntent = 'model_decides'
export type TurnScope = 'model_decides'

export interface TurnStrategy {
  intent: TurnIntent
  scope: TurnScope
  needsWorkspaceContext: boolean
  requiresEvidence: boolean
  allowWrites: boolean
  confidence: number
  reasons: string[]
  retrievalPlan: string[]
  verificationPlan: string[]
}

function latestUserMessage(turns: AgentTurn[]): string {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (turn.role === 'user' && turn.content.trim()) return turn.content.trim()
  }
  return ''
}

function recentToolErrors(turns: AgentTurn[]): ToolResult[] {
  const errors: ToolResult[] = []
  for (const turn of turns.slice(-8)) {
    if (!turn.toolResults) continue
    for (const result of turn.toolResults) {
      if (result.isError) errors.push(result)
    }
  }
  return errors
}

function recentToolCalls(turns: AgentTurn[]): string[] {
  return turns.slice(-8).flatMap(turn => turn.toolCalls?.map(tool => tool.name) || [])
}

function hasRecentEvidence(turns: AgentTurn[]): boolean {
  return recentToolCalls(turns).some(name =>
    name === 'read_file'
    || name === 'list_directory'
    || name === 'get_codemap'
    || name.startsWith('search_')
  )
}

function hasOpenWork(session: AgentSession): boolean {
  return session.currentTaskId !== null
}

/**
 * TurnStrategyPlanner intentionally does not classify natural language.
 *
 * It only derives execution guidance from structured runtime facts: explicit
 * mode, task state, recent tool evidence, and recent tool errors. The model
 * decides whether the user's text requires retrieval, edits, explanation, or
 * planning by using the full tool surface allowed by mode and permissions.
 */
export class TurnStrategyPlanner {
  plan(session: AgentSession, mode: AgentMode): TurnStrategy | null {
    const message = latestUserMessage(session.turns)
    if (!message) return null

    const errors = recentToolErrors(session.turns)
    const hasEvidence = hasRecentEvidence(session.turns)
    const hasTasks = hasOpenWork(session)
    const canWriteByMode = mode === 'vibe'
    const needsWorkspaceContext = true
    const requiresEvidence = false

    const reasons = [
      `mode=${mode}`,
      hasTasks ? 'active task exists' : 'no active task',
      errors.length > 0 ? `recent tool errors=${errors.length}` : 'no recent tool errors',
      hasEvidence ? 'recent code evidence exists' : 'no recent code evidence',
      'workspace rules available without automatic repository mapping',
    ]

    return {
      intent: 'model_decides',
      scope: 'model_decides',
      needsWorkspaceContext,
      requiresEvidence,
      allowWrites: canWriteByMode,
      confidence: 1,
      reasons,
      retrievalPlan: this.buildRetrievalPlan(mode, hasEvidence),
      verificationPlan: this.buildVerificationPlan(mode, errors.length > 0),
    }
  }

  buildStrategyContext(strategy: TurnStrategy | null): string | null {
    if (!strategy) return null
    const lines = [
      '<turn_strategy intent="model_decides" scope="model_decides">',
      'This is execution guidance only. It must not classify the user request or hide tools.',
      `workspace_context: ${strategy.needsWorkspaceContext ? 'available' : 'lightweight by default'}`,
      `evidence: ${strategy.requiresEvidence ? 'gather before codebase claims' : 'use tools only when repository state is needed'}`,
      `writes_by_mode: ${strategy.allowWrites ? 'available subject to permissions' : 'not available in plan mode until approved'}`,
      'Runtime signals:',
      ...strategy.reasons.map(reason => `- ${reason}`),
      'Tool policy:',
      ...strategy.retrievalPlan.map(item => `- ${item}`),
      'Verification policy:',
      ...strategy.verificationPlan.map(item => `- ${item}`),
      '</turn_strategy>',
    ]
    return lines.join('\n')
  }

  private buildRetrievalPlan(mode: AgentMode, hasEvidence: boolean): string[] {
    const plan = [
      'Maximize information gain per model round: batch all independent searches and reads needed for the next decision.',
      'Use user-provided and tool-returned paths directly. Search only unresolved locations, and do not repeat successful reads without a concrete reason.',
    ]
    if (!hasEvidence) {
      plan.push('Gather enough direct evidence for the next decision in one batch when dependencies are already known.')
    }
    return plan
  }

  private buildVerificationPlan(mode: AgentMode, hasRecentErrors: boolean): string[] {
    const plan = ['After edits, run the narrowest relevant check when mode permits execution.']
    if (mode === 'plan') {
      plan.push('Ask for approval before write operations.')
    }
    if (hasRecentErrors) {
      plan.push('If a tool failed, recover from the failure with a different read/search path before concluding.')
    }
    return plan
  }
}
