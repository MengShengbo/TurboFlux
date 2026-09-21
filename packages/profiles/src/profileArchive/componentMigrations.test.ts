import { describe, expect, it } from 'vitest'
import { ArchiveComponentMigrationRegistry } from './componentMigrations'

describe('profile archive component migrations', () => {
  it('applies only consecutive N to N+1 migrations without mutating input', () => {
    const registry = new ArchiveComponentMigrationRegistry()
    registry.register('conversations', 1, value => ({ ...(value as object), schemaVersion: 2, migrated: ['1-2'] }))
    registry.register('conversations', 2, value => ({
      ...(value as Record<string, unknown>),
      schemaVersion: 3,
      migrated: [...(value as { migrated: string[] }).migrated, '2-3'],
    }))
    const source = { schemaVersion: 1, items: [{ id: 'conversation-1' }] }

    expect(registry.migrate('conversations', source, 1, 3)).toEqual({
      schemaVersion: 3,
      items: [{ id: 'conversation-1' }],
      migrated: ['1-2', '2-3'],
    })
    expect(source).toEqual({ schemaVersion: 1, items: [{ id: 'conversation-1' }] })
  })

  it('is an idempotent clone at the target version and fails closed for missing or future chains', () => {
    const registry = new ArchiveComponentMigrationRegistry()
    const source = { schemaVersion: 1, value: 'stable' }
    const cloned = registry.migrate('projects', source, 1, 1)
    expect(cloned).toEqual(source)
    expect(cloned).not.toBe(source)
    expect(() => registry.migrate('projects', source, 1, 2)).toThrow('缺少 1 → 2 迁移器')
    expect(() => registry.migrate('projects', source, 2, 1)).toThrow('来自更高版本')
  })
})
