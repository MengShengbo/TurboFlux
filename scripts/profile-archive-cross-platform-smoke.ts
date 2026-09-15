import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureGithubActionsProvenance } from './github-actions-provenance.mjs'
import { writeSourceEvidenceReportAtomically } from './source-evidence-report.mjs'
import { AgentEngine } from '../packages/agent-core/src/core/agentEngine'
import { NodeToolExecutor } from '../packages/agent-core/src/core/runtime/nodeToolExecutor'
import { DefaultAgentStateProvider } from '../packages/agent-core/src/core/runtime/stateProvider'
import { ConversationInteractionStoreV2 } from '../packages/agent-core/src/application/conversations/conversationInteractionStoreV2'
import { ConversationRepositoryV2 } from '../packages/agent-core/src/application/conversations/conversationRepositoryV2'
import { ConversationRuntimeRepositoryV2 } from '../packages/agent-core/src/application/conversations/conversationRuntimeRepositoryV2'
import { WorkSession } from '../packages/agent-core/src/application/work/workSession'
import type { AgentTurn } from '../packages/agent-core/src/shared/agentTypes'
import type { PersistedConversation } from '../packages/agent-core/src/application/conversations/types'
import {
  InstallationProfileRegistry,
  ProfileArchiveApplicationService,
  ProfileArchiveImporter,
  ProfileExportPlanner,
  ProfileWorkspaceRebindService,
  WorkspaceBindingService,
  collectProfileArchiveEntries,
  containsForbiddenExportData,
  createProfileStorageLayout,
  ensureProfileStorageLayout,
  workspaceOverlayRoot,
  type ArchiveComponentId,
  type LocalProfileRecord,
} from '../packages/agent-core/src/application/profiles/index'

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Profile archive cross-platform smoke failed: ${message}`)
}

function readCollection(path: string, key: string): Array<Record<string, unknown>> {
  const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  invariant(Array.isArray(document[key]), `${key} collection is missing`)
  return document[key] as Array<Record<string, unknown>>
}

async function run(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-profile-product-smoke-'))
  const workspaceId = 'workspace-smoke-12345678'
  const archivePassword = 'portable smoke password'
  try {
    const sourceProfile: LocalProfileRecord = {
      schemaVersion: 1,
      id: 'profile-source-smoke',
      displayName: '跨平台源资料',
      createdAt: 100,
      updatedAt: 100,
      state: 'ready',
      lock: { kind: 'none' },
      storageVersion: 1,
    }
    const sourceLayout = createProfileStorageLayout(join(root, 'source-data'), join(root, 'source-device'), sourceProfile.id)
    ensureProfileStorageLayout(sourceLayout)
    const sourceWorkspace = join(root, 'source-machine', 'portable-workspace')
    mkdirSync(sourceWorkspace, { recursive: true })
    new WorkspaceBindingService(sourceLayout, () => 110, () => workspaceId).ensureBound(sourceWorkspace, '可移植工作区')
    writeFileSync(sourceLayout.configPath, JSON.stringify({
      provider: 'custom',
      model: 'portable-model',
      baseUrl: 'https://example.test/v1',
      approvalPolicy: 'ask',
      capabilityProfile: 'workspace-write',
      gitEnabled: true,
      apiConfigs: [],
    }))
    writeFileSync(sourceLayout.projectsPath, JSON.stringify({
      schemaVersion: 1,
      projects: [{ id: 'project-smoke', name: '可移植项目', path: sourceWorkspace, pinned: true, tags: ['smoke'], createdAt: 100, updatedAt: 110, lastOpenedAt: 110, available: true }],
    }))
    writeFileSync(sourceLayout.automationsPath, JSON.stringify({
      schemaVersion: 2,
      automations: [{ id: 'automation-smoke', name: '导入后不可自动运行', enabled: true, status: 'active', workspacePath: sourceWorkspace, activeRunId: 'source-run', nextRunAt: 999, history: [] }],
      approvals: [{ id: 'source-approval' }],
    }))
    const memoryRoot = join(workspaceOverlayRoot(sourceLayout, workspaceId), 'memory')
    mkdirSync(memoryRoot, { recursive: true })
    writeFileSync(join(memoryRoot, 'facts.jsonl'), '{"text":"portable memory survives"}\n')
    const conversationId = 'conversation-smoke'
    const sourceConversations = new ConversationRepositoryV2(sourceLayout.conversationsV2Root, () => 130)
    sourceConversations.append([{
      eventId: 'event-created-smoke', profileId: sourceProfile.id, conversationId, workspaceId,
      source: 'user', provenance: 'live', type: 'conversation.created', at: 120, payload: { record: {
        schemaVersion: 2, id: conversationId, profileId: sourceProfile.id, workspaceId, title: '跨平台迁移会话',
        titleSource: 'custom', mode: 'vibe', provider: 'custom', model: 'portable-model', status: 'idle',
        createdAt: 120, updatedAt: 120, lastEventSeq: 0, turnCount: 0, runCount: 0, tags: [],
      } },
    }, {
      eventId: 'event-user-smoke', profileId: sourceProfile.id, conversationId, workspaceId, turnId: 'turn-user', itemId: 'item-user',
      source: 'user', provenance: 'live', type: 'item.created', at: 121, payload: { item: {
        schemaVersion: 1, id: 'item-user', conversationId, turnId: 'turn-user', kind: 'user_message', status: 'completed',
        createdAt: 121, updatedAt: 121, payload: { text: '第一条历史消息', attachmentIds: [] },
      } },
    }, {
      eventId: 'event-assistant-smoke', profileId: sourceProfile.id, conversationId, workspaceId, turnId: 'turn-assistant', itemId: 'item-assistant',
      source: 'agent', provenance: 'live', type: 'item.created', at: 122, payload: { item: {
        schemaVersion: 1, id: 'item-assistant', conversationId, turnId: 'turn-assistant', kind: 'assistant_message', status: 'completed',
        createdAt: 122, updatedAt: 122, payload: { text: '第二条历史消息' },
      } },
    }])
    new ConversationInteractionStoreV2(sourceLayout.interactionRoot, sourceProfile.id, () => 130).save(conversationId, {
      queuedInputs: [{ id: 'queued-smoke', prompt: '不得在目标电脑执行' }],
      draft: {
        text: `继续处理 ${sourceWorkspace}/NEXT.md，token=source-draft-secret`,
        files: [{ id: 'file-smoke', type: 'file', path: join(sourceWorkspace, 'NEXT.md'), mime: 'text/markdown', filename: 'NEXT.md', size: 12 }],
        pendingPastes: [{ placeholder: '[Pasted text #1]', text: `查看 ${sourceWorkspace}/NEXT.md` }],
      },
      pendingSteering: [{ id: 'steering-smoke', text: '不得在目标电脑 steering' }],
      pendingApprovals: [{ requestId: 'approval-smoke', requestKind: 'permission', question: '不得恢复审批' }],
    })

    const targetRegistry = new InstallationProfileRegistry(join(root, 'target-data'), {
      deviceRoot: join(root, 'target-device'),
      createId: () => 'default-smoke',
      installationId: () => 'target-installation-smoke',
      now: () => 1_000,
    })
    const targetBefore = targetRegistry.initialize()
    let generatedId = 0
    let operationId = 0
    const importer = new ProfileArchiveImporter({
      registry: targetRegistry,
      createId: () => `smoke-${++generatedId}`,
      now: () => 2_000,
    })
    const planner = new ProfileExportPlanner({
      profile: sourceProfile,
      layout: sourceLayout,
      conversationDataVersion: 2,
      appVersion: '1.0.1',
      coreVersion: '1.0.1',
      now: () => 200,
      createId: () => 'cross-platform-smoke-archive',
    })
    const service = new ProfileArchiveApplicationService({
      planner,
      importer,
      createOperationId: () => `profile-smoke-operation-${++operationId}`,
      now: () => 3_000 + operationId,
    })
    const components: ArchiveComponentId[] = [
      'profile.preferences',
      'model.configurations',
      'conversations',
      'projects',
      'automations',
      'memories',
    ]
    const estimate = await service.estimateExport({
      profileId: sourceProfile.id,
      components,
      encrypted: true,
    })
    invariant(estimate.blockers.length === 0, `export blockers: ${estimate.blockers.map(blocker => blocker.code).join(', ')}`)
    const archivePath = join(root, 'portable-profile-smoke.turboflux-profile')
    const exportRef = service.startExport({ planId: estimate.planId, targetPath: archivePath, password: archivePassword })
    const exported = await service.waitForOperation(exportRef.operationId)
    invariant(exported.phase === 'completed' && exported.result?.sha256 && exported.result.physicalBytes, exported.error?.message || 'export did not complete')
    const entries = await collectProfileArchiveEntries({ path: archivePath, password: archivePassword })
    const exportedText = [...entries.values()].map(value => value.toString('utf8')).join('\n')
    invariant(!exportedText.includes(sourceWorkspace), 'archive retained the source absolute workspace path')
    invariant(!containsForbiddenExportData(exportedText), 'archive retained forbidden secret or device data')
    const archiveManifest = JSON.parse(entries.get('manifest.json')?.toString('utf8') ?? '{}') as Record<string, unknown>
    const conversationData = archiveManifest.conversationData as Record<string, unknown> | undefined
    const eventSegments = conversationData?.eventSegments as Record<string, unknown> | undefined
    const projections = conversationData?.projections as Record<string, unknown> | undefined
    invariant(archiveManifest.conversationDataVersion === 2, 'archive did not declare Conversation V2')
    invariant(eventSegments?.format === 'per-conversation-json' && eventSegments.segmentCount === 1 && eventSegments.eventCount === 3, 'archive Event segment metadata is incomplete')
    invariant(projections?.included === false && projections.rebuildRequired === true, 'archive did not require projection rebuild')

    const preview = await service.inspectArchive(archivePath, archivePassword)
    const importPlan = service.planImport(archivePath, {
      archiveId: preview.archiveId,
      displayName: '跨平台导入资料',
      selectedComponents: preview.components.filter(component => component.supported).map(component => component.id),
    })
    invariant(importPlan.blockers.length === 0, `import blockers: ${importPlan.blockers.map(blocker => blocker.code).join(', ')}`)
    const importRef = service.startImport({ planId: importPlan.planId, password: archivePassword })
    const imported = await service.waitForOperation(importRef.operationId)
    const importedProfileId = imported.result?.profileId
    invariant(imported.phase === 'completed' && importedProfileId, imported.error?.message || 'import did not complete')
    const targetAfterImport = targetRegistry.snapshot()
    invariant(targetAfterImport.activeProfileId === targetBefore.activeProfileId, 'import replaced or activated over the existing profile')
    invariant(targetAfterImport.profiles.length === targetBefore.profiles.length + 1, 'import did not create exactly one isolated profile')
    const importedLayout = targetRegistry.context(importedProfileId).storage
    const importedWorkspace = new WorkspaceBindingService(importedLayout).get(workspaceId)
    invariant(importedWorkspace?.state === 'unbound' && !importedWorkspace.localPath, 'foreign workspace was materialized before rebind')
    const importedConversations = new ConversationRepositoryV2(importedLayout.conversationsV2Root)
    const importedConversation = importedConversations.projection(conversationId)
    invariant(importedConversation.conversation?.workspaceId === workspaceId && importedConversation.conversation.status === 'needs_workspace', 'conversation did not retain an unbound portable workspace identity')
    const importedMessages = importedConversation.items
      .filter(item => item.kind === 'user_message' || item.kind === 'assistant_message')
      .map(item => String((item.payload as { text?: unknown }).text ?? ''))
    invariant(importedMessages.join('|') === '第一条历史消息|第二条历史消息', 'conversation history changed during round trip')
    const searchResults = importedConversations.search('第二条历史消息')
    invariant(searchResults.some(result => result.conversationId === conversationId && result.itemId === 'item-assistant'), 'imported history was not searchable before workspace rebind')
    const importedInteraction = new ConversationInteractionStoreV2(importedLayout.interactionRoot, importedProfileId).load(conversationId)
    invariant(importedInteraction.queuedInputs.length === 0 && importedInteraction.pendingSteering.length === 0 && importedInteraction.pendingApprovals.length === 0, 'import restored active interaction state')
    invariant(importedInteraction.draft.text.includes('workspace://workspace-smoke-12345678/NEXT.md') && importedInteraction.draft.text.includes('[secret-redacted]'), 'safe draft was not virtualized and redacted')
    invariant(!importedInteraction.draft.files?.length && !importedInteraction.draft.attachments?.length, 'draft retained machine-bound files or attachments')
    const importedAutomation = readCollection(importedLayout.automationsPath, 'automations')[0]
    invariant(importedAutomation?.enabled === false && importedAutomation.status === 'paused', 'imported automation execution was not disabled')
    invariant(!('activeRunId' in importedAutomation) && !('nextRunAt' in importedAutomation), 'imported automation retained execution state')

    const importedBindings = new WorkspaceBindingService(importedLayout)
    let executionBlockedBeforeRebind = false
    try {
      importedBindings.pathResolver().resolve({ scheme: 'workspace', workspaceId, relativePath: 'NEXT.md' })
    } catch (error) {
      executionBlockedBeforeRebind = error instanceof Error && 'code' in error && error.code === 'WORKSPACE_UNBOUND'
    }
    invariant(executionBlockedBeforeRebind, 'unbound workspace did not block executable path resolution')
    const journalPath = join(importedLayout.conversationsV2Root, 'events', `${conversationId}.jsonl`)
    const historicalJournal = readFileSync(journalPath, 'utf8')

    const targetWorkspace = join(root, 'target-machine', 'portable-workspace')
    mkdirSync(targetWorkspace, { recursive: true })
    const rebound = new ProfileWorkspaceRebindService(importedLayout, () => 4_000).rebind({ workspaceId, localPath: targetWorkspace })
    invariant(!rebound.requiresMismatchConfirmation && rebound.workspace.state === 'bound', 'workspace rebind did not complete')
    invariant(rebound.automationsRemainDisabled && rebound.updated.conversations === 1 && rebound.updated.projects === 1 && rebound.updated.automations === 1, 'rebind did not update every portable reference')
    const reboundConversation = new ConversationRepositoryV2(importedLayout.conversationsV2Root).projection(conversationId)
    invariant(reboundConversation.conversation?.status === 'idle' && reboundConversation.workspace?.bindingState === 'bound', 'Conversation V2 did not become runnable after workspace rebind')
    const reboundJournal = readFileSync(journalPath, 'utf8')
    invariant(reboundJournal.startsWith(historicalJournal), 'workspace rebind rewrote historical Conversation V2 events')
    invariant(!reboundJournal.includes(targetWorkspace), 'Conversation V2 persisted the target machine path')
    invariant(readCollection(importedLayout.projectsPath, 'projects')[0]?.path === targetWorkspace, 'project was not rebound to the target workspace')
    const reboundAutomation = readCollection(importedLayout.automationsPath, 'automations')[0]
    invariant(reboundAutomation?.workspacePath === targetWorkspace && reboundAutomation.enabled === false && reboundAutomation.status === 'paused', 'rebind re-enabled imported automation execution')

    const continuationMarker = 'TARGET_WORKSPACE_CONTINUATION_READY'
    writeFileSync(join(targetWorkspace, 'NEXT.md'), `${continuationMarker}\n请读取此文件并继续迁移后的任务。\n`)
    const resolvedNextPath = new WorkspaceBindingService(importedLayout).pathResolver().resolve({ scheme: 'workspace', workspaceId, relativePath: 'NEXT.md' })
    invariant(readFileSync(resolvedNextPath, 'utf8').includes(continuationMarker), 'portable path did not resolve against the rebound workspace')

    const historicalTurns: AgentTurn[] = [
      { id: 'turn-history-user', role: 'user', content: importedMessages[0]!, timestamp: 121 },
      { id: 'turn-history-assistant', role: 'assistant', content: importedMessages[1]!, timestamp: 122 },
    ]
    const stateProvider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'offline-smoke',
      baseUrl: 'http://127.0.0.1.invalid',
      model: 'deterministic-profile-smoke',
      contextWindow: 100_000,
      maxTokens: 2_048,
    }, targetWorkspace)
    const engine = new AgentEngine({
      mode: 'vibe',
      approvalPolicy: 'full',
      capabilityProfile: 'workspace-write',
      workspacePath: targetWorkspace,
      gitEnabled: false,
    }, new NodeToolExecutor(targetWorkspace, { capabilityProfile: 'workspace-write' }), stateProvider)
    engine.restoreFromTurns(historicalTurns, { emitRunState: false })
    const runtimeRepository = new ConversationRuntimeRepositoryV2(
      importedLayout.conversationsV2Root,
      importedProfileId,
      workspaceId,
      targetWorkspace,
      () => 5_000,
    )
    const work = new WorkSession(conversationId)
    work.replaceFromTurns(historicalTurns)
    let eventTime = 5_000
    const currentConversation = (): PersistedConversation => ({
      id: conversationId,
      title: '跨平台迁移会话',
      titleSource: 'custom',
      workspacePath: targetWorkspace,
      createdAt: 120,
      updatedAt: eventTime,
      mode: 'vibe',
      provider: 'custom',
      model: 'deterministic-profile-smoke',
      turnCount: engine.getFullConversationTurns().length,
      turns: engine.getFullConversationTurns(),
    })
    const unsubscribe = engine.subscribe(event => {
      eventTime += 1
      for (const canonicalEvent of work.appendAgent(event, eventTime)) {
        runtimeRepository.appendCanonical(canonicalEvent, currentConversation())
      }
    })
    let modelCall = 0
    let agentObservedTargetWorkspace = false
    const engineInternals = engine as unknown as {
      initializeGit(): Promise<boolean>
      prepareContextWindow(): Promise<void>
      callModel(): Promise<AgentTurn>
    }
    engineInternals.initializeGit = async () => false
    engineInternals.prepareContextWindow = async () => undefined
    engineInternals.callModel = async () => {
      modelCall += 1
      if (modelCall === 1) {
        return {
          id: 'assistant-continuation-tool',
          role: 'assistant',
          content: '',
          timestamp: eventTime + 1,
          toolCalls: [{ id: 'tool-read-rebound-workspace', name: 'read_file', arguments: { path: 'NEXT.md' } }],
        }
      }
      const toolResult = engine.getFullConversationTurns()
        .flatMap(turn => turn.toolResults ?? [])
        .find(result => result.toolCallId === 'tool-read-rebound-workspace')
      agentObservedTargetWorkspace = toolResult?.isError === false && toolResult.output.includes(continuationMarker)
      invariant(agentObservedTargetWorkspace, 'Agent did not receive the file contents from the rebound workspace')
      return {
        id: 'assistant-continuation-final',
        role: 'assistant',
        content: '已从目标工作区继续完成迁移任务。',
        timestamp: eventTime + 1,
      }
    }
    let continuationTurns: AgentTurn[]
    try {
      continuationTurns = await engine.run('读取 NEXT.md，继续这个迁移后的开发任务。')
    } finally {
      unsubscribe()
      engine.destroy()
    }
    invariant(modelCall === 2 && agentObservedTargetWorkspace, 'deterministic Agent continuation did not complete its tool loop')
    invariant(continuationTurns.some(turn => turn.content === '已从目标工作区继续完成迁移任务。'), 'Agent continuation did not produce a final response')
    const continuedRepository = new ConversationRepositoryV2(importedLayout.conversationsV2Root)
    const continuedProjection = continuedRepository.projection(conversationId)
    invariant(continuedProjection.items.some(item => item.kind === 'tool_result'
      && String((item.payload as { output?: unknown }).output ?? '').includes(continuationMarker)), 'continued conversation did not persist the rebound workspace tool result')
    invariant(continuedRepository.search('目标工作区继续完成').some(result => result.conversationId === conversationId), 'continued conversation was not added to search')

    const result = {
      schemaVersion: 2,
      platform: process.platform,
      arch: process.arch,
      provenance: captureGithubActionsProvenance(),
      encryptedArchive: true,
      archiveSha256: exported.result.sha256,
      archiveBytes: exported.result.physicalBytes,
      componentCount: preview.components.length,
      importedProfileCreated: true,
      originalProfilePreserved: true,
      workspaceInitiallyUnbound: true,
      executionBlockedBeforeRebind,
      workspaceRebound: true,
      historicalEventsPreserved: true,
      importedHistorySearchable: true,
      agentContinuedInReboundWorkspace: true,
      continuedConversationSearchable: true,
      automationRemainedDisabled: true,
      conversationTurnsVerified: importedMessages.length,
      safeDraftMigrated: true,
      activeInteractionStateDiscarded: true,
    }
    const outputRoot = join(process.cwd(), 'apps', 'desktop', 'generated', 'profile-smoke')
    mkdirSync(outputRoot, { recursive: true })
    await writeSourceEvidenceReportAtomically(
      join(outputRoot, `result-${process.platform}-${process.arch}.json`),
      result,
    )
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

await run()
