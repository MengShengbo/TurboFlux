import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationStore } from '@turboflux/conversations/conversations/store'
import { ConversationEventStoreV2 } from '@turboflux/conversations/conversations/conversationEventStoreV2'
import type { PersistedConversation } from '@turboflux/conversations/conversations/types'
import { createProfileStorageLayout, ensureProfileStorageLayout, workspaceOverlayRoot } from '../profileStorageLayout'
import type { LocalProfileRecord } from '../types'
import { WorkspaceBindingService } from '../workspaceBindingService'
import { collectProfileArchiveEntries } from './container'
import { writeProfileArchive } from './container'
import { ProfileExportPlanner } from './exportPlanner'
import { ProfileArchiveApplicationService } from './profileArchiveService'
import { containsForbiddenExportData } from './redaction'
import { scanProfileArchive } from './archiveScanner'

const directories: string[] = []

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-export-plan-'))
  directories.push(root)
  const dataRoot = join(root, 'data')
  const deviceRoot = join(root, 'device')
  const workspacePath = join(root, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  const profile: LocalProfileRecord = {
    schemaVersion: 1,
    id: 'profile-export-test',
    displayName: '迁移测试',
    createdAt: 100,
    updatedAt: 100,
    state: 'ready',
    lock: { kind: 'none' },
    storageVersion: 1,
  }
  const layout = createProfileStorageLayout(dataRoot, deviceRoot, profile.id)
  ensureProfileStorageLayout(layout)
  const binding = new WorkspaceBindingService(layout, () => 100, () => 'workspace-12345678').ensureBound(workspacePath, 'Demo')
  writeFileSync(layout.configPath, JSON.stringify({
    provider: 'openai', apiKey: 'sk-never-export-this', baseUrl: 'https://api.openai.com/v1', model: 'gpt-test',
    approvalPolicy: 'ask', capabilityProfile: 'workspace-write', gitEnabled: true,
    apiConfigs: [{ id: 'one', name: 'One', apiKey: 'sk-another-secret', provider: 'openai' }],
  }))
  writeFileSync(layout.projectsPath, JSON.stringify({ schemaVersion: 1, projects: [{ id: 'project-1', name: 'Demo', path: workspacePath, pinned: true, tags: [], createdAt: 1, updatedAt: 2, lastOpenedAt: 2 }] }))
  writeFileSync(layout.automationsPath, JSON.stringify({ schemaVersion: 2, automations: [{ id: 'automation-1', workspacePath, enabled: true, status: 'active', activeRunId: 'run-1', pendingRunAt: 2, nextRunAt: 3, activeRuns: ['run-1'] }], approvals: [{ id: 'approval-1' }] }))
  const memoryRoot = join(workspaceOverlayRoot(layout, binding.id), 'memory')
  mkdirSync(memoryRoot, { recursive: true })
  writeFileSync(join(memoryRoot, 'facts.jsonl'), JSON.stringify({ text: `source ${workspacePath}/report.md token=hidden-value` }))
  const conversation: PersistedConversation = {
    id: 'conversation-1', title: 'Private work', workspacePath, createdAt: 1, updatedAt: 2, mode: 'vibe', model: 'gpt-test', provider: 'openai', turnCount: 1,
    turns: [{ id: 'turn-1', role: 'user', content: `Open ${workspacePath}/report.md with sk-super-secret-value`, timestamp: 1 }],
    interactionState: { queuedInputs: [{ id: 'queued', prompt: 'do not migrate' }], draft: { text: 'safe draft' }, pendingSteering: [], pendingApprovals: [{ requestId: 'approval', requestKind: 'permission', question: 'run?' }] },
  }
  new ConversationStore(layout.conversationsRoot).save(conversation, { compact: true })
  return { root, profile, layout, workspacePath }
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('profile export planner and service', () => {
  it('fails closed instead of falling back to V1 when V2 event storage is missing', async () => {
    const { profile, layout } = fixture()
    const planner = new ProfileExportPlanner({
      profile,
      layout,
      conversationDataVersion: 2,
      appVersion: '1',
      coreVersion: '1',
    })

    await expect(planner.prepare({ profileId: profile.id, components: ['conversations'], encrypted: false }))
      .rejects.toMatchObject({
        code: 'ARCHIVE_COMPONENT_INVALID',
        message: expect.stringContaining('避免静默回退旧格式'),
      })
  })

  it('fails closed when Conversation V2 event identities collide across journals', async () => {
    const { profile, layout } = fixture()
    const events = new ConversationEventStoreV2(join(layout.conversationsV2Root, 'events'))
    for (const conversationId of ['conversation-v2-a', 'conversation-v2-b']) {
      events.append([{
        eventId: 'event-shared-across-conversations',
        profileId: profile.id,
        conversationId,
        source: 'user',
        provenance: 'live',
        type: 'conversation.renamed',
        payload: { title: conversationId, titleSource: 'custom' },
      }])
    }
    const planner = new ProfileExportPlanner({
      profile,
      layout,
      conversationDataVersion: 2,
      appVersion: '1',
      coreVersion: '1',
    })

    await expect(planner.prepare({ profileId: profile.id, components: ['conversations'], encrypted: false }))
      .rejects.toMatchObject({
        code: 'ARCHIVE_COMPONENT_INVALID',
        message: expect.stringContaining('事件身份冲突'),
      })
  })

  it('exports stable domain snapshots without device IDs, secrets, or absolute paths', async () => {
    const { root, profile, layout, workspacePath } = fixture()
    const planner = new ProfileExportPlanner({ profile, layout, conversationDataVersion: 1, appVersion: '1.0.1', coreVersion: '1.0.1', now: () => 200, createId: () => 'fixed-id' })
    const service = new ProfileArchiveApplicationService({ planner, createOperationId: () => 'operation-1' })
    const estimate = await service.estimateExport({
      profileId: profile.id,
      components: ['profile.preferences', 'conversations', 'model.configurations', 'projects', 'automations', 'memories'],
      encrypted: false,
    })
    expect(estimate.blockers).toEqual([])
    expect(estimate.excluded.join(' ')).toContain('Remote')
    const targetPath = join(root, 'export.turboflux-profile')
    const operation = service.startExport({ planId: estimate.planId, targetPath })
    const completed = await service.waitForOperation(operation.operationId)
    expect(completed.phase).toBe('completed')
    const entries = await collectProfileArchiveEntries({ path: targetPath })
    const text = [...entries.values()].map(value => value.toString('utf8')).join('\n')
    expect(text).toContain('workspace://workspace-12345678/report.md')
    expect(text).not.toContain(workspacePath)
    expect(text).not.toContain('sk-super-secret-value')
    expect(text).not.toContain('do not migrate')
    expect(text).not.toContain('"requestId":"approval"')
    expect(text).not.toContain('activeRunId')
    expect(text).not.toContain('pendingRunAt')
    expect(text).not.toContain('nextRunAt')
    expect(containsForbiddenExportData(text)).toBe(false)
  })

  it('omits host-only projects when their workspace path is excluded from the archive', async () => {
    const { root, profile, layout, workspacePath } = fixture()
    const hostOnlyPath = join(root, 'no-workspace-selected')
    mkdirSync(hostOnlyPath, { recursive: true })
    writeFileSync(layout.projectsPath, JSON.stringify({
      schemaVersion: 1,
      projects: [
        { id: 'project-1', name: 'Portable', path: workspacePath, createdAt: 1, updatedAt: 2 },
        { id: 'host-only', name: 'No workspace selected', path: hostOnlyPath, createdAt: 1, updatedAt: 2 },
      ],
    }))
    const plan = await new ProfileExportPlanner({
      profile,
      layout,
      conversationDataVersion: 1,
      appVersion: '1',
      coreVersion: '1',
      excludedWorkspacePaths: [hostOnlyPath],
      createId: () => 'without-host-only-project',
    }).prepare({ profileId: profile.id, components: ['projects'], encrypted: false })
    const targetPath = join(root, 'without-host-only-project.turboflux-profile')
    await writeProfileArchive({ targetPath, entries: plan.entries, verifyDocument: true })

    const projectsEntry = plan.entries.find(entry => entry.path === 'components/projects/projects.json')
    const projects = JSON.parse(Buffer.from(projectsEntry!.data!).toString('utf8')) as { projects: Array<Record<string, unknown>> }
    expect(projects.projects).toEqual([expect.objectContaining({ id: 'project-1', workspaceId: 'workspace-12345678' })])
    const scan = await scanProfileArchive({ path: targetPath })
    expect(scan.preview.workspaces).toEqual([expect.objectContaining({ id: 'workspace-12345678' })])
  })

  it('requires encryption for credentials and round trips them only inside an encrypted archive', async () => {
    const { root, profile, layout } = fixture()
    const planner = new ProfileExportPlanner({ profile, layout, conversationDataVersion: 1, appVersion: '1', coreVersion: '1', credentialReader: () => ({ apiKey: 'secret' }) })
    const service = new ProfileArchiveApplicationService({ planner })
    const estimate = await service.estimateExport({ profileId: profile.id, components: ['credentials'], encrypted: false })
    expect(estimate.requiresEncryption).toBe(true)
    expect(estimate.blockers[0]?.code).toBe('SECRET_EXPORT_REQUIRES_ENCRYPTION')
    expect(() => service.startExport({ planId: estimate.planId, targetPath: join(layout.profileRoot, 'blocked.turboflux-profile') })).toThrow('必须设置资料包密码')

    const protectedEstimate = await service.estimateExport({ profileId: profile.id, components: ['credentials'], encrypted: true })
    const targetPath = join(root, 'credentials.turboflux-profile')
    const operation = service.startExport({ planId: protectedEstimate.planId, targetPath, password: 'a strong archive password' })
    expect((await service.waitForOperation(operation.operationId)).phase).toBe('completed')
    expect(readFileSync(targetPath).toString('utf8')).not.toContain('secret')
    const entries = await collectProfileArchiveEntries({ path: targetPath, password: 'a strong archive password' })
    expect(entries.get('components/credentials/credentials.json')?.toString('utf8')).toContain('secret')
  })

  it('cleans temporary output after cancellation or a failed destination', async () => {
    const { root, profile, layout } = fixture()
    const planner = new ProfileExportPlanner({ profile, layout, conversationDataVersion: 1, appVersion: '1', coreVersion: '1' })
    const service = new ProfileArchiveApplicationService({ planner, createOperationId: () => 'cancel-operation' })
    const estimate = await service.estimateExport({ profileId: profile.id, components: ['profile.preferences'], encrypted: false })
    const targetPath = join(root, 'cancelled.turboflux-profile')
    const operation = service.startExport({ planId: estimate.planId, targetPath })
    service.cancelOperation(operation.operationId)
    const cancelled = await service.waitForOperation(operation.operationId)
    expect(cancelled.phase).toBe('cancelled')
    expect(() => readFileSync(targetPath)).toThrow()
    await expect((await import('node:fs/promises')).readdir(root).then(items => items.filter(item => item.endsWith('.tmp')))).resolves.toEqual([])

    const failedEstimate = await service.estimateExport({ profileId: profile.id, components: ['profile.preferences'], encrypted: false })
    const failed = service.startExport({ planId: failedEstimate.planId, targetPath: join(root, 'missing', 'archive.turboflux-profile') })
    expect((await service.waitForOperation(failed.operationId)).phase).toBe('failed')
  })

  it('rejects a document whose framed entries no longer match checksums', async () => {
    const { root, profile, layout } = fixture()
    const planner = new ProfileExportPlanner({ profile, layout, conversationDataVersion: 1, appVersion: '1', coreVersion: '1' })
    const plan = await planner.prepare({ profileId: profile.id, components: ['profile.preferences'], encrypted: false })
    const entries = plan.entries.map(entry => ({ ...entry }))
    const checksums = entries.find(entry => entry.path === 'checksums.json')!
    const document = JSON.parse(Buffer.from(checksums.data!).toString('utf8')) as { entries: Record<string, { sha256: string }> }
    document.entries['profile/profile.json']!.sha256 = '0'.repeat(64)
    const data = Buffer.from(JSON.stringify(document), 'utf8')
    checksums.data = data
    checksums.size = data.length
    checksums.digest = (await import('node:crypto')).createHash('sha256').update(data).digest('hex')
    const targetPath = join(root, 'invalid-document.turboflux-profile')
    await expect(writeProfileArchive({ targetPath, entries, verifyDocument: true })).rejects.toMatchObject({ code: 'ARCHIVE_CORRUPT' })
    expect(() => readFileSync(targetPath)).toThrow()
  })

  it('produces logically equivalent component content for an unchanged profile', async () => {
    const { profile, layout } = fixture()
    let ordinal = 0
    const planner = new ProfileExportPlanner({ profile, layout, conversationDataVersion: 1, appVersion: '1', coreVersion: '1', now: () => 500, createId: () => `id-${++ordinal}` })
    const selection = { profileId: profile.id, components: ['profile.preferences', 'conversations', 'projects'] as const, encrypted: false }
    const first = await planner.prepare({ ...selection, components: [...selection.components] })
    const second = await planner.prepare({ ...selection, components: [...selection.components] })
    const logical = (entries: typeof first.entries) => entries
      .filter(entry => entry.path !== 'manifest.json')
      .map(entry => ({ path: entry.path, size: entry.size, digest: entry.digest }))
    expect(logical(first.entries)).toEqual(logical(second.entries))
  })

  it('omits host-internal workspace placeholders from portable manifests', async () => {
    const { root, profile, layout } = fixture()
    const internalWorkspace = join(root, 'desktop-internal', 'unscoped')
    mkdirSync(internalWorkspace, { recursive: true })
    new WorkspaceBindingService(layout, () => 110, () => 'workspace-internal123').ensureBound(internalWorkspace, 'unscoped')
    const planner = new ProfileExportPlanner({
      profile,
      layout,
      conversationDataVersion: 1,
      appVersion: '1',
      coreVersion: '1',
      excludedWorkspacePaths: [internalWorkspace],
    })

    const plan = await planner.prepare({ profileId: profile.id, components: ['profile.preferences'], encrypted: false })

    expect(plan.manifest.workspaces.map(workspace => workspace.id)).toEqual(['workspace-12345678'])
  })

  it('refuses symbolic links and hard links in executable package directories', async () => {
    const { root, profile, layout } = fixture()
    const outside = join(root, 'outside-skill.md')
    writeFileSync(outside, 'outside content')
    const skillRoot = join(layout.userSkillsRoot, 'linked-skill')
    mkdirSync(skillRoot, { recursive: true })
    const planner = new ProfileExportPlanner({ profile, layout, conversationDataVersion: 1, appVersion: '1', coreVersion: '1' })

    symlinkSync(outside, join(skillRoot, 'SYMLINK.md'))
    await expect(planner.prepare({ profileId: profile.id, components: ['skills.user'], encrypted: false }))
      .rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE_ENTRY' })
    rmSync(join(skillRoot, 'SYMLINK.md'))

    linkSync(outside, join(skillRoot, 'HARDLINK.md'))
    await expect(planner.prepare({ profileId: profile.id, components: ['skills.user'], encrypted: false }))
      .rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE_ENTRY' })
  })
})
