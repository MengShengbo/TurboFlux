// Generic types shared by project-defined subagents.

/**
 * Provider-neutral reasoning preference applied to the main model inherited
 * by the subagent. Unsupported levels are normalized by the model runtime.
 */
export type SubAgentThinking = 'disabled' | 'high' | 'max'
export interface SubAgentDefinition {
  /** Stable id used by spawn_agent and event metadata. */
  id: string
  /** Human-readable label for UI / logs. */
  label: string
  /** One-line description shown to the parent agent in spawn_agent tool. */
  description: string
  /** System instruction shaping the subagent's behavior. */
  systemPrompt: string
  /** Optional allowlist of tools exposed to this subagent. */
  allowedTools?: string[]
  /** Hard cap on agent loop turns. */
  maxTurns: number
  /** Hard cap on parallel tool calls per turn. */
  maxParallel: number
  /** Optional output token cap (per turn). */
  maxOutputTokens?: number
  /** Optional wall-clock budget for each model request. */
  requestTimeoutMs?: number
  /** Distinct successful tool calls required before the agent may finish. */
  requiredToolCalls?: Record<string, number>
  /** Optional sampling temperature (ignored by upstream when thinking is enabled). */
  temperature?: number
  /**
   * Reasoning effort. Defaults to 'disabled' if omitted — matches the
   * the low-cost retrieval default. Project-defined agents may override it.
   */
  thinking?: SubAgentThinking
}

export interface SubAgentEvidence {
  path: string
  startLine: number
  endLine: number
  preview: string
  content?: string
  reason: string
  kind?: 'entry' | 'implementation' | 'caller' | 'config' | 'schema' | 'test' | 'root_cause' | 'supporting'
  score?: number
  confidence?: 'high' | 'medium' | 'low'
  symbol?: string
}

export type SubAgentEvent =
  | { type: 'turn_start'; turn: number; maxTurns: number }
  | { type: 'model_wait'; turn: number; elapsedMs: number; timeoutMs: number }
  | { type: 'model_retry'; turn: number; attempt: number; delayMs: number; reason: string }
  | {
      type: 'model_response'
      turn: number
      protocol: string
      offeredTools: string[]
      returnedTools: string[]
    }
  | {
      type: 'turn_complete'
      turn: number
      calls: number
      modelElapsedMs?: number
      toolElapsedMs?: number
      totalElapsedMs?: number
      inputTokens?: number
      outputTokens?: number
      cacheReadTokens?: number
      reasoningTokens?: number
    }
  | { type: 'tool_call'; toolCallId: string; tool: string; args: unknown; turn: number }
  | { type: 'tool_result'; toolCallId: string; tool: string; ok: boolean; summary: string; turn: number; elapsedMs?: number; operations?: number; readOperations?: number }
  | { type: 'evidence'; evidence: SubAgentEvidence }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string }

export interface SubAgentInvocation {
  definition: SubAgentDefinition
  objective: string
  workspacePath: string
  abortSignal?: AbortSignal
  onEvent?: (event: SubAgentEvent) => void
}

export interface SubAgentResult {
  ok: boolean
  finalText: string
  evidence: SubAgentEvidence[]
  turns: number
  elapsedMs: number
  truncated: boolean
  error?: string
}
