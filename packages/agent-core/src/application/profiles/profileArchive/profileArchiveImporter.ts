import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { ConversationDraftState, PersistedConversation } from '../../conversations/types'
import { ConversationStore } from '../../conversations/store'
import { ConversationInteractionStoreV2 } from '../../conversations/conversationInteractionStoreV2'
import { ConversationRepositoryV2 } from '../../conversations/conversationRepositoryV2'
import { normalizeConversationV2Id, stableConversationV2Id } from '../../conversations/conversationV2Ids'
import type { AnyAppendConversationEventV2Input, AnyConversationEventV2 } from '../../conversations/conversationV2Types'
import { InstallationProfileRegistry } from '../profileRegistry'
import { createProfileStorageLayout } from '../profileStorageLayout'
import type { LocalProfileRecord, ProfileStorageLayout } from '../types'
import { scanProfileArchive, type ScannedProfileArchive } from './archiveScanner'
import { readProfileArchive } from './container'
import { normalizeArchivePath } from './archivePath'
import {
  PROFILE_REGISTRY_SCHEMA_VERSION,
  PROFILE_STORAGE_VERSION,
} from '../types'
import {
  ProfileArchiveError,
  type ArchiveComponentId,
  type ArchiveOperationPhase,
  type ArchiveWarning,
  type ImportSelectionInput,
  type ProfileArchivePreview,
  type ProfileImportPlan,
} from './types'

type ImportJournalPhase = 'staging' | 'validated' | 'committing' | 'directory_committed' | 'registered'

interface ImportJournal {
  schemaVersion: 1
  transactionId: string
  phase: ImportJournalPhase
  profileId: string
  stagingRoot: string
  profilePayloadRoot: string
  finalProfileRoot: string
  archiveId: string
  selectedComponents: ArchiveComponentId[]
  createdAt: number
  updatedAt: number
}

export interface PreparedProfileImportPlan extends ProfileImportPlan {
  sourcePath: string
  encrypted: boolean
}

export interface ProfileArchiveImporterOptions {
  registry: InstallationProfileRegistry
  now?: () => number
  createId?: () => string
  protectCredentials?: (credentials: unknown) => Promise<Buffer> | Buffer
  faultAfterPhase?: ImportJournalPhase
}

export interface ProfileImportResult {
  profile: LocalProfileRecord
  receiptPath: string
  warnings: ArchiveWarning[]
}

class SimulatedImportInterruption extends Error {}

function safeDisplayName(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, ' ').slice(0, 80)
  if (!normalized) throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '新资料名称不能为空。', '请输入资料名称。')
  return normalized
}

function unboundWorkspacePath(workspaceId: string): string {
  return `turboflux-unbound:${workspaceId}`
}

function unassociatedWorkspaceId(scan: ScannedProfileArchive): string | undefined {
  const id = stableConversationV2Id('workspace', scan.manifest.archiveId, 'unassociated')
  return scan.preview.workspaces.some(workspace => workspace.id === id) ? id : undefined
}

function importedWorkspaceId(value: unknown, fallback: string | undefined): string {
  if (typeof value === 'string' && value) return value
  if (fallback) return fallback
  throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '导入内容缺少可恢复的 Workspace 身份。', '请从来源设备重新导出资料包。')
}

function scrubSecretValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      scrubSecretValue(value[index])
      value[index] = undefined
    }
    return
  }
  if (!value || typeof value !== 'object') return
  for (const key of Object.keys(value as Record<string, unknown>)) {
    scrubSecretValue((value as Record<string, unknown>)[key])
    ;(value as Record<string, unknown>)[key] = undefined
  }
}

export function isUnboundWorkspacePath(value: string): boolean {
  return /^turboflux-unbound:(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|workspace-[A-Za-z0-9_-]{8,96})$/iu.test(value)
}

