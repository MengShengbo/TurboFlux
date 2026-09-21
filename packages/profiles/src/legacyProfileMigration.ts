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
  statfsSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { ProfileStorageLayout } from './types'

export type LegacyProfileMigrationStepId =
  | 'config'
  | 'credentials'
  | 'persona'
  | 'settings'
  | 'conversations'
  | 'skills'
  | 'projects'
  | 'automations'
  | 'artifacts'
  | 'managed-task-titles'
  | 'plugins-index'
  | 'plugins'
  | 'remote'

export interface LegacyProfileMigrationStep {
  id: LegacyProfileMigrationStepId
  sourcePath: string
  targetPath: string
  status: 'pending' | 'staging' | 'validating' | 'committing' | 'copied' | 'skipped' | 'failed'
  files: number
  bytes: number
  error?: string
  digest?: string
  warnings?: string[]
}

export interface LegacyProfileMigrationPlanStep {
  id: LegacyProfileMigrationStepId
  sourcePath: string
  targetPath: string
  exists: boolean
  files: number
  bytes: number
  digest?: string
  blocked: boolean
  warnings: string[]
}

export interface LegacyProfileMigrationPlan {
  schemaVersion: 1
  profileId: string
  createdAt: number
  files: number
  bytes: number
  requiredBytes: number
  availableBytes: number
  sufficientSpace: boolean
  warnings: string[]
  steps: LegacyProfileMigrationPlanStep[]
}

export interface LegacyProfileMigrationJournal {
  schemaVersion: 1
  transactionId: string
  profileId: string
  startedAt: number
  updatedAt: number
  completedAt?: number
  status: 'running' | 'completed' | 'failed'
  steps: LegacyProfileMigrationStep[]
}

export interface LegacyProfileMigrationOptions {
  legacyConfigRoot: string
  legacyPlatformRoot?: string
  legacyConversationsRoot?: string
  legacyRemoteRoot?: string
  migrationRoot: string
  layout: ProfileStorageLayout
  now?: () => number
  availableBytes?: () => number
  credentialTransformer?: (source: Buffer) => Buffer
  onPhase?: (phase: 'staged' | 'validated' | 'committed', step: LegacyProfileMigrationStepId) => void
}

interface CopyStats {
  files: number
  bytes: number
}

interface TreeEntry {
  relativePath: string
  size: number
  digest: string
}

interface ConversationCatalogEntry {
  meta?: {
    id?: unknown
    updatedAt?: unknown
    [key: string]: unknown
  }
  visible?: unknown
  fingerprint?: unknown
  [key: string]: unknown
}

