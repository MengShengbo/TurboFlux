export const PROFILE_ARCHIVE_CONTAINER_VERSION = 1 as const
export const PROFILE_ARCHIVE_MANIFEST_VERSION = 1 as const
export const PROFILE_ARCHIVE_MAGIC = 'TURBOFLUXPROFILE' as const
export const PROFILE_ARCHIVE_EXTENSION = '.turboflux-profile' as const
export const PROFILE_ARCHIVE_MIME = 'application/vnd.turboflux.profile' as const

export type ArchiveComponentId =
  | 'profile.preferences'
  | 'conversations'
  | 'model.configurations'
  | 'credentials'
  | 'projects'
  | 'automations'
  | 'memories'
  | 'attachments'
  | 'artifacts.index'
  | 'artifacts.blobs'
  | 'skills.user'
  | 'plugins.packages'
  | 'plugins.storage'
  | 'mcp.configurations'
  | 'runtime.transcripts'
  | 'captures'

export type ArchiveSensitivity = 'normal' | 'private' | 'secret' | 'executable'

export interface ArchiveComponentDescriptor {
  id: ArchiveComponentId
  schemaVersion: number
  itemCount: number
  logicalBytes: number
  blobCount: number
  sensitivity: ArchiveSensitivity
  requiredComponents?: ArchiveComponentId[]
}

export interface ArchiveWorkspaceDescriptor {
  id: string
  displayName: string
  sourceHint?: {
    platform: 'darwin' | 'win32' | 'linux' | 'unknown'
    folderName?: string
    gitRemotes?: string[]
    projectFingerprint?: string
  }
}

export type ArchiveConversationMigrationSource = 'legacy-v1' | 'profile-archive-v2' | 'recovery'

export interface ArchiveConversationDataDescriptorV2 {
  schemaVersion: 2
  eventSegments: {
    format: 'per-conversation-json'
    indexPath: 'components/conversations/index.json'
    segmentCount: number
    eventCount: number
  }
  projections: {
    included: false
    rebuildRequired: true
  }
  migrationSources: ArchiveConversationMigrationSource[]
}

export interface ProfileArchiveManifestV1 {
  schemaVersion: typeof PROFILE_ARCHIVE_MANIFEST_VERSION
  archiveId: string
  exportedAt: number
  source: {
    appVersion: string
    coreVersion: string
    platform: string
    profileStorageVersion: number
  }
  profile: {
    sourceProfileId: string
    displayName: string
  }
  conversationDataVersion?: 1 | 2
  conversationData?: ArchiveConversationDataDescriptorV2
  components: ArchiveComponentDescriptor[]
  workspaces: ArchiveWorkspaceDescriptor[]
  contentDigest: string
}

export interface ArchiveEntryInput {
  path: string
  size: number
  digest: string
  data?: Uint8Array | string
  sourcePath?: string
  sourceMtimeMs?: number
}

export interface ArchiveEntrySummary {
  path: string
  size: number
  digest: string
}

export interface ProfileArchiveContainerHeaderV1 {
  containerVersion: typeof PROFILE_ARCHIVE_CONTAINER_VERSION
  compression: 'gzip'
  encrypted: boolean
  kdf?: {
    algorithm: 'scrypt'
    salt: string
    cost: number
    blockSize: number
    parallelization: number
    keyLength: number
  }
  cipher?: {
    algorithm: 'aes-256-gcm'
    nonce: string
    tagLength: number
  }
}

export interface ProfileArchiveWriteResult {
  path: string
  physicalBytes: number
  sha256: string
  encrypted: boolean
  entries: ArchiveEntrySummary[]
}

export interface ExportSelectionInput {
  profileId: string
  components: ArchiveComponentId[]
  conversationIds?: string[]
  includeBlobs?: boolean
  encrypted: boolean
}

export interface ProfileExportComponentEstimate extends ArchiveComponentDescriptor {
  selected: boolean
  defaultSelected: boolean
  description: string
  warnings: string[]
}

export interface ProfileExportEstimate {
  planId: string
  profileId: string
  selectionDigest: string
  components: ProfileExportComponentEstimate[]
  itemCount: number
  logicalBytes: number
  estimatedPhysicalBytes: number
  encrypted: boolean
  requiresEncryption: boolean
  excluded: string[]
  warnings: string[]
  blockers: Array<{ code: string; message: string; action: string }>
}

