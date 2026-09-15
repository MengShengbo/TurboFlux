import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, readFile, readdir, stat } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { ConversationStore } from '../../conversations/store'
import { ConversationEventStoreV2 } from '../../conversations/conversationEventStoreV2'
import { ConversationInteractionStoreV2 } from '../../conversations/conversationInteractionStoreV2'
import type { ConversationDraftState, PersistedConversation } from '../../conversations/types'
import { WorkspaceBindingService, type WorkspaceBindingRecord } from '../workspaceBindingService'
import type { LocalProfileRecord, ProfileStorageLayout } from '../types'
import { canonicalJsonBytes } from './canonicalJson'
import { ArchiveBlobStore, type ArchiveBlobReference } from './blobStore'
import { redactExportText, redactExportValue, type ExportRedactionPolicy } from './redaction'
import {
  ProfileArchiveError,
  type ArchiveConversationDataDescriptorV2,
  type ArchiveConversationMigrationSource,
  type ArchiveComponentDescriptor,
  type ArchiveComponentId,
  type ArchiveEntryInput,
  type ArchiveSensitivity,
} from './types'

export interface ArchiveComponentDefinition {
  id: ArchiveComponentId
  defaultSelected: boolean
  sensitivity: ArchiveSensitivity
  description: string
  requiresEncryption: boolean
}

export const ARCHIVE_COMPONENT_DEFINITIONS: ArchiveComponentDefinition[] = [
  { id: 'profile.preferences', defaultSelected: true, sensitivity: 'normal', description: '资料名称、个性化与安全偏好', requiresEncryption: false },
  { id: 'conversations', defaultSelected: true, sensitivity: 'private', description: '会话、消息与已完成的工作记录', requiresEncryption: false },
  { id: 'model.configurations', defaultSelected: true, sensitivity: 'private', description: '模型、服务地址与推理偏好，不含密钥', requiresEncryption: false },
  { id: 'credentials', defaultSelected: false, sensitivity: 'secret', description: '保存在 TurboFlux 中的模型密钥', requiresEncryption: true },
  { id: 'projects', defaultSelected: true, sensitivity: 'private', description: '项目索引与工作区身份，不含本机路径', requiresEncryption: false },
  { id: 'automations', defaultSelected: false, sensitivity: 'executable', description: '自动化定义；导入后保持禁用', requiresEncryption: false },
  { id: 'memories', defaultSelected: true, sensitivity: 'private', description: '各工作区的用户私有记忆', requiresEncryption: false },
  { id: 'attachments', defaultSelected: false, sensitivity: 'private', description: '会话附件 Blob，可能较大', requiresEncryption: false },
  { id: 'artifacts.index', defaultSelected: true, sensitivity: 'private', description: '成果名称、类型与关联索引', requiresEncryption: false },
  { id: 'artifacts.blobs', defaultSelected: false, sensitivity: 'private', description: '成果文件 Blob，可能较大', requiresEncryption: false },
  { id: 'skills.user', defaultSelected: false, sensitivity: 'executable', description: '用户安装的 Skills，导入后等待检查', requiresEncryption: false },
  { id: 'plugins.packages', defaultSelected: false, sensitivity: 'executable', description: '插件程序包，导入后保持禁用', requiresEncryption: false },
  { id: 'plugins.storage', defaultSelected: false, sensitivity: 'secret', description: '插件私有数据，可能包含 Token', requiresEncryption: true },
  { id: 'mcp.configurations', defaultSelected: false, sensitivity: 'executable', description: 'MCP 定义，内联秘密会被移除', requiresEncryption: false },
  { id: 'runtime.transcripts', defaultSelected: false, sensitivity: 'private', description: '只读运行记录，不恢复活动执行', requiresEncryption: false },
  { id: 'captures', defaultSelected: false, sensitivity: 'private', description: 'Browser 与 Computer 捕获内容', requiresEncryption: false },
]

export interface ComponentSnapshot {
  descriptor: ArchiveComponentDescriptor
  entries: ArchiveEntryInput[]
  warnings: string[]
  conversationData?: ArchiveConversationDataDescriptorV2
}

