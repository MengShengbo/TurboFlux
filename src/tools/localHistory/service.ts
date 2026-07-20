/**
 * LocalHistoryService — file-level revision tracking
 * WorkspaceCheckpointService — AI-driven multi-file checkpoint management
 *
 * Together they replace Git-based checkpointing with a VS Code-like
 * local history system that is decoupled from the user's Git repo.
 */

import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { writeFileAtomic } from '../../core/fileIO'
import {
  type FileRevision,
  type FileSnapshot,
  type WorkspaceCheckpoint,
  type CreateCheckpointResult,
  type ListCheckpointsResult,
  type RestoreCheckpointResult,
  type GetCheckpointDetailResult,
  type ConflictInfo,
  type RestoreMode,
  generateCheckpointId,
  toShortId,
} from '../../shared/checkpointTypes'

// ==================== Storage Layout ====================
// All local history data is stored under:
//   <localHistoryDir>/<workspaceHash>/
//     checkpoints/       — JSON manifests for each workspace checkpoint
//     revisions/         — File content blobs keyed by content hash
//     index.json         — Checkpoint index for fast listing

// SHA-256 keyed hashes. Previously this used a 32-bit djb2 fold which has a
// realistic collision rate over a few thousand revisions: when two distinct
// contents produce the same hash, `storeRevision` would silently skip the
// second write and any future restore from that hash would surface the wrong
// content. SHA-256 makes the collision risk negligible, at the cost of ~2x
// blob filename length.
function workspaceHash(workspacePath: string): string {
  return createHash('sha256').update(workspacePath).digest('hex').slice(0, 16)
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left)
  const normalizedRight = path.resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

// ==================== LocalHistoryService ====================

export class LocalHistoryService {
  private baseDir: string

  constructor(localHistoryDir: string) {
    this.baseDir = localHistoryDir
  }

  private workspaceDir(workspacePath: string): string {
    return path.join(this.baseDir, workspaceHash(workspacePath))
  }

  private revisionsDir(workspacePath: string): string {
    return path.join(this.workspaceDir(workspacePath), 'revisions')
  }

  private checkpointsDir(workspacePath: string): string {
    return path.join(this.workspaceDir(workspacePath), 'checkpoints')
  }

  private indexPath(workspacePath: string): string {
    return path.join(this.workspaceDir(workspacePath), 'index.json')
  }

