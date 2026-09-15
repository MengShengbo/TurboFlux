import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path'
import type { CapabilityProfile } from '../../shared/agentTypes'

export type FilesystemAccess = 'read' | 'write'

export class CapabilityViolationError extends Error {
  readonly code = 'CAPABILITY_VIOLATION'

  constructor(
    readonly profile: CapabilityProfile,
    readonly operation: FilesystemAccess | 'command',
    readonly target?: string,
  ) {
    const detail = target ? `: ${target}` : ''
    super(`Capability profile "${profile}" does not allow ${operation}${detail}`)
    this.name = 'CapabilityViolationError'
  }
}

function resolveInputPath(workspaceRoot: string, inputPath: string): string {
  if (inputPath.includes('\0')) throw new Error('Path contains a null byte')
  if (/^[A-Za-z]:(?![\\/])/.test(inputPath)) {
    throw new Error(`Drive-relative paths are not supported: ${inputPath}`)
  }

  const value = inputPath || '.'
  const windowsWorkspace = /^[A-Za-z]:[\\/]/.test(workspaceRoot)
  const modelStyleRootedPath = windowsWorkspace && /^[\\/](?![\\/])/.test(value)
  if (modelStyleRootedPath) return resolve(workspaceRoot, value.replace(/^[\\/]+/, ''))
  return isAbsolute(value) ? resolve(value) : resolve(workspaceRoot, value)
}

function canonicalizeWithExistingAncestor(inputPath: string): string {
  let cursor = resolve(inputPath)
  const missingSegments: string[] = []

  while (!existsSync(cursor)) {
    const parent = dirname(cursor)
    if (parent === cursor) return resolve(cursor, ...missingSegments)
    missingSegments.unshift(basename(cursor))
    cursor = parent
  }

  const canonicalAncestor = realpathSync.native(cursor)
  return resolve(canonicalAncestor, ...missingSegments)
}

function isContainedBy(root: string, target: string): boolean {
  const relativePath = relative(root, target)
  return relativePath === ''
    || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
}

function hasDifferentFilesystemRoot(root: string, target: string): boolean {
  const rootVolume = parse(root).root
  const targetVolume = parse(target).root
  if (process.platform === 'win32') {
    return rootVolume.toLowerCase() !== targetVolume.toLowerCase()
  }
  return rootVolume !== targetVolume
}

export class CapabilityBoundary {
  readonly workspaceRoot: string
  private profile: CapabilityProfile

  constructor(workspacePath: string, profile: CapabilityProfile = 'workspace-write') {
    this.workspaceRoot = canonicalizeWithExistingAncestor(resolve(workspacePath))
    this.profile = profile
  }

  getProfile(): CapabilityProfile {
    return this.profile
  }

  setProfile(profile: CapabilityProfile): void {
    this.profile = profile
  }

  resolvePath(inputPath: string, access: FilesystemAccess = 'read'): string {
    const resolvedPath = resolveInputPath(this.workspaceRoot, inputPath)
    if (access === 'write' && this.profile === 'read-only') {
      throw new CapabilityViolationError(this.profile, access, resolvedPath)
    }
    if (this.profile !== 'danger-full-access' && hasDifferentFilesystemRoot(this.workspaceRoot, resolvedPath)) {
      throw new CapabilityViolationError(this.profile, access, resolvedPath)
    }

    const canonicalPath = canonicalizeWithExistingAncestor(resolvedPath)
    if (this.profile !== 'danger-full-access' && !isContainedBy(this.workspaceRoot, canonicalPath)) {
      throw new CapabilityViolationError(this.profile, access, canonicalPath)
    }
    return canonicalPath
  }

  assertCommandAllowed(): void {
    if (this.profile !== 'danger-full-access') {
      throw new CapabilityViolationError(this.profile, 'command')
    }
  }
}