export interface ConfirmedExportInput {
  planId: string
  targetPath: string
  password?: string | Uint8Array
}

export interface ArchiveOperationRef {
  operationId: string
}

export interface ArchiveWarning {
  code: string
  severity: 'info' | 'warning' | 'danger'
  message: string
  action?: string
}

export interface ArchiveComponentPreview extends ArchiveComponentDescriptor {
  supported: boolean
  defaultSelected: boolean
  importedEnabled: boolean
  warnings: ArchiveWarning[]
}

export interface ProfileArchivePreview {
  archiveId: string
  exportedAt: number
  sourcePlatform: string
  suggestedProfileName: string
  encrypted: boolean
  physicalBytes: number
  components: ArchiveComponentPreview[]
  workspaces: ArchiveWorkspaceDescriptor[]
  warnings: ArchiveWarning[]
  compatibility: 'supported' | 'upgrade-required' | 'partially-supported' | 'unsupported'
}

export interface ImportSelectionInput {
  archiveId: string
  selectedComponents: ArchiveComponentId[]
  displayName: string
}

export interface ProfileImportPlan {
  planId: string
  archiveId: string
  selectedComponents: ArchiveComponentId[]
  skippedComponents: ArchiveComponentId[]
  displayName: string
  itemCount: number
  logicalBytes: number
  requiredDiskBytes: number
  disabled: { automations: number; skills: number; plugins: number; mcpServers: number }
  unboundWorkspaceCount: number
  warnings: ArchiveWarning[]
  blockers: Array<{ code: string; message: string; action: string }>
}

export interface ConfirmedImportInput {
  planId: string
  password?: string | Uint8Array
}

export interface ProfileArchiveReadLimits {
  maxArchiveBytes: number
  maxEntries: number
  maxEntryBytes: number
  maxExpandedBytes: number
  maxCompressionRatio: number
  maxPathBytes: number
}

export const DEFAULT_PROFILE_ARCHIVE_LIMITS: ProfileArchiveReadLimits = {
  maxArchiveBytes: 64 * 1024 * 1024 * 1024,
  maxEntries: 50_000,
  maxEntryBytes: 16 * 1024 * 1024 * 1024,
  maxExpandedBytes: 64 * 1024 * 1024 * 1024,
  maxCompressionRatio: 250,
  maxPathBytes: 1_024,
}

export type ArchiveOperationPhase =
  | 'selected'
  | 'reading_header'
  | 'awaiting_password'
  | 'authenticating'
  | 'scanning'
  | 'preview_ready'
  | 'planning'
  | 'staging'
  | 'migrating'
  | 'validating'
  | 'committing'
  | 'rolled_back'
  | 'draft'
  | 'estimating'
  | 'awaiting_confirmation'
  | 'snapshotting'
  | 'serializing'
  | 'compressing'
  | 'encrypting'
  | 'verifying'
  | 'completed'
  | 'cancelling'
  | 'cancelled'
  | 'failed'

export interface ArchiveOperationSnapshot {
  operationId: string
  kind: 'export' | 'import'
  phase: ArchiveOperationPhase
  progress: number
  startedAt: number
  updatedAt: number
  completedAt?: number
  message?: string
  error?: { code: string; message: string; action: string }
  result?: { path?: string; physicalBytes?: number; sha256?: string; archiveId?: string; profileId?: string }
}

export class ProfileArchiveError extends Error {
  constructor(
    readonly code:
      | 'ARCHIVE_UNSUPPORTED_VERSION'
      | 'ARCHIVE_AUTHENTICATION_FAILED'
      | 'ARCHIVE_CORRUPT'
      | 'ARCHIVE_RESOURCE_LIMIT'
      | 'ARCHIVE_UNSAFE_ENTRY'
      | 'ARCHIVE_COMPONENT_INVALID'
      | 'ARCHIVE_DISK_SPACE_LOW'
      | 'ARCHIVE_TARGET_EXISTS'
      | 'IMPORT_ROLLBACK_REQUIRED'
      | 'WORKSPACE_REBIND_REQUIRED'
      | 'SECRET_EXPORT_REQUIRES_ENCRYPTION',
    message: string,
    readonly action: string,
  ) {
    super(message)
    this.name = 'ProfileArchiveError'
  }
}
