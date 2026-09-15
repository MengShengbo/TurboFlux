import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { assertProfileId, createProfileStorageLayout, ensureProfileStorageLayout } from './profileStorageLayout'
import {
  PROFILE_REGISTRY_SCHEMA_VERSION,
  PROFILE_STORAGE_VERSION,
  type CreateLocalProfileInput,
  type InstallationProfileRegistryFile,
  type LocalProfileRecord,
  type LocalProfileState,
  type ProfileContext,
  type ProfileRegistrySnapshot,
} from './types'

const DEFAULT_PROFILE_NAME = '默认资料'
const MAX_PROFILE_NAME_LENGTH = 80

export interface InstallationProfileRegistryOptions {
  dataRoot: string
  deviceRoot?: string
  now?: () => number
  createId?: () => string
  installationId?: () => string
}

function normalizeDisplayName(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, ' ').slice(0, MAX_PROFILE_NAME_LENGTH)
  if (!normalized) throw new Error('Local profile name cannot be empty')
  return normalized
}

function cloneProfile(profile: LocalProfileRecord): LocalProfileRecord {
  return structuredClone(profile)
}

function isAvatar(value: unknown): value is NonNullable<LocalProfileRecord['avatar']> {
  if (!value || typeof value !== 'object') return false
  const avatar = value as Record<string, unknown>
  return (avatar.kind === 'color' || avatar.kind === 'image') && typeof avatar.value === 'string' && avatar.value.length <= 2_048
}

function isProfile(value: unknown): value is LocalProfileRecord {
  if (!value || typeof value !== 'object') return false
  const profile = value as Partial<LocalProfileRecord>
  return profile.schemaVersion === PROFILE_REGISTRY_SCHEMA_VERSION
    && typeof profile.id === 'string'
    && typeof profile.displayName === 'string'
    && typeof profile.createdAt === 'number'
    && typeof profile.updatedAt === 'number'
    && ['ready', 'migrating', 'importing', 'degraded', 'trashed'].includes(String(profile.state))
    && profile.storageVersion === PROFILE_STORAGE_VERSION
    && Boolean(profile.lock && (profile.lock.kind === 'none' || profile.lock.kind === 'passphrase'))
    && (profile.avatar === undefined || isAvatar(profile.avatar))
}

function isRegistry(value: unknown): value is InstallationProfileRegistryFile {
  if (!value || typeof value !== 'object') return false
  const registry = value as Partial<InstallationProfileRegistryFile>
  return registry.schemaVersion === PROFILE_REGISTRY_SCHEMA_VERSION
    && typeof registry.installationId === 'string'
    && typeof registry.activeProfileId === 'string'
    && typeof registry.updatedAt === 'number'
    && Array.isArray(registry.profiles)
    && registry.profiles.every(isProfile)
    && new Set(registry.profiles.map(profile => profile.id)).size === registry.profiles.length
    && registry.profiles.some(profile => profile.id === registry.activeProfileId && profile.state !== 'trashed')
}

function unsupportedRegistryVersion(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const registry = value as { schemaVersion?: unknown }
  if (registry.schemaVersion === undefined || registry.schemaVersion === PROFILE_REGISTRY_SCHEMA_VERSION) return undefined
  return String(registry.schemaVersion)
}

function unsupportedProfileVersion(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const profile = value as { schemaVersion?: unknown; storageVersion?: unknown }
  if (profile.schemaVersion !== undefined && profile.schemaVersion !== PROFILE_REGISTRY_SCHEMA_VERSION) {
    return `schema ${String(profile.schemaVersion)}`
  }
  if (profile.storageVersion !== undefined && profile.storageVersion !== PROFILE_STORAGE_VERSION) {
    return `storage ${String(profile.storageVersion)}`
  }
  return undefined
}

export class InstallationProfileRegistry {
  readonly registryPath: string
  readonly profilesRoot: string
  readonly deviceRoot: string
  private readonly now: () => number
  private readonly createId: () => string
  private readonly createInstallationId: () => string
  private data: InstallationProfileRegistryFile | undefined
  private warnings: string[] = []

  constructor(readonly dataRoot: string, options: Omit<InstallationProfileRegistryOptions, 'dataRoot'> = {}) {
    this.registryPath = join(dataRoot, 'profiles.json')
    this.profilesRoot = join(dataRoot, 'profiles')
    this.deviceRoot = options.deviceRoot ?? join(dataRoot, 'device')
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
    this.createInstallationId = options.installationId ?? randomUUID
  }

