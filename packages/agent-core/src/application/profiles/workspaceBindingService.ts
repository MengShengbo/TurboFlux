import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { AtomicJsonStore } from '../platform/atomicJsonStore'
import { WorkspacePathResolver } from '../conversations/portablePath'
import type { ProfileStorageLayout } from './types'
import { workspaceOverlayRoot } from './profileStorageLayout'

export type WorkspaceBindingState = 'unbound' | 'candidate' | 'bound' | 'mismatch' | 'unavailable'

export interface WorkspaceSourceHint {
  platform: 'darwin' | 'win32' | 'linux' | 'unknown'
  folderName?: string
  gitRemotes?: string[]
  projectFingerprint?: string
}

export interface WorkspaceBindingRecord {
  schemaVersion: 1
  id: string
  displayName: string
  localPath?: string
  boundAt?: number
  verifiedAt?: number
  sourceHint?: WorkspaceSourceHint
  state: WorkspaceBindingState
  createdAt: number
  updatedAt: number
}

interface WorkspaceBindingStoreFile {
  schemaVersion: 1
  workspaces: WorkspaceBindingRecord[]
}

export interface WorkspaceBindingSnapshot {
  schemaVersion: 1
  warnings: string[]
  workspaces: WorkspaceBindingRecord[]
}

export interface WorkspaceBindingVerification {
  workspaceId: string
  candidatePath: string
  state: 'bound' | 'missing' | 'mismatch'
  reasons: string[]
  expectedFingerprint?: string
  candidateFingerprint?: string
}

function validStore(value: unknown): value is WorkspaceBindingStoreFile {
  if (!value || typeof value !== 'object') return false
  const store = value as Partial<WorkspaceBindingStoreFile>
  return store.schemaVersion === 1
    && Array.isArray(store.workspaces)
    && store.workspaces.every(workspace => workspace?.schemaVersion === 1
      && typeof workspace.id === 'string'
      && typeof workspace.displayName === 'string'
      && typeof workspace.createdAt === 'number'
      && typeof workspace.updatedAt === 'number'
      && ['unbound', 'candidate', 'bound', 'mismatch', 'unavailable'].includes(String(workspace.state)))
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = resolve(value).replaceAll('\\', '/')
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  return normalize(left) === normalize(right)
}

function cloneRecord(record: WorkspaceBindingRecord): WorkspaceBindingRecord {
  return structuredClone(record)
}

function directoryAvailable(path: string): boolean {
  try { return existsSync(path) && statSync(path).isDirectory() } catch { return false }
}

function sanitizedGitRemotes(root: string): string[] {
  try {
    const config = readFileSync(join(root, '.git', 'config'), 'utf8')
    return [...config.matchAll(/^\s*url\s*=\s*(.+)$/gmu)].map(match => {
      const value = match[1]!.trim()
      try {
        const url = new URL(value)
        url.username = ''
        url.password = ''
        return url.toString().replace(/\/$/u, '')
      } catch {
        return value.replace(/^(?:[^@/]+@)?([^:]+):/u, '$1/')
      }
    }).sort()
  } catch {
    return []
  }
}

function workspaceFingerprint(root: string): { fingerprint: string; gitRemotes: string[] } {
  const gitRemotes = sanitizedGitRemotes(root)
  let head = ''
  try { head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim() } catch {}
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ folderName: basename(root).toLocaleLowerCase(), gitRemotes, head }))
    .digest('base64url')
    .slice(0, 24)
  return { fingerprint, gitRemotes }
}

export class WorkspaceBindingService {
  private readonly store: AtomicJsonStore<WorkspaceBindingStoreFile>
  private data: WorkspaceBindingStoreFile
  private warnings: string[]

  constructor(
    private readonly layout: ProfileStorageLayout,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID,
  ) {
    this.store = new AtomicJsonStore(layout.workspaceBindingsPath, () => ({ schemaVersion: 1, workspaces: [] }), validStore)
    const loaded = this.store.load()
    this.data = loaded.value
    this.warnings = loaded.warnings
  }

  list(): WorkspaceBindingSnapshot {
    return {
      schemaVersion: 1,
      warnings: [...this.warnings],
      workspaces: this.data.workspaces.map(workspace => this.refreshAvailability(cloneRecord(workspace))),
    }
  }