export interface ArchiveComponentExporter {
  definition: ArchiveComponentDefinition
  estimate(context: ExportComponentContext, selectedComponents: ReadonlySet<ArchiveComponentId>): Promise<ArchiveComponentDescriptor>
  snapshot(context: ExportComponentContext, selectedComponents: ReadonlySet<ArchiveComponentId>): Promise<ComponentSnapshot>
  serialize(snapshot: ComponentSnapshot): ArchiveEntryInput[]
}

export interface ExportComponentContext {
  profile: LocalProfileRecord
  layout: ProfileStorageLayout
  conversationDataVersion: 1 | 2
  workspaces: WorkspaceBindingRecord[]
  excludedWorkspacePaths: ReadonlySet<string>
  redaction: ExportRedactionPolicy
  blobs: ArchiveBlobStore
  conversationIds?: Set<string>
  credentialReader?: () => Promise<unknown> | unknown
}

function comparablePath(path: string): string {
  const normalized = resolve(path).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function jsonEntry(path: string, value: unknown): ArchiveEntryInput {
  const data = canonicalJsonBytes(value)
  return { path, data, size: data.length, digest: digest(data) }
}

async function readJson(path: string, fallback: unknown): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) as unknown } catch { return structuredClone(fallback) }
}

function workspaceForPath(path: string | undefined, workspaces: WorkspaceBindingRecord[]): WorkspaceBindingRecord | undefined {
  if (!path) return undefined
  if (path.startsWith('turboflux-unbound:')) {
    const workspaceId = path.slice('turboflux-unbound:'.length)
    return workspaces.find(workspace => workspace.id === workspaceId)
  }
  const normalized = resolve(path)
  return workspaces.find(workspace => workspace.localPath && resolve(workspace.localPath) === normalized)
}

function stripConversationRuntime(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripConversationRuntime)
  if (!value || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:pendingApprovals|approvalRequests|activeToolCalls|activeRuns|abortController|queuedInputs|pendingSteering|steeringInputs|lease|processId|pid)$/u.test(key)) continue
    if (key === 'queue' || key === 'runtime') continue
    result[key] = stripConversationRuntime(child)
  }
  if (typeof result.status === 'string' && ['pending', 'running', 'waiting', 'paused', 'starting', 'stopping'].includes(result.status)) {
    result.status = 'partial'
    result.importedInterrupted = true
  }
  return result
}

function conversationSnapshot(conversation: PersistedConversation, context: ExportComponentContext): unknown {
  const workspace = workspaceForPath(conversation.workspacePath, context.workspaces)
  const stripped = stripConversationRuntime(structuredClone(conversation)) as Record<string, unknown>
  stripped.workspaceId = workspace?.id
  delete stripped.workspacePath
  return redactExportValue(stripped, context.redaction)
}

function portableDraft(draft: ConversationDraftState, context: ExportComponentContext): ConversationDraftState {
  const result: ConversationDraftState = { text: redactExportText(draft.text, context.redaction) }
  if (draft.pendingPastes?.length) {
    result.pendingPastes = draft.pendingPastes.map(paste => ({
      placeholder: redactExportText(paste.placeholder, context.redaction),
      text: redactExportText(paste.text, context.redaction),
    }))
  }
  if (draft.capabilities) {
    result.capabilities = redactExportValue(draft.capabilities, context.redaction) as ConversationDraftState['capabilities']
  }
  return result
}

function hasPortableDraft(draft: ConversationDraftState): boolean {
  return draft.text.length > 0 || Boolean(draft.pendingPastes?.length) || draft.capabilities !== undefined
}

function descriptor(definition: ArchiveComponentDefinition, entries: ArchiveEntryInput[], itemCount: number, blobCount = 0): ArchiveComponentDescriptor {
  return {
    id: definition.id,
    schemaVersion: 1,
    itemCount,
    logicalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    blobCount,
    sensitivity: definition.sensitivity,
  }
}

