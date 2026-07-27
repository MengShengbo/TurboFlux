import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import type { SandboxPolicy } from '../../shared/agentTypes'

export class GuardedCommandPolicy {
  private readonly workspaceRoot: string
  private readonly workspaceRealRoot: string

  constructor(workspacePath: string, private readonly policy: SandboxPolicy) {
    this.workspaceRoot = resolve(workspacePath)
    this.workspaceRealRoot = existsSync(this.workspaceRoot) ? realpathSync.native(this.workspaceRoot) : this.workspaceRoot
  }

  validate(command: string, cwd: string): void {
    if (this.policy === 'readonly') throw new Error('Sandbox is read-only: command execution is disabled')
    if (this.policy === 'full') return
    this.ensureWithinWorkspace(cwd)
    for (const candidate of extractAbsolutePathCandidates(command)) {
      if (this.isSystemExecutableCandidate(candidate, command)) continue
      try {
        this.ensureWithinWorkspace(candidate)
      } catch {
        throw new Error(`Sandbox blocked command because it references a path outside the workspace: ${candidate}`)
      }
    }
    for (const candidate of extractRelativeTraversalCandidates(command)) {
      try {
        this.ensureWithinWorkspace(resolve(cwd, candidate))
      } catch {
        throw new Error(`Sandbox blocked command because it references a relative path outside the workspace: ${candidate}`)
      }
    }
  }

  validateEnvironmentValue(name: string, value: string, cwd: string): void {
    if (this.policy !== 'workspace') return
    for (const candidate of extractAbsolutePathCandidates(value)) {
      try {
        this.ensureWithinWorkspace(candidate)
      } catch {
        throw new Error(`Sandbox blocked environment variable ${name} because it references a path outside the workspace: ${candidate}`)
      }
    }
    for (const candidate of extractRelativeTraversalCandidates(value)) {
      try {
        this.ensureWithinWorkspace(resolve(cwd, candidate))
      } catch {
        throw new Error(`Sandbox blocked environment variable ${name} because it references a relative path outside the workspace: ${candidate}`)
      }
    }
  }

  private isSystemExecutableCandidate(candidate: string, command: string): boolean {
    const trimmed = command.trimStart()
    return trimmed === candidate || trimmed.startsWith(`${candidate} `)
  }

  private ensureWithinWorkspace(path: string): void {
    const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(this.workspaceRoot, path)
    const canonicalPath = resolveRealPath(resolvedPath)
    const relativePath = relative(this.workspaceRealRoot, canonicalPath)
    if (relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))) return
    throw new Error(`Path outside workspace: ${path}`)
  }
}

function resolveRealPath(path: string): string {
  if (existsSync(path)) return realpathSync.native(path)
  const missingParts: string[] = []
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    missingParts.unshift(basename(current))
    current = parent
  }
  const existingParent = existsSync(current) ? realpathSync.native(current) : current
  return resolve(existingParent, ...missingParts)
}

function extractAbsolutePathCandidates(command: string): string[] {
  const candidates = new Set<string>()
  const windowsPath = /\b[A-Za-z]:[\\/][^\s"'`|;&<>)]*/g
  for (const match of command.matchAll(windowsPath)) candidates.add(match[0])
  if (process.platform === 'win32') return [...candidates]
  const posixPath = /(^|[\s"'`=])\/[^\s"'`|;&<>)]*/g
  for (const match of command.matchAll(posixPath)) {
    const value = match[0].trim().replace(/^["'`=]/, '')
    if (!value.startsWith('//') && !value.startsWith('/?')) candidates.add(value)
  }
  return [...candidates]
}

function extractRelativeTraversalCandidates(command: string): string[] {
  const candidates = new Set<string>()
  for (const match of command.matchAll(/[^\s"'`|;&<>]+/g)) {
    for (const rawPart of match[0].split('=')) {
      const value = rawPart.replace(/^[([{]+/, '').replace(/[)\]},]+$/, '')
      const normalized = value.replace(/\\/g, '/')
      if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../') || normalized.endsWith('/..')) {
        candidates.add(value)
      }
    }
  }
  return [...candidates]
}
