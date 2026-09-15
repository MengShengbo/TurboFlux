import { stat } from 'node:fs/promises'
import { ARCHIVE_COMPONENT_DEFINITIONS } from './exportComponents'
import { parseManifestBytes } from './manifest'
import { readProfileArchive, verifyProfileArchive } from './container'
import {
  ProfileArchiveError,
  type ArchiveComponentId,
  type ArchiveEntrySummary,
  type ArchiveWarning,
  type ProfileArchiveContainerHeaderV1,
  type ProfileArchiveManifestV1,
  type ProfileArchivePreview,
  type ProfileArchiveReadLimits,
} from './types'
import type { AnyConversationEventV2 } from '../../conversations/conversationV2Types'
import { parseConversationEventV2 } from '../../conversations/conversationEventStoreV2'
import { stableConversationV2Id } from '../../conversations/conversationV2Ids'
import { containsForbiddenExportData } from './redaction'

const MAX_JSON_BYTES = 32 * 1024 * 1024
const MAX_JSON_DEPTH = 64
const MAX_JSON_STRING = 1024 * 1024
const MAX_JSON_ARRAY = 100_000
const MAX_JSON_KEYS = 100_000
const DEVICE_KEYS = new Set(['installationId', 'remoteIdentity', 'pairedDevices', 'grants', 'controlLeases', 'browserSession', 'terminalPid', 'debugPort'])
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u
const UNC_PATH = /^\\\\/u
const UNIX_ABSOLUTE_PATH = /^\/(?:Users|home|private|tmp|var)(?:\/|$)/u
const SECRET_KEY = /(?:api[-_]?key|token|authorization|password|passwd|secret|cookie|private[-_]?key)/iu
const ACTIVE_RUNTIME_KEY = /^(?:activeToolCalls|activeRun|activeRuns|approvalRequests|pendingApproval|pendingApprovals|queuedInputs|pendingSteering|steeringInputs|lease|nextRunAt|processId|pid|retryAt|retryTimer|runQueue)$/u

export interface ScannedProfileArchive {
  header: ProfileArchiveContainerHeaderV1
  manifest: ProfileArchiveManifestV1
  preview: ProfileArchivePreview
  entries: ArchiveEntrySummary[]
  documents: Map<string, unknown>
}

function assertJsonBudget(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let keys = 0
  while (stack.length) {
    const current = stack.pop()!
    if (current.depth > MAX_JSON_DEPTH) throw new ProfileArchiveError('ARCHIVE_RESOURCE_LIMIT', '资料包 JSON 嵌套过深。', '请勿导入该文件。')
    if (typeof current.value === 'string') {
      if (current.value.length > MAX_JSON_STRING) throw new ProfileArchiveError('ARCHIVE_RESOURCE_LIMIT', '资料包包含过长文本字段。', '请减少单条内容后重新导出。')
      continue
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_JSON_ARRAY) throw new ProfileArchiveError('ARCHIVE_RESOURCE_LIMIT', '资料包数组长度超出安全限制。', '请减少条目后重新导出。')
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 })
      continue
    }
    if (!current.value || typeof current.value !== 'object') continue
    const entries = Object.entries(current.value as Record<string, unknown>)
    keys += entries.length
    if (keys > MAX_JSON_KEYS) throw new ProfileArchiveError('ARCHIVE_RESOURCE_LIMIT', '资料包 JSON 字段数量超出安全限制。', '请减少内容后重新导出。')
    for (const [key, child] of entries) {
      if (DEVICE_KEYS.has(key)) throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '资料包包含禁止迁移的设备状态。', '请勿导入该文件，并从可信设备重新导出。')
      if (typeof child === 'string' && /path$/iu.test(key)
        && (WINDOWS_ABSOLUTE_PATH.test(child) || UNC_PATH.test(child) || UNIX_ABSOLUTE_PATH.test(child))) {
        throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '资料包组件包含本机绝对路径。', '请从新版 TurboFlux 重新导出。')
      }
      stack.push({ value: child, depth: current.depth + 1 })
    }
  }
}

