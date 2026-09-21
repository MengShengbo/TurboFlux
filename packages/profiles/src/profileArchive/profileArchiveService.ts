import { writeProfileArchive } from './container'
import { ProfileExportPlanner, type PreparedProfileExportPlan } from './exportPlanner'
import { ProfileArchiveImporter, type PreparedProfileImportPlan } from './profileArchiveImporter'
import {
  ProfileArchiveError,
  type ArchiveOperationRef,
  type ArchiveOperationSnapshot,
  type ConfirmedExportInput,
  type ConfirmedImportInput,
  type ExportSelectionInput,
  type ImportSelectionInput,
  type ProfileArchivePreview,
  type ProfileExportEstimate,
  type ProfileImportPlan,
} from './types'

export interface ProfileArchiveApplicationServiceOptions {
  planner: ProfileExportPlanner
  now?: () => number
  createOperationId?: () => string
  onOperationUpdated?: (operation: ArchiveOperationSnapshot) => void
  importer?: ProfileArchiveImporter
}

interface OperationRecord {
  snapshot: ArchiveOperationSnapshot
  controller: AbortController
  done: Promise<ArchiveOperationSnapshot>
  resolveDone: (snapshot: ArchiveOperationSnapshot) => void
}

function cloneOperation(snapshot: ArchiveOperationSnapshot): ArchiveOperationSnapshot {
  return structuredClone(snapshot)
}

export class ProfileArchiveApplicationService {
  private readonly now: () => number
  private readonly createOperationId: () => string
  private readonly plans = new Map<string, PreparedProfileExportPlan>()
  private readonly importPlans = new Map<string, PreparedProfileImportPlan>()
  private readonly previews = new Map<string, ProfileArchivePreview>()
  private readonly operations = new Map<string, OperationRecord>()

  constructor(private readonly options: ProfileArchiveApplicationServiceOptions) {
    this.now = options.now ?? Date.now
    this.createOperationId = options.createOperationId ?? (() => `archive-operation-${crypto.randomUUID()}`)
  }

  async estimateExport(input: ExportSelectionInput): Promise<ProfileExportEstimate> {
    const plan = await this.options.planner.prepare(input)
    this.plans.set(plan.planId, plan)
    return structuredClone(plan.estimate)
  }

