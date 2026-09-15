import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { LocalProfileRecord, ProfileStorageLayout } from '../types'
import { canonicalJsonBytes, canonicalJsonDigest } from './canonicalJson'
import { ArchiveBlobStore } from './blobStore'
import {
  ARCHIVE_COMPONENT_DEFINITIONS,
  ArchiveComponentRegistry,
  exportWorkspaces,
  type ComponentSnapshot,
} from './exportComponents'
import { finalizeManifest } from './manifest'
import type { ExportRedactionPolicy } from './redaction'
import {
  PROFILE_ARCHIVE_MANIFEST_VERSION,
  ProfileArchiveError,
  type ArchiveComponentId,
  type ArchiveEntryInput,
  type ExportSelectionInput,
  type ProfileArchiveManifestV1,
  type ProfileExportEstimate,
} from './types'

export interface PreparedProfileExportPlan {
  planId: string
  profileId: string
  selectionDigest: string
  estimate: ProfileExportEstimate
  manifest: ProfileArchiveManifestV1
  entries: ArchiveEntryInput[]
  encrypted: boolean
}

export interface ExportPlannerOptions {
  profile: LocalProfileRecord
  layout: ProfileStorageLayout
  conversationDataVersion: 1 | 2
  appVersion: string
  coreVersion: string
  platform?: string
  now?: () => number
  createId?: () => string
  credentialReader?: () => Promise<unknown> | unknown
  excludedWorkspacePaths?: string[]
}

function entry(path: string, value: unknown): ArchiveEntryInput {
  const data = canonicalJsonBytes(value)
  return { path, data, size: data.length, digest: createHash('sha256').update(data).digest('hex') }
}

function uniqueComponents(components: ArchiveComponentId[]): ArchiveComponentId[] {
  const allowed = new Set(ARCHIVE_COMPONENT_DEFINITIONS.map(definition => definition.id))
  const unique = [...new Set(components)]
  if (unique.some(component => !allowed.has(component))) {
    throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '导出选择包含未知组件。', '请刷新后重新选择导出内容。')
  }
  return unique.sort()
}

