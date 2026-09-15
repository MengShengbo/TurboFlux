import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceOverlayMigration } from './workspaceOverlayMigration'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-overlay-migration-'))
  const workspacePath = join(root, 'workspace')
  const overlayRoot = join(root, 'profile', 'workspaces', 'workspace-test0001')
  roots.push(root)
  mkdirSync(join(workspacePath, '.turboflux', 'memory'), { recursive: true })
  mkdirSync(join(workspacePath, '.turboflux', 'skills', 'shared-skill'), { recursive: true })
  mkdirSync(join(workspacePath, '.turboflux', 'browser-captures'), { recursive: true })
  writeFileSync(join(workspacePath, '.turboflux', 'memory', 'facts.jsonl'), '{"id":"legacy","text":"private"}\n')
  writeFileSync(join(workspacePath, '.turboflux', 'skills', 'shared-skill', 'SKILL.md'), '# Shared')
  writeFileSync(join(workspacePath, '.turboflux', 'browser-captures', 'capture.png'), 'image')
  return { workspacePath, overlayRoot }
}

describe('WorkspaceOverlayMigration', () => {
  it('stages and verifies private workspace data without moving project declarations', () => {
    const { workspacePath, overlayRoot } = setup()
    const migration = new WorkspaceOverlayMigration('workspace-test0001', workspacePath, overlayRoot)

    const result = migration.migrate()

    expect(result.status).toBe('completed')
    expect(readFileSync(join(overlayRoot, 'memory', 'facts.jsonl'), 'utf8')).toContain('private')
    expect(existsSync(join(overlayRoot, 'captures', 'browser', 'capture.png'))).toBe(true)
    expect(existsSync(join(overlayRoot, 'skills'))).toBe(false)
    expect(existsSync(join(workspacePath, '.turboflux', 'memory', 'facts.jsonl'))).toBe(true)
    expect(migration.migrate()).toEqual(result)
  })

  it('fails closed instead of overwriting conflicting overlay data', () => {
    const { workspacePath, overlayRoot } = setup()
    mkdirSync(join(overlayRoot, 'memory'), { recursive: true })
    writeFileSync(join(overlayRoot, 'memory', 'facts.jsonl'), 'new-profile-data')

    const result = new WorkspaceOverlayMigration('workspace-test0001', workspacePath, overlayRoot).migrate()

    expect(result.status).toBe('failed')
    expect(result.steps.find(step => step.id === 'memory')?.error).toContain('conflicts')
    expect(readFileSync(join(overlayRoot, 'memory', 'facts.jsonl'), 'utf8')).toBe('new-profile-data')
  })
})
