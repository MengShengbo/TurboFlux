import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { AtomicJsonStore } from '@turboflux/platform/atomicJsonStore'

export type ArtifactKind = 'document' | 'pdf' | 'presentation' | 'spreadsheet' | 'image' | 'archive' | 'code' | 'data' | 'other'
export type ArtifactSource = 'agent' | 'browser' | 'browser-download' | 'import' | 'automation' | 'plugin'

export interface ArtifactRecord {
  id: string
  name: string
  path: string
  workspacePath: string
  kind: ArtifactKind
  mime: string
  size: number
  source: ArtifactSource
  createdAt: number
  updatedAt: number
  available: boolean
  conversationId?: string
  taskId?: string
  metadata?: Record<string, string | number | boolean>
}

export interface ArtifactSnapshot {
  schemaVersion: 1
  warnings: string[]
  artifacts: ArtifactRecord[]
}

interface ArtifactStoreFile {
  schemaVersion: 1
  artifacts: ArtifactRecord[]
}

function validStore(value: unknown): value is ArtifactStoreFile {
  return Boolean(value && typeof value === 'object' && (value as ArtifactStoreFile).schemaVersion === 1 && Array.isArray((value as ArtifactStoreFile).artifacts))
}

function kindForExtension(extension: string): ArtifactKind {
  if (['.doc', '.docx', '.md', '.txt', '.rtf', '.pages'].includes(extension)) return 'document'
  if (extension === '.pdf') return 'pdf'
  if (['.ppt', '.pptx', '.key'].includes(extension)) return 'presentation'
  if (['.xls', '.xlsx', '.csv', '.tsv', '.numbers'].includes(extension)) return 'spreadsheet'
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.heic'].includes(extension)) return 'image'
  if (['.zip', '.tar', '.gz', '.7z', '.rar'].includes(extension)) return 'archive'
  if (['.json', '.yaml', '.yml', '.xml', '.sql'].includes(extension)) return 'data'
  if (['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.swift', '.html', '.css'].includes(extension)) return 'code'
  return 'other'
}

function mimeForExtension(extension: string): string {
  return ({
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.zip': 'application/zip',
  } as Record<string, string>)[extension] || 'application/octet-stream'
}

export class ArtifactService {
  private readonly store: AtomicJsonStore<ArtifactStoreFile>
  private data: ArtifactStoreFile
  private warnings: string[]

  constructor(storePath: string) {
    this.store = new AtomicJsonStore(storePath, () => ({ schemaVersion: 1, artifacts: [] }), validStore)
    const loaded = this.store.load()
    this.data = loaded.value
    this.warnings = loaded.warnings
  }

  list(workspacePath?: string): ArtifactSnapshot {
    const normalizedWorkspace = workspacePath ? resolve(workspacePath) : undefined
    const artifacts = this.data.artifacts
      .filter(artifact => !normalizedWorkspace || artifact.workspacePath === normalizedWorkspace)
      .map(artifact => ({ ...artifact, metadata: artifact.metadata ? { ...artifact.metadata } : undefined, available: existsSync(artifact.path) }))
      .sort((left, right) => right.updatedAt - left.updatedAt)
    return { schemaVersion: 1, warnings: [...this.warnings], artifacts }
  }

  register(input: {
    path: string
    workspacePath: string
    source: ArtifactSource
    name?: string
    mime?: string
    conversationId?: string
    taskId?: string
    metadata?: Record<string, string | number | boolean>
  }): ArtifactRecord {
    const path = resolve(input.path)
    const workspacePath = resolve(input.workspacePath)
    const workspaceRelative = relative(workspacePath, path)
    const outsideWorkspace = workspaceRelative === '..' || workspaceRelative.startsWith(`..${sep}`) || isAbsolute(workspaceRelative)
    if (outsideWorkspace && input.source !== 'browser-download') throw new Error(`Artifact is outside the workspace: ${path}`)
    const info = statSync(path)
    if (!info.isFile()) throw new Error(`Artifact is not a file: ${path}`)
    const extension = extname(path).toLowerCase()
    const now = Date.now()
    const existing = this.data.artifacts.find(artifact => artifact.path === path && artifact.workspacePath === workspacePath)
    const record: ArtifactRecord = {
      id: existing?.id || `artifact-${createHash('sha256').update(`${workspacePath}\0${path}`).digest('hex').slice(0, 18)}`,
      name: input.name?.trim().slice(0, 160) || basename(path),
      path,
      workspacePath,
      kind: kindForExtension(extension),
      mime: input.mime || mimeForExtension(extension),
      size: info.size,
      source: input.source,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      available: true,
      conversationId: input.conversationId || existing?.conversationId,
      taskId: input.taskId || existing?.taskId,
      metadata: input.metadata ? { ...input.metadata } : existing?.metadata,
    }
    if (existing) Object.assign(existing, record)
    else this.data.artifacts.push(record)
    this.persist()
    return { ...record, metadata: record.metadata ? { ...record.metadata } : undefined }
  }

  remove(id: string): ArtifactSnapshot {
    const before = this.data.artifacts.length
    this.data.artifacts = this.data.artifacts.filter(artifact => artifact.id !== id)
    if (before === this.data.artifacts.length) throw new Error(`Artifact not found: ${id}`)
    this.persist()
    return this.list()
  }

  get(id: string): ArtifactRecord | null {
    const artifact = this.data.artifacts.find(item => item.id === id)
    return artifact ? { ...artifact, metadata: artifact.metadata ? { ...artifact.metadata } : undefined, available: existsSync(artifact.path) } : null
  }

  private persist(): void {
    this.store.save(this.data)
    this.warnings = []
  }
}