function comparablePath(path: string): string {
  const normalized = resolve(path).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export class ProfileExportPlanner {
  private readonly now: () => number
  private readonly createId: () => string

  constructor(private readonly options: ExportPlannerOptions) {
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
  }

  async prepare(selection: ExportSelectionInput): Promise<PreparedProfileExportPlan> {
    if (selection.profileId !== this.options.profile.id) {
      throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '导出资料与当前存储上下文不一致。', '请重新打开导出向导。')
    }
    const components = uniqueComponents(selection.components)
    const selected = new Set(components)
    const blockers: ProfileExportEstimate['blockers'] = []
    if (selected.has('artifacts.blobs') && !selected.has('artifacts.index')) {
      blockers.push({ code: 'ARCHIVE_COMPONENT_INVALID', message: '成果文件需要同时包含成果索引。', action: '请勾选“成果索引”。' })
    }
    const requiresEncryption = components.some(component => ARCHIVE_COMPONENT_DEFINITIONS.find(item => item.id === component)?.requiresEncryption)
    if (requiresEncryption && !selection.encrypted) {
      blockers.push({ code: 'SECRET_EXPORT_REQUIRES_ENCRYPTION', message: '所选内容包含秘密，必须设置资料包密码。', action: '请返回保护步骤并设置密码。' })
    }
    const excludedWorkspacePaths = new Set((this.options.excludedWorkspacePaths ?? []).map(comparablePath))
    const workspaces = exportWorkspaces(this.options.layout).filter(workspace => (
      !workspace.localPath || !excludedWorkspacePaths.has(comparablePath(workspace.localPath))
    ))
    const redaction: ExportRedactionPolicy = {
      version: 1,
      workspaces: workspaces.map(workspace => ({ id: workspace.id, localPath: workspace.localPath })),
      allowSecrets: false,
    }
    const blobs = new ArchiveBlobStore()
    const registry = new ArchiveComponentRegistry()
    const snapshots: ComponentSnapshot[] = []
    if (blockers.length === 0) {
      for (const component of components) {
        snapshots.push(await registry.get(component).snapshot({
          profile: this.options.profile,
          layout: this.options.layout,
          conversationDataVersion: this.options.conversationDataVersion,
          workspaces,
          excludedWorkspacePaths,
          redaction: component === 'credentials' || component === 'plugins.storage' ? { ...redaction, allowSecrets: true } : redaction,
          blobs,
          conversationIds: selection.conversationIds ? new Set(selection.conversationIds) : undefined,
          credentialReader: this.options.credentialReader,
        }, selected))
      }
    }
    const componentEntries = snapshots.flatMap(snapshot => snapshot.entries)
    const blobEntries = blobs.listEntries()
    const profileEntry = entry('profile/profile.json', {
      schemaVersion: 1,
      displayName: this.options.profile.displayName,
      avatar: this.options.profile.avatar,
      sourceCreatedAt: this.options.profile.createdAt,
      lock: { kind: 'none' },
    })
    const checksums = Object.fromEntries(
      [profileEntry, ...componentEntries, ...blobEntries]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map(item => [item.path, { sha256: item.digest, bytes: item.size }]),
    )
    const checksumsEntry = entry('checksums.json', { schemaVersion: 1, algorithm: 'sha256', entries: checksums })
    const conversationSnapshot = snapshots.find(snapshot => snapshot.descriptor.id === 'conversations')
    const manifest = finalizeManifest({
      schemaVersion: PROFILE_ARCHIVE_MANIFEST_VERSION,
      archiveId: `archive-${this.createId()}`,
      exportedAt: this.now(),
      source: {
        appVersion: this.options.appVersion,
        coreVersion: this.options.coreVersion,
        platform: this.options.platform ?? process.platform,
        profileStorageVersion: this.options.profile.storageVersion,
      },
      profile: { sourceProfileId: this.options.profile.id, displayName: this.options.profile.displayName },
      conversationDataVersion: conversationSnapshot?.descriptor.schemaVersion === 2 ? 2 : 1,
      conversationData: conversationSnapshot?.conversationData,
      components: snapshots.map(snapshot => snapshot.descriptor),
      workspaces: workspaces.map(workspace => ({
        id: workspace.id,
        displayName: workspace.displayName,
        sourceHint: workspace.sourceHint ? structuredClone(workspace.sourceHint) : undefined,
      })),
    })
    const manifestEntry = entry('manifest.json', manifest)
    const entries = [manifestEntry, profileEntry, ...componentEntries, ...blobEntries, checksumsEntry]
      .sort((left, right) => left.path.localeCompare(right.path))
    const selectionDigest = canonicalJsonDigest({
      profileId: selection.profileId,
      components,
      conversationIds: [...(selection.conversationIds ?? [])].sort(),
      includeBlobs: selection.includeBlobs === true,
      encrypted: selection.encrypted,
      manifestDigest: manifest.contentDigest,
    })
    const warnings = snapshots.flatMap(snapshot => snapshot.warnings)
    const logicalBytes = entries.reduce((sum, item) => sum + item.size, 0)
    const itemCount = snapshots.reduce((sum, snapshot) => sum + snapshot.descriptor.itemCount, 0)
    const estimate: ProfileExportEstimate = {
      planId: `export-plan-${this.createId()}`,
      profileId: selection.profileId,
      selectionDigest,
      components: ARCHIVE_COMPONENT_DEFINITIONS.map(definition => {
        const snapshot = snapshots.find(item => item.descriptor.id === definition.id)
        return {
          ...(snapshot?.descriptor ?? { id: definition.id, schemaVersion: 1, itemCount: 0, logicalBytes: 0, blobCount: 0, sensitivity: definition.sensitivity }),
          selected: selected.has(definition.id),
          defaultSelected: definition.defaultSelected,
          description: definition.description,
          warnings: snapshot?.warnings ?? [],
        }
      }),
      itemCount,
      logicalBytes,
      estimatedPhysicalBytes: Math.ceil(logicalBytes * 0.72 + entries.length * 96 + 8_192),
      encrypted: selection.encrypted,
      requiresEncryption,
      excluded: [
        '设备安装身份与 Remote 配对授权',
        'Terminal、Browser、Computer 和 Agent 的活动执行状态',
        '系统钥匙串、环境变量与外部工具凭据',
        '本机绝对路径和临时文件',
      ],
      warnings,
      blockers,
    }
    return {
      planId: estimate.planId,
      profileId: selection.profileId,
      selectionDigest,
      estimate,
      manifest,
      entries,
      encrypted: selection.encrypted,
    }
  }
}
