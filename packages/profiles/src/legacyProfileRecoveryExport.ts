import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  closeSync,
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
import { basename, dirname, join, relative, resolve } from 'node:path'
import { redactRecoveryValue } from '@turboflux/conversations/conversations/recoveryExport'
import type { ProfileContext } from './types'

export interface LegacyProfileRecoveryExportResult {
  schemaVersion: 1
  readOnlyRecovery: true
  sourceProfileId: string
  sourceProfileName: string
  createdAt: number
  files: number
  bytes: number
  targetPath: string
  excluded: string[]
}

interface RecoveryEntry {
  path: string
  bytes: number
  sha256: string
}

export interface LegacyProfileRecoveryExportOptions {
  now?: () => number
}

const EXCLUDED_COMPONENTS = [
  'credentials',
  'remote identity and grants',
  'installation identity',
  'device cache',
  'plugin private storage',
  'active execution state',
]

const RUNTIME_AUTOMATION_KEY = /^(?:activeRun|activeRunId|activeRuns|pendingApproval|pendingApprovals|pendingRunAt|nextRunAt|lease|processId|pid|retryAt|retryTimer|runQueue)$/u

function stripAutomationRuntime(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAutomationRuntime)
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (RUNTIME_AUTOMATION_KEY.test(key)) continue
    output[key] = stripAutomationRuntime(child)
  }
  return output
}

function sanitizeAutomations(value: unknown): unknown {
  const document = redactRecoveryValue(stripAutomationRuntime(value))
  if (!document || typeof document !== 'object' || Array.isArray(document)) return document
  const output = document as Record<string, unknown>
  output.approvals = []
  output.automations = (Array.isArray(output.automations) ? output.automations : []).map(value => {
    const automation = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
    return { ...automation, enabled: false, status: automation.status === 'archived' ? 'archived' : 'paused' }
  })
  return output
}

function sanitizePlugins(value: unknown): unknown {
  const document = redactRecoveryValue(value)
  if (!document || typeof document !== 'object' || Array.isArray(document)) return document
  const output = document as Record<string, unknown>
  output.plugins = (Array.isArray(output.plugins) ? output.plugins : []).map(value => {
    const plugin = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
    return { ...plugin, enabled: false, approvedPermissions: [] }
  })
  return output
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
}

function copyRecoveryFile(sourcePath: string, targetPath: string, transform?: (value: unknown) => unknown): void {
  const source = lstatSync(sourcePath)
  if (source.isSymbolicLink() || !source.isFile() || source.nlink > 1) {
    throw new Error(`Recovery export only accepts private regular files: ${basename(sourcePath)}`)
  }
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 })
  if (!transform) {
    copyFileSync(sourcePath, targetPath, 0)
    return
  }
  const parsed = JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown
  atomicJson(targetPath, transform(parsed))
}

function copyWorkspaceRecovery(sourceRoot: string, targetRoot: string): void {
  if (!existsSync(sourceRoot)) return
  for (const workspace of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue
    for (const directory of ['memory', 'attachments', 'artifacts']) {
      copyTreeIfPresent(join(sourceRoot, workspace.name, directory), join(targetRoot, workspace.name, directory))
    }
  }
}

function hashFile(path: string): { bytes: number; sha256: string } {
  const descriptor = openSync(path, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let bytes = 0
  try {
    let bytesRead = 0
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead))
      bytes += bytesRead
    }
  } finally {
    buffer.fill(0)
    closeSync(descriptor)
  }
  return { bytes, sha256: hash.digest('hex') }
}

