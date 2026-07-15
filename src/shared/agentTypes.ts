export type AgentMode = 'vibe' | 'plan'

export type ApprovalPolicy = 'request' | 'auto' | 'full'

export type SandboxPolicy = 'workspace' | 'readonly' | 'full'

export type ThinkingMode = 'auto' | 'off' | 'standard' | 'max'

export type ResolvedThinkingMode = Exclude<ThinkingMode, 'auto'>

export type ContextPolicyMode = 'normal' | 'qualityFirst'

export type TaskPriority = 'major' | 'medium' | 'minor'

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export type ToolCategory = 'read' | 'write' | 'execute' | 'communicate' | 'manage'

export interface AgentTool {
  name: string
  description: string
  category: ToolCategory
  parameters: ToolParameter[]
  isReadOnly: boolean
  isDestructive: boolean
  isConcurrencySafe: boolean
  requiredMode?: AgentMode[]
  inputSchema?: Record<string, unknown>
}

export interface ToolParameter {
  name: string
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  description: string
  required: boolean
  enum?: string[]
  default?: unknown
}

export interface TaskNode {
  id: string
  title: string
  description: string
  priority: TaskPriority
  status: TaskStatus
  parentId: string | null
  children: string[]
  dependencies: string[]
  order: number
  toolUseId?: string
  progress: number
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
  error?: string
  metadata?: {
    estimatedDuration?: string
    relatedFiles?: string[]
    testResults?: string
    errorLog?: string
    relatedIssue?: string
    [key: string]: unknown
  }
}

export interface AgentTurn {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool_result'
  content: string
  timestamp: number
  toolCalls?: ToolCall[]
  toolResults?: ToolResult[]
  metadata?: {
    model?: string
    tokens?: TokenUsage
    duration?: number
    mode?: AgentMode
    thinkingMode?: ThinkingMode
    resolvedThinkingMode?: ResolvedThinkingMode
    thinking?: ThinkingTrace
    rawReasoningPayload?: RawReasoningPayload
    checkpointId?: string
    checkpointLabel?: string
    attachments?: AgentAttachment[]
  }
}

export interface AgentAttachment {
  id: string
  type: 'image'
  path: string
  mime: string
  filename: string
  size: number
}

export interface TokenUsage {
  input?: number
  output?: number
  total?: number
  source?: 'provider' | 'unknown'
}

/**
 * Provider-native raw reasoning blocks captured during streaming.
 * Used to replay reasoning across multi-turn tool-use flows where the
 * provider (e.g. Anthropic Claude 4) requires the original thinking blocks
 * to maintain reasoning continuity. Stored as opaque blobs because the
 * exact schema (e.g. signature hashes) is provider-specific.
 */
export interface OpenAIReasoningBlock {
  type: 'reasoning'
  reasoning: string
}

export interface RawReasoningPayload {
  provider: 'anthropic' | 'openai-compatible'
  blocks: AnthropicThinkingBlock[]
  /** For OpenAI-compatible providers that return reasoning_content as a plain string */
  reasoningContent?: string
}

export interface AnthropicThinkingBlock {
  type: 'thinking' | 'redacted_thinking'
  thinking?: string
  signature?: string
  data?: string
}

export type ThinkingStage = 'problem_framing' | 'evidence_gathering' | 'hypothesis_testing' | 'verification' | 'conclusion'

export type ThinkingEvidenceLevel = 'none' | 'broad' | 'strong' | 'multi_source'

export type ThinkingVerificationStatus = 'unverified' | 'partial' | 'verified' | 'contested'

