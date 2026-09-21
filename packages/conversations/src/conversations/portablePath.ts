import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { PortablePathRef } from './conversationV2Types'

const PORTABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export class PortablePathError extends Error {
  constructor(
    readonly code: 'INVALID_REFERENCE' | 'WORKSPACE_UNBOUND' | 'PATH_ESCAPE' | 'PATH_UNAVAILABLE',
    message: string,
  ) {
    super(message)
    this.name = 'PortablePathError'
  }
}

function normalizeRelativePath(value: string): string {
  if (value.includes('\0') || value.includes('\\')) throw new PortablePathError('INVALID_REFERENCE', 'Portable paths must use forward slashes')
  if (isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith('//')) throw new PortablePathError('INVALID_REFERENCE', 'Portable paths cannot be absolute')
  const segments = value.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.some(segment => segment === '..')) throw new PortablePathError('PATH_ESCAPE', 'Portable path escapes its root')
  return segments.join('/')
}

function validId(value: string): boolean {
  return PORTABLE_ID_PATTERN.test(value)
}

export function normalizePortablePathRef(ref: PortablePathRef): PortablePathRef {
  switch (ref.scheme) {
    case 'workspace':
      if (!validId(ref.workspaceId)) throw new PortablePathError('INVALID_REFERENCE', 'Invalid workspace identity')
      return { ...ref, relativePath: normalizeRelativePath(ref.relativePath) }
    case 'artifact':
      if (!validId(ref.artifactId)) throw new PortablePathError('INVALID_REFERENCE', 'Invalid artifact identity')
      return { ...ref }
    case 'profile':
      return { ...ref, relativePath: normalizeRelativePath(ref.relativePath) }
    case 'external':
      return { ...ref, displayPath: ref.displayPath.trim().slice(0, 512) }
  }
}

export function serializePortablePathRef(ref: PortablePathRef): string {
  const normalized = normalizePortablePathRef(ref)
  switch (normalized.scheme) {
    case 'workspace':
      return `workspace://${normalized.workspaceId}/${normalized.relativePath.split('/').map(encodeURIComponent).join('/')}`
    case 'artifact':
      return `artifact://${normalized.artifactId}`
    case 'profile':
      return `profile:///${normalized.relativePath.split('/').map(encodeURIComponent).join('/')}`
    case 'external':
      return `external://${normalized.portability}/${encodeURIComponent(normalized.displayPath)}`
  }
}

export function parsePortablePathRef(value: string): PortablePathRef {
  let url: URL
  try { url = new URL(value) } catch { throw new PortablePathError('INVALID_REFERENCE', 'Invalid portable path URI') }
  const decodePath = () => url.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment)).join('/')
  switch (url.protocol) {
    case 'workspace:':
      return normalizePortablePathRef({ scheme: 'workspace', workspaceId: url.hostname, relativePath: decodePath() })
    case 'artifact:':
      return normalizePortablePathRef({ scheme: 'artifact', artifactId: url.hostname })
    case 'profile:':
      return normalizePortablePathRef({ scheme: 'profile', relativePath: decodePath() })
    case 'external:': {
      const portability = url.hostname
      if (portability !== 'redacted' && portability !== 'unavailable') throw new PortablePathError('INVALID_REFERENCE', 'Invalid external path portability')
      return normalizePortablePathRef({ scheme: 'external', portability, displayPath: decodeURIComponent(url.pathname.slice(1)) })
    }
    default:
      throw new PortablePathError('INVALID_REFERENCE', 'Unsupported portable path scheme')
  }
}

export interface PortablePathBindings {
  workspaceRoot(workspaceId: string): string | null
  artifactPath(artifactId: string): string | null
  profileRoot(): string
}

function withinRoot(root: string, candidate: string): boolean {
  const delta = relative(root, candidate)
  return delta === '' || (!delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta))
}

export class WorkspacePathResolver {
  constructor(private readonly bindings: PortablePathBindings) {}

  resolve(ref: PortablePathRef): string {
    const normalized = normalizePortablePathRef(ref)
    if (normalized.scheme === 'external') throw new PortablePathError('PATH_UNAVAILABLE', 'External path references are display-only')
    if (normalized.scheme === 'artifact') {
      const artifactPath = this.bindings.artifactPath(normalized.artifactId)
      if (!artifactPath) throw new PortablePathError('PATH_UNAVAILABLE', 'Artifact is unavailable on this device')
      return artifactPath
    }
    const root = normalized.scheme === 'workspace'
      ? this.bindings.workspaceRoot(normalized.workspaceId)
      : this.bindings.profileRoot()
    if (!root) throw new PortablePathError('WORKSPACE_UNBOUND', 'Workspace must be bound before this path can be used')
    const canonicalRoot = realpathSync(root)
    const candidate = resolve(canonicalRoot, normalized.relativePath)
    if (!withinRoot(canonicalRoot, candidate)) throw new PortablePathError('PATH_ESCAPE', 'Resolved path escapes its root')

    try {
      const stats = statSync(candidate)
      const canonicalCandidate = realpathSync(candidate)
      if (!withinRoot(canonicalRoot, canonicalCandidate)) throw new PortablePathError('PATH_ESCAPE', 'Resolved symlink escapes its root')
      if (!stats.isFile() && !stats.isDirectory()) throw new PortablePathError('PATH_UNAVAILABLE', 'Resolved path is not a file or directory')
      return canonicalCandidate
    } catch (error) {
      if (error instanceof PortablePathError) throw error
      const parent = realpathSync(resolve(candidate, '..'))
      if (!withinRoot(canonicalRoot, parent)) throw new PortablePathError('PATH_ESCAPE', 'Resolved parent escapes its root')
      return candidate
    }
  }
}