function parseJsonDocument(path: string, bytes: Buffer): unknown {
  if (bytes.length > MAX_JSON_BYTES) throw new ProfileArchiveError('ARCHIVE_RESOURCE_LIMIT', `${path} 超出 JSON 安全限制。`, '请减少内容后重新导出。')
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    assertJsonBudget(value)
    return value
  } catch (error) {
    if (error instanceof ProfileArchiveError) throw error
    throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', `${path} 不是有效的组件 JSON。`, '请重新导出资料包。')
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', `${label} 组件格式无效。`, '请重新导出资料包。')
  }
  return value as Record<string, unknown>
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', `${label} 组件缺少条目列表。`, '请重新导出资料包。')
  return value
}

function assertNoUnsafeExecutableState(value: unknown, label: string): void {
  const stack: unknown[] = [value]
  while (stack.length) {
    const current = stack.pop()
    if (Array.isArray(current)) {
      stack.push(...current)
      continue
    }
    if (!current || typeof current !== 'object') continue
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (SECRET_KEY.test(key) && child !== '' && child !== '[secret-redacted]' && child !== null && child !== undefined) {
        throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', `${label} 包含未隔离的内联秘密。`, '请从新版 TurboFlux 重新导出，或取消该组件。')
      }
      if (ACTIVE_RUNTIME_KEY.test(key)) {
        throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', `${label} 包含活动执行状态。`, '请从新版 TurboFlux 重新导出，或取消该组件。')
      }
      stack.push(child)
    }
  }
}

function assertPortableConversationInteraction(value: unknown, conversationId: string): void {
  const interaction = objectValue(value, 'Conversation V2 草稿')
  const allowedInteractionKeys = new Set(['schemaVersion', 'conversationId', 'draft'])
  if (Object.keys(interaction).some(key => !allowedInteractionKeys.has(key))
    || interaction.schemaVersion !== 1
    || interaction.conversationId !== conversationId) {
    throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', 'Conversation V2 草稿文档包含不支持的状态。', '请从新版 TurboFlux 重新导出。')
  }
  const draft = objectValue(interaction.draft, 'Conversation V2 草稿')
  const allowedDraftKeys = new Set(['text', 'pendingPastes', 'capabilities'])
  if (Object.keys(draft).some(key => !allowedDraftKeys.has(key)) || typeof draft.text !== 'string') {
    throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', 'Conversation V2 草稿字段无效。', '请从新版 TurboFlux 重新导出。')
  }
  if (draft.pendingPastes !== undefined) {
    for (const value of arrayValue(draft.pendingPastes, 'Conversation V2 粘贴草稿')) {
      const paste = objectValue(value, 'Conversation V2 粘贴草稿')
      if (Object.keys(paste).some(key => key !== 'placeholder' && key !== 'text')
        || typeof paste.placeholder !== 'string' || typeof paste.text !== 'string') {
        throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', 'Conversation V2 粘贴草稿字段无效。', '请从新版 TurboFlux 重新导出。')
      }
    }
  }
  if (draft.capabilities !== undefined && (!draft.capabilities || typeof draft.capabilities !== 'object' || Array.isArray(draft.capabilities))) {
    throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', 'Conversation V2 草稿能力选择无效。', '请从新版 TurboFlux 重新导出。')
  }
  assertNoUnsafeExecutableState(interaction, 'Conversation V2 草稿')
  if (containsForbiddenExportData(JSON.stringify(interaction))) {
    throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', 'Conversation V2 草稿包含本机路径或未移除的秘密。', '请从新版 TurboFlux 重新导出。')
  }
}