async function walkFiles(root: string, limits: { files: number; bytes: number }): Promise<Array<{ path: string; relativePath: string; size: number }>> {
  if (!existsSync(root)) return []
  const files: Array<{ path: string; relativePath: string; size: number }> = []
  let totalBytes = 0
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new ProfileArchiveError('ARCHIVE_UNSAFE_ENTRY', '导出内容包含符号链接。', '请移除链接或取消选择该组件。')
      if (info.isDirectory()) await visit(path)
      else if (info.isFile()) {
        if (info.nlink > 1) throw new ProfileArchiveError('ARCHIVE_UNSAFE_ENTRY', '导出内容包含硬链接。', '请复制为独立文件后重试。')
        files.push({ path, relativePath: relative(root, path).split(sep).join('/'), size: info.size })
        totalBytes += info.size
        if (files.length > limits.files || totalBytes > limits.bytes) {
          throw new ProfileArchiveError('ARCHIVE_RESOURCE_LIMIT', '所选组件超出首发容量限制。', '请减少文件数量或取消大型组件。')
        }
      } else throw new ProfileArchiveError('ARCHIVE_UNSAFE_ENTRY', '导出内容包含不支持的文件类型。', '请取消选择该组件。')
    }
  }
  await visit(root)
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

async function snapshotProfilePreferences(context: ExportComponentContext, definition: ArchiveComponentDefinition): Promise<ComponentSnapshot> {
  const persona = redactExportValue(await readJson(context.layout.personaPath, {}), context.redaction)
  const config = await readJson(context.layout.configPath, {}) as Record<string, unknown>
  const preferences = redactExportValue({
    profile: { displayName: context.profile.displayName, avatar: context.profile.avatar, createdAt: context.profile.createdAt },
    persona,
    behavior: {
      approvalPolicy: config.approvalPolicy,
      capabilityProfile: config.capabilityProfile,
      gitEnabled: config.gitEnabled,
    },
  }, context.redaction)
  const entries = [jsonEntry('components/profile.preferences/preferences.json', { schemaVersion: 1, ...preferences as object })]
  return { descriptor: descriptor(definition, entries, 1), entries, warnings: [] }
}