  ensureBound(localPath: string, displayName = basename(resolve(localPath)) || 'workspace'): WorkspaceBindingRecord {
    const normalizedPath = resolve(localPath)
    if (!directoryAvailable(normalizedPath)) throw new Error(`Workspace folder is unavailable: ${normalizedPath}`)
    const existing = this.data.workspaces.find(workspace => workspace.localPath && samePath(workspace.localPath, normalizedPath))
    const timestamp = this.now()
    const identity = workspaceFingerprint(normalizedPath)
    if (existing) {
      existing.displayName = displayName.trim().slice(0, 120) || existing.displayName
      existing.state = 'bound'
      existing.verifiedAt = timestamp
      existing.updatedAt = timestamp
      this.persist()
      return cloneRecord(existing)
    }
    const record: WorkspaceBindingRecord = {
      schemaVersion: 1,
      id: this.createId(),
      displayName: displayName.trim().slice(0, 120) || 'workspace',
      localPath: normalizedPath,
      boundAt: timestamp,
      verifiedAt: timestamp,
      sourceHint: {
        platform: process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux' ? process.platform : 'unknown',
        folderName: basename(normalizedPath),
        gitRemotes: identity.gitRemotes,
        projectFingerprint: identity.fingerprint,
      },
      state: 'bound',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    workspaceOverlayRoot(this.layout, record.id)
    this.data.workspaces.push(record)
    this.persist()
    return cloneRecord(record)
  }

  addUnbound(input: { id?: string; displayName: string; sourceHint?: WorkspaceSourceHint }): WorkspaceBindingRecord {
    const id = input.id ?? this.createId()
    workspaceOverlayRoot(this.layout, id)
    if (this.data.workspaces.some(workspace => workspace.id === id)) throw new Error(`Workspace identity already exists: ${id}`)
    const timestamp = this.now()
    const record: WorkspaceBindingRecord = {
      schemaVersion: 1,
      id,
      displayName: input.displayName.trim().slice(0, 120) || 'workspace',
      sourceHint: input.sourceHint ? structuredClone(input.sourceHint) : undefined,
      state: 'unbound',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.data.workspaces.push(record)
    this.persist()
    return cloneRecord(record)
  }

  bind(workspaceId: string, localPath: string, acceptMismatch = false): WorkspaceBindingRecord {
    const workspace = this.requireWorkspace(workspaceId)
    const normalizedPath = resolve(localPath)
    if (!directoryAvailable(normalizedPath)) throw new Error(`Workspace folder is unavailable: ${normalizedPath}`)
    const occupied = this.data.workspaces.find(item => item.id !== workspace.id && item.localPath && samePath(item.localPath, normalizedPath))
    if (occupied) throw new Error(`Workspace folder is already bound to ${occupied.displayName}`)
    const verification = this.verify(workspaceId, normalizedPath)
    if (verification.state === 'mismatch' && !acceptMismatch) {
      workspace.state = 'mismatch'
      workspace.updatedAt = this.now()
      this.persist()
      return cloneRecord(workspace)
    }
    const timestamp = this.now()
    workspace.localPath = normalizedPath
    workspace.boundAt = timestamp
    workspace.verifiedAt = timestamp
    workspace.state = 'bound'
    workspace.updatedAt = timestamp
    this.persist()
    return cloneRecord(workspace)
  }

  get(workspaceId: string): WorkspaceBindingRecord | null {
    const workspace = this.data.workspaces.find(item => item.id === workspaceId)
    return workspace ? this.refreshAvailability(cloneRecord(workspace)) : null
  }

  verify(workspaceId: string, localPath: string): WorkspaceBindingVerification {
    const workspace = this.requireWorkspace(workspaceId)
    const candidatePath = resolve(localPath)
    if (!directoryAvailable(candidatePath)) {
      return { workspaceId, candidatePath, state: 'missing', reasons: ['所选文件夹不存在或无法访问。'], expectedFingerprint: workspace.sourceHint?.projectFingerprint }
    }
    const candidate = workspaceFingerprint(candidatePath)
    const reasons: string[] = []
    if (workspace.sourceHint?.folderName && workspace.sourceHint.folderName !== basename(candidatePath)) reasons.push('文件夹名称与来源工作区不同。')
    if (workspace.sourceHint?.projectFingerprint && workspace.sourceHint.projectFingerprint !== candidate.fingerprint) reasons.push('Git 远端、HEAD 或工作区指纹与来源不同。')
    return {
      workspaceId,
      candidatePath,
      state: reasons.length ? 'mismatch' : 'bound',
      reasons,
      expectedFingerprint: workspace.sourceHint?.projectFingerprint,
      candidateFingerprint: candidate.fingerprint,
    }
  }

  pathResolver(artifactPath: (artifactId: string) => string | null = () => null): WorkspacePathResolver {
    return new WorkspacePathResolver({
      workspaceRoot: workspaceId => {
        const workspace = this.get(workspaceId)
        return workspace?.state === 'bound' ? workspace.localPath ?? null : null
      },
      artifactPath,
      profileRoot: () => this.layout.profileRoot,
    })
  }

  overlayRoot(workspaceId: string): string {
    this.requireWorkspace(workspaceId)
    return workspaceOverlayRoot(this.layout, workspaceId)
  }

  private refreshAvailability(record: WorkspaceBindingRecord): WorkspaceBindingRecord {
    if (record.state === 'bound' && record.localPath && !directoryAvailable(record.localPath)) record.state = 'unavailable'
    if (record.state === 'unavailable' && record.localPath && directoryAvailable(record.localPath)) record.state = 'bound'
    return record
  }

  private requireWorkspace(workspaceId: string): WorkspaceBindingRecord {
    workspaceOverlayRoot(this.layout, workspaceId)
    const workspace = this.data.workspaces.find(item => item.id === workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    return workspace
  }

  private persist(): void {
    this.store.save(this.data)
    this.warnings = []
  }
}
