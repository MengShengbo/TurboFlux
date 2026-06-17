import type { AgentTool, AgentMode } from './agentTypes'

export interface EnhancedToolDef extends AgentTool {
  maxResultSizeChars?: number
  isConcurrencySafeFor?: (input: Record<string, unknown>) => boolean
}

export interface ToolContext {
  workspacePath: string
  mode: AgentMode
  abortSignal?: AbortSignal
}

export type PermissionVerdict = 'allow' | 'deny' | 'ask'

export interface PermissionRule {
  toolPattern: string
  argMatcher?: (args: Record<string, unknown>) => boolean
  verdict: PermissionVerdict
  reason?: string
  source: 'builtin' | 'project' | 'user' | 'session'
}

export interface PermissionCheckResult {
  verdict: PermissionVerdict
  rule?: PermissionRule
  reason?: string
}