async function snapshotConversations(context: ExportComponentContext, definition: ArchiveComponentDefinition): Promise<ComponentSnapshot> {
  const eventRoot = join(context.layout.conversationsV2Root, 'events')
  if (context.conversationDataVersion === 2) {
    if (!existsSync(eventRoot)) {
      throw new ProfileArchiveError(
        'ARCHIVE_COMPONENT_INVALID',
        'Conversation V2 事件目录不存在，已停止导出以避免静默回退旧格式。',
        '请先完成会话迁移，或使用只读 Legacy Recovery Export。',
      )
    }
    const eventStore = new ConversationEventStoreV2(eventRoot)
    const interactionStore = new ConversationInteractionStoreV2(context.layout.interactionRoot, context.profile.id)
    const files = (await readdir(eventRoot, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
      .sort((left, right) => left.name.localeCompare(right.name))
    const entries: ArchiveEntryInput[] = []
    const index: Array<{ id: string; path: string; interactionPath?: string; eventCount: number; lastSeq: number }> = []
    const migrationSources = new Set<ArchiveConversationMigrationSource>()
    const eventIds = new Set<string>()
    let eventCount = 0
    for (const file of files) {
      const id = file.name.slice(0, -'.jsonl'.length)
      if (context.conversationIds && !context.conversationIds.has(id)) continue
      const events = eventStore.readAll(id)
      eventCount += events.length
      for (const event of events) {
        if (event.profileId !== context.profile.id || eventIds.has(event.eventId)) {
          throw new ProfileArchiveError(
            'ARCHIVE_COMPONENT_INVALID',
            'Conversation V2 事件身份冲突，已停止导出以避免生成无法恢复的资料包。',
            '请使用 Recovery Export 保存原始数据，并检查会话事件完整性。',
          )
        }
        eventIds.add(event.eventId)
        if (event.provenance === 'migrated' || event.legacyEventId) migrationSources.add('legacy-v1')
        if (event.provenance === 'imported') migrationSources.add('profile-archive-v2')
        if (event.provenance === 'restored' || event.source === 'recovery') migrationSources.add('recovery')
      }
      const path = `components/conversations/events/${encodeURIComponent(id)}.json`
      entries.push(jsonEntry(path, { schemaVersion: 2, conversationId: id, events }))
      const draft = portableDraft(interactionStore.load(id).draft, context)
      const interactionPath = hasPortableDraft(draft)
        ? `components/conversations/interactions/${encodeURIComponent(id)}.json`
        : undefined
      if (interactionPath) entries.push(jsonEntry(interactionPath, { schemaVersion: 1, conversationId: id, draft }))
      index.push({ id, path, ...(interactionPath ? { interactionPath } : {}), eventCount: events.length, lastSeq: events.at(-1)?.seq ?? 0 })
    }
    entries.unshift(jsonEntry('components/conversations/index.json', { schemaVersion: 2, items: index, projectionsIncluded: false }))
    return {
      descriptor: { ...descriptor(definition, entries, index.length), schemaVersion: 2 },
      entries,
      warnings: ['会话以 Conversation V2 事实事件导出；仅迁移安全草稿，可重建索引、输入队列、steering、审批和运行缓存不会进入资料包。'],
      conversationData: {
        schemaVersion: 2,
        eventSegments: {
          format: 'per-conversation-json',
          indexPath: 'components/conversations/index.json',
          segmentCount: index.length,
          eventCount,
        },
        projections: { included: false, rebuildRequired: true },
        migrationSources: [...migrationSources].sort(),
      },
    }
  }
  if (context.conversationDataVersion !== 1) throw new Error('Unsupported conversation data version')
  const store = new ConversationStore(context.layout.conversationsRoot)
  const metas = await store.listAsync()
  const selected = context.conversationIds ? metas.filter(meta => context.conversationIds!.has(meta.id)) : metas
  const entries: ArchiveEntryInput[] = []
  const index: Array<{ id: string; path: string; title?: string; updatedAt?: number }> = []
  const warnings: string[] = []
  for (const meta of selected) {
    const conversation = await store.loadAsync(meta.id)
    if (!conversation) {
      warnings.push(`会话 ${meta.id} 无法读取，已跳过。`)
      continue
    }
    const path = `components/conversations/items/${encodeURIComponent(meta.id)}.json`
    entries.push(jsonEntry(path, { schemaVersion: 1, conversation: conversationSnapshot(conversation, context) }))
    index.push({ id: meta.id, path, title: redactExportText(meta.title || '', context.redaction), updatedAt: meta.updatedAt })
  }
  entries.unshift(jsonEntry('components/conversations/index.json', { schemaVersion: 1, items: index }))
  return { descriptor: descriptor(definition, entries, index.length), entries, warnings }
}

async function snapshotModelConfigurations(context: ExportComponentContext, definition: ArchiveComponentDefinition): Promise<ComponentSnapshot> {
  const config = await readJson(context.layout.configPath, {}) as Record<string, unknown>
  const redacted = redactExportValue({ ...config, apiKey: '', apiConfigs: Array.isArray(config.apiConfigs)
    ? config.apiConfigs.map(item => ({ ...(item as Record<string, unknown>), apiKey: '' }))
    : [] }, { ...context.redaction, allowSecrets: false })
  const entries = [jsonEntry('components/model.configurations/configurations.json', { schemaVersion: 1, config: redacted })]
  return { descriptor: descriptor(definition, entries, Array.isArray(config.apiConfigs) ? config.apiConfigs.length : 1), entries, warnings: [] }
}

async function snapshotCredentials(context: ExportComponentContext, definition: ArchiveComponentDefinition): Promise<ComponentSnapshot> {
  if (!context.credentialReader) {
    const entries = [jsonEntry('components/credentials/credentials.json', { schemaVersion: 1, credentials: {} })]
    return { descriptor: descriptor(definition, entries, 0), entries, warnings: ['当前平台无法读取受保护凭据，已导出空凭据组件。'] }
  }
  const credentials = await context.credentialReader()
  const entries = [jsonEntry('components/credentials/credentials.json', { schemaVersion: 1, credentials })]
  const count = credentials && typeof credentials === 'object' ? Object.keys(credentials as object).length : 0
  return { descriptor: descriptor(definition, entries, count), entries, warnings: [] }
}

async function snapshotProjects(context: ExportComponentContext, definition: ArchiveComponentDefinition): Promise<ComponentSnapshot> {
  const raw = await readJson(context.layout.projectsPath, { schemaVersion: 1, projects: [] }) as Record<string, unknown>
  const projects = (Array.isArray(raw.projects) ? raw.projects : []).filter(item => {
    const project = item as Record<string, unknown>
    return typeof project.path !== 'string' || !context.excludedWorkspacePaths.has(comparablePath(project.path))
  }).map(item => {
    const project = item as Record<string, unknown>
    const workspace = workspaceForPath(typeof project.path === 'string' ? project.path : undefined, context.workspaces)
    return redactExportValue({
      id: project.id,
      workspaceId: workspace?.id,
      name: project.name,
      pinned: project.pinned,
      tags: project.tags,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      lastOpenedAt: project.lastOpenedAt,
      lastConversationId: project.lastConversationId,
    }, context.redaction)
  })
  const entries = [jsonEntry('components/projects/projects.json', { schemaVersion: 1, projects })]
  return { descriptor: descriptor(definition, entries, projects.length), entries, warnings: [] }
}

function inactiveAutomation(value: unknown, policy: ExportRedactionPolicy): unknown {
  const stripRuntime = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(stripRuntime)
    if (!candidate || typeof candidate !== 'object') return candidate
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      if (/^(?:activeRun|activeRunId|activeRuns|pendingApproval|pendingApprovals|pendingRunAt|nextRunAt|lease|processId|pid|retryAt|retryTimer|runQueue)$/u.test(key)) continue
      result[key] = stripRuntime(child)
    }
    return result
  }
  const automation = redactExportValue(stripRuntime(value), policy) as Record<string, unknown>
  automation.enabled = false
  if ('status' in automation) automation.status = 'paused'
  if (Array.isArray(automation.history)) {
    automation.history = automation.history.slice(0, 20).map(item => {
      const history = item as Record<string, unknown>
      return { id: history.id, status: history.status, startedAt: history.startedAt, completedAt: history.completedAt, summary: history.summary }
    })
  }
  return automation
}