function copyRecoveryTree(sourceRoot: string, targetRoot: string): void {
  const source = lstatSync(sourceRoot)
  if (source.isSymbolicLink() || !source.isDirectory()) throw new Error(`Recovery export only accepts private directories: ${basename(sourceRoot)}`)
  mkdirSync(targetRoot, { recursive: true, mode: 0o700 })
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    const sourcePath = join(sourceRoot, entry.name)
    const targetPath = join(targetRoot, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Recovery export does not follow symbolic links: ${entry.name}`)
    if (entry.isDirectory()) copyRecoveryTree(sourcePath, targetPath)
    else if (entry.isFile()) copyRecoveryFile(sourcePath, targetPath)
    else throw new Error(`Recovery export only accepts regular files: ${entry.name}`)
  }
}

function listRecoveryEntries(root: string): RecoveryEntry[] {
  const entries: RecoveryEntry[] = []
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) {
        const digest = hashFile(child)
        entries.push({
          path: relative(root, child).replaceAll('\\', '/'),
          ...digest,
        })
      }
    }
  }
  visit(root)
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

function copyIfPresent(sourcePath: string, targetPath: string, transform?: (value: unknown) => unknown): void {
  if (existsSync(sourcePath)) copyRecoveryFile(sourcePath, targetPath, transform)
}

function copyTreeIfPresent(sourcePath: string, targetPath: string): void {
  if (existsSync(sourcePath)) copyRecoveryTree(sourcePath, targetPath)
}

export function writeLegacyProfileRecoveryExport(
  context: ProfileContext,
  requestedTargetPath: string,
  options: LegacyProfileRecoveryExportOptions = {},
): LegacyProfileRecoveryExportResult {
  if (!requestedTargetPath.trim()) throw new Error('A recovery export directory is required')
  const targetPath = resolve(requestedTargetPath)
  if (existsSync(targetPath)) throw new Error('Recovery export target already exists')
  const stagingPath = `${targetPath}.staging-${process.pid}-${randomUUID()}`
  const now = options.now ?? Date.now
  try {
    mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 })
    mkdirSync(stagingPath, { recursive: false, mode: 0o700 })
    const configRoot = join(stagingPath, 'legacy-config')
    const platformRoot = join(stagingPath, 'legacy-platform')
    copyIfPresent(context.storage.configPath, join(configRoot, 'config.json'), redactRecoveryValue)
    copyIfPresent(context.storage.personaPath, join(configRoot, 'profile.json'), redactRecoveryValue)
    copyIfPresent(context.storage.settingsPath, join(configRoot, 'settings.json'), redactRecoveryValue)
    copyTreeIfPresent(context.storage.conversationsRoot, join(configRoot, 'conversations'))
    copyTreeIfPresent(context.storage.userSkillsRoot, join(configRoot, 'skills'))
    copyIfPresent(context.storage.projectsPath, join(platformRoot, 'projects.json'), redactRecoveryValue)
    copyIfPresent(context.storage.automationsPath, join(platformRoot, 'automations.json'), sanitizeAutomations)
    copyIfPresent(context.storage.artifactsPath, join(platformRoot, 'artifacts.json'), redactRecoveryValue)
    copyIfPresent(context.storage.managedTaskTitlesPath, join(platformRoot, 'managed-task-titles.json'), redactRecoveryValue)
    copyIfPresent(context.storage.pluginsIndexPath, join(platformRoot, 'plugins.json'), sanitizePlugins)
    copyTreeIfPresent(context.storage.pluginsRoot, join(platformRoot, 'plugins'))
    copyWorkspaceRecovery(context.storage.workspaceOverlaysRoot, join(stagingPath, 'manual-recovery', 'workspace-overlays'))

    const payloadEntries = listRecoveryEntries(stagingPath)
    const manifest = {
      schemaVersion: 1,
      readOnlyRecovery: true,
      sourceProfileId: context.profile.id,
      sourceProfileName: context.profile.displayName,
      createdAt: now(),
      layout: {
        legacyConfigRoot: 'legacy-config',
        legacyPlatformRoot: 'legacy-platform',
        manualRecoveryRoot: 'manual-recovery',
      },
      excluded: EXCLUDED_COMPONENTS,
      files: payloadEntries.length,
      bytes: payloadEntries.reduce((sum, entry) => sum + entry.bytes, 0),
    }
    atomicJson(join(stagingPath, 'recovery-manifest.json'), manifest)
    atomicJson(join(stagingPath, 'checksums.json'), { schemaVersion: 1, algorithm: 'sha256', entries: payloadEntries })
    writeFileSync(join(stagingPath, 'README.txt'), [
      'TurboFlux read-only legacy recovery export',
      '',
      'This directory is a recovery snapshot, not an active TurboFlux data root.',
      'Do not point two TurboFlux versions at the same writable data source.',
      'Credentials, device identity, remote grants, plugin private storage and active execution state are excluded.',
      'Automations and plugins are disabled. Review the recovery runbook before copying selected files.',
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o400, flag: 'wx' })
    renameSync(stagingPath, targetPath)
    const finalEntries = listRecoveryEntries(targetPath)
    return {
      schemaVersion: 1,
      readOnlyRecovery: true,
      sourceProfileId: context.profile.id,
      sourceProfileName: context.profile.displayName,
      createdAt: manifest.createdAt,
      files: finalEntries.length,
      bytes: finalEntries.reduce((sum, entry) => sum + entry.bytes, 0),
      targetPath,
      excluded: [...EXCLUDED_COMPONENTS],
    }
  } catch (error) {
    rmSync(stagingPath, { recursive: true, force: true })
    throw error
  }
}