export interface ThinkingTrace {
  content: string
  isStreaming?: boolean
  source?: 'provider' | 'fallback'
  stage?: ThinkingStage
  evidenceLevel?: ThinkingEvidenceLevel
  verificationStatus?: ThinkingVerificationStatus
  hadAlternatives?: boolean
  hasToolBackedVerification?: boolean
  /**
   * Wall-clock milliseconds the model spent emitting reasoning content for
   * this turn. Populated when the stream finalizes; surfaced in the collapsed
   * digest as e.g. "Thought for 4.2s" so users can audit reasoning cost
   * without expanding the trace.
   */
  durationMs?: number
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ChangeSummary {
  path: string
  operation: 'write' | 'edit' | 'delete'
  addedLines?: number
  removedLines?: number
  totalLines?: number
  preview?: string
  oldPreview?: string
  /**
   * Full preimage and postimage snapshots for inline diff rendering.
   *
   * Populated by AgentEngine on successful write_file / edit_file /
   * multi_edit / delete_file when both sides are within MAX_DIFF_INPUT_BYTES
   * (256 KB) — bigger files fall back to the lightweight oldPreview/preview
   * heuristics so we never bloat chat metadata. Both are optional; the diff
   * UI gracefully degrades when either is missing.
   *
   * Aligned with the project DNA (lazy + size-capped + algorithmic): callers
   * compute hunks via diffCompute on demand (folded card = zero work).
   */
  before?: string
  after?: string
}

export interface ToolResult {
  toolCallId: string
  name: string
  output: string
  isError: boolean
  errorKind?: 'validation' | 'permission' | 'execution' | 'timeout' | 'abort'
  changeSummary?: ChangeSummary
}

export interface AgentSession {
  id: string
  mode: AgentMode
  turns: AgentTurn[]
  currentTaskId: string | null
  createdAt: number
  updatedAt: number
  workspacePath?: string
  workspaceName?: string
  totalTokens: { input: number; output: number }
  gitEnabled?: boolean
}

export interface AgentConfig {
  mode: AgentMode
  approvalPolicy?: ApprovalPolicy
  sandboxPolicy?: SandboxPolicy
  thinkingMode?: ThinkingMode
  temperature: number
  maxTokens: number
  maxTurns: number
  contextWindow?: number
  contextPolicy?: ContextPolicyMode
  conversationId?: string
  workspacePath?: string
  workspaceName?: string
  systemPromptOverride?: string
  appendSystemPrompt?: string
  profileSystemPrompt?: string
  disabledTools?: string[]
  enabledSkills?: Array<{ id: string; name: string; command: string; description: string; capabilities?: { can?: string[]; cannot?: string[] }; principles?: string[]; systemPrompt?: string }>
  /** Detected shell id from the main process (e.g. 'pwsh', 'powershell', 'cmd', 'bash', 'zsh'). */
  shell?: string
  /** When true the engine uses git for checkpoints and injects git status into the system prompt. */
  gitEnabled?: boolean
}

export const TASK_ID_PREFIXES: Record<TaskPriority, string> = {
  major: 'M',
  medium: 'D',
  minor: 'T',
}

export const MODE_LABELS: Record<AgentMode, string> = {
  vibe: 'Vibe',
  plan: 'Plan',
}

export const MODE_DESCRIPTIONS: Record<AgentMode, string> = {
  vibe: '快速执行模式 - AI 自主完成从规划到实现的全过程',
  plan: '规划模式 - 先制定详细计划，用户审批后执行',
}

export const THINKING_MODE_LABELS: Record<ThinkingMode, string> = {
  auto: 'Auto',
  off: 'None',
  standard: 'Thinking',
  max: 'Thinking Max',
}

export const THINKING_MODE_DESCRIPTIONS: Record<ThinkingMode, string> = {
  auto: '根据问题复杂度自动决定是否进入思考流程。',
  off: '普通对话输出，不主动进入额外思考流程。',
  standard: '为复杂任务启用问题建模、证据优先检索、有限反思与结论前验证。',
  max: '为高难任务启用竞争假设、外部证据校验、批判复核与更严格停止条件。',
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed'
}

export function generateTaskId(priority: TaskPriority): string {
  const prefix = TASK_ID_PREFIXES[priority]
  // Prefer crypto.randomUUID for collision resistance (≈ 5.3e36 combinations
  // vs. 2.8e12 for the previous 8-char base36 random). Fall back to
  // timestamp + random for environments where crypto is unavailable.
  let suffix: string
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    } else {
      suffix = `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 10)}`
    }
  } catch {
    suffix = `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 10)}`
  }
  return `${prefix}-${suffix}`
}

export function generateTurnId(): string {
  return `turn-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
}

export function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
}