  private resolveWorkspaceFilePath(workspacePath: string, filePath: string): string | null {
    const workspaceRoot = path.resolve(workspacePath)
    const candidatePath = path.resolve(path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath))
    const realWorkspaceRoot = fs.existsSync(workspaceRoot) ? fs.realpathSync.native(workspaceRoot) : workspaceRoot
    const realCandidatePath = this.resolveRealPath(candidatePath)
    const relativePath = path.relative(realWorkspaceRoot, realCandidatePath)
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      return null
    }
    return candidatePath
  }

  private resolveRealPath(filePath: string): string {
    if (fs.existsSync(filePath)) return fs.realpathSync.native(filePath)
    const missingParts: string[] = []
    let current = filePath
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current)
      if (parent === current) break
      missingParts.unshift(path.basename(current))
      current = parent
    }
    const existingParent = fs.existsSync(current) ? fs.realpathSync.native(current) : current
    return path.resolve(existingParent, ...missingParts)
  }

  // ---------- Initialization ----------

  async ensureInitialized(workspacePath: string): Promise<void> {
    workspacePath = path.resolve(workspacePath)
    const revDir = this.revisionsDir(workspacePath)
    const cpDir = this.checkpointsDir(workspacePath)

    await fs.promises.mkdir(revDir, { recursive: true })
    await fs.promises.mkdir(cpDir, { recursive: true })

    const idxPath = this.indexPath(workspacePath)
    if (!fs.existsSync(idxPath)) {
      await writeFileAtomic(idxPath, JSON.stringify({ checkpoints: [] }))
    }
  }

  // ---------- File Revision Storage ----------

  /**
   * Store a file revision (content blob). Returns the content hash key.
   * Content blobs are deduplicated by hash.
   */
  async storeRevision(workspacePath: string, content: string): Promise<string> {
    workspacePath = path.resolve(workspacePath)
    const hash = contentHash(content)
    const revDir = this.revisionsDir(workspacePath)
    const revPath = path.join(revDir, hash)

    if (!fs.existsSync(revPath)) {
      await writeFileAtomic(revPath, content)
    }

    return hash
  }

  /**
   * Read a stored revision by content hash.
   */
  async readRevision(workspacePath: string, hash: string): Promise<string | null> {
    workspacePath = path.resolve(workspacePath)
    const revPath = path.join(this.revisionsDir(workspacePath), hash)
    try {
      return await fs.promises.readFile(revPath, 'utf-8')
    } catch {
      return null
    }
  }

  // ---------- Workspace Checkpoint ----------

  /**
   * Read the current on-disk content of a file, or null if it doesn't exist.
   */
  private async readFileContent(filePath: string): Promise<string | null> {
    try {
      return await fs.promises.readFile(filePath, 'utf-8')
    } catch {
      return null
    }
  }

  /**
   * Create a workspace checkpoint from a list of AI-touched file paths.
   * Only the specified files are included — not the entire workspace.
   * For each file, we store both the current content and the previous content
   * (from the last checkpoint that touched this file, if any).
   */
  async createCheckpoint(
    workspacePath: string,
    label: string,
    filePaths: string[],
    source: 'auto' | 'explicit' | 'safety' = 'auto',
    preimages?: Record<string, string | null>,
  ): Promise<CreateCheckpointResult> {
    workspacePath = path.resolve(workspacePath)
    await this.ensureInitialized(workspacePath)

    const checkpointId = generateCheckpointId()
    const timestamp = Date.now()
    const files: FileSnapshot[] = []

    // Pre-load enough recent checkpoints to walk back through any file's
    // last known state. Previously we only consulted the most recent
    // checkpoint, which lost previousContent whenever the latest checkpoint
    // didn't happen to touch the file.
    const recentCheckpoints = await this.loadRecentCheckpoints(workspacePath, 50)

    for (const fp of filePaths) {
      const absPath = this.resolveWorkspaceFilePath(workspacePath, fp)
      if (!absPath) {
        return { success: false, error: `Refusing checkpoint path outside workspace: ${fp}` }
      }
      const currentContent = await this.readFileContent(absPath)

      // If the caller provided a preimage (captured before the write), use it
      // as previousContent. This gives correct rollback data even for newly
      // created files where no prior checkpoint exists.
      let previousContent: string | null = null
      let existedBefore = false
      let foundPriorSnapshot = false

      if (preimages && absPath in preimages) {
        previousContent = preimages[absPath]
        existedBefore = previousContent !== null
        foundPriorSnapshot = true
      } else {
        for (const prior of recentCheckpoints) {
          const prevSnap = prior.files.find(f => f.filePath === absPath)
          if (prevSnap) {
            previousContent = prevSnap.content
            existedBefore = prevSnap.existedBefore || prevSnap.content !== null
            foundPriorSnapshot = true
            break
          }
        }
      }
      if (!foundPriorSnapshot) {
        // No earlier checkpoint touched this file. Fall back to the on-disk
        // signal: if it exists now, assume it existed before.
        existedBefore = currentContent !== null
      }

      // Store content blob
      if (currentContent !== null) {
        await this.storeRevision(workspacePath, currentContent)
      }
      if (previousContent !== null) {
        await this.storeRevision(workspacePath, previousContent)
      }

      files.push({
        filePath: absPath,
        content: currentContent,
        existedBefore,
        previousContent,
      })
    }

    const checkpoint: WorkspaceCheckpoint = {
      id: checkpointId,
      label,
      timestamp,
      workspacePath,
      files,
      source,
      isSafetySnapshot: source === 'safety',
    }

    // Write checkpoint manifest
    const cpPath = path.join(this.checkpointsDir(workspacePath), `${checkpointId}.json`)
    await writeFileAtomic(cpPath, JSON.stringify(checkpoint))

    // Update index
    await this.addToIndex(workspacePath, checkpointId, label, timestamp, files.length, source)

    return {
      success: true,
      checkpointId,
      shortId: toShortId(checkpointId),
      label,
      fileCount: files.length,
    }
  }

  /**
   * Create a safety snapshot before a restore operation.
   * This captures the current state of files that would be overwritten.
   */
  async createSafetySnapshot(
    workspacePath: string,
    filePaths: string[],
  ): Promise<CreateCheckpointResult> {
    return this.createCheckpoint(
      workspacePath,
      `Safety snapshot before restore`,
      filePaths,
      'safety',
    )
  }

  // ---------- Index Management ----------

  private async addToIndex(
    workspacePath: string,
    checkpointId: string,
    label: string,
    timestamp: number,
    fileCount: number,
    source: 'auto' | 'explicit' | 'safety',
  ): Promise<void> {
    workspacePath = path.resolve(workspacePath)
    const idxPath = this.indexPath(workspacePath)
    let idx: { checkpoints: Array<{
      id: string; shortId: string; label: string; timestamp: number; fileCount: number; source: string
    }> }

    try {
      idx = JSON.parse(await fs.promises.readFile(idxPath, 'utf-8'))
    } catch {
      idx = { checkpoints: [] }
    }

    idx.checkpoints.unshift({
      id: checkpointId,
      shortId: toShortId(checkpointId),
      label,
      timestamp,
      fileCount,
      source,
    })

    // Keep index bounded (max 200 entries)
    if (idx.checkpoints.length > 200) {
      idx.checkpoints = idx.checkpoints.slice(0, 200)
    }

    await writeFileAtomic(idxPath, JSON.stringify(idx))
  }

  // ---------- Query ----------

  async listCheckpoints(
    workspacePath: string,
    limit: number = 20,
  ): Promise<ListCheckpointsResult> {
    workspacePath = path.resolve(workspacePath)
    await this.ensureInitialized(workspacePath)

    const idxPath = this.indexPath(workspacePath)
    try {
      const idx = JSON.parse(await fs.promises.readFile(idxPath, 'utf-8'))
      return {
        success: true,
        checkpoints: idx.checkpoints.slice(0, limit),
      }
    } catch {
      return { success: true, checkpoints: [] }
    }
  }

  async getCheckpointDetail(
    workspacePath: string,
    checkpointId: string,
  ): Promise<GetCheckpointDetailResult> {
    workspacePath = path.resolve(workspacePath)
    const cpPath = path.join(this.checkpointsDir(workspacePath), `${checkpointId}.json`)
    try {
      const raw = await fs.promises.readFile(cpPath, 'utf-8')
      const checkpoint: WorkspaceCheckpoint = JSON.parse(raw)
      if (checkpoint.workspacePath && !samePath(checkpoint.workspacePath, workspacePath)) {
        return { success: false, error: 'Checkpoint workspace mismatch' }
      }
      return { success: true, checkpoint }
    } catch {
      return { success: false, error: 'Checkpoint not found' }
    }
  }

  async getLatestCheckpoint(
    workspacePath: string,
  ): Promise<WorkspaceCheckpoint | null> {
    workspacePath = path.resolve(workspacePath)
    const idxPath = this.indexPath(workspacePath)
    try {
      const idx = JSON.parse(await fs.promises.readFile(idxPath, 'utf-8'))
      if (idx.checkpoints.length === 0) return null
      const latestId = idx.checkpoints[0].id
      const result = await this.getCheckpointDetail(workspacePath, latestId)
      return result.checkpoint || null
    } catch {
      return null
    }
  }

  /**
   * Load the N most recent checkpoint manifests, newest first.
   * Used by createCheckpoint to walk back for previousContent lookups so a
   * file's prior state is recovered even when the latest checkpoint did not
   * touch that file.
   */
  private async loadRecentCheckpoints(
    workspacePath: string,
    limit: number,
  ): Promise<WorkspaceCheckpoint[]> {
    workspacePath = path.resolve(workspacePath)
    const idxPath = this.indexPath(workspacePath)
    try {
      const idx = JSON.parse(await fs.promises.readFile(idxPath, 'utf-8')) as {
        checkpoints: Array<{ id: string }>
      }
      const ids = idx.checkpoints.slice(0, Math.max(1, limit)).map(c => c.id)
      const checkpoints: WorkspaceCheckpoint[] = []
      for (const id of ids) {
        const detail = await this.getCheckpointDetail(workspacePath, id)
        if (detail.checkpoint) checkpoints.push(detail.checkpoint)
      }
      return checkpoints
    } catch {
      return []
    }
  }

  // ---------- Restore ----------

  /**
   * Check for conflicts: files that have been manually modified since the checkpoint.
   * A file is "conflicted" if its current on-disk content differs from the
   * checkpoint's recorded content AND the checkpoint is not the latest one.
   */
  async checkConflicts(
    workspacePath: string,
    checkpointId: string,
  ): Promise<ConflictInfo[]> {
    workspacePath = path.resolve(workspacePath)
    const detail = await this.getCheckpointDetail(workspacePath, checkpointId)
    if (!detail.checkpoint) return []

    const conflicts: ConflictInfo[] = []

    for (const snap of detail.checkpoint.files) {
      const filePath = this.resolveWorkspaceFilePath(workspacePath, snap.filePath)
      if (!filePath) continue
      const currentContent = await this.readFileContent(filePath)
      // Content differs from what the checkpoint recorded
      if (currentContent !== snap.content) {
        conflicts.push({
          filePath,
          checkpointContent: snap.content,
          currentContent,
        })
      }
    }

    return conflicts
  }

  /**
   * Restore files to the state recorded in a checkpoint.
   * Only touches files that are part of the checkpoint manifest.
   * Creates a safety snapshot before overwriting.
   *
   * NOTE on `mode`: backend behavior is intentionally identical for all three
   * modes (`code_only` / `conversation_and_code` / `fork`). The mode parameter
   * is forward-compat metadata for telemetry and future per-mode policies
   * (e.g. forks may want to skip safety snapshot since the source conversation
   * is preserved). Today the renderer (ChatView.handleRollbackConfirm) is
   * responsible for the conversation-level differences:
   *   - `code_only`: restore files; keep all conversation history.
   *   - `conversation_and_code`: restore files; renderer truncates messages
   *     after the rollback point.
   *   - `fork`: restore files; renderer creates a new conversation branch
   *     from this point.
   */
  async restoreCheckpoint(
    workspacePath: string,
    checkpointId: string,
    _mode: RestoreMode = 'code_only',
  ): Promise<RestoreCheckpointResult> {
    workspacePath = path.resolve(workspacePath)
    const detail = await this.getCheckpointDetail(workspacePath, checkpointId)
    if (!detail.checkpoint) {
      return { success: false, error: 'Checkpoint not found' }
    }

    const checkpoint = detail.checkpoint
    const restoreTargets = checkpoint.files.map(snap => ({
      snap,
      filePath: this.resolveWorkspaceFilePath(workspacePath, snap.filePath),
    }))
    const invalidTarget = restoreTargets.find(target => !target.filePath)
    if (invalidTarget) {
      return { success: false, error: `Refusing restore path outside workspace: ${invalidTarget.snap.filePath}` }
    }
    const restoredFiles: string[] = []
    const conflictedFiles: string[] = []

    // Create safety snapshot of files that will be overwritten
    const filesToSnapshot = restoreTargets.map(target => target.filePath as string)

    let safetyCheckpointId: string | undefined
    if (filesToSnapshot.length > 0) {
      const safetyResult = await this.createSafetySnapshot(workspacePath, filesToSnapshot)
      if (safetyResult.checkpointId) {
        safetyCheckpointId = safetyResult.checkpointId
      }
    }

    // Restore each file
    for (const { snap, filePath } of restoreTargets) {
      const targetPath = filePath as string
      try {
        if (snap.content === null) {
          // File was deleted / didn't exist at checkpoint time
          // If it exists now, delete it
          if (fs.existsSync(targetPath)) {
            const previousContent = await this.readFileContent(targetPath)
            await this.recordFileRevision(workspacePath, targetPath, previousContent, 'restore', 'Restore preimage', checkpoint.id)
            await fs.promises.unlink(targetPath)
            await this.recordFileRevision(workspacePath, targetPath, null, 'restore', checkpoint.label, checkpoint.id)
          }
        } else {
          // Write checkpoint content
          const previousContent = await this.readFileContent(targetPath)
          await this.recordFileRevision(workspacePath, targetPath, previousContent, 'restore', 'Restore preimage', checkpoint.id)
          const dir = path.dirname(targetPath)
          await fs.promises.mkdir(dir, { recursive: true })
          await writeFileAtomic(targetPath, snap.content)
          await this.recordFileRevision(workspacePath, targetPath, snap.content, 'restore', checkpoint.label, checkpoint.id)
        }
        restoredFiles.push(targetPath)
      } catch (err) {
        conflictedFiles.push(targetPath)
      }
    }

    return {
      success: conflictedFiles.length === 0,
      restoredFiles,
      conflictedFiles: conflictedFiles.length > 0 ? conflictedFiles : undefined,
      safetyCheckpointId,
    }
  }

  // ---------- File-level History (for future VS Code-like Local History UI) ----------

  /**
   * Record a file-level revision (called from fs:write-file / fs:delete-file hooks).
   * This builds up a per-file history independent of workspace checkpoints.
   */
  async recordFileRevision(
    workspacePath: string,
    filePath: string,
    content: string | null,
    source: 'ai' | 'manual' | 'restore',
    label?: string,
    checkpointId?: string,
  ): Promise<void> {
    workspacePath = path.resolve(workspacePath)
    await this.ensureInitialized(workspacePath)
    const resolvedFilePath = this.resolveWorkspaceFilePath(workspacePath, filePath)
    if (!resolvedFilePath) {
      throw new Error(`Refusing revision path outside workspace: ${filePath}`)
    }

    const rev: FileRevision = {
      id: `rev_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`,
      filePath: resolvedFilePath,
      content,
      timestamp: Date.now(),
      source,
      label,
      checkpointId,
    }

    // Store content blob
    if (content) {
      await this.storeRevision(workspacePath, content)
    }

    // Append to per-file history
    const fileHistDir = path.join(this.workspaceDir(workspacePath), 'file-history')
    await fs.promises.mkdir(fileHistDir, { recursive: true })

    // Use a safe filename derived from the file path
    const safeName = resolvedFilePath.replace(/[\\/:"*?<>|]/g, '_')
    const histPath = path.join(fileHistDir, `${safeName}.jsonl`)

    // Append line
    const line = JSON.stringify(rev) + '\n'
    await fs.promises.appendFile(histPath, line, 'utf-8')

    // Trim to last 100 entries per file
    try {
      const lines = (await fs.promises.readFile(histPath, 'utf-8')).trim().split('\n')
      if (lines.length > 100) {
        const trimmed = lines.slice(lines.length - 100).join('\n') + '\n'
        await writeFileAtomic(histPath, trimmed)
      }
    } catch {
      // Ignore trim errors
    }
  }

  // ---------- Cleanup ----------

  /**
   * Remove old checkpoints and revisions to keep storage bounded.
   * Keeps the most recent N checkpoints and their associated revisions.
   */
  async pruneOldCheckpoints(workspacePath: string, keepCount: number = 50): Promise<void> {
    workspacePath = path.resolve(workspacePath)
    const idxPath = this.indexPath(workspacePath)
    try {
      const idx = JSON.parse(await fs.promises.readFile(idxPath, 'utf-8'))
      if (idx.checkpoints.length <= keepCount) return

      const toRemove = idx.checkpoints.slice(keepCount)
      idx.checkpoints = idx.checkpoints.slice(0, keepCount)

      // Delete checkpoint manifests
      for (const entry of toRemove) {
        const cpPath = path.join(this.checkpointsDir(workspacePath), `${entry.id}.json`)
        try {
          await fs.promises.unlink(cpPath)
        } catch {
          // Ignore
        }
      }

      await writeFileAtomic(idxPath, JSON.stringify(idx))
    } catch {
      // Ignore
    }
  }
}