interface ConversationCatalogDocument {
  version: 1
  entries: ConversationCatalogEntry[]
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
  const rootInfo = lstatSync(root)
  if (rootInfo.isSymbolicLink()) throw new Error('Legacy profile migration does not follow symbolic links')
  const entries: TreeEntry[] = []
  const visit = (path: string): void => {
    const info = lstatSync(path)
    if (info.isSymbolicLink()) throw new Error('Legacy profile migration does not follow symbolic links')
    if (info.isFile()) {
      entries.push({
        relativePath: rootInfo.isFile() ? basename(root) : relative(root, path).replaceAll('\\', '/'),
        size: info.size,
        digest: hashFile(path),
      })
      return
    }
    if (!info.isDirectory()) throw new Error('Legacy profile migration only supports regular files and directories')
    for (const entry of readdirSync(path)) visit(join(path, entry))
  }
  visit(root)
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

function treeDigest(entries: TreeEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

function nearestExistingDirectory(path: string): string {
  let candidate = resolve(path)
  while (!existsSync(candidate)) {
    const parent = dirname(candidate)
    if (parent === candidate) return candidate
    candidate = parent
  }
  return lstatSync(candidate).isDirectory() ? candidate : dirname(candidate)
}

function verifyCommittedTree(stagingPath: string, targetPath: string): TreeEntry[] {
  const stagedRootInfo = lstatSync(stagingPath)
  const stagedEntries = scanTree(stagingPath)
  for (const entry of stagedEntries) {
    const target = stagedRootInfo.isFile() ? targetPath : join(targetPath, entry.relativePath)
    if (!existsSync(target) || !lstatSync(target).isFile() || hashFile(target) !== entry.digest) {
      throw new Error(`Legacy migration commit verification failed: ${entry.relativePath}`)
    }
  }
  return stagedEntries
}

function assertTargetContained(layout: ProfileStorageLayout, targetPath: string): void {
  const allowedRoots = [layout.profileRoot, layout.deviceBoundRoot].map(root => resolve(root))
  const target = resolve(targetPath)
  if (!allowedRoots.some(root => {
    const child = relative(root, target)
    return child && child !== '..' && !child.startsWith(`..${sep}`)
  })) throw new Error('Legacy migration target escaped the local profile roots')
}

function atomicWriteFile(path: string, contents: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporaryPath, contents, { mode: 0o600, flag: 'wx' })
  renameSync(temporaryPath, path)
}

function validConversationCatalog(value: unknown): value is ConversationCatalogDocument {
  if (!value || typeof value !== 'object') return false
  const document = value as Partial<ConversationCatalogDocument>
  return document.version === 1 && Array.isArray(document.entries) && document.entries.every(entry => (
    Boolean(entry?.meta)
    && typeof entry.meta?.id === 'string'
    && entry.meta.id.length > 0
  ))
}

function mergeConversationCatalog(sourcePath: string, targetPath: string): void {
  const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown
  const target = JSON.parse(readFileSync(targetPath, 'utf8')) as unknown
  if (!validConversationCatalog(source) || !validConversationCatalog(target)) {
    throw new Error('Legacy conversation catalog is invalid')
  }
  const merged = new Map<string, ConversationCatalogEntry>()
  for (const entry of target.entries) merged.set(entry.meta!.id as string, structuredClone(entry))
  for (const sourceEntry of source.entries) {
    const id = sourceEntry.meta!.id as string
    const targetEntry = merged.get(id)
    if (!targetEntry) {
      merged.set(id, structuredClone(sourceEntry))
      continue
    }
    const sourceUpdatedAt = typeof sourceEntry.meta?.updatedAt === 'number' ? sourceEntry.meta.updatedAt : 0
    const targetUpdatedAt = typeof targetEntry.meta?.updatedAt === 'number' ? targetEntry.meta.updatedAt : 0
    const preferred = sourceUpdatedAt > targetUpdatedAt ? sourceEntry : targetEntry
    merged.set(id, {
      ...structuredClone(preferred),
      visible: sourceEntry.visible === true || targetEntry.visible === true,
    })
  }
  const entries = [...merged.values()].sort((left, right) => (
    String(left.meta!.id).localeCompare(String(right.meta!.id))
  ))
  atomicWriteFile(targetPath, `${JSON.stringify({ version: 1, entries })}\n`)
}

function resolveConversationConflict(sourcePath: string, targetPath: string): boolean {
  if (basename(targetPath) === '.conversation-catalog-v1.json') {
    mergeConversationCatalog(sourcePath, targetPath)
    return true
  }
  if (!targetPath.endsWith('.jsonl')) return false
  const source = readFileSync(sourcePath)
  const target = readFileSync(targetPath)
  const sharedLength = Math.min(source.length, target.length)
  if (!source.subarray(0, sharedLength).equals(target.subarray(0, sharedLength))) return false
  if (source.length > target.length) atomicWriteFile(targetPath, source)
  return true
}

function copyTreeNoLinks(
  sourcePath: string,
  targetPath: string,
  conflictResolver?: (sourcePath: string, targetPath: string) => boolean,
): CopyStats {
  const source = lstatSync(sourcePath)
  if (source.isSymbolicLink()) throw new Error('Legacy profile migration does not follow symbolic links')
  if (source.isFile()) {
    if (existsSync(targetPath)) {
      const target = lstatSync(targetPath)
      if (target.isSymbolicLink()) throw new Error('Legacy profile migration does not write through symbolic links')
      if (!target.isFile()) throw new Error('Legacy profile migration target type does not match its source')
      if (hashFile(sourcePath) !== hashFile(targetPath) && !conflictResolver?.(sourcePath, targetPath)) {
        throw new Error('Legacy profile migration target conflicts with its source')
      }
      return { files: 0, bytes: 0 }
    }
    mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
    copyFileSync(sourcePath, temporaryPath, constants.COPYFILE_EXCL)
    renameSync(temporaryPath, targetPath)
    return { files: 1, bytes: source.size }
  }
  if (!source.isDirectory()) throw new Error('Legacy profile migration only supports regular files and directories')
  if (existsSync(targetPath)) {
    const target = lstatSync(targetPath)
    if (target.isSymbolicLink()) throw new Error('Legacy profile migration does not write through symbolic links')
    if (!target.isDirectory()) throw new Error('Legacy profile migration target type does not match its source')
  } else {
    mkdirSync(targetPath, { recursive: true, mode: 0o700 })
  }
  const stats = { files: 0, bytes: 0 }
  for (const entry of readdirSync(sourcePath)) {
    const copied = copyTreeNoLinks(join(sourcePath, entry), join(targetPath, entry), conflictResolver)
    stats.files += copied.files
    stats.bytes += copied.bytes
  }
  return stats
}

function verifyConversationMigration(stagingPath: string, targetPath: string): TreeEntry[] {
  const stagedEntries = scanTree(stagingPath)
  for (const entry of stagedEntries) {
    const target = join(targetPath, entry.relativePath)
    if (!existsSync(target) || !lstatSync(target).isFile()) {
      throw new Error(`Legacy migration commit verification failed: ${entry.relativePath}`)
    }
    if (entry.relativePath === '.conversation-catalog-v1.json') {
      const stagedCatalog = JSON.parse(readFileSync(join(stagingPath, entry.relativePath), 'utf8')) as unknown
      const targetCatalog = JSON.parse(readFileSync(target, 'utf8')) as unknown
      if (!validConversationCatalog(stagedCatalog) || !validConversationCatalog(targetCatalog)) {
        throw new Error('Legacy conversation catalog verification failed')
      }
      const targetIds = new Set(targetCatalog.entries.map(record => record.meta!.id as string))
      if (stagedCatalog.entries.some(record => !targetIds.has(record.meta!.id as string))) {
        throw new Error('Legacy conversation catalog merge omitted source entries')
      }
      continue
    }
    const source = readFileSync(join(stagingPath, entry.relativePath))
    const committed = readFileSync(target)
    const sharedLength = Math.min(source.length, committed.length)
    if (!source.subarray(0, sharedLength).equals(committed.subarray(0, sharedLength)) || committed.length < source.length) {
      throw new Error(`Legacy migration commit verification failed: ${entry.relativePath}`)
    }
  }
  return stagedEntries
}

function validJournal(value: unknown): value is LegacyProfileMigrationJournal {
  if (!value || typeof value !== 'object') return false
  const journal = value as Partial<LegacyProfileMigrationJournal>
  return journal.schemaVersion === 1
    && typeof journal.transactionId === 'string'
    && typeof journal.profileId === 'string'
    && (journal.status === 'running' || journal.status === 'completed' || journal.status === 'failed')
    && Array.isArray(journal.steps)
}

export class LegacyProfileMigration {
  readonly journalPath: string
  private readonly now: () => number