function validateComponentDocuments(manifest: ProfileArchiveManifestV1, documents: Map<string, unknown>, entryPaths: Set<string>): void {
  const workspaceIds = new Set(manifest.workspaces.map(workspace => workspace.id))
  const componentIds = new Set(manifest.components.map(component => component.id))
  if (componentIds.has('artifacts.blobs') && !componentIds.has('artifacts.index')) {
    throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '成果文件组件缺少成果索引依赖。', '请重新导出资料包。')
  }
  for (const component of manifest.components) {
    if (component.requiredComponents?.some(required => !componentIds.has(required))) {
      throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', `${component.id} 组件缺少必要依赖。`, '请重新导出资料包。')
    }
    if (component.schemaVersion !== 1 && !(component.id === 'conversations' && component.schemaVersion === 2)) {
      throw new ProfileArchiveError('ARCHIVE_UNSUPPORTED_VERSION', `${component.id} 组件版本不受支持。`, '请升级 TurboFlux 后重试。')
    }
    const prefix = `components/${component.id}/`
    const paths = [...entryPaths].filter(path => path.startsWith(prefix))
    if (paths.length === 0) throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', `资料包缺少 ${component.id} 组件。`, '请重新导出资料包。')
    const logicalBytes = paths.reduce((sum, path) => sum + (documents.has(path) ? Buffer.byteLength(JSON.stringify(documents.get(path)), 'utf8') : 0), 0)
    if (paths.every(path => documents.has(path)) && logicalBytes > component.logicalBytes * 4 + 4_096) {
      throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', `${component.id} 组件声明大小明显不一致。`, '请重新导出资料包。')
    }
  }

  if (componentIds.has('conversations')) {
    const index = objectValue(documents.get('components/conversations/index.json'), '会话')
    const items = arrayValue(index.items, '会话')
    const descriptor = manifest.components.find(component => component.id === 'conversations')!
    if (items.length !== descriptor.itemCount) {
      throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '会话数量与 Manifest 不一致。', '请重新导出资料包。')
    }
    const ids = new Set<string>()
    const eventIds = new Set<string>()
    let totalEventCount = 0
    for (const value of items) {
      const item = objectValue(value, '会话索引')
      if (typeof item.id !== 'string' || typeof item.path !== 'string' || !entryPaths.has(item.path) || ids.has(item.id)) {
        throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '会话索引包含缺失或重复引用。', '请重新导出资料包。')
      }
      ids.add(item.id)
      const document = objectValue(documents.get(item.path), '会话')
      if (descriptor.schemaVersion === 2) {
        if (document.schemaVersion !== 2 || document.conversationId !== item.id || !Array.isArray(document.events)) {
          throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', 'Conversation V2 文档格式无效。', '请重新导出资料包。')
        }
        let previousSeq = 0
        for (const value of document.events) {
          let event: AnyConversationEventV2
          try {
            event = parseConversationEventV2(value)
          } catch {
            throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', 'Conversation V2 Event Schema 或身份无效。', '请重新导出资料包。')
          }
          if (event.conversationId !== item.id || event.profileId !== manifest.profile.sourceProfileId
            || event.seq !== previousSeq + 1 || eventIds.has(event.eventId)) {
            throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', 'Conversation V2 事件序列或身份无效。', '请重新导出资料包。')
          }
          if (event.workspaceId !== undefined && !workspaceIds.has(event.workspaceId)) {
            throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', 'Conversation V2 引用了未知工作区。', '请重新导出资料包。')
          }
          previousSeq = event.seq
          eventIds.add(event.eventId)
        }
        if (Number(item.eventCount) !== document.events.length || Number(item.lastSeq) !== previousSeq) {
          throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', 'Conversation V2 索引与事件数量不一致。', '请重新导出资料包。')
        }
        totalEventCount += document.events.length
        if (item.interactionPath !== undefined) {
          if (typeof item.interactionPath !== 'string' || !entryPaths.has(item.interactionPath)
            || !item.interactionPath.startsWith('components/conversations/interactions/')) {
            throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', 'Conversation V2 草稿引用无效。', '请重新导出资料包。')
          }
          assertPortableConversationInteraction(documents.get(item.interactionPath), item.id)
        }
      } else {
        const conversation = objectValue(document.conversation, '会话')
        assertNoUnsafeExecutableState(conversation, '会话')
        if (conversation.id !== item.id || (conversation.workspaceId !== undefined && !workspaceIds.has(String(conversation.workspaceId)))) {
          throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '会话身份或工作区引用无效。', '请重新导出资料包。')
        }
      }
    }
    if (descriptor.schemaVersion === 2) {
      const metadata = manifest.conversationData
      if (!metadata
        || metadata.eventSegments.segmentCount !== items.length
        || metadata.eventSegments.eventCount !== totalEventCount) {
        throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', 'Conversation V2 分段清单与实际事件不一致。', '请从来源设备重新导出。')
      }
    }
  }

  if (componentIds.has('automations')) {
    const document = objectValue(documents.get('components/automations/automations.json'), '自动化')
    for (const value of arrayValue(document.automations, '自动化')) {
      const automation = objectValue(value, '自动化')
      assertNoUnsafeExecutableState(automation, '自动化')
      if (automation.enabled === true || (typeof automation.status === 'string' && !['paused', 'archived', 'disabled'].includes(automation.status))) {
        throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '自动化未处于安全禁用状态。', '请从新版 TurboFlux 重新导出，或取消自动化组件。')
      }
    }
  }

  if (componentIds.has('mcp.configurations')) {
    const document = objectValue(documents.get('components/mcp.configurations/configurations.json'), 'MCP')
    assertNoUnsafeExecutableState(document, 'MCP')
    const configurations = objectValue(document.configurations, 'MCP')
    const servers = objectValue(configurations.mcpServers, 'MCP')
    for (const value of Object.values(servers)) {
      const server = objectValue(value, 'MCP')
      if (server.enabled === true) throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', 'MCP 未处于安全断开状态。', '请从新版 TurboFlux 重新导出，或取消 MCP 组件。')
    }
  }

  if (componentIds.has('projects')) {
    const document = objectValue(documents.get('components/projects/projects.json'), '项目')
    for (const value of arrayValue(document.projects, '项目')) {
      const project = objectValue(value, '项目')
      if (project.workspaceId !== undefined && !workspaceIds.has(String(project.workspaceId))) {
        throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '项目引用了未知工作区。', '请重新导出资料包。')
      }
    }
  }

  if (componentIds.has('memories')) {
    const document = objectValue(documents.get('components/memories/index.json'), '记忆')
    for (const value of arrayValue(document.items, '记忆')) {
      const memory = objectValue(value, '记忆')
      if (!workspaceIds.has(String(memory.workspaceId)) || typeof memory.relativePath !== 'string' || typeof memory.content !== 'string') {
        throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '记忆组件包含无效引用。', '请重新导出资料包。')
      }
    }
  }

  for (const id of ['attachments', 'runtime.transcripts', 'captures', 'skills.user', 'plugins.packages', 'plugins.storage'] as ArchiveComponentId[]) {
    if (!componentIds.has(id)) continue
    const indexPath = `components/${id}/index.json`
    const document = objectValue(documents.get(indexPath), id)
    const references = Array.isArray(document.blobs) ? document.blobs : Array.isArray(document.files) ? document.files : []
    for (const value of references) {
      const reference = objectValue(value, id)
      if (typeof reference.digest !== 'string' || !entryPaths.has(`blobs/sha256/${reference.digest}`)) {
        throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', `${id} 包含缺失 Blob 引用。`, '请重新导出资料包。')
      }
    }
  }
}

