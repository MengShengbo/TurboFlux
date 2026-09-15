import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationStore } from '../../conversations/store'
import { ConversationEventStoreV2 } from '../../conversations/conversationEventStoreV2'
import { ConversationInteractionStoreV2 } from '../../conversations/conversationInteractionStoreV2'
import { projectConversationEvents } from '../../conversations/conversationProjections'
import { isConversationV2Uuid, normalizeConversationV2Id } from '../../conversations/conversationV2Ids'
import type { PersistedConversation } from '../../conversations/types'
import { InstallationProfileRegistry } from '../profileRegistry'
import { createProfileStorageLayout, ensureProfileStorageLayout, workspaceOverlayRoot } from '../profileStorageLayout'
import type { LocalProfileRecord } from '../types'
import { WorkspaceBindingService } from '../workspaceBindingService'
import { writeProfileArchive } from './container'
import { ProfileExportPlanner } from './exportPlanner'
import { ProfileArchiveImporter } from './profileArchiveImporter'

const directories: string[] = []

async function sourceArchive(root: string, encrypted = false, includeExecutable = false) {
  const profile: LocalProfileRecord = {
    schemaVersion: 1, id: 'profile-source', displayName: 'Source Profile', createdAt: 1, updatedAt: 1,
    state: 'ready', lock: { kind: 'none' }, storageVersion: 1,
  }
  const layout = createProfileStorageLayout(join(root, 'source-data'), join(root, 'source-device'), profile.id)
  ensureProfileStorageLayout(layout)
  const workspacePath = join(root, 'source-workspace')
  mkdirSync(workspacePath, { recursive: true })
  new WorkspaceBindingService(layout, () => 10, () => 'workspace-12345678').ensureBound(workspacePath, 'Source Workspace')
  writeFileSync(layout.configPath, JSON.stringify({ provider: 'custom', model: 'model-a', baseUrl: 'https://example.test/v1', approvalPolicy: 'ask', capabilityProfile: 'workspace-write', gitEnabled: true, apiConfigs: [] }))
  writeFileSync(layout.projectsPath, JSON.stringify({ schemaVersion: 1, projects: [{ id: 'project-1', name: 'Source', path: workspacePath, pinned: true, tags: ['demo'], createdAt: 1, updatedAt: 2, lastOpenedAt: 2, available: true }] }))
  writeFileSync(layout.automationsPath, JSON.stringify({ schemaVersion: 2, automations: [{ id: 'automation-1', name: 'Never auto-run', enabled: true, status: 'active', workspacePath, activeRunId: 'run-1', pendingRunAt: 28, nextRunAt: 30, activeRuns: ['run-1'], history: [] }], approvals: [{ id: 'approval-1' }] }))
  if (includeExecutable) {
    mkdirSync(join(layout.userSkillsRoot, 'imported-skill'), { recursive: true })
    writeFileSync(join(layout.userSkillsRoot, 'imported-skill', 'SKILL.md'), '---\nname: imported-skill\ndescription: Must be reviewed\n---\n\nNever load before review.')
    mkdirSync(join(layout.pluginsRoot, 'imported-plugin'), { recursive: true })
    writeFileSync(join(layout.pluginsRoot, 'imported-plugin', 'plugin.json'), JSON.stringify({ id: 'imported-plugin', name: 'Imported Plugin', main: 'main.js' }))
    writeFileSync(join(layout.pluginsRoot, 'imported-plugin', 'main.js'), 'throw new Error("must not execute during import")')
    writeFileSync(layout.settingsPath, JSON.stringify({
      mcpServers: {
        imported: { enabled: true, command: 'dangerous-command', args: ['--safe-after-review'], env: { API_KEY: 'must-not-survive' } },
      },
    }))
  }
  const memoryRoot = join(workspaceOverlayRoot(layout, 'workspace-12345678'), 'memory')
  mkdirSync(memoryRoot, { recursive: true })
  writeFileSync(join(memoryRoot, 'facts.jsonl'), '{"text":"remember me"}\n')
  const conversation: PersistedConversation = {
    id: 'conversation-import', title: 'Imported conversation', workspacePath, createdAt: 11, updatedAt: 29,
    mode: 'vibe', model: 'model-a', provider: 'custom', turnCount: 2,
    turns: [
      { id: 'turn-1', role: 'user', content: 'history survives', timestamp: 13 },
      { id: 'turn-2', role: 'assistant', content: 'in the same order', timestamp: 17 },
    ],
  }
  new ConversationStore(layout.conversationsRoot).save(conversation, { compact: true })
  const planner = new ProfileExportPlanner({
    profile, layout, conversationDataVersion: 1, appVersion: '1', coreVersion: '1', now: () => 100, createId: () => 'source-archive',
    credentialReader: () => ({ apiKey: 'source-secret' }),
  })
  const components = [
    'profile.preferences',
    'model.configurations',
    'conversations',
    'projects',
    'automations',
    'memories',
    ...(encrypted ? ['credentials'] as const : []),
    ...(includeExecutable ? ['skills.user', 'plugins.packages', 'mcp.configurations'] as const : []),
  ] as const
  const plan = await planner.prepare({ profileId: profile.id, components: [...components], encrypted })
  const path = join(root, encrypted ? 'source-encrypted.turboflux-profile' : 'source.turboflux-profile')
  const password = encrypted ? 'import source password' : undefined
  await writeProfileArchive({ targetPath: path, entries: plan.entries, password, verifyDocument: true })
  return { path, password, profile, layout }
}