async function snapshotAutomations(context: ExportComponentContext, definition: ArchiveComponentDefinition): Promise<ComponentSnapshot> {
  const raw = await readJson(context.layout.automationsPath, { schemaVersion: 1, automations: [] }) as Record<string, unknown>
  const automations = (Array.isArray(raw.automations) ? raw.automations : []).map(item => {
    const source = item as Record<string, unknown>
    const workspace = workspaceForPath(typeof source.workspacePath === 'string' ? source.workspacePath : undefined, context.workspaces)
    const automation = inactiveAutomation(item, context.redaction) as Record<string, unknown>
    if (workspace) automation.workspaceId = workspace.id
    delete automation.workspacePath
    delete automation.workspaceRef
    return automation
  })
  const entries = [jsonEntry('components/automations/automations.json', { schemaVersion: 1, automations, importedEnabled: false })]
  return { descriptor: descriptor(definition, entries, automations.length), entries, warnings: automations.length ? ['所有自动化在导入后保持禁用，且不携带活动租约。'] : [] }
}

async function snapshotMemories(context: ExportComponentContext, definition: ArchiveComponentDefinition): Promise<ComponentSnapshot> {
  const items: Array<{ workspaceId: string; relativePath: string; content: string }> = []
  for (const workspace of context.workspaces) {
    const memoryRoot = join(context.layout.workspaceOverlaysRoot, workspace.id, 'memory')
    for (const file of await walkFiles(memoryRoot, { files: 10_000, bytes: 512 * 1024 * 1024 })) {
      const content = await readFile(file.path, 'utf8').catch(() => '')
      items.push({ workspaceId: workspace.id, relativePath: file.relativePath, content: redactExportText(content, context.redaction) })
    }
  }
  const entries = [jsonEntry('components/memories/index.json', { schemaVersion: 1, items })]
  return { descriptor: descriptor(definition, entries, items.length), entries, warnings: [] }
}

