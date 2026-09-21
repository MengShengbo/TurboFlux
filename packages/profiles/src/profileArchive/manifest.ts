import { canonicalJsonBytes, canonicalJsonDigest } from './canonicalJson'
import {
  PROFILE_ARCHIVE_MANIFEST_VERSION,
  ProfileArchiveError,
  type ArchiveComponentDescriptor,
  type ArchiveComponentId,
  type ProfileArchiveManifestV1,
} from './types'

const COMPONENT_IDS = new Set<ArchiveComponentId>([
  'profile.preferences', 'conversations', 'model.configurations', 'credentials', 'projects', 'automations',
  'memories', 'attachments', 'artifacts.index', 'artifacts.blobs', 'skills.user', 'plugins.packages',
  'plugins.storage', 'mcp.configurations', 'runtime.transcripts', 'captures',
])
const SENSITIVITIES = new Set(['normal', 'private', 'secret', 'executable'])
const CONVERSATION_MIGRATION_SOURCES = new Set(['legacy-v1', 'profile-archive-v2', 'recovery'])
const WORKSPACE_ID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|workspace-[A-Za-z0-9_-]{8,96})$/iu

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validComponent(value: unknown): value is ArchiveComponentDescriptor {
  if (!isRecord(value)) return false
  return COMPONENT_IDS.has(value.id as ArchiveComponentId)
    && Number.isInteger(value.schemaVersion) && Number(value.schemaVersion) > 0
    && Number.isInteger(value.itemCount) && Number(value.itemCount) >= 0
    && Number.isInteger(value.logicalBytes) && Number(value.logicalBytes) >= 0
    && Number.isInteger(value.blobCount) && Number(value.blobCount) >= 0
    && SENSITIVITIES.has(String(value.sensitivity))
    && (value.requiredComponents === undefined || (Array.isArray(value.requiredComponents)
      && value.requiredComponents.every(component => COMPONENT_IDS.has(component as ArchiveComponentId))))
}

function validWorkspace(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && WORKSPACE_ID_PATTERN.test(value.id)
    && typeof value.displayName === 'string'
    && value.displayName.length > 0
    && value.displayName.length <= 120
}

function validConversationData(value: unknown): boolean {
  if (!isRecord(value) || value.schemaVersion !== 2
    || !isRecord(value.eventSegments)
    || value.eventSegments.format !== 'per-conversation-json'
    || value.eventSegments.indexPath !== 'components/conversations/index.json'
    || !Number.isInteger(value.eventSegments.segmentCount) || Number(value.eventSegments.segmentCount) < 0
    || !Number.isInteger(value.eventSegments.eventCount) || Number(value.eventSegments.eventCount) < 0
    || !isRecord(value.projections)
    || value.projections.included !== false
    || value.projections.rebuildRequired !== true
    || !Array.isArray(value.migrationSources)
    || value.migrationSources.some(source => !CONVERSATION_MIGRATION_SOURCES.has(String(source)))) return false
  return new Set(value.migrationSources).size === value.migrationSources.length
}

export function manifestContentDigest(manifest: Omit<ProfileArchiveManifestV1, 'contentDigest'>): string {
  return canonicalJsonDigest(manifest)
}

export function finalizeManifest(manifest: Omit<ProfileArchiveManifestV1, 'contentDigest'>): ProfileArchiveManifestV1 {
  return { ...manifest, contentDigest: manifestContentDigest(manifest) }
}

export function serializeManifest(manifest: ProfileArchiveManifestV1): Buffer {
  parseManifest(manifest)
  return canonicalJsonBytes(manifest)
}

export function parseManifest(value: unknown): ProfileArchiveManifestV1 {
  if (!isRecord(value) || value.schemaVersion !== PROFILE_ARCHIVE_MANIFEST_VERSION) {
    throw new ProfileArchiveError('ARCHIVE_UNSUPPORTED_VERSION', '该资料包版本无法由当前 TurboFlux 打开。', '请升级 TurboFlux 后重试。')
  }
  const source = value.source
  const profile = value.profile
  const conversationComponent = Array.isArray(value.components)
    ? value.components.find(component => isRecord(component) && component.id === 'conversations')
    : undefined
  const conversationComponentVersion = isRecord(conversationComponent) ? conversationComponent.schemaVersion : undefined
  if (typeof value.archiveId !== 'string' || !value.archiveId
    || !Number.isFinite(value.exportedAt)
    || !isRecord(source)
    || typeof source.appVersion !== 'string'
    || typeof source.coreVersion !== 'string'
    || typeof source.platform !== 'string'
    || !Number.isInteger(source.profileStorageVersion)
    || !isRecord(profile)
    || typeof profile.sourceProfileId !== 'string'
    || typeof profile.displayName !== 'string'
    || (value.conversationDataVersion !== undefined && value.conversationDataVersion !== 1 && value.conversationDataVersion !== 2)
    || (conversationComponentVersion === 2 && value.conversationDataVersion !== 2)
    || (value.conversationDataVersion === 2 && (!validConversationData(value.conversationData)
      || conversationComponentVersion !== 2))
    || (value.conversationData !== undefined && value.conversationDataVersion !== 2)
    || !Array.isArray(value.components)
    || !value.components.every(validComponent)
    || new Set(value.components.map(component => component.id)).size !== value.components.length
    || !Array.isArray(value.workspaces)
    || !value.workspaces.every(validWorkspace)
    || typeof value.contentDigest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.contentDigest)) {
    throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '资料包清单不完整或格式无效。', '请从来源设备重新导出。')
  }
  const manifest = value as unknown as ProfileArchiveManifestV1
  const { contentDigest, ...unsigned } = manifest
  if (manifestContentDigest(unsigned) !== contentDigest) {
    throw new ProfileArchiveError('ARCHIVE_CORRUPT', '资料包清单校验失败。', '请重新获取或重新导出该资料包。')
  }
  return structuredClone(manifest)
}

export function parseManifestBytes(bytes: Uint8Array): ProfileArchiveManifestV1 {
  try {
    return parseManifest(JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown)
  } catch (error) {
    if (error instanceof ProfileArchiveError) throw error
    throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '资料包清单不是有效 JSON。', '请从来源设备重新导出。')
  }
}