function targetRegistry(root: string): InstallationProfileRegistry {
  const registry = new InstallationProfileRegistry(join(root, 'target-data'), {
    deviceRoot: join(root, 'target-device'),
    createId: () => 'default-profile',
    installationId: () => 'target-installation',
    now: () => 1_000,
  })
  registry.initialize()
  return registry
}

function ids(...values: string[]): () => string {
  let index = 0
  return () => values[index++] ?? `extra-${index}`
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('profile archive transactional importer', () => {
  it('round trips Conversation V2 events while rebasing profile identity and requiring workspace binding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-import-conversation-v2-'))
    directories.push(root)
    const profile: LocalProfileRecord = {
      schemaVersion: 1, id: 'profile-v2-source', displayName: 'V2 Source', createdAt: 1, updatedAt: 1,
      state: 'ready', lock: { kind: 'none' }, storageVersion: 1,
    }
    const sourceLayout = createProfileStorageLayout(join(root, 'source-data'), join(root, 'source-device'), profile.id)
    ensureProfileStorageLayout(sourceLayout)
    const workspacePath = join(root, 'workspace')
    mkdirSync(workspacePath)
    new WorkspaceBindingService(sourceLayout, () => 1, () => 'workspace-12345678').ensureBound(workspacePath, 'Workspace')
    const sourceEvents = new ConversationEventStoreV2(join(sourceLayout.profileRoot, 'conversations-v2', 'events'), () => 10, () => 'generated-event')
    sourceEvents.append([{
      eventId: 'event-created', profileId: profile.id, conversationId: 'conversation-v2', workspaceId: 'workspace-12345678',
      source: 'user', provenance: 'live', type: 'conversation.created', payload: { record: {
        schemaVersion: 2, id: 'conversation-v2', profileId: profile.id, workspaceId: 'workspace-12345678', title: 'Portable history',
        titleSource: 'custom', mode: 'vibe', provider: 'openai', model: 'gpt-test', status: 'idle', createdAt: 10, updatedAt: 10,
        lastEventSeq: 0, turnCount: 0, runCount: 0, tags: [],
      } },
    }, {
      eventId: 'event-run', profileId: profile.id, conversationId: 'conversation-v2', workspaceId: 'workspace-12345678', runId: 'run-1',
      source: 'agent', provenance: 'live', type: 'run.started', payload: { run: {
        id: 'run-1', conversationId: 'conversation-v2', workspaceId: 'workspace-12345678', objective: 'Continue work', status: 'running', startedAt: 12, updatedAt: 12,
      } },
    }, {
      eventId: 'event-turn', profileId: profile.id, conversationId: 'conversation-v2', workspaceId: 'workspace-12345678', runId: 'run-1', turnId: 'turn-1',
      source: 'user', provenance: 'live', type: 'turn.started', payload: { turn: {
        id: 'turn-1', conversationId: 'conversation-v2', runId: 'run-1', role: 'user', status: 'started', createdAt: 11,
      } },
    }, {
      eventId: 'event-message', profileId: profile.id, conversationId: 'conversation-v2', workspaceId: 'workspace-12345678', runId: 'run-1', turnId: 'turn-1', itemId: 'item-1',
      source: 'user', provenance: 'live', type: 'item.created', payload: { item: {
        schemaVersion: 1, id: 'item-1', conversationId: 'conversation-v2', runId: 'run-1', turnId: 'turn-1', kind: 'user_message', status: 'completed',
        createdAt: 11, updatedAt: 11, payload: { text: 'History survives', attachmentIds: [] },
      } },
    }, {
      eventId: 'event-configuration', profileId: profile.id, conversationId: 'conversation-v2', workspaceId: 'workspace-12345678',
      source: 'runtime', provenance: 'live', type: 'conversation.configuration_changed', at: 13,
      payload: { mode: 'plan', provider: 'custom', model: 'updated-model' },
    }, {
      eventId: 'event-rewrite', profileId: profile.id, conversationId: 'conversation-v2', workspaceId: 'workspace-12345678',
      source: 'runtime', provenance: 'live', type: 'conversation.rewritten', at: 14,
      payload: { retainedTurnIds: ['turn-1'], rewrittenAt: 14 },
    }, {
      eventId: 'event-approval', profileId: profile.id, conversationId: 'conversation-v2', workspaceId: 'workspace-12345678', runId: 'run-1',
      source: 'agent', provenance: 'live', type: 'approval.requested', payload: { requestId: 'approval-1', requestKind: 'permission', question: 'Allow write?' },
    }])
    new ConversationInteractionStoreV2(sourceLayout.interactionRoot, profile.id, () => 20).save('conversation-v2', {
      queuedInputs: [{ id: 'queued-1', prompt: 'must never execute' }],
      draft: {
        text: `Continue from ${workspacePath}/notes.md with sk-draft-secret-value`,
        files: [{ id: 'file-1', type: 'file', path: join(workspacePath, 'notes.md'), mime: 'text/markdown', filename: 'notes.md', size: 10 }],
        pendingPastes: [{ placeholder: '[Pasted text #1]', text: `Review ${workspacePath}/notes.md` }],
        capabilities: { items: [{ type: 'skill', id: 'skill-review', name: 'Review' }] },
      },
      pendingSteering: [{ id: 'steering-1', text: 'must never steer' }],
      pendingApprovals: [{ requestId: 'approval-live', requestKind: 'permission', question: 'must never approve' }],
    })
    const exportPlan = await new ProfileExportPlanner({
      profile, layout: sourceLayout, conversationDataVersion: 2, appVersion: '1', coreVersion: '1', now: () => 100, createId: () => 'v2-archive',
    }).prepare({ profileId: profile.id, components: ['conversations'], encrypted: false })
    expect(exportPlan.manifest.conversationDataVersion).toBe(2)
    expect(exportPlan.manifest.components[0]).toMatchObject({ id: 'conversations', schemaVersion: 2 })
    expect(exportPlan.manifest.conversationData).toEqual({
      schemaVersion: 2,
      eventSegments: {
        format: 'per-conversation-json',
        indexPath: 'components/conversations/index.json',
        segmentCount: 1,
        eventCount: 7,
      },
      projections: { included: false, rebuildRequired: true },
      migrationSources: [],
    })
    const interactionEntry = exportPlan.entries.find(entry => entry.path === 'components/conversations/interactions/conversation-v2.json')
    expect(interactionEntry).toBeDefined()
    const exportedInteraction = JSON.parse(Buffer.from(interactionEntry!.data!).toString('utf8')) as Record<string, unknown>
    expect(exportedInteraction).toMatchObject({
      schemaVersion: 1,
      conversationId: 'conversation-v2',
      draft: {
        text: 'Continue from workspace://workspace-12345678/notes.md with [secret-redacted]',
        pendingPastes: [{ placeholder: '[Pasted text #1]', text: 'Review workspace://workspace-12345678/notes.md' }],
        capabilities: { items: [{ type: 'skill', id: 'skill-review', name: 'Review' }] },
      },
    })
    expect(JSON.stringify(exportedInteraction)).not.toContain('queuedInputs')
    expect(JSON.stringify(exportedInteraction)).not.toContain('pendingSteering')
    expect(JSON.stringify(exportedInteraction)).not.toContain('pendingApprovals')
    expect(JSON.stringify(exportedInteraction)).not.toContain('"files"')
    expect(JSON.stringify(exportedInteraction)).not.toContain(workspacePath)
    const archivePath = join(root, 'v2.turboflux-profile')
    await writeProfileArchive({ targetPath: archivePath, entries: exportPlan.entries, verifyDocument: true })

    const registry = targetRegistry(root)
    const importer = new ProfileArchiveImporter({ registry, createId: ids('plan-v2', 'transaction-v2', 'imported-v2'), now: () => 200 })
    const preview = await importer.inspect(archivePath)
    const importPlan = importer.plan(archivePath, preview, { archiveId: preview.archiveId, displayName: 'Imported V2', selectedComponents: ['conversations'] })
    const imported = await importer.execute({ plan: importPlan })
    expect(isConversationV2Uuid(imported.profile.id)).toBe(true)
    const targetLayout = registry.context(imported.profile.id).storage
    const importedEvents = new ConversationEventStoreV2(join(targetLayout.profileRoot, 'conversations-v2', 'events')).readAll('conversation-v2')
    expect(importedEvents.slice(0, 7).map(event => event.eventId)).toEqual([
      'event-created',
      'event-run',
      'event-turn',
      'event-message',
      'event-configuration',
      'event-rewrite',
      'event-approval',
    ])
    expect(importedEvents.slice(0, 7).every(event => event.profileId === imported.profile.id && event.provenance === 'imported')).toBe(true)
    const projection = projectConversationEvents(importedEvents)
    expect(projection.conversation).toMatchObject({
      profileId: imported.profile.id,
      status: 'needs_workspace',
      workspaceId: 'workspace-12345678',
      mode: 'plan',
      provider: 'custom',
      model: 'updated-model',
    })
    expect(projection.runs).toEqual([expect.objectContaining({ id: 'run-1', status: 'interrupted', recoveredFromPersistence: true })])
    expect(projection.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'approval', status: 'cancelled' })]))
    expect(new ConversationInteractionStoreV2(targetLayout.interactionRoot, imported.profile.id).load('conversation-v2')).toEqual({
      queuedInputs: [],
      draft: {
        text: 'Continue from workspace://workspace-12345678/notes.md with [secret-redacted]',
        pendingPastes: [{ placeholder: '[Pasted text #1]', text: 'Review workspace://workspace-12345678/notes.md' }],
        capabilities: { items: [{ type: 'skill', id: 'skill-review', name: 'Review' }] },
      },
      pendingSteering: [],
      pendingApprovals: [],
      workflow: undefined,
    })
    expect(new WorkspaceBindingService(targetLayout).get('workspace-12345678')).toMatchObject({ state: 'unbound' })
    expect(JSON.parse(readFileSync(imported.receiptPath, 'utf8'))).toMatchObject({
      migrations: [],
      conversationData: {
        sourceVersion: 2,
        eventSegments: { segmentCount: 1, eventCount: 7 },
        projectionsRebuilt: true,
      },
    })
  })

  it('turns missing legacy Workspace references into a visible rebindable UUID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-import-unassociated-workspace-'))
    directories.push(root)
    const profile: LocalProfileRecord = {
      schemaVersion: 1, id: 'profile-legacy-source', displayName: 'Legacy Source', createdAt: 1, updatedAt: 1,
      state: 'ready', lock: { kind: 'none' }, storageVersion: 1,
    }
    const sourceLayout = createProfileStorageLayout(join(root, 'source-data'), join(root, 'source-device'), profile.id)
    ensureProfileStorageLayout(sourceLayout)
    new ConversationStore(sourceLayout.conversationsRoot).save({
      id: 'legacy-unassociated', title: 'Legacy history', workspacePath: join(root, 'missing-workspace'), createdAt: 1, updatedAt: 2,
      mode: 'vibe', model: 'test', provider: 'openai', turnCount: 1,
      turns: [{ id: 'turn-legacy', role: 'user', content: 'Keep this history', timestamp: 2 }],
    }, { compact: true })
    const exportPlan = await new ProfileExportPlanner({
      profile, layout: sourceLayout, conversationDataVersion: 1, appVersion: '1', coreVersion: '1', createId: ids('archive-unassociated', 'plan-unassociated'),
    }).prepare({ profileId: profile.id, components: ['conversations'], encrypted: false })
    const archivePath = join(root, 'unassociated.turboflux-profile')
    await writeProfileArchive({ targetPath: archivePath, entries: exportPlan.entries, verifyDocument: true })

    const registry = targetRegistry(root)
    const importer = new ProfileArchiveImporter({ registry, createId: ids('inspect-plan', 'transaction-unassociated', 'profile-unassociated') })
    const preview = await importer.inspect(archivePath)
    expect(preview.workspaces).toEqual([expect.objectContaining({ displayName: '未关联工作区' })])
    expect(isConversationV2Uuid(preview.workspaces[0]!.id)).toBe(true)
    const plan = importer.plan(archivePath, preview, { archiveId: preview.archiveId, displayName: 'Imported Legacy', selectedComponents: ['conversations'] })
    expect(plan.unboundWorkspaceCount).toBe(1)
    const imported = await importer.execute({ plan })
    const layout = registry.context(imported.profile.id).storage
    const workspace = new WorkspaceBindingService(layout).list().workspaces[0]!
    expect(workspace).toMatchObject({ id: preview.workspaces[0]!.id, displayName: '未关联工作区', state: 'unbound' })
    expect(new ConversationStore(layout.conversationsRoot).load('legacy-unassociated')?.workspacePath).toBe(`turboflux-unbound:${workspace.id}`)
  })

  it('rejects an import selection that omits a declared component dependency', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-import-dependency-'))
    directories.push(root)
    const archive = await sourceArchive(root)
    const registry = targetRegistry(root)
    const importer = new ProfileArchiveImporter({ registry })
    const preview = await importer.inspect(archive.path)
    preview.components.push({
      id: 'artifacts.index', schemaVersion: 1, itemCount: 0, logicalBytes: 0, blobCount: 0,
      sensitivity: 'private', supported: true, defaultSelected: false, importedEnabled: false, warnings: [],
    }, {
      id: 'artifacts.blobs', schemaVersion: 1, itemCount: 0, logicalBytes: 0, blobCount: 0,
      sensitivity: 'private', requiredComponents: ['artifacts.index'], supported: true, defaultSelected: false, importedEnabled: false, warnings: [],
    })
    const plan = importer.plan(archive.path, preview, { archiveId: preview.archiveId, displayName: 'Dependency', selectedComponents: ['artifacts.blobs'] })
    expect(plan.blockers).toContainEqual(expect.objectContaining({ message: 'artifacts.blobs 依赖 artifacts.index。' }))
  })

  it('imports into a new inactive profile with unbound workspaces and disabled execution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-import-'))
    directories.push(root)
    const archive = await sourceArchive(root)
    const registry = targetRegistry(root)
    const activeBefore = registry.snapshot().activeProfileId
    const existingMarkerPath = join(registry.activeContext().storage.profileRoot, 'existing-marker.txt')
    writeFileSync(existingMarkerPath, 'must remain unchanged')
    const importer = new ProfileArchiveImporter({ registry, createId: ids('transaction-1', 'imported-1'), now: () => 2_000 })
    const preview = await importer.inspect(archive.path)
    const plan = importer.plan(archive.path, preview, {
      archiveId: preview.archiveId,
      displayName: 'Imported Copy',
      selectedComponents: preview.components.map(component => component.id),
    })
    const result = await importer.execute({ plan })
    expect(registry.snapshot().activeProfileId).toBe(activeBefore)
    expect(readFileSync(existingMarkerPath, 'utf8')).toBe('must remain unchanged')
    expect(registry.has(result.profile.id)).toBe(true)
    expect(result.profile).toMatchObject({ displayName: 'Imported Copy', state: 'ready', importedFrom: { archiveId: preview.archiveId } })
    const layout = registry.context(result.profile.id).storage
    const importedWorkspace = new WorkspaceBindingService(layout).list().workspaces[0]
    expect(importedWorkspace).toMatchObject({ id: 'workspace-12345678', state: 'unbound' })
    expect(importedWorkspace).not.toHaveProperty('localPath')
    expect(new ConversationStore(layout.conversationsRoot).load('conversation-import')).toMatchObject({
      title: 'Imported conversation',
      createdAt: 11,
      updatedAt: 29,
      workspacePath: 'turboflux-unbound:workspace-12345678',
      turns: [
        { id: 'turn-1', content: 'history survives', timestamp: 13 },
        { id: 'turn-2', content: 'in the same order', timestamp: 17 },
      ],
    })
    const automations = JSON.parse(readFileSync(layout.automationsPath, 'utf8')) as { automations: Array<{ enabled: boolean; status: string }>; approvals: unknown[] }
    expect(automations.automations[0]).toMatchObject({ enabled: false, status: 'paused' })
    expect(automations.automations[0]).not.toHaveProperty('activeRunId')
    expect(automations.automations[0]).not.toHaveProperty('pendingRunAt')
    expect(automations.automations[0]).not.toHaveProperty('nextRunAt')
    expect(automations.approvals).toEqual([])
    const receipt = JSON.parse(readFileSync(join(layout.profileRoot, 'import-receipt.json'), 'utf8')) as Record<string, unknown>
    expect(receipt).toMatchObject({ archiveId: preview.archiveId, profileId: result.profile.id, unboundWorkspaces: 1 })
    expect(JSON.stringify(receipt)).not.toContain('source-secret')
  })

  it('reprotects credentials for the target device without preserving source ciphertext', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-import-secret-'))
    directories.push(root)
    const archive = await sourceArchive(root, true)
    const registry = targetRegistry(root)
    let plaintext: unknown
    const importer = new ProfileArchiveImporter({
      registry,
      createId: ids('transaction-secret', 'imported-secret'),
      protectCredentials: credentials => {
        plaintext = structuredClone(credentials)
        return Buffer.from(JSON.stringify({ schemaVersion: 2, protected: true, payload: 'target-device-ciphertext' }))
      },
    })
    const preview = await importer.inspect(archive.path, archive.password)
    const plan = importer.plan(archive.path, preview, { archiveId: preview.archiveId, displayName: 'Secrets', selectedComponents: ['credentials'] })
    const result = await importer.execute({ plan, password: archive.password })
    expect(plaintext).toEqual({ apiKey: 'source-secret' })
    const document = readFileSync(registry.context(result.profile.id).storage.credentialsPath, 'utf8')
    expect(document).toContain('target-device-ciphertext')
    expect(document).not.toContain('source-secret')
  })

  it('never materializes plaintext credential JSON in a recoverable staging transaction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-import-secret-staging-'))
    directories.push(root)
    const archive = await sourceArchive(root, true)
    const registry = targetRegistry(root)
    const importer = new ProfileArchiveImporter({
      registry,
      createId: ids('plan-secret-staging', 'transaction-secret-staging', 'imported-secret-staging'),
      protectCredentials: credentials => Buffer.from(JSON.stringify(credentials)),
      faultAfterPhase: 'staging',
    })
    const preview = await importer.inspect(archive.path, archive.password)
    const plan = importer.plan(archive.path, preview, { archiveId: preview.archiveId, displayName: 'Secrets', selectedComponents: ['credentials'] })
    await expect(importer.execute({ plan, password: archive.password })).rejects.toThrow('Simulated interruption after staging')

    const stagingRoot = join(registry.profilesRoot, '.staging-import-transaction-secret-staging')
    const files = readdirSync(stagingRoot, { recursive: true }).map(path => join(stagingRoot, String(path))).filter(path => statSync(path).isFile())
    expect(files).toEqual([])
    expect(readFileSync(join(importer.journalRoot, 'import-transaction-secret-staging.json'), 'utf8')).not.toContain('source-secret')
  })

  it('preserves stable workspace references when an unbound import is exported again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-import-reexport-'))
    directories.push(root)
    const archive = await sourceArchive(root)
    const registry = targetRegistry(root)
    const importer = new ProfileArchiveImporter({ registry, createId: ids('plan-reexport', 'transaction-reexport', 'imported-reexport'), now: () => 2_000 })
    const preview = await importer.inspect(archive.path)
    const selectedComponents = ['conversations', 'projects', 'automations'] as const
    const plan = importer.plan(archive.path, preview, {
      archiveId: preview.archiveId,
      displayName: 'Re-exported Copy',
      selectedComponents: [...selectedComponents],
    })
    const imported = await importer.execute({ plan })
    const context = registry.context(imported.profile.id)
    const reexport = await new ProfileExportPlanner({
      profile: imported.profile,
      layout: context.storage,
      conversationDataVersion: 1,
      appVersion: '1',
      coreVersion: '1',
      now: () => 3_000,
      createId: () => 'reexported-archive',
    }).prepare({ profileId: imported.profile.id, components: [...selectedComponents], encrypted: false })
    const documents = new Map(reexport.entries.filter(entry => entry.data).map(entry => [entry.path, JSON.parse(Buffer.from(entry.data!).toString('utf8')) as Record<string, unknown>]))
    const conversation = (documents.get('components/conversations/items/conversation-import.json')?.conversation ?? {}) as Record<string, unknown>
    const projects = documents.get('components/projects/projects.json')?.projects as Array<Record<string, unknown>>
    const automations = documents.get('components/automations/automations.json')?.automations as Array<Record<string, unknown>>

    expect(conversation.workspaceId).toBe('workspace-12345678')
    expect(conversation).not.toHaveProperty('workspacePath')
    expect(projects[0]).toMatchObject({ workspaceId: 'workspace-12345678' })
    expect(projects[0]).not.toHaveProperty('path')
    expect(automations[0]).toMatchObject({ workspaceId: 'workspace-12345678', enabled: false, status: 'paused' })
    expect(automations[0]).not.toHaveProperty('workspacePath')
  })

  it('quarantines imported Skills and keeps Plugin and MCP execution disabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-import-executable-'))
    directories.push(root)
    const archive = await sourceArchive(root, false, true)
    const registry = targetRegistry(root)
    const importer = new ProfileArchiveImporter({ registry, createId: ids('plan-executable', 'transaction-executable', 'imported-executable'), now: () => 2_000 })
    const preview = await importer.inspect(archive.path)
    const plan = importer.plan(archive.path, preview, {
      archiveId: preview.archiveId,
      displayName: 'Executable Review',
      selectedComponents: preview.components.map(component => component.id),
    })
    const imported = await importer.execute({ plan })
    const layout = registry.context(imported.profile.id).storage
    const receipt = JSON.parse(readFileSync(imported.receiptPath, 'utf8')) as { disabled: Record<string, number> }
    const plugins = JSON.parse(readFileSync(layout.pluginsIndexPath, 'utf8')) as { plugins: Array<Record<string, unknown>> }
    const settings = JSON.parse(readFileSync(layout.settingsPath, 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> }

    expect(existsSync(layout.userSkillsRoot) ? readdirSync(layout.userSkillsRoot) : []).toEqual([])
    expect(readFileSync(join(layout.extensionsRoot, 'skills-review', 'imported-skill', 'SKILL.md'), 'utf8')).toContain('Must be reviewed')
    expect(receipt.disabled).toMatchObject({ automations: 1, skills: 1, plugins: 1, mcpServers: 1 })
    expect(plugins.plugins).toEqual([expect.objectContaining({ id: 'imported-plugin', enabled: false, approvedPermissions: [] })])
    expect(settings.mcpServers.imported).toMatchObject({ enabled: false, command: 'dangerous-command', env: { API_KEY: '' } })
  })

  it.each([
    ['staging', 'rolled_back'],
    ['validated', 'rolled_back'],
    ['committing', 'rolled_back'],
    ['directory_committed', 'committed'],
    ['registered', 'committed'],
  ] as const)('recovers an interruption after %s as %s', async (phase, expectedOutcome) => {
    const root = mkdtempSync(join(tmpdir(), `turboflux-import-${phase}-`))
    directories.push(root)
    const archive = await sourceArchive(root)
    const registry = targetRegistry(root)
    const importer = new ProfileArchiveImporter({
      registry,
      createId: ids(`plan-${phase}`, `transaction-${phase}`, `imported-${phase}`),
      faultAfterPhase: phase,
    })
    const preview = await importer.inspect(archive.path)
    const plan = importer.plan(archive.path, preview, { archiveId: preview.archiveId, displayName: `Fault ${phase}`, selectedComponents: ['profile.preferences'] })
    await expect(importer.execute({ plan })).rejects.toThrow(`Simulated interruption after ${phase}`)
    const recovered = await new ProfileArchiveImporter({ registry }).recoverTransactions()
    expect(recovered).toEqual([{ transactionId: `import-transaction-${phase}`, outcome: expectedOutcome }])
    const profileId = normalizeConversationV2Id('profile', `imported-${phase}`)
    expect(registry.has(profileId)).toBe(expectedOutcome === 'committed')
    expect(registry.snapshot().profiles.filter(profile => profile.id === profileId)).toHaveLength(expectedOutcome === 'committed' ? 1 : 0)
  })
})