  initialize(): ProfileRegistrySnapshot {
    if (this.data) return this.snapshot()
    mkdirSync(this.profilesRoot, { recursive: true, mode: 0o700 })
    mkdirSync(this.deviceRoot, { recursive: true, mode: 0o700 })
    this.data = this.readRegistry() ?? this.recoverRegistryFromProfileDirectories() ?? this.createInitialRegistry()
    this.ensureRegisteredLayouts()
    this.persist()
    return this.snapshot()
  }

  snapshot(): ProfileRegistrySnapshot {
    const data = this.requireData()
    return {
      schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION,
      installationId: data.installationId,
      activeProfileId: data.activeProfileId,
      profiles: data.profiles.map(cloneProfile),
      warnings: [...this.warnings],
    }
  }

  activeContext(): ProfileContext {
    return this.context(this.requireData().activeProfileId)
  }

  context(profileId: string): ProfileContext {
    const profile = this.requireProfile(profileId)
    return {
      profile: cloneProfile(profile),
      storage: createProfileStorageLayout(this.dataRoot, this.deviceRoot, profile.id),
    }
  }

  create(input: CreateLocalProfileInput): ProfileContext {
    const data = this.requireData()
    const timestamp = this.now()
    const id = assertProfileId(this.createId())
    if (data.profiles.some(profile => profile.id === id)) throw new Error('Local profile identity already exists')
    const profile: LocalProfileRecord = {
      schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION,
      id,
      displayName: normalizeDisplayName(input.displayName),
      avatar: input.avatar ? structuredClone(input.avatar) : undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
      state: input.importedFrom ? 'importing' : 'ready',
      lock: { kind: 'none' },
      storageVersion: PROFILE_STORAGE_VERSION,
      importedFrom: input.importedFrom ? structuredClone(input.importedFrom) : undefined,
    }
    const layout = createProfileStorageLayout(this.dataRoot, this.deviceRoot, profile.id)
    ensureProfileStorageLayout(layout)
    this.writeProfileMetadata(layout.profileMetadataPath, profile)
    data.profiles.push(profile)
    data.updatedAt = timestamp
    this.persist()
    return { profile: cloneProfile(profile), storage: layout }
  }

  rename(profileId: string, displayName: string): LocalProfileRecord {
    const profile = this.requireProfile(profileId)
    profile.displayName = normalizeDisplayName(displayName)
    profile.updatedAt = this.now()
    this.writeProfileMetadata(this.context(profileId).storage.profileMetadataPath, profile)
    this.requireData().updatedAt = profile.updatedAt
    this.persist()
    return cloneProfile(profile)
  }

  activate(profileId: string): ProfileContext {
    const data = this.requireData()
    const profile = this.requireProfile(profileId)
    if (profile.state !== 'ready' && profile.state !== 'degraded') throw new Error('Local profile is not available for activation')
    const timestamp = this.now()
    profile.lastActivatedAt = timestamp
    profile.updatedAt = timestamp
    data.activeProfileId = profile.id
    data.updatedAt = timestamp
    this.writeProfileMetadata(this.context(profileId).storage.profileMetadataPath, profile)
    this.persist()
    return this.context(profileId)
  }

  setState(profileId: string, state: LocalProfileState): LocalProfileRecord {
    const data = this.requireData()
    const profile = this.requireProfile(profileId)
    if (state === 'trashed' && data.activeProfileId === profile.id) throw new Error('The active local profile cannot be trashed')
    profile.state = state
    profile.updatedAt = this.now()
    data.updatedAt = profile.updatedAt
    this.writeProfileMetadata(this.context(profileId).storage.profileMetadataPath, profile)
    this.persist()
    return cloneProfile(profile)
  }

  has(profileId: string): boolean {
    assertProfileId(profileId)
    return this.requireData().profiles.some(profile => profile.id === profileId)
  }

