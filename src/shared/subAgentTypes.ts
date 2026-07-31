// Generic types shared by project-defined subagents.

/**
 * Subagent driver tag.
 *
 * The hosted proxy (`turboflux.aibinghe.xyz/api/v1`) maps this tag to a
 * concrete DeepSeek V4 model id at request time:
 *
 *   - 'deepseek-flash'    → 'deepseek-v4-flash' (284B / 13B active, fast)
 *   - 'deepseek-reasoner' → 'deepseek-v4-pro'   (1.6T / 49B active, deep think)
 *
 * Both share the OpenAI Chat Completions schema so the runner stays
 * driver-agnostic. When DeepSeek ships a new tier (e.g. v5-flash) we
 * extend the union and the proxy's mapping table — nothing else.
 */
export type SubAgentDriver = 'main-model' | 'deepseek-flash' | 'deepseek-reasoner'

/**
 * Thinking effort. Maps onto DeepSeek V4's three-tier reasoning control:
 *   - 'disabled' → fast path, no chain-of-thought, no `reasoning_content`.
 *                  Use for retrieval-style work where extra reasoning is wasted budget.
 *   - 'high'     → default thinking effort. Use for cross-file exploration / synthesis.
 *   - 'max'      → maximum reasoning effort. Use for code review / bug hunting.
 *
 * Caveat: when thinking is enabled, DeepSeek silently ignores `temperature`,
 * `top_p`, `presence_penalty`, `frequency_penalty`. The runner sends them anyway
 * for consistency with the disabled-thinking path.
 *
 * Caveat 2: when a thinking-enabled assistant turn produces tool_calls, the
 * `reasoning_content` MUST be echoed back in subsequent requests or the API
 * returns 400. The runner handles this transparently.
 */
export type SubAgentThinking = 'disabled' | 'high' | 'max'
export interface SubAgentDefinition {
  /** Stable id used by spawn_agent and event metadata. */
  id: string
  /** Human-readable label for UI / logs. */
  label: string
  /** One-line description shown to the parent agent in spawn_agent tool. */
  description: string
  /** Which model drives the loop. */
  driver: SubAgentDriver
  /** System instruction shaping the subagent's behavior. */
  systemPrompt: string
  /** Hard cap on agent loop turns. */
  maxTurns: number
  /** Hard cap on parallel tool calls per turn. */
  maxParallel: number
  /** Optional output token cap (per turn). */
  maxOutputTokens?: number
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
  | { type: 'tool_call'; tool: string; args: unknown; turn: number }
  | { type: 'tool_result'; tool: string; ok: boolean; summary: string; turn: number; elapsedMs?: number; operations?: number; readOperations?: number }
  | { type: 'evidence'; evidence: SubAgentEvidence }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string }

export interface SubAgentInvocation {
  definition: SubAgentDefinition
  objective: string
  workspacePath: string
  /**
   * Optional workspace skeleton (codemap formatted as markdown-ish bullets).
   *
   * Why: DeepSeek V4's prompt cache persists at request boundaries. By
   * inserting a stable workspace primer as a synthetic [user → assistant: 'READY']
   * pair right after the system prompt, every subsequent subagent call
   * within the same workspace can reuse the stable cache prefix
   * price for the primer. The model also gets a free "map" so its first
   * grep is informed instead of guessed.
   *
   * Pass undefined to skip the primer (e.g., when no codemap is available
   * yet because the index is still building).
   */
  codemap?: string
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