async function addDirectoryBlobs(context: ExportComponentContext, rootName: string, roots: Array<{ workspaceId?: string; root: string; prefix?: string }>, limits: { files: number; bytes: number }): Promise<{ references: Array<ArchiveBlobReference & { workspaceId?: string; relativePath: string }>; blobCount: number }> {
  const references: Array<ArchiveBlobReference & { workspaceId?: string; relativePath: string }> = []
  const before = context.blobs.count
  for (const source of roots) {
    for (const file of await walkFiles(source.root, limits)) {
      const reference = await context.blobs.addFile(file.path, basename(file.relativePath))
      references.push({ ...reference, workspaceId: source.workspaceId, relativePath: [rootName, source.prefix, file.relativePath].filter(Boolean).join('/') })
    }
  }
  return { references, blobCount: context.blobs.count - before }
}

async function snapshotOverlayBlobs(context: ExportComponentContext, definition: ArchiveComponentDefinition, directories: string[]): Promise<ComponentSnapshot> {
  const roots = context.workspaces.flatMap(workspace => directories.map(directory => ({
    workspaceId: workspace.id,
    root: join(context.layout.workspaceOverlaysRoot, workspace.id, directory),
    prefix: directory === definition.id ? undefined : directory,
  })))
  const result = await addDirectoryBlobs(context, definition.id, roots, { files: 20_000, bytes: 16 * 1024 * 1024 * 1024 })
  const entries = [jsonEntry(`components/${definition.id}/index.json`, { schemaVersion: 1, blobs: result.references })]
  return { descriptor: descriptor(definition, entries, result.references.length, result.blobCount), entries, warnings: [] }
}

async function snapshotArtifactsIndex(context: ExportComponentContext, definition: ArchiveComponentDefinition, includeBlobs: boolean): Promise<ComponentSnapshot> {
  const raw = await readJson(context.layout.artifactsPath, { schemaVersion: 1, artifacts: [] }) as Record<string, unknown>
  const artifacts: unknown[] = []
  let blobCount = 0
  for (const value of Array.isArray(raw.artifacts) ? raw.artifacts : []) {
    const artifact = value as Record<string, unknown>
    const workspace = workspaceForPath(typeof artifact.workspacePath === 'string' ? artifact.workspacePath : undefined, context.workspaces)
    let blob: ArchiveBlobReference | undefined
    if (includeBlobs && typeof artifact.path === 'string' && existsSync(artifact.path)) {
      const before = context.blobs.count
      blob = await context.blobs.addFile(artifact.path, String(artifact.name || basename(artifact.path)), typeof artifact.mime === 'string' ? artifact.mime : undefined)
      blobCount += context.blobs.count - before
    }
    artifacts.push(redactExportValue({
      id: artifact.id, name: artifact.name, workspaceId: workspace?.id, kind: artifact.kind, mime: artifact.mime,
      size: artifact.size, source: artifact.source, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt,
      conversationId: artifact.conversationId, taskId: artifact.taskId, metadata: artifact.metadata,
      blob: blob ?? { missing: true, reason: includeBlobs ? 'unavailable' : 'not-selected' },
    }, context.redaction))
  }
  const entries = [jsonEntry('components/artifacts.index/index.json', { schemaVersion: 1, artifacts })]
  return { descriptor: descriptor(definition, entries, artifacts.length, blobCount), entries, warnings: [] }
}

async function snapshotPackageDirectory(context: ExportComponentContext, definition: ArchiveComponentDefinition, root: string): Promise<ComponentSnapshot> {
  const result = await addDirectoryBlobs(context, definition.id, [{ root }], { files: 5_000, bytes: 1024 * 1024 * 1024 })
  const entries = [jsonEntry(`components/${definition.id}/index.json`, { schemaVersion: 1, files: result.references, importedEnabled: false, needsReview: true })]
  return { descriptor: descriptor(definition, entries, result.references.length, result.blobCount), entries, warnings: result.references.length ? ['可执行内容在导入后保持禁用并等待检查。'] : [] }
}

