import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LegacyProfileMigration } from './legacyProfileMigration'
import { createProfileStorageLayout, ensureProfileStorageLayout } from './profileStorageLayout'

const roots: string[] = []

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-legacy-profile-'))
  roots.push(root)
  const legacyConfigRoot = join(root, 'legacy-config')
  const legacyPlatformRoot = join(root, 'legacy-platform')
  mkdirSync(join(legacyConfigRoot, 'conversations'), { recursive: true })
  mkdirSync(join(legacyConfigRoot, 'skills', 'legacy-skill'), { recursive: true })
  mkdirSync(legacyPlatformRoot, { recursive: true })
  mkdirSync(join(legacyPlatformRoot, 'plugins', 'legacy-plugin'), { recursive: true })
  mkdirSync(join(root, 'legacy-remote'), { recursive: true })
  writeFileSync(join(legacyConfigRoot, 'config.json'), '{"model":"test"}')
  writeFileSync(join(legacyConfigRoot, 'credentials.json'), '{"apiKey":"legacy"}')
  writeFileSync(join(legacyConfigRoot, 'profile.json'), '{"interfaceLanguage":"zh-CN"}')
  writeFileSync(join(legacyConfigRoot, 'settings.json'), '{"mcpServers":{}}')
  writeFileSync(join(legacyConfigRoot, 'conversations', 'conversation-1.jsonl'), '{"type":"snapshot"}\n')
  writeFileSync(join(legacyConfigRoot, 'skills', 'legacy-skill', 'SKILL.md'), '# Legacy Skill')
  writeFileSync(join(legacyPlatformRoot, 'projects.json'), '{"schemaVersion":1,"projects":[]}')
  writeFileSync(join(legacyPlatformRoot, 'automations.json'), '{"schemaVersion":1,"automations":[]}')
  writeFileSync(join(legacyPlatformRoot, 'artifacts.json'), '{"schemaVersion":1,"artifacts":[]}')
  writeFileSync(join(legacyPlatformRoot, 'managed-task-titles.json'), '{"version":1,"entries":{}}')
  writeFileSync(join(legacyPlatformRoot, 'plugins.json'), '{"schemaVersion":1,"plugins":[]}')
  writeFileSync(join(legacyPlatformRoot, 'plugins', 'legacy-plugin', 'plugin.json'), '{"id":"legacy-plugin"}')
  writeFileSync(join(root, 'legacy-remote', 'preferences.json'), '{"schemaVersion":1,"enabled":false}')
  const layout = createProfileStorageLayout(join(root, 'data'), join(root, 'device'), 'profile-default')
  ensureProfileStorageLayout(layout)
  return { root, legacyConfigRoot, legacyPlatformRoot, legacyRemoteRoot: join(root, 'legacy-remote'), layout }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('LegacyProfileMigration', () => {
  it('builds a read-only source plan with counts, digests, and space budget', () => {
    const { root, legacyConfigRoot, legacyPlatformRoot, layout } = setup()
    const migrationRoot = join(root, 'migration')
    const migration = new LegacyProfileMigration({ legacyConfigRoot, legacyPlatformRoot, migrationRoot, layout, availableBytes: () => 1024 * 1024 * 1024 })

    const plan = migration.plan()

    expect(plan.sufficientSpace).toBe(true)
    expect(plan.files).toBeGreaterThanOrEqual(3)
    expect(plan.bytes).toBeGreaterThan(0)
    expect(plan.steps.find(step => step.id === 'config')).toMatchObject({ exists: true, blocked: false, files: 1 })
    expect(plan.steps.find(step => step.id === 'config')?.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(existsSync(migrationRoot)).toBe(false)
    expect(existsSync(layout.configPath)).toBe(false)
  })

  it('copies legacy data into the default profile without deleting its source', () => {
    const { root, legacyConfigRoot, legacyPlatformRoot, legacyRemoteRoot, layout } = setup()
    let now = 100
    const migration = new LegacyProfileMigration({
      legacyConfigRoot,
      legacyPlatformRoot,
      legacyRemoteRoot,
      migrationRoot: join(root, 'migration'),
      layout,
      now: () => now++,
    })

    const result = migration.migrate()
    expect(result.status).toBe('completed')
    expect(readFileSync(layout.configPath, 'utf8')).toContain('test')
    expect(existsSync(join(layout.conversationsRoot, 'conversation-1.jsonl'))).toBe(true)
    expect(existsSync(join(legacyConfigRoot, 'config.json'))).toBe(true)
    expect(existsSync(join(layout.remoteRoot, 'preferences.json'))).toBe(true)
    expect(existsSync(join(layout.userSkillsRoot, 'legacy-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(layout.pluginsRoot, 'legacy-plugin', 'plugin.json'))).toBe(true)
    expect(existsSync(layout.automationsPath)).toBe(true)
    expect(existsSync(layout.artifactsPath)).toBe(true)
    expect(existsSync(layout.managedTaskTitlesPath)).toBe(true)
    expect(existsSync(join(layout.profileRoot, 'migration-receipt.json'))).toBe(true)
    const receipt = JSON.parse(readFileSync(join(layout.profileRoot, 'migration-receipt.json'), 'utf8')) as {
      planned: { files: number; bytes: number }
      migrated: { files: number; bytes: number }
      legacySourcesRetained: boolean
    }
    expect(receipt.migrated).toEqual(receipt.planned)
    expect(receipt.legacySourcesRetained).toBe(true)
    expect(migration.migrate()).toEqual(result)
  })

  it('resumes pending steps without overwriting an existing target', () => {
    const { root, legacyConfigRoot, legacyPlatformRoot, layout } = setup()
    writeFileSync(layout.configPath, '{"model":"target"}')
    writeFileSync(join(layout.conversationsRoot, 'existing.jsonl'), '{"type":"existing"}\n')
    const migration = new LegacyProfileMigration({ legacyConfigRoot, legacyPlatformRoot, migrationRoot: join(root, 'migration'), layout })
    const result = migration.migrate()
    expect(result.steps.find(step => step.id === 'config')?.status).toBe('skipped')
    expect(readFileSync(layout.configPath, 'utf8')).toContain('target')
    expect(existsSync(join(layout.conversationsRoot, 'existing.jsonl'))).toBe(true)
    expect(existsSync(join(layout.conversationsRoot, 'conversation-1.jsonl'))).toBe(true)
  })

  it('merges a changed conversation catalog while preserving both histories', () => {
    const { root, legacyConfigRoot, legacyPlatformRoot, layout } = setup()
    writeFileSync(join(legacyConfigRoot, 'conversations', '.conversation-catalog-v1.json'), JSON.stringify({
      version: 1,
      entries: [
        { meta: { id: 'source-only', updatedAt: 10 }, visible: true },
        { meta: { id: 'shared', title: 'source', updatedAt: 10 }, visible: true },
      ],
    }))
    writeFileSync(join(layout.conversationsRoot, '.conversation-catalog-v1.json'), JSON.stringify({
      version: 1,
      entries: [
        { meta: { id: 'target-only', updatedAt: 20 }, visible: true },
        { meta: { id: 'shared', title: 'target', updatedAt: 20 }, visible: false },
      ],
    }))

    const result = new LegacyProfileMigration({ legacyConfigRoot, legacyPlatformRoot, migrationRoot: join(root, 'migration'), layout }).migrate()
    const catalog = JSON.parse(readFileSync(join(layout.conversationsRoot, '.conversation-catalog-v1.json'), 'utf8')) as {
      entries: Array<{ meta: { id: string; title?: string }; visible: boolean }>
    }

    expect(result.status).toBe('completed')
    expect(catalog.entries.map(entry => entry.meta.id)).toEqual(['shared', 'source-only', 'target-only'])
    expect(catalog.entries.find(entry => entry.meta.id === 'shared')).toMatchObject({
      meta: { title: 'target' },
      visible: true,
    })
  })

  it('resumes when the target has a longer append-only conversation journal', () => {
    const { root, legacyConfigRoot, legacyPlatformRoot, layout } = setup()
    writeFileSync(join(layout.conversationsRoot, 'conversation-1.jsonl'), '{"type":"snapshot"}\n{"type":"event"}\n')

    const result = new LegacyProfileMigration({ legacyConfigRoot, legacyPlatformRoot, migrationRoot: join(root, 'migration'), layout }).migrate()

    expect(result.status).toBe('completed')
    expect(readFileSync(join(layout.conversationsRoot, 'conversation-1.jsonl'), 'utf8')).toContain('{"type":"event"}')
  })

  it('fails before staging when free space is insufficient', () => {
    const { root, legacyConfigRoot, legacyPlatformRoot, layout } = setup()
    const migration = new LegacyProfileMigration({
      legacyConfigRoot,
      legacyPlatformRoot,
      migrationRoot: join(root, 'migration'),
      layout,
      availableBytes: () => 0,
    })

    const result = migration.migrate()

    expect(result.status).toBe('failed')
    expect(result.steps.find(step => step.status === 'failed')?.error).toContain('Insufficient free space')
    expect(existsSync(layout.configPath)).toBe(false)
    expect(existsSync(join(legacyConfigRoot, 'config.json'))).toBe(true)
  })

  it('resumes after interruption immediately following a committed step', () => {
    const { root, legacyConfigRoot, legacyPlatformRoot, layout } = setup()
    const migrationRoot = join(root, 'migration')
    const interrupted = new LegacyProfileMigration({
      legacyConfigRoot,
      legacyPlatformRoot,
      migrationRoot,
      layout,
      onPhase: (phase, step) => {
        if (phase === 'committed' && step === 'config') throw new Error('simulated process interruption')
      },
    }).migrate()
    expect(interrupted.status).toBe('failed')
    expect(readFileSync(layout.configPath, 'utf8')).toContain('test')

    const resumed = new LegacyProfileMigration({ legacyConfigRoot, legacyPlatformRoot, migrationRoot, layout }).migrate()

    expect(resumed.status).toBe('completed')
    expect(existsSync(join(layout.conversationsRoot, 'conversation-1.jsonl'))).toBe(true)
    expect(existsSync(join(legacyConfigRoot, 'config.json'))).toBe(true)
  })

  it.each(['staged', 'validated'] as const)('resumes after interruption when a step was %s', phase => {
    const { root, legacyConfigRoot, legacyPlatformRoot, layout } = setup()
    const migrationRoot = join(root, 'migration')
    const interrupted = new LegacyProfileMigration({
      legacyConfigRoot,
      legacyPlatformRoot,
      migrationRoot,
      layout,
      onPhase: (current, step) => {
        if (current === phase && step === 'config') throw new Error(`simulated ${phase} interruption`)
      },
    }).migrate()
    expect(interrupted.status).toBe('failed')

    const resumed = new LegacyProfileMigration({ legacyConfigRoot, legacyPlatformRoot, migrationRoot, layout }).migrate()

    expect(resumed.status).toBe('completed')
    expect(readFileSync(layout.configPath, 'utf8')).toContain('test')
    expect(existsSync(join(layout.conversationsRoot, 'conversation-1.jsonl'))).toBe(true)
  })
})
