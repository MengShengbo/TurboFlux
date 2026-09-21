import { ProfileArchiveError, type ArchiveComponentId } from './types'

export type ArchiveComponentMigration = (value: unknown) => unknown

export class ArchiveComponentMigrationRegistry {
  private readonly migrations = new Map<string, ArchiveComponentMigration>()

  register(componentId: ArchiveComponentId, fromVersion: number, migration: ArchiveComponentMigration): void {
    if (!Number.isInteger(fromVersion) || fromVersion < 1) throw new Error('Component migration version must be positive')
    const key = `${componentId}:${fromVersion}`
    if (this.migrations.has(key)) throw new Error(`Component migration already exists: ${key}`)
    this.migrations.set(key, migration)
  }

  migrate(componentId: ArchiveComponentId, value: unknown, fromVersion: number, targetVersion: number): unknown {
    if (fromVersion > targetVersion) {
      throw new ProfileArchiveError('ARCHIVE_UNSUPPORTED_VERSION', `${componentId} 组件来自更高版本。`, '请升级 TurboFlux 后重试。')
    }
    let migrated = structuredClone(value)
    for (let version = fromVersion; version < targetVersion; version += 1) {
      const migration = this.migrations.get(`${componentId}:${version}`)
      if (!migration) throw new ProfileArchiveError('ARCHIVE_UNSUPPORTED_VERSION', `${componentId} 缺少 ${version} → ${version + 1} 迁移器。`, '请升级 TurboFlux 后重试。')
      migrated = migration(migrated)
    }
    return migrated
  }
}