  constructor(private readonly options: LegacyProfileMigrationOptions) {
    this.now = options.now ?? Date.now
    this.journalPath = join(options.migrationRoot, `profile-layout-v1-${options.layout.profileId}.json`)
  }

  inspect(): LegacyProfileMigrationJournal {
    const existing = this.readJournal()
    if (existing) return existing
    const mappings = this.mappings()
    const timestamp = this.now()
    return {
      schemaVersion: 1,
      transactionId: randomUUID(),
      profileId: this.options.layout.profileId,
      startedAt: timestamp,
      updatedAt: timestamp,
      status: 'running',
      steps: mappings.map(([id, sourcePath, targetPath]) => ({ id, sourcePath, targetPath, status: 'pending', files: 0, bytes: 0 })),
    }
  }

  plan(): LegacyProfileMigrationPlan {
    const steps = this.mappings().map(([id, sourcePath, targetPath]): LegacyProfileMigrationPlanStep => {
      if (!existsSync(sourcePath)) {
        return { id, sourcePath, targetPath, exists: false, files: 0, bytes: 0, blocked: false, warnings: [] }
      }
      try {
        const entries = scanTree(sourcePath)
        const warnings: string[] = []
        if (existsSync(targetPath) && lstatSync(targetPath).isFile()) warnings.push('Target already exists and will be preserved')
        if (id === 'credentials' && !this.options.credentialTransformer) {
          try {
            const document = JSON.parse(readFileSync(sourcePath, 'utf8')) as { protected?: unknown }
            if (document.protected === true) warnings.push('Protected credentials will be preserved without re-protection because the platform key store is unavailable')
          } catch {
            warnings.push('Credential document is invalid and will be preserved for recovery')
          }
        } else if (lstatSync(sourcePath).isFile() && sourcePath.endsWith('.json')) {
          try { JSON.parse(readFileSync(sourcePath, 'utf8')) } catch { warnings.push('Source JSON is invalid and will be preserved for recovery') }
        }
        return {
          id,
          sourcePath,
          targetPath,
          exists: true,
          files: entries.length,
          bytes: entries.reduce((total, entry) => total + entry.size, 0),
          digest: treeDigest(entries),
          blocked: false,
          warnings,
        }
      } catch (error) {
        return {
          id,
          sourcePath,
          targetPath,
          exists: true,
          files: 0,
          bytes: 0,
          blocked: true,
          warnings: [error instanceof Error ? error.message : String(error)],
        }
      }
    })
    const files = steps.reduce((total, step) => total + step.files, 0)
    const bytes = steps.reduce((total, step) => total + step.bytes, 0)
    const requiredBytes = Math.ceil(bytes * 1.15) + 16 * 1024 * 1024
    let availableBytes = Number.MAX_SAFE_INTEGER
    try {
      availableBytes = this.options.availableBytes?.()
        ?? (() => {
          const stats = statfsSync(nearestExistingDirectory(this.options.migrationRoot))
          return Number(stats.bavail) * Number(stats.bsize)
        })()
    } catch {}
    const warnings = steps.flatMap(step => step.warnings.map(warning => `${step.id}: ${warning}`))
    if (availableBytes < requiredBytes) warnings.push('Insufficient free space for staged local profile migration')
    return {
      schemaVersion: 1,
      profileId: this.options.layout.profileId,
      createdAt: this.now(),
      files,
      bytes,
      requiredBytes,
      availableBytes,
      sufficientSpace: availableBytes >= requiredBytes,
      warnings,
      steps,
    }
  }

