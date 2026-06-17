/**
 * Local History & Workspace Checkpoint types
 * Replaces Git-based checkpointing with a VS Code-like local history system.
 */

// ==================== File Revision ====================

export interface FileRevision {
  /** Unique revision ID */
  id: string
  /** Absolute file path */
  filePath: string
  /** File content at this revision (null = file did not exist / was deleted) */
  content: string | null
  /** Timestamp */
  timestamp: number
  /** Source of this revision */
  source: 'ai' | 'manual' | 'restore'
  /** Optional label (e.g. "Auto-checkpoint after file operations") */
  label?: string
  /** Associated checkpoint ID (if part of a workspace checkpoint) */
  checkpointId?: string
}

// ==================== Workspace Checkpoint ====================

export interface FileSnapshot {
  /** Absolute file path */
  filePath: string
  /** Content at checkpoint time (null = file didn't exist / was deleted) */
  content: string | null
  /** Whether the file existed before this checkpoint */
  existedBefore: boolean
  /** Content before this checkpoint (null = file didn't exist before) */
  previousContent: string | null
}

export interface WorkspaceCheckpoint {
  /** Unique checkpoint ID (replaces Git hash) */
  id: string
  /** Human-readable label */
  label: string
  /** Timestamp */
  timestamp: number
  /** Workspace root path */
  workspacePath: string
  /** Files managed by this checkpoint (only AI-touched files, not entire workspace) */
  files: FileSnapshot[]
  /** Source */
  source: 'auto' | 'explicit' | 'safety'
  /** Whether this checkpoint is a pre-restore safety snapshot */
  isSafetySnapshot?: boolean
}

// ==================== Restore ====================

export type RestoreMode = 'code_only' | 'conversation_and_code' | 'fork'

export interface RestoreResult {
  success: boolean
  /** Files that were restored */
  restoredFiles?: string[]
  /** Files that had conflicts (manually modified since checkpoint) */
  conflictedFiles?: string[]
  /** Safety checkpoint ID created before restore (if any) */
  safetyCheckpointId?: string
  error?: string
}

export interface ConflictInfo {
  filePath: string
  /** Checkpoint version content */
  checkpointContent: string | null
  /** Current on-disk content */
  currentContent: string | null
}

// ==================== IPC Result Types ====================

export interface CreateCheckpointResult {
  success: boolean
  checkpointId?: string
  /** Short display ID (first 8 chars) */
  shortId?: string
  label?: string
  /** Number of files in this checkpoint */
  fileCount?: number
  error?: string
}

export interface ListCheckpointsResult {
  success: boolean
  checkpoints?: Array<{
    id: string
    shortId: string
    label: string
    timestamp: number
    fileCount: number
    source: 'auto' | 'explicit' | 'safety'
  }>
  error?: string
}

export interface RestoreCheckpointResult {
  success: boolean
  restoredFiles?: string[]
  conflictedFiles?: string[]
  safetyCheckpointId?: string
  error?: string
}

export interface GetCheckpointDetailResult {
  success: boolean
  checkpoint?: WorkspaceCheckpoint
  error?: string
}

// ==================== Helpers ====================

export function generateCheckpointId(): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).substring(2, 8)
  return `cp_${ts}_${rand}`
}

export function toShortId(id: string): string {
  return id.substring(0, 11)
}
