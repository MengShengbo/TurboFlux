import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parsePortablePathRef,
  PortablePathError,
  serializePortablePathRef,
  WorkspacePathResolver,
} from './portablePath'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'turboflux-portable-path-'))
  roots.push(value)
  return value
}

describe('portable paths', () => {
  it('round-trips workspace paths with unicode and spaces', () => {
    const ref = { scheme: 'workspace' as const, workspaceId: 'workspace-1', relativePath: 'src/你好 world.ts' }
    expect(parsePortablePathRef(serializePortablePathRef(ref))).toEqual(ref)
  })

  it.each(['../secret', '/etc/passwd', 'C:/secret', '//server/share', 'safe\\windows'])('rejects unsafe relative path %s', relativePath => {
    expect(() => serializePortablePathRef({ scheme: 'workspace', workspaceId: 'workspace-1', relativePath })).toThrow(PortablePathError)
  })

  it('requires a bound workspace and resolves safe files', () => {
    const directory = root()
    mkdirSync(join(directory, 'src'))
    writeFileSync(join(directory, 'src', 'index.ts'), 'ok')
    const resolver = new WorkspacePathResolver({
      workspaceRoot: id => id === 'workspace-1' ? directory : null,
      artifactPath: () => null,
      profileRoot: () => directory,
    })
    expect(resolver.resolve({ scheme: 'workspace', workspaceId: 'workspace-1', relativePath: 'src/index.ts' })).toBe(realpathSync(join(directory, 'src', 'index.ts')))
    expect(() => resolver.resolve({ scheme: 'workspace', workspaceId: 'missing', relativePath: 'src/index.ts' })).toThrowError(expect.objectContaining({ code: 'WORKSPACE_UNBOUND' }))
  })

  it('rejects symlinks escaping the workspace root', () => {
    const workspace = root()
    const outside = root()
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(outside, join(workspace, 'escape'))
    const resolver = new WorkspacePathResolver({
      workspaceRoot: () => workspace,
      artifactPath: () => null,
      profileRoot: () => workspace,
    })
    expect(() => resolver.resolve({ scheme: 'workspace', workspaceId: 'workspace-1', relativePath: 'escape/secret.txt' })).toThrowError(expect.objectContaining({ code: 'PATH_ESCAPE' }))
  })
})
