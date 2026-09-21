import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { AtomicJsonStore } from '@turboflux/platform/atomicJsonStore'

export interface ProjectRecord {
  id: string
  name: string
  path: string
  pinned: boolean
  tags: string[]
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
  available: boolean
  lastConversationId?: string
}

export interface ProjectSnapshot {
  schemaVersion: 1
  warnings: string[]
  projects: ProjectRecord[]
}

interface ProjectStoreFile {
  schemaVersion: 1
  projects: ProjectRecord[]
  removedProjectIds?: string[]
}

function validStore(value: unknown): value is ProjectStoreFile {
  if (!value || typeof value !== 'object') return false
  const store = value as ProjectStoreFile
  return store.schemaVersion === 1 && Array.isArray(store.projects)
    && (store.removedProjectIds === undefined || (Array.isArray(store.removedProjectIds) && store.removedProjectIds.every(id => typeof id === 'string')))
}

function normalizeTags(tags: unknown): string[] {
  return Array.isArray(tags)
    ? [...new Set(tags.map(String).map(tag => tag.trim()).filter(Boolean).map(tag => tag.slice(0, 40)))].slice(0, 20)
    : []
}

function availableDirectory(path: string): boolean {
  try { return existsSync(path) && statSync(path).isDirectory() } catch { return false }
}

function projectPathId(path: string): string {
  return `project-${createHash('sha256').update(resolve(path)).digest('hex').slice(0, 16)}`
}

export class ProjectService {
  private readonly store: AtomicJsonStore<ProjectStoreFile>
  private data: ProjectStoreFile
  private warnings: string[]

  constructor(storePath: string) {
    this.store = new AtomicJsonStore<ProjectStoreFile>(storePath, () => ({ schemaVersion: 1, projects: [] }), validStore)
    const loaded = this.store.load()
    this.data = loaded.value
    this.warnings = loaded.warnings
  }

  list(): ProjectSnapshot {
    const projects = this.data.projects
      .map(project => ({ ...project, tags: [...project.tags], available: availableDirectory(project.path) }))
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.lastOpenedAt - left.lastOpenedAt)
    return { schemaVersion: 1, warnings: [...this.warnings], projects }
  }

  add(path: string, options: { name?: string; tags?: string[]; pinned?: boolean; conversationId?: string } = {}): ProjectSnapshot {
    const normalizedPath = resolve(path)
    if (!availableDirectory(normalizedPath)) throw new Error(`Project folder is unavailable: ${normalizedPath}`)
    this.data.removedProjectIds = (this.data.removedProjectIds || []).filter(id => id !== projectPathId(normalizedPath))
    const now = Date.now()
    const existing = this.data.projects.find(project => project.path === normalizedPath)
    if (existing) {
      existing.name = options.name?.trim().slice(0, 120) || existing.name
      existing.tags = options.tags ? normalizeTags(options.tags) : existing.tags
      existing.pinned = options.pinned ?? existing.pinned
      existing.lastConversationId = options.conversationId || existing.lastConversationId
      existing.lastOpenedAt = now
      existing.updatedAt = now
    } else {
      this.data.projects.push({
        id: projectPathId(normalizedPath),
        name: options.name?.trim().slice(0, 120) || basename(normalizedPath) || normalizedPath,
        path: normalizedPath,
        pinned: options.pinned === true,
        tags: normalizeTags(options.tags),
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: now,
        available: true,
        lastConversationId: options.conversationId,
      })
    }
    this.persist()
    return this.list()
  }

  update(id: string, patch: { name?: string; pinned?: boolean; tags?: string[] }): ProjectSnapshot {
    const project = this.requireProject(id)
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, 120)
      if (!name) throw new Error('Project name cannot be empty')
      project.name = name
    }
    if (patch.pinned !== undefined) project.pinned = patch.pinned
    if (patch.tags !== undefined) project.tags = normalizeTags(patch.tags)
    project.updatedAt = Date.now()
    this.persist()
    return this.list()
  }

  recordOpened(path: string, conversationId?: string): ProjectSnapshot {
    // Opening retained history must not restore a workspace the user removed.
    if (this.data.removedProjectIds?.includes(projectPathId(path))) return this.list()
    return this.add(path, { conversationId })
  }

  remove(id: string): ProjectSnapshot {
    const project = this.requireProject(id)
    this.data.removedProjectIds = [...new Set([...(this.data.removedProjectIds || []), projectPathId(project.path)])]
    this.data.projects = this.data.projects.filter(project => project.id !== id)
    this.persist()
    return this.list()
  }

  get(id: string): ProjectRecord | null {
    const project = this.data.projects.find(item => item.id === id)
    return project ? { ...project, tags: [...project.tags], available: availableDirectory(project.path) } : null
  }

  private requireProject(id: string): ProjectRecord {
    const project = this.data.projects.find(item => item.id === id)
    if (!project) throw new Error(`Project not found: ${id}`)
    return project
  }

  private persist(): void {
    this.store.save(this.data)
    this.warnings = []
  }
}