function componentWarnings(componentId: ArchiveComponentId): ArchiveWarning[] {
  if (componentId === 'automations') return [{ code: 'IMPORTED_DISABLED', severity: 'warning', message: '自动化导入后保持禁用，且不会恢复活动任务。' }]
  if (componentId === 'plugins.packages' || componentId === 'skills.user') return [{ code: 'IMPORTED_CODE_REVIEW', severity: 'danger', message: '可执行内容导入后等待人工检查。' }]
  if (componentId === 'mcp.configurations') return [{ code: 'IMPORTED_DISCONNECTED', severity: 'danger', message: 'MCP 导入后保持断开，并需要重新授权。' }]
  if (componentId === 'credentials') return [{ code: 'SECRET_REPROTECTION', severity: 'warning', message: '凭据仅在导入期间短暂解密，并由目标设备重新保护。' }]
  return []
}

function hasMissingWorkspaceReferences(manifest: ProfileArchiveManifestV1, documents: Map<string, unknown>): boolean {
  const components = new Set(manifest.components.map(component => component.id))
  const conversations = manifest.components.find(component => component.id === 'conversations')
  if (conversations?.schemaVersion === 1) {
    const index = documents.get('components/conversations/index.json') as { items?: Array<{ path?: string }> } | undefined
    if ((index?.items ?? []).some(item => {
      const document = documents.get(String(item.path)) as { conversation?: { workspaceId?: unknown } } | undefined
      return document?.conversation?.workspaceId === undefined
    })) return true
  }
  if (components.has('projects')) {
    const document = documents.get('components/projects/projects.json') as { projects?: Array<{ workspaceId?: unknown }> } | undefined
    if ((document?.projects ?? []).some(project => project.workspaceId === undefined)) return true
  }
  if (components.has('automations')) {
    const document = documents.get('components/automations/automations.json') as { automations?: Array<{ workspaceId?: unknown; workspaceRef?: { id?: unknown } }> } | undefined
    if ((document?.automations ?? []).some(automation => automation.workspaceId === undefined && automation.workspaceRef?.id === undefined)) return true
  }
  if (components.has('artifacts.index')) {
    const document = documents.get('components/artifacts.index/index.json') as { artifacts?: Array<{ workspaceId?: unknown }> } | undefined
    if ((document?.artifacts ?? []).some(artifact => artifact.workspaceId === undefined)) return true
  }
  return false
}