  registerExisting(profileId: string): LocalProfileRecord {
    const id = assertProfileId(profileId)
    const data = this.requireData()
    if (data.profiles.some(profile => profile.id === id)) throw new Error('Local profile identity already exists')
    const layout = createProfileStorageLayout(this.dataRoot, this.deviceRoot, id)
    let profile: unknown
    try {
      if (!statSync(layout.profileRoot).isDirectory()) throw new Error('profile root is not a directory')
      profile = JSON.parse(readFileSync(layout.profileMetadataPath, 'utf8')) as unknown
    } catch (error) {
      throw new Error(`Imported local profile metadata is unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    if (!isProfile(profile) || profile.id !== id || profile.state === 'trashed') throw new Error('Imported local profile metadata is invalid')
    const previousUpdatedAt = data.updatedAt
    data.profiles.push(cloneProfile(profile))
    data.updatedAt = this.now()
    try {
      this.persist()
    } catch (error) {
      data.profiles = data.profiles.filter(candidate => candidate.id !== id)
      data.updatedAt = previousUpdatedAt
      throw error
    }
    return cloneProfile(profile)
  }

  private readRegistry(): InstallationProfileRegistryFile | undefined {
    if (!existsSync(this.registryPath)) return undefined
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.registryPath, 'utf8'))
      const unsupportedVersion = unsupportedRegistryVersion(parsed)
      if (unsupportedVersion) {
        throw new UnsupportedProfileDataVersionError(`Profile registry version ${unsupportedVersion} is newer or unsupported. Open this data with a compatible TurboFlux version and export it before downgrading.`)
      }
      if (!isRegistry(parsed)) throw new Error('unsupported or inconsistent profile registry')
      return structuredClone(parsed)
    } catch (error) {
      if (error instanceof UnsupportedProfileDataVersionError) throw error
      const backupPath = `${this.registryPath}.corrupt-${this.now()}`
      try { renameSync(this.registryPath, backupPath) } catch {}
      this.warnings.push(`Recovered an invalid local profile registry: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private recoverRegistryFromProfileDirectories(): InstallationProfileRegistryFile | undefined {
    const unsupported: string[] = []
    const profiles = readdirSync(this.profilesRoot, { withFileTypes: true }).flatMap(entry => {
      if (!entry.isDirectory()) return []
      try {
        assertProfileId(entry.name)
        const metadataPath = join(this.profilesRoot, entry.name, 'profile.json')
        const metadata: unknown = JSON.parse(readFileSync(metadataPath, 'utf8'))
        const unsupportedVersion = unsupportedProfileVersion(metadata)
        if (unsupportedVersion) {
          unsupported.push(`${entry.name} (${unsupportedVersion})`)
          return []
        }
        if (!isProfile(metadata) || metadata.id !== entry.name) return []
        return [metadata]
      } catch {
        return []
      }
    }).sort((left, right) => left.createdAt - right.createdAt)
    if (unsupported.length > 0) {
      throw new UnsupportedProfileDataVersionError(`Unsupported local profile data found: ${unsupported.join(', ')}. Open it with a compatible TurboFlux version and export it before downgrading.`)
    }
    const active = profiles.find(profile => profile.state !== 'trashed')
    if (!active) return undefined
    this.warnings.push(`Rebuilt the local profile registry from ${profiles.length} profile director${profiles.length === 1 ? 'y' : 'ies'}`)
    return {
      schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION,
      installationId: this.createInstallationId(),
      activeProfileId: active.id,
      profiles,
      updatedAt: this.now(),
    }
  }

  private createInitialRegistry(): InstallationProfileRegistryFile {
    const timestamp = this.now()
    const profile: LocalProfileRecord = {
      schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION,
      id: assertProfileId(this.createId()),
      displayName: DEFAULT_PROFILE_NAME,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivatedAt: timestamp,
      state: 'ready',
      lock: { kind: 'none' },
      storageVersion: PROFILE_STORAGE_VERSION,
    }
    return {
      schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION,
      installationId: this.createInstallationId(),
      activeProfileId: profile.id,
      profiles: [profile],
      updatedAt: timestamp,
    }
  }

  private ensureRegisteredLayouts(): void {
    for (const profile of this.requireData().profiles) {
      if (profile.state === 'trashed') continue
      const layout = createProfileStorageLayout(this.dataRoot, this.deviceRoot, profile.id)
      ensureProfileStorageLayout(layout)
      if (!existsSync(layout.profileMetadataPath)) this.writeProfileMetadata(layout.profileMetadataPath, profile)
    }
  }

  private writeProfileMetadata(path: string, profile: LocalProfileRecord): void {
    this.writeAtomic(path, `${JSON.stringify(profile, null, 2)}\n`)
  }

  private persist(): void {
    const data = this.requireData()
    this.writeAtomic(this.registryPath, `${JSON.stringify(data, null, 2)}\n`)
  }

  private writeAtomic(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporaryPath, path)
    if (!statSync(path).isFile()) throw new Error(`Profile store is not a file: ${basename(path)}`)
  }

  private requireData(): InstallationProfileRegistryFile {
    if (!this.data) throw new Error('Local profile registry has not been initialized')
    return this.data
  }

  private requireProfile(profileId: string): LocalProfileRecord {
    const safeProfileId = assertProfileId(profileId)
    const profile = this.requireData().profiles.find(item => item.id === safeProfileId)
    if (!profile) throw new Error(`Local profile not found: ${safeProfileId}`)
    return profile
  }
}

export class UnsupportedProfileDataVersionError extends Error {
  readonly code = 'PROFILE_DATA_VERSION_UNSUPPORTED'

  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedProfileDataVersionError'
  }
}
