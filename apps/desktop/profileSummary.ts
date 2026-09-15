import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

interface PersistedConversationCatalog {
  version: 1
  entries: Array<{
    visible?: unknown
    meta?: {
      id?: unknown
      title?: unknown
      workspacePath?: unknown
      updatedAt?: unknown
      turnCount?: unknown
    }
  }>
}

interface PersistedConversationCatalogV2 {
  schemaVersion: 1
  records: Array<{
    id?: unknown
    title?: unknown
    workspaceId?: unknown
    status?: unknown
    updatedAt?: unknown
    turnCount?: unknown
  }>
}

export interface ProfileConversationSummary {
  id: string
  title: string
  workspaceId?: string
  workspacePath?: string
  status: 'active' | 'idle' | 'needs_workspace'
  updatedAt: number
  turnCount: number
}

export interface ProfileWorkspaceSummaryInput {
  localPath?: unknown
  state?: unknown
}

interface ProfileDirectorySummaryFileSystem {
  readDirectory(path: string): Promise<Array<{ name: string }>>
  inspectPath(path: string): Promise<{
    isDirectory(): boolean
    isFile(): boolean
    isSymbolicLink(): boolean
    size: number
  }>
}

const profileDirectoryFileSystem: ProfileDirectorySummaryFileSystem = {
  readDirectory: path => readdir(path, { withFileTypes: true }),
  inspectPath: path => lstat(path),
}

function isTransientProfilePathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function comparablePath(path: string): string {
  const normalized = resolve(path).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function countVisibleProfileWorkspaces(
  workspaces: ProfileWorkspaceSummaryInput[],
  excludedPaths: string[] = [],
): { bound: number; unbound: number } {
  const visible = filterVisibleProfileWorkspaces(workspaces, excludedPaths)
  return {
    bound: visible.filter(workspace => workspace.state === 'bound').length,
    unbound: visible.filter(workspace => workspace.state !== 'bound').length,
  }
}

export function filterVisibleProfileWorkspaces<T extends ProfileWorkspaceSummaryInput>(
  workspaces: T[],
  excludedPaths: string[] = [],
): T[] {
  const excluded = new Set(excludedPaths.map(comparablePath))
  return workspaces.filter(workspace => (
    typeof workspace.localPath !== 'string' || !excluded.has(comparablePath(workspace.localPath))
  ))
}

async function readProfileConversationCatalog(profileRoot: string): Promise<ProfileConversationSummary[] | null> {
  try {
    const parsed = JSON.parse(await readFile(join(profileRoot, 'conversations-v2', 'catalog.json'), 'utf8')) as PersistedConversationCatalogV2
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.records)) throw new Error('Unsupported Conversation V2 catalog')
    return parsed.records
      .filter(record => typeof record.id === 'string'
        && typeof record.title === 'string'
        && typeof record.updatedAt === 'number'
        && typeof record.turnCount === 'number'
        && (record.status === 'active' || record.status === 'idle' || record.status === 'needs_workspace'))
      .map(record => ({
        id: record.id as string,
        title: record.title as string,
        ...(typeof record.workspaceId === 'string' ? { workspaceId: record.workspaceId } : {}),
        status: record.status as ProfileConversationSummary['status'],
        updatedAt: record.updatedAt as number,
        turnCount: record.turnCount as number,
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
  } catch {}
  try {
    const parsed = JSON.parse(await readFile(join(profileRoot, 'conversations', '.conversation-catalog-v1.json'), 'utf8')) as PersistedConversationCatalog
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('Unsupported conversation catalog')
    return parsed.entries
      .filter(entry => entry.visible === true
        && typeof entry.meta?.id === 'string'
        && typeof entry.meta.title === 'string'
        && typeof entry.meta.updatedAt === 'number'
        && typeof entry.meta.turnCount === 'number')
      .map(entry => ({
        id: entry.meta!.id as string,
        title: entry.meta!.title as string,
        ...(typeof entry.meta!.workspacePath === 'string' ? { workspacePath: entry.meta!.workspacePath } : {}),
        status: 'idle' as const,
        updatedAt: entry.meta!.updatedAt as number,
        turnCount: entry.meta!.turnCount as number,
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
  } catch {
    return null
  }
}

export async function listVisibleProfileConversations(profileRoot: string): Promise<ProfileConversationSummary[]> {
  return await readProfileConversationCatalog(profileRoot) ?? []
}

export async function countVisibleProfileConversations(profileRoot: string): Promise<number> {
  const catalog = await readProfileConversationCatalog(profileRoot)
  if (catalog) return new Set(catalog.map(conversation => conversation.id)).size
  const entries = await readdir(join(profileRoot, 'conversations')).catch(() => [])
  return new Set(entries
    .filter(name => /\.(?:json|jsonl)$/u.test(name) && !name.startsWith('.'))
    .map(name => name.replace(/\.(?:json|jsonl)$/u, ''))).size
}

export async function summarizeProfileDirectory(
  root: string,
  fileSystem: ProfileDirectorySummaryFileSystem = profileDirectoryFileSystem,
): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  const visit = async (directory: string): Promise<void> => {
    let entries: Array<{ name: string }>
    try {
      entries = await fileSystem.readDirectory(directory)
    } catch (error) {
      if (isTransientProfilePathError(error)) return
      throw error
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      let info: Awaited<ReturnType<ProfileDirectorySummaryFileSystem['inspectPath']>>
      try {
        info = await fileSystem.inspectPath(path)
      } catch (error) {
        if (isTransientProfilePathError(error)) continue
        throw error
      }
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) await visit(path)
      else if (info.isFile()) { files += 1; bytes += info.size }
    }
  }
  await visit(root)
  return { bytes, files }
}