async function snapshotMcp(context: ExportComponentContext, definition: ArchiveComponentDefinition): Promise<ComponentSnapshot> {
  const raw = await readJson(context.layout.settingsPath, {}) as Record<string, unknown>
  const sourceServers = raw.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers)
    ? raw.mcpServers as Record<string, unknown>
    : {}
  const mcpServers = Object.fromEntries(Object.entries(sourceServers).map(([name, value]) => [
    name,
    { ...(value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}), enabled: false },
  ]))
  const configurations = redactExportValue({ mcpServers }, { ...context.redaction, allowSecrets: false })
  const entries = [jsonEntry('components/mcp.configurations/configurations.json', { schemaVersion: 1, configurations, importedEnabled: false })]
  const count = Object.keys(sourceServers).length
  return { descriptor: descriptor(definition, entries, count), entries, warnings: count ? ['MCP 在导入后保持断开，内联秘密已移除。'] : [] }
}

export async function snapshotArchiveComponent(
  componentId: ArchiveComponentId,
  context: ExportComponentContext,
  selectedComponents: ReadonlySet<ArchiveComponentId>,
): Promise<ComponentSnapshot> {
  const definition = ARCHIVE_COMPONENT_DEFINITIONS.find(item => item.id === componentId)
  if (!definition) throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', `未知导出组件：${componentId}`, '请刷新后重新选择导出内容。')
  switch (componentId) {
    case 'profile.preferences': return snapshotProfilePreferences(context, definition)
    case 'conversations': return snapshotConversations(context, definition)
    case 'model.configurations': return snapshotModelConfigurations(context, definition)
    case 'credentials': return snapshotCredentials(context, definition)
    case 'projects': return snapshotProjects(context, definition)
    case 'automations': return snapshotAutomations(context, definition)
    case 'memories': return snapshotMemories(context, definition)
    case 'attachments': return snapshotOverlayBlobs(context, definition, ['attachments'])
    case 'artifacts.index': return snapshotArtifactsIndex(context, definition, selectedComponents.has('artifacts.blobs'))
    case 'artifacts.blobs': {
      const entries = [jsonEntry('components/artifacts.blobs/index.json', { schemaVersion: 1, providedBy: 'artifacts.index' })]
      return { descriptor: descriptor(definition, entries, 0, 0), entries, warnings: [] }
    }
    case 'skills.user': return snapshotPackageDirectory(context, definition, context.layout.userSkillsRoot)
    case 'plugins.packages': return snapshotPackageDirectory(context, definition, context.layout.pluginsRoot)
    case 'plugins.storage': return snapshotPackageDirectory(context, definition, context.layout.pluginStorageRoot)
    case 'mcp.configurations': return snapshotMcp(context, definition)
    case 'runtime.transcripts': return snapshotOverlayBlobs(context, definition, ['runtime/sessions', 'runtime/runtime-logs'])
    case 'captures': return snapshotOverlayBlobs(context, definition, ['browser', 'computer'])
  }
}

export class ArchiveComponentRegistry {
  list(): ArchiveComponentDefinition[] {
    return ARCHIVE_COMPONENT_DEFINITIONS.map(definition => ({ ...definition }))
  }

  get(componentId: ArchiveComponentId): ArchiveComponentExporter {
    const definition = ARCHIVE_COMPONENT_DEFINITIONS.find(item => item.id === componentId)
    if (!definition) throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', `未知导出组件：${componentId}`, '请刷新后重新选择导出内容。')
    const snapshot = (context: ExportComponentContext, selectedComponents: ReadonlySet<ArchiveComponentId>) => (
      snapshotArchiveComponent(componentId, context, selectedComponents)
    )
    return {
      definition: { ...definition },
      estimate: async (context, selectedComponents) => (await snapshot(context, selectedComponents)).descriptor,
      snapshot,
      serialize: componentSnapshot => componentSnapshot.entries.map(entry => ({ ...entry })),
    }
  }
}

export function exportWorkspaces(layout: ProfileStorageLayout): WorkspaceBindingRecord[] {
  return new WorkspaceBindingService(layout).list().workspaces
}
