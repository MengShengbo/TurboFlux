/**
 * Workspace memory shared types.
 */

/**
 * Where a memory lives.
 *
 * - `global`: single-machine, cross-workspace user preferences.
 * - `workspace_shared`: committed to the project repo, team-visible.
 * - `workspace_private`: single-machine, not committed.
 * - `conversation`: per-conversation summary.
 */
export type MemoryScope = 'global' | 'workspace_shared' | 'workspace_private' | 'conversation'

/**
 * The type of a memory entry.
 */
export type MemoryKind =
  | 'rule'
  | 'fact'
  | 'preference'
  | 'episode'
  | 'todo'
  | 'verdict'
  | 'strategy'
  | 'pitfall'
  | 'workflow'

export type MemoryConfidence = 'asserted' | 'observed' | 'inferred'

export interface MemoryEvidence {
  kind: 'file' | 'tool_result' | 'user_quote' | 'web' | 'conversation'
  path?: string
  lines?: [number, number]
  quote?: string
  conversationId?: string
  messageId?: string
}

export interface Memory {
  id: string
  scope: MemoryScope
  kind: MemoryKind
  text: string
  source: string
  evidence: MemoryEvidence[]
  confidence: MemoryConfidence
  createdAt: number
  updatedAt: number
  pinned: boolean
  tags: string[]
  reviewState: 'auto' | 'user_approved' | 'user_edited'
  status: 'active' | 'superseded' | 'rejected' | 'stale'
  supersededBy?: string
}

export interface MemoryGroup {
  id: string
  label: string
  source: string
  loader: string
  items: Memory[]
}

export interface MemorySnapshot {
  workspacePath: string
  injectionText: string
  injectionTokens: number
  groups: MemoryGroup[]
  totalCount: number
  warnings: string[]
  loadersAttempted: string[]
  builtAt: number
}

export interface MemoryListRequest {
  workspacePath: string
  forceReload?: boolean
}

export interface MemoryListResponse {
  success: boolean
  snapshot?: MemorySnapshot
  error?: string
}

export interface MemoryQueryParams {
  workspacePath: string
  scope?: MemoryScope
  kind?: MemoryKind
  query?: string
  limit?: number
  includeStale?: boolean
}

export interface MemoryWriteRequest {
  workspacePath: string
  text: string
  kind?: MemoryKind
  scope?: MemoryScope
  tags?: string[]
  evidence?: MemoryEvidence[]
  confidence?: MemoryConfidence
  conversationId?: string
  messageId?: string
}

export interface MemoryWriteResponse {
  success: boolean
  id?: string
  error?: string
  deduplicated?: boolean
}

export interface MemoryForgetRequest {
  workspacePath: string
  id: string
  reason?: string
}

export interface MemoryForgetResponse {
  success: boolean
  error?: string
}

export interface MemoryUpdateRequest {
  workspacePath: string
  id: string
  text?: string
  kind?: MemoryKind
  tags?: string[]
  pinned?: boolean
  status?: Memory['status']
}

export interface MemoryUpdateResponse {
  success: boolean
  error?: string
}
