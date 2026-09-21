import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CapabilityBoundary, CapabilityViolationError } from './capabilityBoundary'

function withDirectories(run: (workspace: string, outside: string) => void): void {
  const workspace = mkdtempSync(join(tmpdir(), 'turboflux-capability-workspace-'))
  const outside = mkdtempSync(join(tmpdir(), 'turboflux-capability-outside-'))
  try {
    run(workspace, outside)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
}

describe('CapabilityBoundary', () => {
  it('keeps workspace reads and writes inside the canonical root', () => withDirectories((workspace) => {
    const boundary = new CapabilityBoundary(workspace)

    expect(boundary.resolvePath('src/file.ts', 'read')).toBe(resolve(boundary.workspaceRoot, 'src/file.ts'))
    expect(boundary.resolvePath('src/file.ts', 'write')).toBe(resolve(boundary.workspaceRoot, 'src/file.ts'))
  }))

  it('blocks absolute and parent traversal escapes by default', () => withDirectories((workspace, outside) => {
    const boundary = new CapabilityBoundary(workspace)

    expect(() => boundary.resolvePath(join(outside, 'secret.txt'))).toThrow(CapabilityViolationError)
    expect(() => boundary.resolvePath(join('..', 'secret.txt'))).toThrow(CapabilityViolationError)
  }))

  it('blocks symlink and junction escapes for existing and missing targets', () => withDirectories((workspace, outside) => {
    writeFileSync(join(outside, 'secret.txt'), 'outside', 'utf-8')
    const linkPath = join(workspace, 'linked')
    try {
      symlinkSync(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return
    }

    const boundary = new CapabilityBoundary(workspace)
    expect(() => boundary.resolvePath(join(linkPath, 'secret.txt'))).toThrow(CapabilityViolationError)
    expect(() => boundary.resolvePath(join(linkPath, 'missing.txt'), 'write')).toThrow(CapabilityViolationError)
  }))

  it('blocks all writes and commands in read-only mode', () => withDirectories((workspace) => {
    const boundary = new CapabilityBoundary(workspace, 'read-only')

    expect(() => boundary.resolvePath('new.txt', 'write')).toThrow(CapabilityViolationError)
    expect(() => boundary.assertCommandAllowed()).toThrow(CapabilityViolationError)
    expect(boundary.resolvePath('existing.txt', 'read')).toBe(resolve(boundary.workspaceRoot, 'existing.txt'))
  }))

  it('allows external paths and commands only in danger-full-access mode', () => withDirectories((workspace, outside) => {
    const boundary = new CapabilityBoundary(workspace, 'danger-full-access')

    expect(boundary.resolvePath(join(outside, 'new.txt'), 'write')).toBe(resolve(new CapabilityBoundary(outside).workspaceRoot, 'new.txt'))
    expect(() => boundary.assertCommandAllowed()).not.toThrow()
  }))

  it('rejects cross-drive and UNC paths before filesystem access on Windows', () => {
    if (process.platform !== 'win32') return
    withDirectories((workspace) => {
      const boundary = new CapabilityBoundary(workspace)
      const alternateDrive = workspace[0].toUpperCase() === 'Z' ? 'Y' : 'Z'

      expect(() => boundary.resolvePath(`${alternateDrive}:\\external\\file.txt`)).toThrow(CapabilityViolationError)
      expect(() => boundary.resolvePath('\\\\invalid-host\\share\\file.txt')).toThrow(CapabilityViolationError)
    })
  })
})