function archiveSourcePlatform(value: string): 'darwin' | 'win32' | 'linux' | 'unknown' {
  return value === 'darwin' || value === 'win32' || value === 'linux' ? value : 'unknown'
}

export async function scanProfileArchive(input: {
  path: string
  password?: string | Uint8Array
  limits?: Partial<ProfileArchiveReadLimits>
}): Promise<ScannedProfileArchive> {
  await verifyProfileArchive(input)
  const documents = new Map<string, unknown>()
  let manifest: ProfileArchiveManifestV1 | undefined
  const result = await readProfileArchive({
    ...input,
    onEntry: async (entry, content) => {
      if (!entry.path.endsWith('.json')) return
      if (entry.size > MAX_JSON_BYTES) throw new ProfileArchiveError('ARCHIVE_RESOURCE_LIMIT', `${entry.path} 超出 JSON 安全限制。`, '请减少内容后重新导出。')
      const chunks: Buffer[] = []
      for await (const chunk of content) chunks.push(chunk)
      const bytes = Buffer.concat(chunks, entry.size)
      try {
        if (entry.path === 'manifest.json') manifest = parseManifestBytes(bytes)
        documents.set(entry.path, parseJsonDocument(entry.path, bytes))
      } finally {
        bytes.fill(0)
        for (const chunk of chunks) chunk.fill(0)
      }
    },
  })
  if (!manifest) throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '资料包缺少 Manifest。', '请重新导出资料包。')
  const entryPaths = new Set(result.entries.map(entry => entry.path))
  validateComponentDocuments(manifest, documents, entryPaths)
  const header = result.header
  if (!header.encrypted && manifest.components.some(component => component.sensitivity === 'secret')) {
    throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '未加密资料包包含秘密组件。', '请勿导入该文件，并使用密码重新导出。')
  }
  const info = await stat(input.path)
  const previewWorkspaces = manifest.workspaces.map(workspace => structuredClone(workspace))
  if (hasMissingWorkspaceReferences(manifest, documents)) {
    previewWorkspaces.push({
      id: stableConversationV2Id('workspace', manifest.archiveId, 'unassociated'),
      displayName: '未关联工作区',
      sourceHint: { platform: archiveSourcePlatform(manifest.source.platform) },
    })
  }
  const warnings: ArchiveWarning[] = [
    ...(previewWorkspaces.length ? [{ code: 'WORKSPACE_REBIND_REQUIRED', severity: 'warning' as const, message: `${previewWorkspaces.length} 个工作区需要在目标电脑重新绑定。` }] : []),
    ...manifest.components.flatMap(component => componentWarnings(component.id)),
  ]
  const preview: ProfileArchivePreview = {
    archiveId: manifest.archiveId,
    exportedAt: manifest.exportedAt,
    sourcePlatform: manifest.source.platform,
    suggestedProfileName: manifest.profile.displayName,
    encrypted: header.encrypted,
    physicalBytes: info.size,
    components: manifest.components.map(component => {
      const definition = ARCHIVE_COMPONENT_DEFINITIONS.find(item => item.id === component.id)!
      return { ...component, supported: true, defaultSelected: definition.defaultSelected, importedEnabled: false, warnings: componentWarnings(component.id) }
    }),
    workspaces: previewWorkspaces,
    warnings,
    compatibility: 'supported',
  }
  return { header, manifest, preview, entries: result.entries, documents }
}
