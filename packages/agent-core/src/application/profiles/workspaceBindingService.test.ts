import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProfileStorageLayout, ensureProfileStorageLayout } from './profileStorageLayout'
import { WorkspaceBindingService } from './workspaceBindingService'

const roots: string[] = []

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-bindings-'))
  roots.push(root)
  const workspace = join(root, 'project-a')
  mkdirSync(workspace)
  const layout = createProfileStorageLayout(join(root, 'data'), join(root, 'device'), 'profile-1')
  ensureProfileStorageLayout(layout)
  let sequence = 0
  return { root, workspace, layout, service: new WorkspaceBindingService(layout, () => 100 + sequence, () => `workspace-id-${String(++sequence).padStart(5, '0')}`) }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('WorkspaceBindingService', () => {
  it('uses UUIDs for newly created workspace identities', () => {
    const { root, workspace } = setup()
    const layout = createProfileStorageLayout(join(root, 'uuid-data'), join(root, 'uuid-device'), 'profile-uuid')
    ensureProfileStorageLayout(layout)
    expect(new WorkspaceBindingService(layout, () => 100).ensureBound(workspace).id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
  })

  it('assigns stable random workspace identities instead of deriving identity from paths', () => {
    const { workspace, service, layout } = setup()
    const first = service.ensureBound(workspace)
    const repeated = service.ensureBound(workspace)
    expect(first.id).toBe('workspace-id-00001')
    expect(repeated.id).toBe(first.id)
    expect(service.overlayRoot(first.id)).toBe(join(layout.workspaceOverlaysRoot, first.id))
  })

  it('imports workspaces unbound and requires explicit mismatch acceptance', () => {
    const { root, service } = setup()
    const imported = service.addUnbound({
      id: 'workspace-imported-1234',
      displayName: 'Original',
      sourceHint: { platform: 'win32', folderName: 'expected-folder' },
    })
    const different = join(root, 'different-folder')
    mkdirSync(different)
    const mismatch = service.bind(imported.id, different)
    expect(mismatch.state).toBe('mismatch')
    expect(mismatch.localPath).toBeUndefined()
    expect(service.bind(imported.id, different, true)).toMatchObject({ state: 'bound', localPath: different })
  })

  it('verifies git fingerprints without exposing credentials and resolves portable paths only after binding', () => {
    const { root, workspace, service } = setup()
    mkdirSync(join(workspace, '.git'))
    writeFileSync(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(workspace, '.git', 'config'), '[remote "origin"]\n  url = https://secret-user:secret-password@example.test/repo.git\n')
    const bound = service.ensureBound(workspace, 'project-a')
    expect(bound.sourceHint?.gitRemotes).toEqual(['https://example.test/repo.git'])
    expect(service.verify(bound.id, workspace)).toMatchObject({ state: 'bound', reasons: [] })
    const file = join(workspace, 'README.md')
    writeFileSync(file, 'ok')
    expect(service.pathResolver().resolve({ scheme: 'workspace', workspaceId: bound.id, relativePath: 'README.md' })).toContain('README.md')

    const different = join(root, 'project-b')
    mkdirSync(join(different, '.git'), { recursive: true })
    writeFileSync(join(different, '.git', 'HEAD'), 'ref: refs/heads/other\n')
    expect(service.verify(bound.id, different)).toMatchObject({ state: 'mismatch' })
  })
})
