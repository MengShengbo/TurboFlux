export const PROFILE_REGISTRY_SCHEMA_VERSION = 1 as const
export const PROFILE_STORAGE_VERSION = 1 as const

export type LocalProfileState = 'ready' | 'migrating' | 'importing' | 'degraded' | 'trashed'

export interface LocalProfileRecord {
  schemaVersion: typeof PROFILE_REGISTRY_SCHEMA_VERSION
  id: string
  displayName: string
  avatar?: { kind: 'color' | 'image'; value: string }
  createdAt: number
  updatedAt: number
  lastActivatedAt?: number
  state: LocalProfileState
  lock: { kind: 'none' | 'passphrase'; configuredAt?: number }
  storageVersion: typeof PROFILE_STORAGE_VERSION
  importedFrom?: {
    archiveId: string
    sourceProfileId?: string
    importedAt: number
  }
}

export interface InstallationProfileRegistryFile {
  schemaVersion: typeof PROFILE_REGISTRY_SCHEMA_VERSION
  installationId: string
  activeProfileId: string
  profiles: LocalProfileRecord[]
  updatedAt: number
}

export interface ProfileRegistrySnapshot {
  schemaVersion: typeof PROFILE_REGISTRY_SCHEMA_VERSION
  installationId: string
  activeProfileId: string
  profiles: LocalProfileRecord[]
  warnings: string[]
}

export interface CreateLocalProfileInput {
  displayName: string
  avatar?: LocalProfileRecord['avatar']
  importedFrom?: LocalProfileRecord['importedFrom']
}

export interface ProfileStorageLayout {
  profileId: string
  dataRoot: string
  deviceRoot: string
  profileRoot: string
  profileMetadataPath: string
  configRoot: string
  configPath: string
  credentialsPath: string
  personaPath: string
  settingsPath: string
  conversationsRoot: string
  conversationsV2Root: string
  interactionRoot: string
  platformRoot: string
  projectsPath: string
  automationsPath: string
  artifactsPath: string
  managedTaskTitlesPath: string
  extensionsRoot: string
  userSkillsRoot: string
  pluginsRoot: string
  pluginsIndexPath: string
  pluginStorageRoot: string
  workspaceOverlaysRoot: string
  workspaceBindingsPath: string
  deviceBoundRoot: string
  remoteRoot: string
  cacheRoot: string
}

export interface ProfileContext {
  profile: LocalProfileRecord
  storage: ProfileStorageLayout
}