  startExport(input: ConfirmedExportInput): ArchiveOperationRef {
    const plan = this.plans.get(input.planId)
    if (!plan) throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '导出计划已过期。', '请重新检查导出内容。')
    if (plan.estimate.blockers.length > 0) {
      const blocker = plan.estimate.blockers[0]!
      throw new ProfileArchiveError(blocker.code as ProfileArchiveError['code'], blocker.message, blocker.action)
    }
    const password = input.password === undefined ? undefined : Buffer.from(input.password)
    if (plan.encrypted && !password?.length) {
      password?.fill(0)
      throw new ProfileArchiveError('SECRET_EXPORT_REQUIRES_ENCRYPTION', '加密资料包需要密码。', '请设置密码后重试。')
    }
    const operationId = this.createOperationId()
    const timestamp = this.now()
    let resolveDone!: (snapshot: ArchiveOperationSnapshot) => void
    const done = new Promise<ArchiveOperationSnapshot>(resolve => { resolveDone = resolve })
    const record: OperationRecord = {
      snapshot: { operationId, kind: 'export', phase: 'snapshotting', progress: 0.15, startedAt: timestamp, updatedAt: timestamp, message: '正在固定资料快照…' },
      controller: new AbortController(),
      done,
      resolveDone,
    }
    this.operations.set(operationId, record)
    this.emit(record)
    void this.runExport(record, plan, input.targetPath, password)
    return { operationId }
  }

  async inspectArchive(path: string, password?: string | Uint8Array): Promise<ProfileArchivePreview> {
    if (!this.options.importer) throw new Error('Profile archive import is unavailable')
    const preview = await this.options.importer.inspect(path, password)
    this.previews.set(path, structuredClone(preview))
    return structuredClone(preview)
  }

  planImport(path: string, input: ImportSelectionInput): ProfileImportPlan {
    if (!this.options.importer) throw new Error('Profile archive import is unavailable')
    const preview = this.previews.get(path)
    if (!preview) throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '导入预览已过期。', '请重新选择并验证资料包。')
    const plan = this.options.importer.plan(path, preview, input)
    this.importPlans.set(plan.planId, plan)
    const { sourcePath: _sourcePath, encrypted: _encrypted, ...publicPlan } = plan
    return structuredClone(publicPlan)
  }

  startImport(input: ConfirmedImportInput): ArchiveOperationRef {
    if (!this.options.importer) throw new Error('Profile archive import is unavailable')
    const plan = this.importPlans.get(input.planId)
    if (!plan) throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '导入计划已过期。', '请重新预览资料包。')
    if (plan.blockers.length) {
      const blocker = plan.blockers[0]!
      throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', blocker.message, blocker.action)
    }
    const password = input.password === undefined ? undefined : Buffer.from(input.password)
    if (plan.encrypted && !password?.length) {
      password?.fill(0)
      throw new ProfileArchiveError('ARCHIVE_AUTHENTICATION_FAILED', '密码错误或资料包已损坏。', '请输入导出时使用的密码。')
    }
    const operationId = this.createOperationId()
    const timestamp = this.now()
    let resolveDone!: (snapshot: ArchiveOperationSnapshot) => void
    const done = new Promise<ArchiveOperationSnapshot>(resolve => { resolveDone = resolve })
    const record: OperationRecord = {
      snapshot: { operationId, kind: 'import', phase: 'staging', progress: 0.1, startedAt: timestamp, updatedAt: timestamp, message: '正在创建安全导入事务…' },
      controller: new AbortController(),
      done,
      resolveDone,
    }
    this.operations.set(operationId, record)
    this.emit(record)
    void this.runImport(record, plan, password)
    return { operationId }
  }

  cancelOperation(operationId: string): boolean {
    const operation = this.operations.get(operationId)
    if (!operation || ['completed', 'cancelled', 'rolled_back', 'failed'].includes(operation.snapshot.phase)) return false
    operation.snapshot = { ...operation.snapshot, phase: 'cancelling', updatedAt: this.now(), message: '正在安全取消并清理临时文件…' }
    this.emit(operation)
    operation.controller.abort(new Error('Archive export cancelled'))
    return true
  }

  getOperation(operationId: string): ArchiveOperationSnapshot {
    const operation = this.operations.get(operationId)
    if (!operation) throw new Error(`Archive operation not found: ${operationId}`)
    return cloneOperation(operation.snapshot)
  }

  async waitForOperation(operationId: string): Promise<ArchiveOperationSnapshot> {
    const operation = this.operations.get(operationId)
    if (!operation) throw new Error(`Archive operation not found: ${operationId}`)
    return cloneOperation(await operation.done)
  }

  transitionBlocker(): string | null {
    const active = [...this.operations.values()].find(operation => !['completed', 'cancelled', 'rolled_back', 'failed'].includes(operation.snapshot.phase))
    if (!active) return null
    return active.snapshot.kind === 'import' ? '用户资料包仍在导入' : '用户资料包仍在导出'
  }

  private async runExport(operation: OperationRecord, plan: PreparedProfileExportPlan, targetPath: string, password?: Buffer): Promise<void> {
    try {
      this.update(operation, 'serializing', 0.3, '正在序列化所选组件…')
      this.update(operation, 'compressing', 0.45, plan.encrypted ? '正在压缩并加密资料包…' : '正在压缩资料包…')
      if (plan.encrypted) this.update(operation, 'encrypting', 0.55, '正在使用密码保护完整资料包…')
      const result = await writeProfileArchive({ targetPath, entries: plan.entries, password, signal: operation.controller.signal, verifyDocument: true })
      this.update(operation, 'verifying', 0.9, '正在重新打开并验证资料包…')
      const completedAt = this.now()
      operation.snapshot = {
        ...operation.snapshot,
        phase: 'completed',
        progress: 1,
        updatedAt: completedAt,
        completedAt,
        message: '资料包已安全导出。',
        result: { path: result.path, physicalBytes: result.physicalBytes, sha256: result.sha256, archiveId: plan.manifest.archiveId },
      }
    } catch (error) {
      const completedAt = this.now()
      if (operation.controller.signal.aborted) {
        operation.snapshot = { ...operation.snapshot, phase: 'cancelled', progress: 0, updatedAt: completedAt, completedAt, message: '导出已取消，临时文件已清理。' }
      } else {
        const archiveError = error instanceof ProfileArchiveError
          ? error
          : new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '资料包导出失败。', '请检查可用空间和文件权限后重试。')
        operation.snapshot = {
          ...operation.snapshot,
          phase: 'failed',
          updatedAt: completedAt,
          completedAt,
          message: archiveError.message,
          error: { code: archiveError.code, message: archiveError.message, action: archiveError.action },
        }
      }
    } finally {
      password?.fill(0)
      this.plans.delete(plan.planId)
      this.emit(operation)
      operation.resolveDone(cloneOperation(operation.snapshot))
    }
  }

  private async runImport(operation: OperationRecord, plan: PreparedProfileImportPlan, password?: Buffer): Promise<void> {
    try {
      const result = await this.options.importer!.execute({
        plan,
        password,
        signal: operation.controller.signal,
        onProgress: (phase, progress, message) => this.update(operation, phase, progress, message),
      })
      const completedAt = this.now()
      operation.snapshot = {
        ...operation.snapshot,
        phase: 'completed',
        progress: 1,
        updatedAt: completedAt,
        completedAt,
        message: '资料已导入为新的本地用户资料。',
        result: { archiveId: plan.archiveId, profileId: result.profile.id },
      }
    } catch (error) {
      const completedAt = this.now()
      if (operation.controller.signal.aborted) {
        operation.snapshot = { ...operation.snapshot, phase: 'rolled_back', progress: 0, updatedAt: completedAt, completedAt, message: '导入已取消，未提交任何资料。' }
      } else {
        const archiveError = error instanceof ProfileArchiveError
          ? error
          : new ProfileArchiveError('IMPORT_ROLLBACK_REQUIRED', '资料导入失败。', 'TurboFlux 将在下次启动检查并完成回滚。')
        operation.snapshot = {
          ...operation.snapshot,
          phase: 'failed',
          updatedAt: completedAt,
          completedAt,
          message: archiveError.message,
          error: { code: archiveError.code, message: archiveError.message, action: archiveError.action },
        }
      }
    } finally {
      password?.fill(0)
      this.importPlans.delete(plan.planId)
      this.emit(operation)
      operation.resolveDone(cloneOperation(operation.snapshot))
    }
  }

  private update(operation: OperationRecord, phase: ArchiveOperationSnapshot['phase'], progress: number, message: string): void {
    operation.snapshot = { ...operation.snapshot, phase, progress, message, updatedAt: this.now() }
    this.emit(operation)
  }

  private emit(operation: OperationRecord): void {
    this.options.onOperationUpdated?.(cloneOperation(operation.snapshot))
  }
}
