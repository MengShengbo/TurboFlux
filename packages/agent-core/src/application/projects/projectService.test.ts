import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectService } from './projectService'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('ProjectService', () => {
  it('deduplicates normalized paths and survives restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-projects-'))
    directories.push(root)
    const project = join(root, 'workspace')
    mkdirSync(project)
    const store = join(root, 'projects.json')
    const service = new ProjectService(store)
    service.add(project, { name: 'First' })
    service.add(join(project, '.'), { name: 'Renamed', pinned: true })
    const restarted = new ProjectService(store).list()
    expect(restarted.projects).toHaveLength(1)
    expect(restarted.projects[0]).toMatchObject({ name: 'Renamed', pinned: true, available: true })
  })

  it('keeps missing projects visible as unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-projects-'))
    directories.push(root)
    const project = join(root, 'workspace')
    mkdirSync(project)
    const service = new ProjectService(join(root, 'projects.json'))
    service.add(project)
    rmSync(project, { recursive: true })
    expect(service.list().projects[0].available).toBe(false)
  })
})
