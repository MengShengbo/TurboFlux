export type GitDiffScope = 'working' | 'staged' | 'all'

export interface GitFileState {
  path: string
  originalPath?: string
  indexStatus: string
  worktreeStatus: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
}

export interface GitCommitSummary {
  hash: string
  shortHash: string
  author: string
  authoredAt: string
  subject: string
}

export interface GitSnapshot {
  branch: string
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  detached: boolean
  clean: boolean
  files: GitFileState[]
  stagedCount: number
  unstagedCount: number
  untrackedCount: number
  conflictedCount: number
  recentCommits: GitCommitSummary[]
  branches: string[]
}

export type GitIntegrationPhase = 'detecting' | 'ready' | 'syncing' | 'error' | 'unavailable' | 'disabled'

export interface GitOperationState {
  name: string
  status: 'running' | 'success' | 'error'
  message?: string
  hash?: string
  updatedAt: number
}

export interface GitIntegrationState {
  enabled: boolean
  phase: GitIntegrationPhase
  snapshot: GitSnapshot | null
  error?: string
  operation?: GitOperationState
  updatedAt: number
}

export interface GitOperationResult {
  ok: boolean
  output?: string
  hash?: string
  nothingToCommit?: boolean
  error?: string
}