  migrate(): LegacyProfileMigrationJournal {
    const journal = this.inspect()
    if (journal.status === 'completed') return structuredClone(journal)
    const migrationPlan = this.plan()
    for (const planned of migrationPlan.steps) {
      const step = journal.steps.find(candidate => candidate.id === planned.id)
      if (step && planned.warnings.length > 0) step.warnings = [...planned.warnings]
    }
    const blocked = migrationPlan.steps.find(step => step.blocked)
    if (blocked || !migrationPlan.sufficientSpace) {
      const failed = journal.steps.find(step => step.id === blocked?.id) ?? journal.steps[0]
      if (failed) {
        failed.status = 'failed'
        failed.error = blocked?.warnings[0] ?? 'Insufficient free space for staged local profile migration'
      }
      journal.status = 'failed'
      journal.updatedAt = this.now()
      this.writeJournal(journal)
      return structuredClone(journal)
    }
    journal.status = 'running'
    for (const step of journal.steps) {
      if (step.status === 'copied' || step.status === 'skipped') continue
      try {
        assertTargetContained(this.options.layout, step.targetPath)
        if (!existsSync(step.sourcePath)) {
          step.status = 'skipped'
        } else if (lstatSync(step.sourcePath).isFile() && existsSync(step.targetPath)) {
          step.status = 'skipped'
          step.warnings = ['Target already exists and was preserved']
        } else {
          const sourceIsFile = lstatSync(step.sourcePath).isFile()
          const stagingContainer = join(this.options.migrationRoot, 'staging', journal.transactionId, step.id)
          const stagingPath = sourceIsFile ? join(stagingContainer, basename(step.targetPath)) : join(stagingContainer, 'payload')
          rmSync(stagingContainer, { recursive: true, force: true })
          if (step.id === 'credentials' && sourceIsFile && this.options.credentialTransformer) {
            mkdirSync(dirname(stagingPath), { recursive: true, mode: 0o700 })
            const source = readFileSync(step.sourcePath)
            try {
              const transformed = this.options.credentialTransformer(source)
              try {
                writeFileSync(stagingPath, transformed, { mode: 0o600, flag: 'wx' })
              } finally {
                transformed.fill(0)
              }
            } finally {
              source.fill(0)
            }
          } else {
            copyTreeNoLinks(step.sourcePath, stagingPath)
          }
          step.status = 'staging'
          journal.updatedAt = this.now()
          this.writeJournal(journal)
          this.options.onPhase?.('staged', step.id)

          const stagedEntries = scanTree(stagingPath)
          if (!(step.id === 'credentials' && this.options.credentialTransformer)) {
            const sourceEntries = scanTree(step.sourcePath)
            if (treeDigest(sourceEntries) !== treeDigest(stagedEntries)) throw new Error('Legacy migration staging verification failed')
          }
          step.status = 'validating'
          journal.updatedAt = this.now()
          this.writeJournal(journal)
          this.options.onPhase?.('validated', step.id)

          step.status = 'committing'
          journal.updatedAt = this.now()
          this.writeJournal(journal)
          copyTreeNoLinks(
            stagingPath,
            step.targetPath,
            step.id === 'conversations' ? resolveConversationConflict : undefined,
          )
          const committedEntries = step.id === 'conversations'
            ? verifyConversationMigration(stagingPath, step.targetPath)
            : verifyCommittedTree(stagingPath, step.targetPath)
          this.options.onPhase?.('committed', step.id)
          step.files = committedEntries.length
          step.bytes = committedEntries.reduce((total, entry) => total + entry.size, 0)
          step.digest = treeDigest(committedEntries)
          step.status = committedEntries.length > 0 ? 'copied' : 'skipped'
          rmSync(stagingContainer, { recursive: true, force: true })
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
    rmSync(join(this.options.migrationRoot, 'staging', journal.transactionId), { recursive: true, force: true })
    this.writeJournal(journal)
    this.writeReceipt(journal, migrationPlan)
    return structuredClone(journal)
  }

  private mappings(): Array<[LegacyProfileMigrationStepId, string, string]> {
    const legacyConfigRoot = resolve(this.options.legacyConfigRoot)
    const legacyPlatformRoot = this.options.legacyPlatformRoot ? resolve(this.options.legacyPlatformRoot) : undefined
    const legacyConversationsRoot = resolve(this.options.legacyConversationsRoot ?? join(legacyConfigRoot, 'conversations'))
    const legacyRemoteRoot = this.options.legacyRemoteRoot ? resolve(this.options.legacyRemoteRoot) : undefined
    const mappings: Array<[LegacyProfileMigrationStepId, string, string]> = [
      ['config', join(legacyConfigRoot, 'config.json'), this.options.layout.configPath],
      ['credentials', join(legacyConfigRoot, 'credentials.json'), this.options.layout.credentialsPath],
      ['persona', join(legacyConfigRoot, 'profile.json'), this.options.layout.personaPath],
      ['settings', join(legacyConfigRoot, 'settings.json'), this.options.layout.settingsPath],
      ['conversations', legacyConversationsRoot, this.options.layout.conversationsRoot],
      ['skills', join(legacyConfigRoot, 'skills'), this.options.layout.userSkillsRoot],
    ]
    if (legacyPlatformRoot) mappings.push(
      ['projects', join(legacyPlatformRoot, 'projects.json'), this.options.layout.projectsPath],
      ['automations', join(legacyPlatformRoot, 'automations.json'), this.options.layout.automationsPath],
      ['artifacts', join(legacyPlatformRoot, 'artifacts.json'), this.options.layout.artifactsPath],
      ['managed-task-titles', join(legacyPlatformRoot, 'managed-task-titles.json'), this.options.layout.managedTaskTitlesPath],
      ['plugins-index', join(legacyPlatformRoot, 'plugins.json'), this.options.layout.pluginsIndexPath],
      ['plugins', join(legacyPlatformRoot, 'plugins'), this.options.layout.pluginsRoot],
    )
    if (legacyRemoteRoot) mappings.push(['remote', legacyRemoteRoot, this.options.layout.remoteRoot])
    return mappings
  }

  private writeReceipt(journal: LegacyProfileMigrationJournal, plan: LegacyProfileMigrationPlan): void {
    const receiptPath = join(this.options.layout.profileRoot, 'migration-receipt.json')
    const receipt = {
      schemaVersion: 1,
      transactionId: journal.transactionId,
      profileId: journal.profileId,
      completedAt: journal.completedAt,
      planned: { files: plan.files, bytes: plan.bytes },
      migrated: {
        files: journal.steps.reduce((total, step) => total + step.files, 0),
        bytes: journal.steps.reduce((total, step) => total + step.bytes, 0),
      },
      legacySourcesRetained: true,
      steps: journal.steps.map(step => ({
        id: step.id,
        status: step.status,
        files: step.files,
        bytes: step.bytes,
        digest: step.digest,
        warnings: step.warnings,
      })),
    }
    const temporaryPath = `${receiptPath}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporaryPath, receiptPath)
  }

  private readJournal(): LegacyProfileMigrationJournal | undefined {
    if (!existsSync(this.journalPath)) return undefined
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.journalPath, 'utf8'))
      if (!validJournal(parsed) || parsed.profileId !== this.options.layout.profileId) throw new Error('unsupported migration journal')
      return parsed
    } catch (error) {
      const backupPath = `${this.journalPath}.corrupt-${this.now()}`
      try { renameSync(this.journalPath, backupPath) } catch {}
      return undefined
    }
  }

  private writeJournal(journal: LegacyProfileMigrationJournal): void {
    mkdirSync(dirname(this.journalPath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.journalPath}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(journal, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporaryPath, this.journalPath)
  }
}