function contained(root: string, path: string): string {
  const normalizedRoot = resolve(root)
  const normalizedPath = resolve(path)
  const child = relative(normalizedRoot, normalizedPath)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new ProfileArchiveError('ARCHIVE_UNSAFE_ENTRY', '导入路径逃离事务目录。', '请勿导入该文件。')
  }
  return normalizedPath
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    await writeFile(temporaryPath, data, { mode: 0o600, flag: 'wx' })
    const handle = await open(temporaryPath, 'r')
    try { await handle.sync() } finally { await handle.close() }
    await rename(temporaryPath, path)
  } finally {
    data.fill(0)
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected JSON object: ${basename(path)}`)
  return value as Record<string, unknown>
}

function stagePath(layout: ProfileStorageLayout, profilePayloadRoot: string, finalPath: string): string {
  const child = relative(layout.profileRoot, finalPath)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Profile layout escaped profile root')
  return contained(profilePayloadRoot, join(profilePayloadRoot, child))
}

async function writeProfileFile(layout: ProfileStorageLayout, profilePayloadRoot: string, finalPath: string, value: unknown): Promise<void> {
  await atomicJson(stagePath(layout, profilePayloadRoot, finalPath), value)
}

async function extractArchive(input: {
  path: string
  password?: string | Uint8Array
  targetRoot: string
  signal?: AbortSignal
  persistEntry?: (path: string) => boolean
}): Promise<void> {
  await mkdir(input.targetRoot, { recursive: true, mode: 0o700 })
  await readProfileArchive({
    path: input.path,
    password: input.password,
    onEntry: async (entry, content) => {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error('Import cancelled')
      if (input.persistEntry && !input.persistEntry(entry.path)) return
      const safePath = normalizeArchivePath(entry.path)
      const targetPath = contained(input.targetRoot, join(input.targetRoot, ...safePath.split('/')))
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
      const stream = createWriteStream(targetPath, { flags: 'wx', mode: 0o600 })
      await pipeline(Readable.from(content), stream, { signal: input.signal })
      await chmod(targetPath, 0o600)
    },
  })
}

async function scanTreeNoLinks(root: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new ProfileArchiveError('ARCHIVE_UNSAFE_ENTRY', '导入 staging 包含符号链接。', '请勿导入该文件。')
      if (info.isDirectory()) await visit(path)
      else if (info.isFile()) { files += 1; bytes += info.size }
      else throw new ProfileArchiveError('ARCHIVE_UNSAFE_ENTRY', '导入 staging 包含特殊文件。', '请勿导入该文件。')
    }
  }
  await visit(root)
  return { files, bytes }
}

function componentPath(incomingRoot: string, path: string): string {
  return contained(incomingRoot, join(incomingRoot, ...normalizeArchivePath(path).split('/')))
}

async function copyBlob(incomingRoot: string, digest: string, targetPath: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', 'Blob Digest 无效。', '请重新导出资料包。')
  const sourcePath = componentPath(incomingRoot, `blobs/sha256/${digest}`)
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
  await copyFile(sourcePath, targetPath)
  await chmod(targetPath, 0o600)
}

function selectedDocument(scan: ScannedProfileArchive, _incomingRoot: string, path: string): Promise<Record<string, unknown>> {
  if (!scan.documents.has(path)) throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', `缺少 ${path}。`, '请重新导出资料包。')
  const document = scan.documents.get(path)
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', `${path} 组件格式无效。`, '请重新导出资料包。')
  }
  return Promise.resolve(structuredClone(document as Record<string, unknown>))
}

async function applyProfilePreferences(scan: ScannedProfileArchive, incomingRoot: string, layout: ProfileStorageLayout, payloadRoot: string, config: Record<string, unknown>): Promise<void> {
  const document = await selectedDocument(scan, incomingRoot, 'components/profile.preferences/preferences.json')
  const behavior = document.behavior && typeof document.behavior === 'object' ? document.behavior as Record<string, unknown> : {}
  Object.assign(config, behavior)
  await writeProfileFile(layout, payloadRoot, layout.personaPath, document.persona ?? {})
}

async function applyModelConfigurations(scan: ScannedProfileArchive, incomingRoot: string, config: Record<string, unknown>): Promise<void> {
  const document = await selectedDocument(scan, incomingRoot, 'components/model.configurations/configurations.json')
  if (document.config && typeof document.config === 'object' && !Array.isArray(document.config)) Object.assign(config, document.config)
}

async function applyConversations(scan: ScannedProfileArchive, incomingRoot: string, layout: ProfileStorageLayout, payloadRoot: string): Promise<number> {
  const index = await selectedDocument(scan, incomingRoot, 'components/conversations/index.json')
  const items = Array.isArray(index.items) ? index.items : []
  if (index.schemaVersion === 2) {
    const repository = new ConversationRepositoryV2(stagePath(layout, payloadRoot, layout.conversationsV2Root))
    const interactionStore = new ConversationInteractionStoreV2(stagePath(layout, payloadRoot, layout.interactionRoot), layout.profileId)
    for (const value of items) {
      const item = value as Record<string, unknown>
      const document = await selectedDocument(scan, incomingRoot, String(item.path))
      const events = (Array.isArray(document.events) ? document.events : []) as AnyConversationEventV2[]
      const inputs = events.map(event => {
        const { schemaVersion: _schemaVersion, seq: _seq, ...input } = structuredClone(event)
        input.profileId = layout.profileId
        input.provenance = 'imported'
        if (input.type === 'conversation.created') {
          input.payload.record.profileId = layout.profileId
          input.payload.record.status = input.payload.record.workspaceId ? 'needs_workspace' : 'idle'
        }
        return input as AnyAppendConversationEventV2Input
      })
      if (inputs.length) repository.append(inputs)
      if (typeof item.interactionPath === 'string') {
        const interaction = await selectedDocument(scan, incomingRoot, item.interactionPath)
        interactionStore.save(String(item.id), {
          queuedInputs: [],
          draft: structuredClone(interaction.draft) as ConversationDraftState,
          pendingSteering: [],
          pendingApprovals: [],
        })
      }
    }
    repository.recoverInterruptedConversations()
    repository.rebuildCatalog()
    return items.length
  }
  const store = new ConversationStore(stagePath(layout, payloadRoot, layout.conversationsRoot))
  const fallbackWorkspaceId = unassociatedWorkspaceId(scan)
  for (const value of items) {
    const item = value as Record<string, unknown>
    const document = await selectedDocument(scan, incomingRoot, String(item.path))
    const conversation = structuredClone(document.conversation) as PersistedConversation & { workspaceId?: string; importedInterrupted?: boolean }
    const workspaceId = importedWorkspaceId(conversation.workspaceId, fallbackWorkspaceId)
    conversation.workspacePath = unboundWorkspacePath(workspaceId)
    delete conversation.workspaceId
    conversation.interactionState = {
      queuedInputs: [],
      draft: conversation.interactionState?.draft ?? { text: '' },
      pendingSteering: [],
      pendingApprovals: [],
      workflow: conversation.interactionState?.workflow,
    }
    store.save(conversation, { compact: true })
  }
  return items.length
}

async function applyWorkspaceBindings(scan: ScannedProfileArchive, layout: ProfileStorageLayout, payloadRoot: string, now: number): Promise<void> {
  await writeProfileFile(layout, payloadRoot, layout.workspaceBindingsPath, {
    schemaVersion: 1,
    workspaces: scan.preview.workspaces.map(workspace => ({
      schemaVersion: 1,
      id: workspace.id,
      displayName: workspace.displayName,
      sourceHint: workspace.sourceHint,
      state: 'unbound',
      createdAt: now,
      updatedAt: now,
    })),
  })
}

async function applyProjects(scan: ScannedProfileArchive, incomingRoot: string, layout: ProfileStorageLayout, payloadRoot: string): Promise<void> {
  const document = await selectedDocument(scan, incomingRoot, 'components/projects/projects.json')
  const fallbackWorkspaceId = unassociatedWorkspaceId(scan)
  const projects = (Array.isArray(document.projects) ? document.projects : []).map(value => {
    const project = value as Record<string, unknown>
    const workspaceId = importedWorkspaceId(project.workspaceId, fallbackWorkspaceId)
    return { ...project, path: unboundWorkspacePath(workspaceId), available: false }
  })
  await writeProfileFile(layout, payloadRoot, layout.projectsPath, { schemaVersion: 1, projects })
}

function stripAutomationExecutionState(candidate: unknown): unknown {
  if (Array.isArray(candidate)) return candidate.map(stripAutomationExecutionState)
  if (!candidate || typeof candidate !== 'object') return candidate
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
    if (/^(?:activeRun|activeRunId|activeRuns|pendingApproval|pendingApprovals|pendingRunAt|nextRunAt|lease|processId|pid|retryAt|retryTimer|runQueue)$/u.test(key)) continue
    result[key] = stripAutomationExecutionState(value)
  }
  return result
}

async function applyAutomations(scan: ScannedProfileArchive, incomingRoot: string, layout: ProfileStorageLayout, payloadRoot: string): Promise<number> {
  const document = await selectedDocument(scan, incomingRoot, 'components/automations/automations.json')
  const fallbackWorkspaceId = unassociatedWorkspaceId(scan)
  const automations = (Array.isArray(document.automations) ? document.automations : []).map(value => {
    const automation = stripAutomationExecutionState(value) as Record<string, unknown>
    const workspaceId = importedWorkspaceId(automation.workspaceId || (automation.workspaceRef as Record<string, unknown> | undefined)?.id, fallbackWorkspaceId)
    return { ...automation, enabled: false, status: automation.status === 'archived' ? 'archived' : 'paused', workspacePath: unboundWorkspacePath(workspaceId), pendingApprovals: [], activeRuns: [] }
  })
  await writeProfileFile(layout, payloadRoot, layout.automationsPath, { schemaVersion: 2, automations, approvals: [] })
  return automations.length
}

async function applyMemories(scan: ScannedProfileArchive, incomingRoot: string, layout: ProfileStorageLayout, payloadRoot: string): Promise<void> {
  const document = await selectedDocument(scan, incomingRoot, 'components/memories/index.json')
  for (const value of Array.isArray(document.items) ? document.items : []) {
    const memory = value as Record<string, unknown>
    const workspaceId = String(memory.workspaceId)
    const relativePath = normalizeArchivePath(String(memory.relativePath))
    const finalPath = join(layout.workspaceOverlaysRoot, workspaceId, 'memory', ...relativePath.split('/'))
    const targetPath = stagePath(layout, payloadRoot, finalPath)
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
    await writeFile(targetPath, String(memory.content), { mode: 0o600, flag: 'wx' })
  }
}

async function applyBlobIndex(input: { scan: ScannedProfileArchive; incomingRoot: string; layout: ProfileStorageLayout; payloadRoot: string; componentId: ArchiveComponentId; baseRoot: string }): Promise<number> {
  const document = await selectedDocument(input.scan, input.incomingRoot, `components/${input.componentId}/index.json`)
  const references = Array.isArray(document.blobs) ? document.blobs : Array.isArray(document.files) ? document.files : []
  for (const value of references) {
    const reference = value as Record<string, unknown>
    const workspaceId = typeof reference.workspaceId === 'string' ? reference.workspaceId : undefined
    const relativePath = normalizeArchivePath(String(reference.relativePath))
    const componentPrefix = `${input.componentId}/`
    const logicalPath = relativePath.startsWith(componentPrefix) ? relativePath.slice(componentPrefix.length) : relativePath
    const root = workspaceId ? join(input.layout.workspaceOverlaysRoot, workspaceId, input.baseRoot) : input.baseRoot
    const finalPath = contained(root, join(root, ...normalizeArchivePath(logicalPath).split('/')))
    await copyBlob(input.incomingRoot, String(reference.digest), stagePath(input.layout, input.payloadRoot, finalPath))
  }
  return references.length
}

async function applyArtifacts(scan: ScannedProfileArchive, incomingRoot: string, layout: ProfileStorageLayout, payloadRoot: string, includeBlobs: boolean): Promise<number> {
  const document = await selectedDocument(scan, incomingRoot, 'components/artifacts.index/index.json')
  const fallbackWorkspaceId = unassociatedWorkspaceId(scan)
  const artifacts: Record<string, unknown>[] = []
  for (const value of Array.isArray(document.artifacts) ? document.artifacts : []) {
    const artifact = value as Record<string, unknown>
    const workspaceId = importedWorkspaceId(artifact.workspaceId, fallbackWorkspaceId)
    const blob = artifact.blob && typeof artifact.blob === 'object' ? artifact.blob as Record<string, unknown> : undefined
    const finalPath = includeBlobs && typeof blob?.digest === 'string'
      ? join(layout.workspaceOverlaysRoot, workspaceId, 'artifacts', blob.digest, basename(String(artifact.name || 'artifact')))
      : join(layout.workspaceOverlaysRoot, workspaceId, 'artifacts', 'missing', `${artifact.id || randomUUID()}`)
    if (includeBlobs && typeof blob?.digest === 'string') await copyBlob(incomingRoot, blob.digest, stagePath(layout, payloadRoot, finalPath))
    artifacts.push({ ...artifact, workspacePath: unboundWorkspacePath(workspaceId), path: finalPath, available: includeBlobs && typeof blob?.digest === 'string' })
  }
  await writeProfileFile(layout, payloadRoot, layout.artifactsPath, { schemaVersion: 1, artifacts })
  return artifacts.length
}

async function applyMcp(scan: ScannedProfileArchive, incomingRoot: string, layout: ProfileStorageLayout, payloadRoot: string): Promise<number> {
  const document = await selectedDocument(scan, incomingRoot, 'components/mcp.configurations/configurations.json')
  const configurations = document.configurations && typeof document.configurations === 'object' ? document.configurations as Record<string, unknown> : {}
  const servers = configurations.mcpServers && typeof configurations.mcpServers === 'object' ? configurations.mcpServers as Record<string, unknown> : {}
  const disabled = Object.fromEntries(Object.entries(servers).map(([name, value]) => [name, { ...(value as Record<string, unknown>), enabled: false }]))
  await writeProfileFile(layout, payloadRoot, layout.settingsPath, { schemaVersion: 1, mcpServers: disabled })
  return Object.keys(disabled).length
}

async function rebuildPluginIndex(layout: ProfileStorageLayout, payloadRoot: string, now: number): Promise<number> {
  const stagedRoot = stagePath(layout, payloadRoot, layout.pluginsRoot)
  const records: Record<string, unknown>[] = []
  for (const entry of await readdir(stagedRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    try {
      const manifest = await readJson(join(stagedRoot, entry.name, 'plugin.json'))
      if (typeof manifest.id !== 'string') continue
      records.push({ id: manifest.id, path: join(layout.pluginsRoot, entry.name), source: 'local', enabled: false, approvedPermissions: [], installedAt: now, updatedAt: now })
    } catch {}
  }
  await writeProfileFile(layout, payloadRoot, layout.pluginsIndexPath, { schemaVersion: 1, plugins: records })
  return records.length
}

async function validateProfilePayload(root: string): Promise<void> {
  const summary = await scanTreeNoLinks(root)
  if (summary.files > 50_000 || summary.bytes > 64 * 1024 * 1024 * 1024) throw new ProfileArchiveError('ARCHIVE_RESOURCE_LIMIT', '导入资料超出安全限制。', '请减少组件后重试。')
}

export class ProfileArchiveImporter {
  private readonly now: () => number
  private readonly createId: () => string
  readonly journalRoot: string

  constructor(private readonly options: ProfileArchiveImporterOptions) {
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
    this.journalRoot = join(options.registry.dataRoot, 'imports', 'transactions')
  }

  async inspect(path: string, password?: string | Uint8Array): Promise<ProfileArchivePreview> {
    return (await scanProfileArchive({ path, password })).preview
  }

  plan(path: string, preview: ProfileArchivePreview, input: ImportSelectionInput): PreparedProfileImportPlan {
    if (preview.archiveId !== input.archiveId) throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '导入预览已过期。', '请重新选择资料包。')
    const available = new Set(preview.components.map(component => component.id))
    const selectedComponents = [...new Set(input.selectedComponents)].filter(component => available.has(component)).sort()
    const blockers: ProfileImportPlan['blockers'] = []
    if (selectedComponents.length === 0) blockers.push({ code: 'ARCHIVE_COMPONENT_INVALID', message: '至少选择一个组件。', action: '请返回内容步骤选择要导入的数据。' })
    for (const component of preview.components.filter(candidate => selectedComponents.includes(candidate.id))) {
      for (const required of component.requiredComponents ?? []) {
        if (selectedComponents.includes(required)) continue
        blockers.push({
          code: 'ARCHIVE_COMPONENT_INVALID',
          message: `${component.id} 依赖 ${required}。`,
          action: `请同时选择 ${required}，或取消 ${component.id}。`,
        })
      }
    }
    const selected = preview.components.filter(component => selectedComponents.includes(component.id))
    const skippedComponents = preview.components.map(component => component.id).filter(component => !selectedComponents.includes(component))
    const count = (id: ArchiveComponentId) => selected.find(component => component.id === id)?.itemCount ?? 0
    const logicalBytes = selected.reduce((sum, component) => sum + component.logicalBytes, 0)
    return {
      planId: `import-plan-${this.createId()}`,
      sourcePath: path,
      archiveId: preview.archiveId,
      selectedComponents,
      skippedComponents,
      displayName: safeDisplayName(input.displayName),
      itemCount: selected.reduce((sum, component) => sum + component.itemCount, 0),
      logicalBytes,
      requiredDiskBytes: Math.ceil(logicalBytes * 1.2 + 32 * 1024 * 1024),
      disabled: {
        automations: count('automations'),
        skills: count('skills.user'),
        plugins: count('plugins.packages'),
        mcpServers: count('mcp.configurations'),
      },
      unboundWorkspaceCount: preview.workspaces.length,
      warnings: [...preview.warnings],
      blockers,
      encrypted: preview.encrypted,
    }
  }

  async execute(input: {
    plan: PreparedProfileImportPlan
    password?: string | Uint8Array
    signal?: AbortSignal
    onProgress?: (phase: ArchiveOperationPhase, progress: number, message: string) => void
  }): Promise<ProfileImportResult> {
    if (input.plan.blockers.length) throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', input.plan.blockers[0]!.message, input.plan.blockers[0]!.action)
    const scan = await scanProfileArchive({ path: input.plan.sourcePath, password: input.password })
    if (scan.manifest.archiveId !== input.plan.archiveId) throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '资料包在确认后发生变化。', '请重新选择并预览资料包。')
    const transactionId = `import-${this.createId()}`
    const profileId = normalizeConversationV2Id('profile', this.createId())
    if (this.options.registry.has(profileId)) throw new Error('Generated profile identity already exists')
    const finalLayout = createProfileStorageLayout(this.options.registry.dataRoot, this.options.registry.deviceRoot, profileId)
    const stagingRoot = join(this.options.registry.profilesRoot, `.staging-${transactionId}`)
    const incomingRoot = join(stagingRoot, 'incoming')
    const profilePayloadRoot = join(stagingRoot, 'profile')
    const journalPath = join(this.journalRoot, `${transactionId}.json`)
    const journal: ImportJournal = {
      schemaVersion: 1,
      transactionId,
      phase: 'staging',
      profileId,
      stagingRoot,
      profilePayloadRoot,
      finalProfileRoot: finalLayout.profileRoot,
      archiveId: scan.manifest.archiveId,
      selectedComponents: [...input.plan.selectedComponents],
      createdAt: this.now(),
      updatedAt: this.now(),
    }
    await mkdir(this.journalRoot, { recursive: true, mode: 0o700 })
    const available = await statfs(this.options.registry.profilesRoot).then(info => Number(info.bavail) * Number(info.bsize), () => Number.POSITIVE_INFINITY)
    if (available < input.plan.requiredDiskBytes) throw new ProfileArchiveError('ARCHIVE_DISK_SPACE_LOW', '可用磁盘空间不足，尚未开始导入。', '请释放空间或减少导入组件。')
    await atomicJson(journalPath, journal)
    try {
      input.onProgress?.('staging', 0.25, '正在安全解压到临时资料…')
      await mkdir(profilePayloadRoot, { recursive: true, mode: 0o700 })
      await extractArchive({
        path: input.plan.sourcePath,
        password: input.password,
        targetRoot: incomingRoot,
        signal: input.signal,
        persistEntry: path => path.startsWith('blobs/sha256/'),
      })
      await this.afterPhase(journal, journalPath, 'staging')

      input.onProgress?.('migrating', 0.5, '正在迁移并禁用可执行内容…')
      const selected = new Set(input.plan.selectedComponents)
      const config: Record<string, unknown> = {}
      const timestamp = this.now()
      await applyWorkspaceBindings(scan, finalLayout, profilePayloadRoot, timestamp)
      if (selected.has('profile.preferences')) await applyProfilePreferences(scan, incomingRoot, finalLayout, profilePayloadRoot, config)
      if (selected.has('model.configurations')) await applyModelConfigurations(scan, incomingRoot, config)
      if (Object.keys(config).length) await writeProfileFile(finalLayout, profilePayloadRoot, finalLayout.configPath, config)
      if (selected.has('credentials')) {
        if (!this.options.protectCredentials) throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '目标设备无法保护导入凭据。', '请取消凭据组件后重试。')
        const document = await selectedDocument(scan, incomingRoot, 'components/credentials/credentials.json')
        const credentials = document.credentials ?? {}
        let protectedDocument: Buffer | undefined
        try {
          protectedDocument = await this.options.protectCredentials(credentials)
          const targetPath = stagePath(finalLayout, profilePayloadRoot, finalLayout.credentialsPath)
          await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
          await writeFile(targetPath, protectedDocument, { mode: 0o600, flag: 'wx' })
        } finally {
          protectedDocument?.fill(0)
          scrubSecretValue(credentials)
          scan.documents.delete('components/credentials/credentials.json')
          document.credentials = undefined
        }
      }
      if (selected.has('conversations')) await applyConversations(scan, incomingRoot, finalLayout, profilePayloadRoot)
      if (selected.has('projects')) await applyProjects(scan, incomingRoot, finalLayout, profilePayloadRoot)
      const disabledAutomations = selected.has('automations') ? await applyAutomations(scan, incomingRoot, finalLayout, profilePayloadRoot) : 0
      if (selected.has('memories')) await applyMemories(scan, incomingRoot, finalLayout, profilePayloadRoot)
      if (selected.has('attachments')) await applyBlobIndex({ scan, incomingRoot, layout: finalLayout, payloadRoot: profilePayloadRoot, componentId: 'attachments', baseRoot: 'attachments' })
      if (selected.has('runtime.transcripts')) await applyBlobIndex({ scan, incomingRoot, layout: finalLayout, payloadRoot: profilePayloadRoot, componentId: 'runtime.transcripts', baseRoot: '' })
      if (selected.has('captures')) await applyBlobIndex({ scan, incomingRoot, layout: finalLayout, payloadRoot: profilePayloadRoot, componentId: 'captures', baseRoot: '' })
      if (selected.has('artifacts.index')) await applyArtifacts(scan, incomingRoot, finalLayout, profilePayloadRoot, selected.has('artifacts.blobs'))
      const quarantinedSkills = selected.has('skills.user')
        ? await applyBlobIndex({
            scan,
            incomingRoot,
            layout: finalLayout,
            payloadRoot: profilePayloadRoot,
            componentId: 'skills.user',
            baseRoot: join(finalLayout.extensionsRoot, 'skills-review'),
          })
        : 0
      if (selected.has('plugins.packages')) await applyBlobIndex({ scan, incomingRoot, layout: finalLayout, payloadRoot: profilePayloadRoot, componentId: 'plugins.packages', baseRoot: finalLayout.pluginsRoot })
      if (selected.has('plugins.storage')) await applyBlobIndex({ scan, incomingRoot, layout: finalLayout, payloadRoot: profilePayloadRoot, componentId: 'plugins.storage', baseRoot: finalLayout.pluginStorageRoot })
      const disabledPlugins = selected.has('plugins.packages') ? await rebuildPluginIndex(finalLayout, profilePayloadRoot, timestamp) : 0
      const disabledMcp = selected.has('mcp.configurations') ? await applyMcp(scan, incomingRoot, finalLayout, profilePayloadRoot) : 0
      const profile: LocalProfileRecord = {
        schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION,
        id: profileId,
        displayName: input.plan.displayName,
        createdAt: timestamp,
        updatedAt: timestamp,
        state: 'ready',
        lock: { kind: 'none' },
        storageVersion: PROFILE_STORAGE_VERSION,
        importedFrom: { archiveId: scan.manifest.archiveId, sourceProfileId: scan.manifest.profile.sourceProfileId, importedAt: timestamp },
      }
      await atomicJson(stagePath(finalLayout, profilePayloadRoot, finalLayout.profileMetadataPath), profile)
      const receipt = {
        schemaVersion: 1,
        archiveId: scan.manifest.archiveId,
        source: scan.manifest.source,
        importedAt: timestamp,
        profileId,
        selectedComponents: input.plan.selectedComponents,
        skippedComponents: input.plan.skippedComponents,
        migrations: scan.manifest.conversationData?.migrationSources ?? [],
        conversationData: scan.manifest.conversationData ? {
          sourceVersion: scan.manifest.conversationData.schemaVersion,
          eventSegments: structuredClone(scan.manifest.conversationData.eventSegments),
          projectionsRebuilt: selected.has('conversations'),
        } : undefined,
        disabled: { automations: disabledAutomations, skills: quarantinedSkills, plugins: disabledPlugins, mcpServers: disabledMcp },
        unboundWorkspaces: scan.preview.workspaces.length,
        warnings: input.plan.warnings.map(warning => ({ code: warning.code, message: warning.message })),
      }
      const receiptPath = join(profilePayloadRoot, 'import-receipt.json')
      await atomicJson(receiptPath, receipt)
      await rm(incomingRoot, { recursive: true, force: true })

      input.onProgress?.('validating', 0.72, '正在验证资料引用与权限…')
      await validateProfilePayload(profilePayloadRoot)
      journal.phase = 'validated'; journal.updatedAt = this.now(); await atomicJson(journalPath, journal)
      await this.afterPhase(journal, journalPath, 'validated')

      input.onProgress?.('committing', 0.88, '正在原子提交新资料…')
      if (await stat(finalLayout.profileRoot).then(() => true, () => false)) throw new Error('Target profile root already exists')
      journal.phase = 'committing'; journal.updatedAt = this.now(); await atomicJson(journalPath, journal)
      await this.afterPhase(journal, journalPath, 'committing')
      await rename(profilePayloadRoot, finalLayout.profileRoot)
      journal.phase = 'directory_committed'; journal.updatedAt = this.now(); await atomicJson(journalPath, journal)
      await this.afterPhase(journal, journalPath, 'directory_committed')

      const registered = this.options.registry.registerExisting(profileId)
      journal.phase = 'registered'; journal.updatedAt = this.now(); await atomicJson(journalPath, journal)
      await this.afterPhase(journal, journalPath, 'registered')
      await rm(stagingRoot, { recursive: true, force: true })
      await rm(journalPath, { force: true })
      return { profile: registered, receiptPath: join(finalLayout.profileRoot, 'import-receipt.json'), warnings: input.plan.warnings }
    } catch (error) {
      if (error instanceof SimulatedImportInterruption) throw error
      if (journal.phase === 'directory_committed' || journal.phase === 'registered'
        || await stat(finalLayout.profileRoot).then(info => info.isDirectory(), () => false)) throw error
      await rm(stagingRoot, { recursive: true, force: true })
      await rm(journalPath, { force: true })
      throw error
    }
  }

  async recoverTransactions(): Promise<Array<{ transactionId: string; outcome: 'committed' | 'rolled_back' }>> {
    const outcomes: Array<{ transactionId: string; outcome: 'committed' | 'rolled_back' }> = []
    for (const entry of await readdir(this.journalRoot, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const journalPath = join(this.journalRoot, entry.name)
      let journal: ImportJournal
      try { journal = JSON.parse(await readFile(journalPath, 'utf8')) as ImportJournal } catch { continue }
      if (journal.phase === 'directory_committed' || journal.phase === 'registered'
        || (journal.phase === 'committing' && await stat(journal.finalProfileRoot).then(info => info.isDirectory(), () => false))) {
        if (!this.options.registry.has(journal.profileId) && await stat(journal.finalProfileRoot).then(info => info.isDirectory(), () => false)) {
          this.options.registry.registerExisting(journal.profileId)
        }
        await rm(journal.stagingRoot, { recursive: true, force: true })
        await rm(journalPath, { force: true })
        outcomes.push({ transactionId: journal.transactionId, outcome: 'committed' })
      } else {
        await rm(journal.stagingRoot, { recursive: true, force: true })
        await rm(journalPath, { force: true })
        outcomes.push({ transactionId: journal.transactionId, outcome: 'rolled_back' })
      }
    }
    return outcomes
  }

  private async afterPhase(journal: ImportJournal, journalPath: string, phase: ImportJournalPhase): Promise<void> {
    if (journal.phase !== phase) {
      journal.phase = phase
      journal.updatedAt = this.now()
      await atomicJson(journalPath, journal)
    }
    if (this.options.faultAfterPhase === phase) throw new SimulatedImportInterruption(`Simulated interruption after ${phase}`)
  }
}
