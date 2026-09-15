import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactService } from './artifactService'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('ArtifactService', () => {
  it('classifies, deduplicates, and reloads workspace artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-artifact-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const path = join(workspace, 'report.pdf')
    writeFileSync(path, 'pdf')
    const store = join(root, 'artifacts.json')
    const service = new ArtifactService(store)
    const first = service.register({ path, workspacePath: workspace, source: 'agent' })
    writeFileSync(path, 'updated')
    const second = service.register({ path, workspacePath: workspace, source: 'automation' })
    expect(second.id).toBe(first.id)
    expect(new ArtifactService(store).list(workspace).artifacts).toMatchObject([{ kind: 'pdf', source: 'automation', size: 7, available: true }])
  })

  it('blocks ambient paths but accepts explicit browser downloads', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-artifact-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const outside = join(root, 'download.csv')
    writeFileSync(outside, 'a,b')
    const service = new ArtifactService(join(root, 'artifacts.json'))
    expect(() => service.register({ path: outside, workspacePath: workspace, source: 'agent' })).toThrow('outside the workspace')
    expect(service.register({ path: outside, workspacePath: workspace, source: 'browser-download' }).kind).toBe('spreadsheet')
    rmSync(outside)
    expect(service.list(workspace).artifacts[0].available).toBe(false)
  })
})
