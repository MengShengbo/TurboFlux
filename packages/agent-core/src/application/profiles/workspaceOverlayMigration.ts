import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'

export type WorkspaceOverlayMigrationStepId =
  | 'memory'
  | 'sessions'
  | 'runtime-agents'
  | 'runtime-logs'
  | 'recovery'
  | 'attachments'
  | 'browser-captures'
  | 'computer-captures'

export interface WorkspaceOverlayMigrationStep {
  id: WorkspaceOverlayMigrationStepId
  status: 'pending' | 'committed' | 'skipped' | 'failed'
  sourcePath: string
  targetPath: string
  files: number
  bytes: number
  digest?: string
  error?: string
}

export interface WorkspaceOverlayMigrationJournal {
  schemaVersion: 1
  transactionId: string
  workspaceId: string
  status: 'running' | 'completed' | 'failed'
  startedAt: number
  updatedAt: number
  completedAt?: number
  steps: WorkspaceOverlayMigrationStep[]
}

interface TreeEntry {
  relativePath: string
  size: number
  digest: string
}

function hashFile(path: string): string {
  const descriptor = openSync(path, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytesRead = 0
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    closeSync(descriptor)
  }
  return hash.digest('hex')
}

function scanTree(root: string): TreeEntry[] {
  const entries: TreeEntry[] = []
  const visit = (path: string): void => {
    const info = lstatSync(path)
    if (info.isSymbolicLink()) throw new Error('Workspace overlay migration does not follow symbolic links')
    if (info.isFile()) {
      entries.push({ relativePath: relative(root, path).replaceAll('\\', '/'), size: info.size, digest: hashFile(path) })
      return
    }
    if (!info.isDirectory()) throw new Error('Workspace overlay migration only supports regular files and directories')
    for (const name of readdirSync(path)) visit(join(path, name))
  }
  visit(root)
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

function treeDigest(entries: TreeEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

function copyToStaging(sourceRoot: string, stagingRoot: string, entries: TreeEntry[]): void {
  rmSync(stagingRoot, { recursive: true, force: true })
  mkdirSync(stagingRoot, { recursive: true, mode: 0o700 })
  for (const entry of entries) {
    const source = join(sourceRoot, entry.relativePath)
    const target = join(stagingRoot, entry.relativePath)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    copyFileSync(source, target, constants.COPYFILE_EXCL)
  }
}

function commitStaging(stagingRoot: string, targetRoot: string, entries: TreeEntry[]): void {
  mkdirSync(targetRoot, { recursive: true, mode: 0o700 })
  for (const entry of entries) {
    const source = join(stagingRoot, entry.relativePath)
    const target = join(targetRoot, entry.relativePath)
    if (existsSync(target)) {
      const targetInfo = lstatSync(target)
      if (!targetInfo.isFile() || targetInfo.isSymbolicLink() || hashFile(target) !== entry.digest) {
        throw new Error(`Workspace overlay target conflicts with legacy data: ${entry.relativePath}`)
      }
      continue
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    copyFileSync(source, target, constants.COPYFILE_EXCL)
  }
}

function validJournal(value: unknown, workspaceId: string): value is WorkspaceOverlayMigrationJournal {
  if (!value || typeof value !== 'object') return false
  const journal = value as Partial<WorkspaceOverlayMigrationJournal>
  return journal.schemaVersion === 1
    && journal.workspaceId === workspaceId
    && typeof journal.transactionId === 'string'
    && Array.isArray(journal.steps)
    && ['running', 'completed', 'failed'].includes(String(journal.status))
}

export class WorkspaceOverlayMigration {
  readonly journalPath: string
  private readonly stagingRoot: string

  constructor(
    private readonly workspaceId: string,
    private readonly workspacePath: string,
    private readonly overlayRoot: string,
    private readonly now: () => number = Date.now,
  ) {
    this.journalPath = join(overlayRoot, 'legacy-migration.json')
    this.stagingRoot = join(overlayRoot, '.migration-staging')
  }

  migrate(): WorkspaceOverlayMigrationJournal {
    const journal = this.readJournal() ?? this.createJournal()
    if (journal.status === 'completed') return structuredClone(journal)
    journal.status = 'running'
    for (const step of journal.steps) {
      if (step.status === 'committed' || step.status === 'skipped') continue
      try {
        if (!existsSync(step.sourcePath)) {
          step.status = 'skipped'
        } else {
          const entries = scanTree(step.sourcePath)
          const stagingPath = join(this.stagingRoot, step.id)
          copyToStaging(step.sourcePath, stagingPath, entries)
          const stagedEntries = scanTree(stagingPath)
          if (treeDigest(entries) !== treeDigest(stagedEntries)) throw new Error('Workspace overlay staging verification failed')
          commitStaging(stagingPath, step.targetPath, entries)
          const committedEntries = entries.map(entry => ({ ...entry, digest: hashFile(join(step.targetPath, entry.relativePath)) }))
          if (treeDigest(entries) !== treeDigest(committedEntries)) throw new Error('Workspace overlay commit verification failed')
          step.files = entries.length
          step.bytes = entries.reduce((total, entry) => total + entry.size, 0)
          step.digest = treeDigest(entries)
          step.status = entries.length > 0 ? 'committed' : 'skipped'
          rmSync(stagingPath, { recursive: true, force: true })
        }
        step.error = undefined
        journal.updatedAt = this.now()
        this.writeJournal(journal)
      } catch (error) {
        step.status = 'failed'
        step.error = error instanceof Error ? error.message : String(error)
        journal.status = 'failed'
        journal.updatedAt = this.now()
        this.writeJournal(journal)
        return structuredClone(journal)
      }
    }
    journal.status = 'completed'
    journal.completedAt = this.now()
    journal.updatedAt = journal.completedAt
    rmSync(this.stagingRoot, { recursive: true, force: true })
    this.writeJournal(journal)
    return structuredClone(journal)
  }

  private createJournal(): WorkspaceOverlayMigrationJournal {
    const legacyRoot = join(this.workspacePath, '.turboflux')
    const mappings: Array<[WorkspaceOverlayMigrationStepId, string, string]> = [
      ['memory', join(legacyRoot, 'memory'), join(this.overlayRoot, 'memory')],
      ['sessions', join(legacyRoot, 'sessions'), join(this.overlayRoot, 'runtime', 'sessions')],
      ['runtime-agents', join(legacyRoot, 'runtime-agents'), join(this.overlayRoot, 'runtime', 'runtime-agents')],
      ['runtime-logs', join(legacyRoot, 'runtime-logs'), join(this.overlayRoot, 'runtime', 'runtime-logs')],
      ['recovery', join(legacyRoot, 'recovery'), join(this.overlayRoot, 'runtime', 'recovery')],
      ['attachments', join(legacyRoot, 'attachments'), join(this.overlayRoot, 'attachments')],
      ['browser-captures', join(legacyRoot, 'browser-captures'), join(this.overlayRoot, 'captures', 'browser')],
      ['computer-captures', join(legacyRoot, 'computer-captures'), join(this.overlayRoot, 'captures', 'computer')],
    ]
    const timestamp = this.now()
    return {
      schemaVersion: 1,
      transactionId: randomUUID(),
      workspaceId: this.workspaceId,
      status: 'running',
      startedAt: timestamp,
      updatedAt: timestamp,
      steps: mappings.map(([id, sourcePath, targetPath]) => ({ id, sourcePath, targetPath, status: 'pending', files: 0, bytes: 0 })),
    }
  }

  private readJournal(): WorkspaceOverlayMigrationJournal | undefined {
    if (!existsSync(this.journalPath)) return undefined
    try {
      const value: unknown = JSON.parse(readFileSync(this.journalPath, 'utf8'))
      return validJournal(value, this.workspaceId) ? value : undefined
    } catch {
      return undefined
    }
  }

  private writeJournal(journal: WorkspaceOverlayMigrationJournal): void {
    mkdirSync(dirname(this.journalPath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.journalPath}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(journal, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporaryPath, this.journalPath)
  }
}
