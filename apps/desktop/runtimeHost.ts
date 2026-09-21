import { createHash } from 'node:crypto'
import { copyFile, mkdir, open as openFile, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { nativeImage, safeStorage } from 'electron'
import {
  AutomationCoordinator,
  AutomationApplicationService,
  AutomationRepository,
  AutomationService,
  nextAutomationRunTimes,
  WorkbenchRuntime,
  WorkspaceBindingService,
  buildWorkPackCatalog,
  configureNetworkProxy,
  loadConfig,
  setCredentialProtection,
  type AgentAttachment,
  type AgentCapabilitySelection,
  type ApprovalPolicy,
  type ArtifactSource,
  type AutomationSchedule,
  type AutomationCapabilityPolicy,
  type AutomationObjective,
  type AutomationRunMode,
  type AutomationUpdateInput,
  type AutomationDraftInput,
  type AutomationDefinition,
  type McpClient,
  type PluginPermission,
  type ProfileStorageLayout,
  WorkbenchCommandId,
  WorkbenchDraftSnapshot,
  type WorkbenchEvent,
  WorkbenchFileReference,
  WorkbenchMemoryCreateInput,
  WorkbenchMemoryFilters,
  WorkbenchMemoryUpdateInput,
  WorkbenchSettingsUpdate,
  type TurboFluxConfig,
  type WorkbenchSnapshot,
} from '@turboflux/workbench'
import { DESKTOP_EXPERIENCE_SYSTEM_PROMPT } from './productExperience'
import { fallbackTaskTitle, isPlaceholderTaskTitle, reusableEmptyConversation } from './conversationPolicy'
import { recoverContextUsage } from './contextUsageRecovery'
import type { DesktopWorkbenchSnapshot } from './desktopTypes'
import { projectHistoryRewrite } from './historyRewrite'
import { runtimeTransitionBlocker } from './runtimeTransitionPolicy'
import { generateTaskTitle } from './taskTitleGenerator'
import { TaskTitleApplyGateRegistry, type TaskTitleApplyGate } from './taskTitleApplyGate'
import { isPathInside } from './pathContainment.js'
import { WorkspaceRuntimePool } from './workspaceRuntimePool'
import { assertExecutableConversationWorkspace } from './conversationWorkspacePolicy'
import { automationRemoteApprovalPolicy } from './automationRemoteApprovalPolicy'

export type DesktopRuntimeEventListener = (event: WorkbenchEvent) => void


export interface DesktopRuntimeHostOptions {
  onUsageEvent?: (event: WorkbenchEvent) => void
  registerSystemPlugins?: (client: McpClient, context: { conversationId: string; workspaceOverlayRoot?: string }) => void
  storagePath?: string
  profileStorage?: ProfileStorageLayout
  unscopedWorkspacePath?: string
  externalTransitionBlocker?: () => string | null
}



interface ManagedTaskTitleState {
  title: string
  evaluatedPromptCount: number
}

function desktopTimingSummary(samples: readonly number[]) {
  if (samples.length === 0) return { count: 0, totalMs: 0, p50Ms: 0, p90Ms: 0, maxMs: 0 }
  const sorted = [...samples].sort((left, right) => left - right)
  const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!
  return {
    count: samples.length,
    totalMs: Number(samples.reduce((total, value) => total + value, 0).toFixed(3)),
    p50Ms: Number(percentile(0.5).toFixed(3)),
    p90Ms: Number(percentile(0.9).toFixed(3)),
    maxMs: Number(sorted.at(-1)!.toFixed(3)),
  }
}



const MAX_IMPORTED_FILE_BYTES = 50 * 1024 * 1024
const MAX_PREVIEW_IMAGE_BYTES = 20 * 1024 * 1024
const PREVIEW_THUMBNAIL_WIDTH = 560
const PREVIEW_THUMBNAIL_HEIGHT = 420
const PREVIEW_THUMBNAIL_CACHE_LIMIT = 48
const PREVIEW_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const DESKTOP_REMOVED_TOOLS = ['web_search', 'web_fetch']
type ImagePreviewPurpose = 'thumbnail' | 'full'

function mimeForPath(filePath: string): string {
  const extension = extname(filePath).toLowerCase()
  return ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
  } as Record<string, string>)[extension] || 'application/octet-stream'
}

function safeFilename(value: string): string {
  return basename(value).replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 120) || 'attachment'
}

export class DesktopRuntimeHost {
  private readonly onUsageEvent?: DesktopRuntimeHostOptions['onUsageEvent']
  private runtime: WorkbenchRuntime | null = null
  private destroyPromise?: Promise<void>
  private unsubscribeRuntime: (() => void) | null = null
  private readonly listeners = new Set<DesktopRuntimeEventListener>()
  private workspacePath: string
  private registerSystemPlugins?: DesktopRuntimeHostOptions['registerSystemPlugins']
  private readonly storagePath?: string
  private readonly profileStorage?: ProfileStorageLayout
  private readonly workspaceBindingService?: WorkspaceBindingService
  private readonly unscopedWorkspacePath?: string
  private readonly externalTransitionBlocker?: DesktopRuntimeHostOptions['externalTransitionBlocker']
  private readonly automationService: AutomationService
  private readonly automationRepository: AutomationRepository
  private readonly workspaceRuntimePool: WorkspaceRuntimePool
  private readonly automationCoordinator: AutomationCoordinator
  private readonly automationApplicationService: AutomationApplicationService
  private runtimeConfig: TurboFluxConfig | null = null
  private suppressRuntimeEvents = false
  private readonly managedTaskTitles = new Map<string, ManagedTaskTitleState>()
  private readonly taskPrompts = new Map<string, string[]>()
  private readonly submittedPromptCounts = new Map<string, number>()
  private readonly taskRunPromptCounts = new Map<string, number[]>()
  private readonly taskTitleUpdates = new Map<string, Promise<void>>()
  private readonly taskTitleRevisions = new Map<string, number>()
  private readonly taskTitleApplyGates = new TaskTitleApplyGateRegistry()
  private readonly historyRewriteConversations = new Set<string>()
  private readonly imageThumbnailCache = new Map<string, string>()
  private managedTaskTitleSave = Promise.resolve()
  private directedConversationOperations = Promise.resolve()
  private runtimeEpoch = 0
  private runtimeTransitioning = false
  private desktopStreamTraceActive = false
  private readonly desktopStreamListenerDurations = new Map<string, number[]>()

  private constructor(workspacePath: string, options: DesktopRuntimeHostOptions = {}) {
    this.onUsageEvent = options.onUsageEvent
    this.workspacePath = workspacePath
    this.registerSystemPlugins = options.registerSystemPlugins
    this.storagePath = options.storagePath
    this.profileStorage = options.profileStorage
    this.workspaceBindingService = options.profileStorage ? new WorkspaceBindingService(options.profileStorage) : undefined
    this.unscopedWorkspacePath = options.unscopedWorkspacePath ? resolve(options.unscopedWorkspacePath) : undefined
    this.externalTransitionBlocker = options.externalTransitionBlocker
    const platformStoragePath = options.profileStorage?.platformRoot
      ?? options.storagePath
      ?? join(workspacePath, '.turboflux', 'desktop-state')
    this.automationService = new AutomationService(options.profileStorage?.automationsPath ?? join(platformStoragePath, 'automations.json'))
    this.automationRepository = new AutomationRepository(join(platformStoragePath, 'automations-v3'))
    this.workspaceRuntimePool = new WorkspaceRuntimePool({
      automationService: this.automationService,
      automationRepository: this.automationRepository,
      createRuntime: backgroundWorkspacePath => this.createBackgroundRuntime(backgroundWorkspacePath),
      foregroundState: () => {
        if (!this.runtime) return { workspacePath: this.workspacePath, busy: false }
        const snapshot = this.runtime.getSnapshot()
        return {
          workspacePath: snapshot.workspace.path,
          busy: snapshot.conversationRuntimes.some(runtime => runtime.status !== 'ready'),
        }
      },
      onApprovalChanged: () => {
        if (this.runtime && !this.suppressRuntimeEvents) {
          for (const listener of this.listeners) listener({ type: 'snapshot', snapshot: this.getSnapshot() })
        }
      },
    })
    this.automationCoordinator = new AutomationCoordinator(
      this.automationService,
      this.automationRepository,
      this.workspaceRuntimePool,
      {
        sourcePath: join(platformStoragePath, 'automations.json'),
        hasSecretRef: id => typeof process.env[id] === 'string' && process.env[id]!.length > 0,
        resolvePluginVersion: id => this.runtime?.plugins.list().plugins.find(plugin => plugin.id === id && plugin.enabled)?.manifest.version,
        onStateChanged: () => {
          if (this.runtime && !this.suppressRuntimeEvents) {
            for (const listener of this.listeners) listener({ type: 'snapshot', snapshot: this.getSnapshot() })
          }
        },
      },
    )
    this.automationApplicationService = new AutomationApplicationService(
      this.automationService,
      this.automationRepository,
      this.automationCoordinator,
      {
        onDefinitionsChanged: () => this.notifyAutomationDefinitionsChanged(),
        hasSecretRef: id => typeof process.env[id] === 'string' && process.env[id]!.length > 0,
        hasSkill: id => Boolean(this.runtime?.getSnapshot().skills.some(skill => skill.id === id)),
        hasPlugin: id => Boolean(this.runtime?.plugins.list().plugins.find(plugin => plugin.id === id && plugin.enabled)),
      },
    )
  }

  static async create(workspacePath: string, options: DesktopRuntimeHostOptions = {}): Promise<DesktopRuntimeHost> {
    configureNetworkProxy()
    if (safeStorage.isEncryptionAvailable()) {
      setCredentialProtection({
        protect: plaintext => safeStorage.encryptString(plaintext.toString('base64url')),
        unprotect: ciphertext => Buffer.from(safeStorage.decryptString(ciphertext), 'base64url'),
      })
    }
    const host = new DesktopRuntimeHost(resolve(workspacePath), options)
    host.automationCoordinator.initialize()
    await host.loadManagedTaskTitles()
    await host.replaceRuntime(host.workspacePath)
    host.automationCoordinator.start()
    return host
  }

  subscribe(listener: DesktopRuntimeEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setSystemPluginRegistrar(registrar: DesktopRuntimeHostOptions['registerSystemPlugins']): void {
    this.registerSystemPlugins = registrar
    if (registrar && this.runtime) this.runtime.registerSystemPlugins(registrar)
  }

  getSnapshot(): DesktopWorkbenchSnapshot {
    return this.decorateSnapshot(this.requireRuntime().getSnapshot())
  }

  transitionBlocker(options: { allowRecoverableError?: boolean } = {}): string | null {
    const externalBlocker = this.externalTransitionBlocker?.()
    if (externalBlocker) return externalBlocker
    if (this.runtimeTransitioning) return '工作环境正在更新，请稍后再试'
    return runtimeTransitionBlocker(this.requireRuntime().getSnapshot(), options)
  }

  async getSettings(forceModels = false) {
    return this.requireRuntime().getSettings(forceModels)
  }

  async previewSettingsModels(update: WorkbenchSettingsUpdate) {
    return this.requireRuntime().previewSettingsModels(update)
  }

  async saveSettings(update: WorkbenchSettingsUpdate) {
    this.assertRuntimeAvailable()
    const result = await this.requireRuntime().saveSettings(update)
    await this.workspaceRuntimePool.invalidateConfiguration()
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  submitPrompt(prompt: string, attachments?: AgentAttachment[], capabilities?: AgentCapabilitySelection) {
    this.assertRuntimeReadyForRun()
    const runtime = this.requireRuntime()
    this.applyDesktopToolPolicy(runtime)
    const snapshot = runtime.getSnapshot()
    const activeConversation = snapshot.conversationCatalog.find(conversation => conversation.id === snapshot.conversation.id)
    if (activeConversation) assertExecutableConversationWorkspace(activeConversation.workspacePath)
    const paused = snapshot.runtime.status === 'paused'
    if (paused) runtime.stopConversation(snapshot.conversation.id)
    const startsNewRun = !['running', 'paused', 'awaiting-action'].includes(snapshot.runtime.status)
    const titleApplyGate = startsNewRun ? this.taskTitleApplyGates.begin(snapshot.conversation.id) : undefined
    let result: ReturnType<WorkbenchRuntime['submitPrompt']>
    try {
      result = runtime.submitPrompt(prompt, attachments, capabilities, { forceQueue: paused })
    } catch (error) {
      if (titleApplyGate) this.taskTitleApplyGates.release(snapshot.conversation.id, titleApplyGate)
      throw error
    }
    if (result.status !== 'started' && titleApplyGate) {
      this.taskTitleApplyGates.release(snapshot.conversation.id, titleApplyGate)
    }
    const promptCount = this.recordTaskPrompt(snapshot.conversation.id, prompt, snapshot)
    this.trackTaskRunPromptCount(snapshot.conversation.id, promptCount, result.status)
    this.scheduleTaskTitleUpdate(snapshot.conversation.id, promptCount, result.status === 'started' ? titleApplyGate : undefined)
    return result
  }

  submitPromptToConversation(conversationId: string, prompt: string, mode: 'turn' | 'queue' | 'steer' = 'turn') {
    return this.runDirectedConversationOperation(conversationId, async runtime => {
      this.applyDesktopToolPolicy(runtime)
      const result = await runtime.submitPromptToConversation(conversationId, prompt, undefined, undefined, mode)
      const promptCount = this.recordTaskPrompt(conversationId, prompt, runtime.getSnapshot())
      this.trackTaskRunPromptCount(conversationId, promptCount, result.status)
      this.scheduleTaskTitleUpdate(conversationId, promptCount)
      return result
    })
  }

  controlConversation(conversationId: string, action: 'pause' | 'resume' | 'stop') {
    return this.runDirectedConversationOperation(conversationId, runtime => {
      if (action === 'pause') return runtime.pauseConversation(conversationId)
      if (action === 'resume') return runtime.resumeConversation(conversationId)
      return runtime.stopConversation(conversationId)
    })
  }

  async resendFromTurn(turnId: string, prompt: string) {
    this.assertRuntimeReadyForRun()
    const runtime = this.requireRuntime()
    this.applyDesktopToolPolicy(runtime)
    const snapshot = runtime.getSnapshot()
    const activeConversation = snapshot.conversationCatalog.find(conversation => conversation.id === snapshot.conversation.id)
    if (activeConversation) assertExecutableConversationWorkspace(activeConversation.workspacePath)
    const rewrite = projectHistoryRewrite(snapshot.conversation.turns, turnId, prompt)
    if (!rewrite) throw new Error('这条消息已经不在当前会话中')
    const conversationId = snapshot.conversation.id
    const titleApplyGate = this.taskTitleApplyGates.begin(conversationId)
    this.taskTitleRevisions.set(conversationId, (this.taskTitleRevisions.get(conversationId) || 0) + 1)
    this.historyRewriteConversations.add(conversationId)
    let result: Awaited<ReturnType<WorkbenchRuntime['resendFromTurn']>>
    try {
      result = await runtime.resendFromTurn(turnId, prompt)
    } catch (error) {
      this.taskTitleApplyGates.release(conversationId, titleApplyGate)
      throw error
    } finally {
      this.historyRewriteConversations.delete(conversationId)
    }
    const previousPromptCount = this.submittedPromptCounts.get(conversationId)
    const previousPrompts = this.taskPrompts.get(conversationId)
    this.submittedPromptCounts.set(conversationId, rewrite.promptCount)
    this.taskPrompts.set(conversationId, rewrite.prompts.slice(-6))
    this.taskRunPromptCounts.set(conversationId, [rewrite.promptCount])
    const managed = this.managedTaskTitles.get(conversationId)
    if (managed && managed.evaluatedPromptCount >= rewrite.promptCount) {
      this.managedTaskTitles.set(conversationId, {
        ...managed,
        evaluatedPromptCount: Math.max(0, rewrite.promptCount - 1),
      })
    }
    try {
      this.scheduleTaskTitleUpdate(conversationId, rewrite.promptCount, titleApplyGate)
    } catch (error) {
      if (previousPromptCount === undefined) this.submittedPromptCounts.delete(conversationId)
      else this.submittedPromptCounts.set(conversationId, previousPromptCount)
      if (previousPrompts === undefined) this.taskPrompts.delete(conversationId)
      else this.taskPrompts.set(conversationId, previousPrompts)
      throw error
    }
    return result
  }

  recordDraft(draft: WorkbenchDraftSnapshot | string) {
    return this.requireRuntime().recordDraft(draft)
  }

  listCommands() {
    return this.requireRuntime().listCommands()
  }

  async executeCommand(command: WorkbenchCommandId) {
    const result = await this.requireRuntime().executeCommand(command)
    return result.snapshot ? { ...result, snapshot: this.decorateSnapshot(result.snapshot) } : result
  }

  stop() {
    return this.requireRuntime().stop()
  }

  stopConversation(id: string) {
    return this.requireRuntime().stopConversation(id)
  }

  pause() {
    return this.requireRuntime().pause()
  }

  pauseConversation(id: string) {
    return this.requireRuntime().pauseConversation(id)
  }

  resumeConversation(id: string) {
    const target = this.requireRuntime().getSnapshot().conversationCatalog.find(conversation => conversation.id === id)
    if (target) assertExecutableConversationWorkspace(target.workspacePath)
    return this.requireRuntime().resumeConversation(id)
  }

  resume() {
    const runtime = this.requireRuntime()
    const snapshot = runtime.getSnapshot()
    const target = snapshot.conversationCatalog.find(conversation => conversation.id === snapshot.conversation.id)
    if (target) assertExecutableConversationWorkspace(target.workspacePath)
    return runtime.resume()
  }

  controlWorkStep(taskId: string, action: 'retry' | 'skip' | 'cancel' | 'resume') {
    const result = this.requireRuntime().controlWorkStep(taskId, action)
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  resolveRequest(requestId: string, response: string) {
    return this.requireRuntime().resolveRequest(requestId, response)
  }

  resolveRequestForConversation(conversationId: string, requestId: string, response: string) {
    return this.runDirectedConversationOperation(conversationId, runtime => (
      runtime.resolveRequestForConversation(conversationId, requestId, response)
    ))
  }

  async newConversation() {
    const runtime = this.requireRuntime()
    const snapshot = runtime.getSnapshot()
    const reusable = reusableEmptyConversation(snapshot.conversations, snapshot.conversation.id)
    const hasActiveWork = snapshot.conversationRuntimes.some(conversationRuntime => conversationRuntime.status !== 'ready')
    if (hasActiveWork || !reusable) {
      const result = await runtime.newConversation()
      this.applyDesktopToolPolicy(runtime)
      return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
    }
    if (reusable.id === snapshot.conversation.id) {
      this.applyDesktopToolPolicy(runtime)
      return { id: reusable.id, snapshot: this.decorateSnapshot(snapshot) }
    }
    const result = await runtime.switchConversation(reusable.id)
    this.applyDesktopToolPolicy(runtime)
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  async switchConversation(id: string) {
    return this.switchConversationWithOptions(id, true)
  }

  async activateRemoteSession(id: string) {
    return this.switchConversationWithOptions(id, false)
  }

  private async switchConversationWithOptions(id: string, startQueuedPrompt: boolean) {
    const currentRuntime = this.requireRuntime()
    const target = currentRuntime.getSnapshot().conversationCatalog.find(conversation => conversation.id === id)
    if (!target) throw new Error(`Conversation not found: ${id}`)
    assertExecutableConversationWorkspace(target.workspacePath)
    const currentWorkspacePath = resolve(currentRuntime.getSnapshot().workspace.path)
    const targetWorkspacePath = resolve(target.workspacePath)
    if (targetWorkspacePath === currentWorkspacePath) {
      const result = await currentRuntime.switchConversation(id, { startQueuedPrompt })
      this.applyDesktopToolPolicy(currentRuntime)
      return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
    }

    this.assertRuntimeTransitionAllowed()
    this.suppressRuntimeEvents = true
    try {
      await this.setWorkspace(targetWorkspacePath)
      const runtime = this.requireRuntime()
      const result = await runtime.switchConversation(id, { startQueuedPrompt })
      this.applyDesktopToolPolicy(runtime)
      return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
    } finally {
      this.suppressRuntimeEvents = false
    }
  }

  deleteConversation(id: string) {
    return this.requireRuntime().deleteConversation(id)
  }

  async renameConversation(id: string, title: string) {
    const renamed = await this.requireRuntime().renameConversation(id, title)
    if (renamed) {
      this.managedTaskTitles.delete(id)
      await this.saveManagedTaskTitles()
    }
    return renamed
  }

  async stageGit(paths: string[]) {
    const result = await this.requireRuntime().stageGit(paths)
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  async unstageGit(paths: string[]) {
    const result = await this.requireRuntime().unstageGit(paths)
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  async commitGit(message: string, paths?: string[]) {
    const result = await this.requireRuntime().commitGit(message, paths)
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  async createGitBranch(name: string, startPoint?: string) {
    const result = await this.requireRuntime().createGitBranch(name, startPoint)
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  async switchGitBranch(name: string) {
    const result = await this.requireRuntime().switchGitBranch(name)
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  async restoreGit(paths: string[], source?: string) {
    const result = await this.requireRuntime().restoreGit(paths, source)
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  async pushGit(remote?: string, branch?: string, setUpstream = false) {
    const result = await this.requireRuntime().pushGit(remote, branch, setUpstream)
    return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
  }

  readGitDiff(path?: string, scope?: 'working' | 'staged' | 'all') {
    return this.requireRuntime().readGitDiff(path, scope)
  }

  addProject(path: string, name?: string) {
    return this.requireRuntime().addProject(path, name)
  }

  renameProject(id: string, name: string) {
    this.requireRuntime().updateProject(id, { name })
    return this.getSnapshot()
  }

  removeProject(id: string) {
    this.requireRuntime().removeProject(id)
    return this.getSnapshot()
  }

  async newConversationInProject(id: string) {
    const project = this.requireRuntime().getProject(id)
    if (!project) throw new Error(`Project not found: ${id}`)
    const currentWorkspacePath = resolve(this.requireRuntime().getSnapshot().workspace.path)
    const targetWorkspacePath = resolve(project.path)
    if (targetWorkspacePath !== currentWorkspacePath) this.assertRuntimeTransitionAllowed()
    this.suppressRuntimeEvents = true
    try {
      await this.setWorkspace(project.path)
      const runtime = this.requireRuntime()
      const snapshot = runtime.getSnapshot()
      const reusable = reusableEmptyConversation(snapshot.conversations, snapshot.conversation.id)
      const hasActiveWork = snapshot.conversationRuntimes.some(conversationRuntime => conversationRuntime.status !== 'ready')
      if (reusable?.id === snapshot.conversation.id && !hasActiveWork) {
        return { id: reusable.id, snapshot: this.decorateSnapshot(snapshot) }
      }
      if (reusable && !hasActiveWork) {
        const result = await runtime.switchConversation(reusable.id)
        return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
      }
      const result = await runtime.newConversation()
      this.applyDesktopToolPolicy(runtime)
      return { ...result, snapshot: this.decorateSnapshot(result.snapshot) }
    } finally {
      this.suppressRuntimeEvents = false
    }
  }

  createAutomation(input: {
    name: string
    prompt: string
    objective?: Partial<AutomationObjective>
    schedule: AutomationSchedule
    mode?: AutomationRunMode
    capabilityPolicy?: Partial<AutomationCapabilityPolicy>
    timezone?: string
    enabled?: boolean
    approvalPolicy?: ApprovalPolicy
    misfirePolicy?: 'run-once' | 'skip'
    overlapPolicy?: 'skip' | 'queue-one'
    retryPolicy?: { maxRetries?: number; backoffMinutes?: number }
    maxRuntimeMinutes?: number
  }) {
    const snapshot = this.requireRuntime().createAutomation(input)
    this.notifyAutomationDefinitionsChanged()
    return snapshot
  }

  previewAutomationSchedule(schedule: AutomationSchedule, timezone: string, count = 5): number[] {
    return nextAutomationRunTimes(schedule, timezone, count)
  }

  listAutomationDefinitions(query?: { workspacePath?: string; status?: AutomationDefinition['status']; offset?: number; limit?: number }) {
    return this.automationApplicationService.listDefinitions(query)
  }

  getAutomationDefinition(id: string) {
    return this.automationApplicationService.getDefinition(id)
  }

  saveAutomationDraft(input: AutomationDraftInput) {
    return this.automationApplicationService.saveDraft(input)
  }

  validateAutomationDefinition(id: string) {
    return this.automationApplicationService.validateDefinition(id, true)
  }

  publishAutomationDefinition(id: string, expectedRevision: number) {
    return this.automationApplicationService.publishDefinition(id, expectedRevision)
  }

  setAutomationDefinitionStatus(id: string, status: Extract<AutomationDefinition['status'], 'draft' | 'testing' | 'paused' | 'archived'>) {
    return this.automationApplicationService.setDefinitionStatus(id, status)
  }

  rollbackAutomationDefinition(id: string, targetRevision: number, expectedRevision: number) {
    return this.automationApplicationService.rollbackDefinition(id, targetRevision, expectedRevision)
  }

  resetAutomationContinuationConversation(id: string, expectedRevision: number) {
    return this.automationApplicationService.resetContinuationConversation(id, expectedRevision)
  }

  listAutomationRuns(query?: { definitionId?: string; offset?: number; limit?: number }) {
    return this.automationApplicationService.listRuns(query)
  }

  getAutomationRun(runId: string) {
    return this.automationApplicationService.getRun(runId)
  }

  setAutomationRunPinned(runId: string, pinned: boolean) {
    return this.automationApplicationService.setRunPinned(runId, pinned)
  }

  emitAutomationRemoteNotification(input: { conversationId?: string; level: 'info' | 'success' | 'warning' | 'error'; message: string }): void {
    const event: WorkbenchEvent = {
      type: 'automation-notification',
      conversationId: input.conversationId,
      level: input.level,
      message: input.message.trim().slice(0, 4_000),
    }
    for (const listener of this.listeners) listener(event)
  }

  resolveAutomationApproval(approvalId: string, response: string, channel: 'desktop' | 'remote', deviceId?: string) {
    return this.workspaceRuntimePool.resolveApproval(approvalId, response, channel, deviceId)
  }

  listRemoteAutomationApprovals() {
    return this.automationService.list().pendingApprovals.map(approval => {
      const policy = automationRemoteApprovalPolicy(approval)
      return {
        id: approval.id,
        sessionId: approval.conversationId,
        automationName: approval.automationName,
        runId: approval.runId,
        workspacePath: approval.workspacePath,
        kind: approval.kind,
        question: approval.kind === 'input' ? `${approval.automationName} 需要补充信息` : `${approval.automationName} 请求执行高风险操作`,
        options: policy.options,
        toolName: policy.allowFromRemote ? approval.toolName : undefined,
        riskCategory: approval.riskCategory,
        targetSummary: policy.targetSummary,
        requestedAt: approval.requestedAt,
        expiresAt: approval.expiresAt,
      }
    })
  }

  updateAutomation(id: string, patch: AutomationUpdateInput) {
    const snapshot = this.requireRuntime().updateAutomation(id, patch)
    this.notifyAutomationDefinitionsChanged()
    return snapshot
  }

  removeAutomation(id: string) {
    const snapshot = this.requireRuntime().removeAutomation(id)
    this.notifyAutomationDefinitionsChanged()
    return snapshot
  }

  async archiveAutomationDefinition(id: string, options: { deleteRuns?: boolean; deleteConversations?: boolean; deleteMemory?: boolean }) {
    const definition = this.automationApplicationService.getDefinition(id).definition
    const archived = this.automationApplicationService.archiveDefinition(id)
    let deletedConversations = 0
    if (options.deleteConversations && archived.conversationIds.length > 0) {
      if (resolve(definition.workspaceRef.path) === resolve(this.workspacePath)) {
        const runtime = this.requireRuntime()
        for (const conversationId of archived.conversationIds) {
          if (await runtime.deleteConversation(conversationId)) deletedConversations += 1
        }
      } else {
        deletedConversations = await this.workspaceRuntimePool.deleteConversations(definition.workspaceRef.path, archived.conversationIds)
      }
    }
    const cleaned = this.automationApplicationService.archiveDefinition(id, {
      deleteRuns: options.deleteRuns,
      deleteMemory: options.deleteMemory,
    })
    this.notifyAutomationDefinitionsChanged()
    return { ...cleaned, deletedConversations }
  }

  duplicateAutomation(id: string) {
    const snapshot = this.requireRuntime().duplicateAutomation(id)
    this.notifyAutomationDefinitionsChanged()
    return snapshot
  }

  runAutomation(id: string) {
    this.assertRuntimeReadyForRun()
    return this.automationCoordinator.runManual(id)
  }

  testAutomation(id: string) {
    this.assertRuntimeReadyForRun()
    return this.automationCoordinator.runManual(id, true)
  }

  retryAutomationRun(id: string, runId: string) {
    this.assertRuntimeReadyForRun()
    return this.automationCoordinator.retry(id, runId)
  }

  recoverAutomationRun(runId: string, action: 'resume_without_replay' | 'retry_idempotent') {
    this.assertRuntimeReadyForRun()
    return this.automationCoordinator.recover(runId, action)
  }

  abandonAutomationRunRecovery(runId: string) {
    return this.automationApplicationService.abandonRunRecovery(runId)
  }

  cancelAutomationRun(id: string) {
    return this.workspaceRuntimePool.cancel(id).then(canceled => {
      if (!canceled) this.automationService.cancelActiveRun(id)
      return this.automationService.list(this.workspacePath)
    })
  }

  async takeOverAutomationRun(id: string) {
    const takeover = await this.workspaceRuntimePool.takeOver(id)
    if (resolve(this.workspacePath) !== takeover.workspacePath) this.assertRuntimeTransitionAllowed()
    this.suppressRuntimeEvents = true
    try {
      if (resolve(this.workspacePath) !== takeover.workspacePath) await this.setWorkspace(takeover.workspacePath)
      const result = await this.requireRuntime().switchConversation(takeover.conversationId)
      return { ...result, snapshot: this.decorateSnapshot(result.snapshot), automationRunId: takeover.runId }
    } finally {
      this.suppressRuntimeEvents = false
    }
  }

  async registerArtifact(path: string, source: ArtifactSource, options?: { name?: string; mime?: string; taskId?: string; conversationId?: string; metadata?: Record<string, string | number | boolean> }) {
    const [workspaceRoot, artifactPath] = await Promise.all([realpath(this.workspacePath), realpath(resolve(path))])
    const artifactRelativePath = relative(workspaceRoot, artifactPath)
    if (!artifactRelativePath || artifactRelativePath === '..' || artifactRelativePath.startsWith(`..${sep}`) || isAbsolute(artifactRelativePath)) {
      throw new Error(`Artifact is outside the active workspace: ${artifactPath}`)
    }
    return this.requireRuntime().registerArtifact(artifactPath, source, options)
  }

  async removeArtifact(id: string) {
    const runtime = this.requireRuntime()
    const artifact = runtime.getArtifact(id)
    if (!artifact) throw new Error(`Artifact not found: ${id}`)
    const managed = artifact.source === 'browser'
      || artifact.source === 'browser-download'
      || artifact.metadata?.visualSource === 'computer'
    if (managed && artifact.available) {
      const [workspaceRoot, artifactPath] = await Promise.all([realpath(this.workspacePath), realpath(artifact.path)])
      const artifactRelativePath = relative(workspaceRoot, artifactPath)
      if (!artifactRelativePath || artifactRelativePath === '..' || artifactRelativePath.startsWith(`..${sep}`) || isAbsolute(artifactRelativePath)) {
        throw new Error(`Managed artifact is outside the active workspace: ${artifactPath}`)
      }
      await unlink(artifactPath)
    }
    return runtime.removeArtifact(id)
  }

  getArtifact(id: string) {
    return this.requireRuntime().getArtifact(id)
  }

  private async previewImageDataUrl(filePath: string, mime: string, purpose: ImagePreviewPurpose): Promise<string> {
    if (purpose === 'full') {
      const data = await readFile(filePath)
      return `data:${mime};base64,${data.toString('base64')}`
    }
    const info = await stat(filePath)
    const cacheKey = `${filePath}:${info.size}:${info.mtimeMs}`
    const cached = this.imageThumbnailCache.get(cacheKey)
    if (cached) {
      this.imageThumbnailCache.delete(cacheKey)
      this.imageThumbnailCache.set(cacheKey, cached)
      return cached
    }
    let image = nativeImage.createFromPath(filePath)
    if (image.isEmpty()) throw new Error('Image could not be decoded')
    const size = image.getSize()
    const scale = Math.min(1, PREVIEW_THUMBNAIL_WIDTH / size.width, PREVIEW_THUMBNAIL_HEIGHT / size.height)
    if (scale < 1) {
      image = image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'best',
      })
    }
    const dataUrl = image.toDataURL()
    this.imageThumbnailCache.set(cacheKey, dataUrl)
    while (this.imageThumbnailCache.size > PREVIEW_THUMBNAIL_CACHE_LIMIT) {
      const oldest = this.imageThumbnailCache.keys().next().value
      if (typeof oldest !== 'string') break
      this.imageThumbnailCache.delete(oldest)
    }
    return dataUrl
  }

  async previewArtifact(id: string, purpose: ImagePreviewPurpose = 'full') {
    const artifact = this.requireRuntime().getArtifact(id)
    if (!artifact?.available) throw new Error('Artifact is unavailable')
    if (artifact.kind === 'image' || artifact.kind === 'pdf') {
      if (artifact.size > 20 * 1024 * 1024) return { artifact, mode: 'external' as const, message: '文件较大，请使用系统应用打开。' }
      const dataUrl = artifact.kind === 'image'
        ? await this.previewImageDataUrl(artifact.path, artifact.mime, purpose)
        : `data:${artifact.mime};base64,${(await readFile(artifact.path)).toString('base64')}`
      return { artifact, mode: artifact.kind as 'image' | 'pdf', dataUrl }
    }
    if (artifact.kind === 'document' || artifact.kind === 'code' || artifact.kind === 'data' || artifact.kind === 'spreadsheet') {
      const extension = extname(artifact.path).toLowerCase()
      if (['.md', '.txt', '.rtf', '.json', '.yaml', '.yml', '.xml', '.sql', '.csv', '.tsv', '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.swift', '.html', '.css'].includes(extension)) {
        const handle = await openFile(artifact.path, 'r')
        try {
          const buffer = Buffer.allocUnsafe(Math.min(500_001, Math.max(1, artifact.size)))
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
          const truncated = artifact.size > bytesRead
          return {
            artifact,
            mode: 'text' as const,
            text: buffer.subarray(0, Math.min(bytesRead, 500_000)).toString('utf8'),
            message: truncated ? '预览已截断到 500,000 字节。' : undefined,
          }
        } finally {
          await handle.close()
        }
      }
    }
    return { artifact, mode: 'external' as const, message: '此格式可使用系统应用打开，并支持定位或导出副本。' }
  }

  async resolveImageAttachment(filePath: string) {
    const attachmentRoot = await realpath(this.workspaceAttachmentsRoot()).catch(() => '')
    const designAtlasRoot = await realpath(join(this.workspacePath, '.turboflux', 'design-atlas')).catch(() => '')
    const workflowRoot = await realpath(join(this.workspacePath, '.turboflux', 'workflows')).catch(() => '')
    const attachmentPath = await realpath(resolve(this.workspacePath, filePath))
    const allowed = Boolean(attachmentRoot && isPathInside(attachmentRoot, attachmentPath))
      || Boolean(designAtlasRoot && isPathInside(designAtlasRoot, attachmentPath))
      || Boolean(workflowRoot && isPathInside(workflowRoot, attachmentPath))
    if (!allowed) {
      throw new Error('Image preview is outside the TurboFlux visual workspace')
    }
    const info = await stat(attachmentPath)
    const mime = mimeForPath(attachmentPath)
    if (!info.isFile() || !PREVIEW_IMAGE_MIMES.has(mime)) throw new Error('Unsupported image attachment')
    if (info.size === 0 || info.size > MAX_PREVIEW_IMAGE_BYTES) throw new Error('Image attachment must be between 1 byte and 20 MB')
    return { path: attachmentPath, filename: basename(attachmentPath), mime, size: info.size }
  }

  async previewImageAttachment(filePath: string, purpose: ImagePreviewPurpose = 'full') {
    const attachment = await this.resolveImageAttachment(filePath)
    const dataUrl = await this.previewImageDataUrl(attachment.path, attachment.mime, purpose)
    return { ...attachment, mode: 'image' as const, dataUrl }
  }

  listPlugins() {
    return this.requireRuntime().listPlugins()
  }

  inspectPlugin(path: string) {
    return this.requireRuntime().inspectPlugin(path)
  }

  async installLocalPlugin(path: string, approvedPermissions: PluginPermission[]) {
    const inspected = await this.requireRuntime().inspectPlugin(path)
    await this.requireRuntime().installPlugin(inspected.path, approvedPermissions)
    await this.requireRuntime().setPluginEnabled(inspected.manifest.id, true)
    return this.listWorkPacks()
  }

  retryPersistence() {
    return this.requireRuntime().retryPersistence()
  }

  exportRecoveryBundle(requestedPath?: string) {
    return this.requireRuntime().exportRecoveryBundle(requestedPath)
  }





  listWorkPacks() {
    const runtime = this.requireRuntime()
    const plugins = runtime.listPlugins()
    return buildWorkPackCatalog({
      installedSkills: runtime.getSnapshot().skills,
      plugins,
    })
  }

  async refreshWorkPacks() {
    this.requireRuntime().reloadSkills()
    return this.listWorkPacks()
  }



  async setWorkPackEnabled(workPackId: string, enabled: boolean) {
    const entry = this.listWorkPacks().entries.find(candidate => candidate.id === workPackId)
    if (!entry) throw new Error(`能力包不存在：${workPackId}`)
    if (entry.backend.type !== 'local-plugin') {
      if (!enabled) throw new Error('工作流能力包始终可用，不能停用')
      return this.listWorkPacks()
    }
    await this.requireRuntime().setPluginEnabled(entry.backend.pluginId, enabled)
    return this.listWorkPacks()
  }

  async uninstallWorkPack(workPackId: string) {
    const entry = this.listWorkPacks().entries.find(candidate => candidate.id === workPackId)
    if (!entry) throw new Error(`能力包不存在：${workPackId}`)
    if (entry.backend.type === 'local-plugin') {
      await this.requireRuntime().uninstallPlugin(entry.backend.pluginId)
      return this.listWorkPacks()
    }
    throw new Error('本地工作流由文件系统管理，插件不会擅自删除')
  }

  reconnectMcp(name: string) {
    return this.requireRuntime().reconnectMcp(name)
  }

  acknowledgeNotification(notificationId: string) {
    return this.requireRuntime().acknowledgeNotification(notificationId)
  }

  listMemories(filters?: WorkbenchMemoryFilters, forceReload = false) {
    return this.requireRuntime().listMemories(filters, forceReload)
  }

  rememberMemory(input: WorkbenchMemoryCreateInput) {
    return this.requireRuntime().rememberMemory(input)
  }

  updateMemory(id: string, update: WorkbenchMemoryUpdateInput) {
    return this.requireRuntime().updateMemory(id, update)
  }

  forgetMemory(id: string, reason?: string) {
    return this.requireRuntime().forgetMemory(id, reason)
  }

  async importFiles(paths: string[]): Promise<WorkbenchFileReference[]> {
    const uniquePaths = [...new Set(paths.map(filePath => resolve(filePath)))].slice(0, 20)
    const targetDirectory = this.workspaceAttachmentsRoot()
    await mkdir(targetDirectory, { recursive: true })
    const imported: WorkbenchFileReference[] = []
    for (const sourcePath of uniquePaths) {
      const info = await stat(sourcePath)
      if (!info.isFile()) continue
      if (info.size > MAX_IMPORTED_FILE_BYTES) throw new Error(`${basename(sourcePath)} exceeds the 50 MB attachment limit`)
      const digest = createHash('sha256').update(await readFile(sourcePath)).digest('hex').slice(0, 16)
      const filename = safeFilename(sourcePath)
      const targetPath = join(targetDirectory, `${digest}-${filename}`)
      await copyFile(sourcePath, targetPath)
      const mime = mimeForPath(targetPath)
      imported.push({
        id: `attachment-${digest}`,
        type: mime.startsWith('image/') ? 'image' : 'file',
        path: targetPath,
        mime,
        filename,
        size: info.size,
      })
      this.requireRuntime().registerArtifact(targetPath, 'import', { name: filename, mime })
    }
    return imported
  }

  async importClipboardImage(base64: string, mime: string, filename = 'clipboard.png'): Promise<WorkbenchFileReference> {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) throw new Error('Unsupported clipboard image type')
    const data = Buffer.from(base64, 'base64')
    if (data.length === 0 || data.length > 20 * 1024 * 1024) throw new Error('Clipboard image must be between 1 byte and 20 MB')
    const digest = createHash('sha256').update(data).digest('hex').slice(0, 16)
    const extension = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' } as Record<string, string>)[mime]
    const displayFilename = `${safeFilename(filename).replace(/\.[^.]+$/, '')}${extension}`
    const targetDirectory = this.workspaceAttachmentsRoot()
    await mkdir(targetDirectory, { recursive: true })
    const targetPath = join(targetDirectory, `${digest}-${displayFilename}`)
    await writeFile(targetPath, data, { mode: 0o600 })
    this.requireRuntime().registerArtifact(targetPath, 'import', { name: displayFilename, mime })
    return { id: `attachment-${digest}`, type: 'image', path: targetPath, mime, filename: displayFilename, size: data.length }
  }

  async setWorkspace(workspacePath: string) {
    const nextPath = resolve(workspacePath)
    const info = await stat(nextPath)
    if (!info.isDirectory()) throw new Error(`Workspace is not a directory: ${nextPath}`)
    if (this.workspaceRuntimePool.snapshot().activeWorkspaces.includes(nextPath)) {
      throw new Error('A background automation currently owns this workspace; wait for it to finish or cancel it first.')
    }
    const activeWorkspacePath = resolve(this.requireRuntime().getSnapshot().workspace.path)
    if (nextPath !== activeWorkspacePath) {
      this.assertRuntimeTransitionAllowed()
      this.runtimeTransitioning = true
      try {
        await this.replaceRuntime(nextPath)
        this.workspacePath = nextPath
      } finally {
        this.runtimeTransitioning = false
      }
    } else {
      this.workspacePath = activeWorkspacePath
    }
    return this.getSnapshot()
  }

  private runDirectedConversationOperation<T>(conversationId: string, operation: (runtime: WorkbenchRuntime) => Promise<T> | T): Promise<T> {
    const next = this.directedConversationOperations.catch(() => undefined).then(async () => {
      this.assertRuntimeReadyForRun()
      let runtime = this.requireRuntime()
      const initialSnapshot = runtime.getSnapshot()
      const initialTarget = initialSnapshot.conversationCatalog.find(conversation => conversation.id === conversationId)
      if (!initialTarget) throw new Error(`Conversation not found: ${conversationId}`)
      assertExecutableConversationWorkspace(initialTarget.workspacePath)
      const targetWorkspacePath = resolve(initialTarget.workspacePath)
      if (targetWorkspacePath !== resolve(initialSnapshot.workspace.path)) {
        this.assertRuntimeTransitionAllowed(runtime)
        this.suppressRuntimeEvents = true
        try {
          await this.setWorkspace(targetWorkspacePath)
        } finally {
          this.suppressRuntimeEvents = false
        }
        runtime = this.requireRuntime()
      }
      const confirmedTarget = runtime.getSnapshot().conversationCatalog.find(conversation => conversation.id === conversationId)
      if (!confirmedTarget || resolve(confirmedTarget.workspacePath) !== targetWorkspacePath) {
        throw new Error(`Conversation target changed before execution: ${conversationId}`)
      }
      return operation(runtime)
    })
    this.directedConversationOperations = next.then(() => undefined, () => undefined)
    return next
  }

  private decorateSnapshot(snapshot: WorkbenchSnapshot): DesktopWorkbenchSnapshot {
    const specified = !this.unscopedWorkspacePath || resolve(snapshot.workspace.path) !== this.unscopedWorkspacePath
    const projects = this.unscopedWorkspacePath
      ? snapshot.projects.projects.filter(project => resolve(project.path) !== this.unscopedWorkspacePath)
      : snapshot.projects.projects
    return {
      ...snapshot,
      context: {
        ...snapshot.context,
        usage: recoverContextUsage(snapshot.context.usage, snapshot.conversation.turns),
      },
      workspace: {
        ...snapshot.workspace,
        name: specified
          ? projects.find(project => resolve(project.path) === resolve(snapshot.workspace.path))?.name || snapshot.workspace.name
          : '未指定工作区',
        specified,
      },
      projects: {
        ...snapshot.projects,
        projects,
      },
      automations: this.automationService.list(),
    }
  }

  suspendForSystemSleep(): void {
    this.automationCoordinator.suspendForSystemSleep()
  }

  async resumeAfterSystemSleep(): Promise<void> {
    await this.automationCoordinator.resumeAfterSystemSleep()
  }

  async prepareForApplicationQuit(mode: 'wait' | 'interrupt'): Promise<void> {
    const stopped = this.automationCoordinator.stop()
    await stopped
    if (mode === 'wait') {
      const idle = this.automationCoordinator.waitForIdle()
      await idle
    }
  }

  destroy(): Promise<void> {
    this.destroyPromise ??= this.performDestroy()
    return this.destroyPromise
  }

  private async performDestroy(): Promise<void> {
    const errors: unknown[] = []
    const attempt = async (cleanup: () => void | Promise<unknown>) => {
      try { await cleanup() } catch (error) { errors.push(error) }
    }
    this.taskTitleApplyGates.clear()
    await attempt(() => this.unsubscribeRuntime?.())
    this.unsubscribeRuntime = null
    await attempt(() => this.automationCoordinator.stop())
    await attempt(() => this.workspaceRuntimePool.destroy())
    await attempt(() => this.automationCoordinator.waitForIdle())
    const runtime = this.runtime
    this.runtime = null
    if (runtime) await attempt(() => runtime.destroy())
    this.listeners.clear()
    if (errors.length > 0) throw new AggregateError(errors, 'Desktop runtime shutdown failed')
  }

  private async replaceRuntime(workspacePath: string, options: { allowRecoverableError?: boolean } = {}): Promise<void> {
    const previousRuntime = this.runtime
    const localConfig = await loadConfig()
    const config: TurboFluxConfig = localConfig
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config,
      storagePath: this.storagePath,
      profileStorage: this.profileStorage,
      workspaceBindingService: this.workspaceBindingService,
      connectMcp: true,
      registerSystemPlugins: this.registerSystemPlugins,
      conversationPrefix: 'desktop',
      surfaceSystemPrompt: DESKTOP_EXPERIENCE_SYSTEM_PROMPT,
      automationService: this.automationService,
      automationScheduling: 'external',
    })
    this.applyDesktopToolPolicy(runtime)
    try {
      await runtime.initializePlatform()
    } catch (error) {
      await runtime.destroy().catch(() => undefined)
      throw error
    }
    if (previousRuntime) {
      const blocker = runtimeTransitionBlocker(previousRuntime.getSnapshot(), options)
      if (blocker) {
        await runtime.destroy().catch(() => undefined)
        throw new Error(blocker)
      }
    }
    this.unsubscribeRuntime?.()
    this.unsubscribeRuntime = null
    this.runtimeConfig = config
    this.runtime = runtime
    this.runtimeEpoch += 1
    this.clearTransientTaskState()
    const runtimeEpoch = this.runtimeEpoch
    this.unsubscribeRuntime = runtime.subscribe(event => {
      if (this.runtime !== runtime || this.runtimeEpoch !== runtimeEpoch) return
      this.onUsageEvent?.(event)
      const canonicalType = event.type === 'conversation-event' ? event.event.type : event.type
      if (process.env.TURBOFLUX_STREAM_TRACE === '1' && canonicalType === 'stream.started') {
        this.desktopStreamTraceActive = true
        this.desktopStreamListenerDurations.clear()
      }
      if (
        event.type === 'conversation-event'
        && ['stream.delta', 'stream.committed', 'tool.delta', 'tool.proposed'].includes(event.event.type)
      ) {
        this.taskTitleApplyGates.release(event.conversationId)
      }
      if (event.type === 'conversation-run') this.taskTitleApplyGates.release(event.conversationId)
      if (this.suppressRuntimeEvents) return
      if (event.type === 'conversation-run' && !this.historyRewriteConversations.has(event.conversationId)) {
        const queue = this.taskRunPromptCounts.get(event.conversationId)
        const promptCount = queue?.shift()
        if (queue && queue.length === 0) this.taskRunPromptCounts.delete(event.conversationId)
        if (promptCount) this.scheduleTaskTitleUpdate(event.conversationId, promptCount)
      }
      const desktopEvent = event.type === 'snapshot'
        ? { ...event, snapshot: this.decorateSnapshot(event.snapshot) }
        : event
      const listenersStartedAt = this.desktopStreamTraceActive ? performance.now() : 0
      for (const listener of this.listeners) listener(desktopEvent)
      if (this.desktopStreamTraceActive) {
        const samples = this.desktopStreamListenerDurations.get(canonicalType) || []
        samples.push(performance.now() - listenersStartedAt)
        this.desktopStreamListenerDurations.set(canonicalType, samples)
      }
      if (this.desktopStreamTraceActive && canonicalType === 'stream.ended') {
        console.error(`[TurboFlux stream trace] ${JSON.stringify({
          scope: 'desktop-runtime-host',
          at: Date.now(),
          listeners: Object.fromEntries(
            [...this.desktopStreamListenerDurations.entries()].map(([type, samples]) => [type, desktopTimingSummary(samples)]),
          ),
        })}`)
        this.desktopStreamTraceActive = false
      }
    })
    if (previousRuntime) await previousRuntime.destroy()
  }

  private async createBackgroundRuntime(workspacePath: string): Promise<WorkbenchRuntime> {
    const config = await loadConfig()
    const runtime = new WorkbenchRuntime({
      workspacePath,
      config,
      storagePath: this.storagePath,
      profileStorage: this.profileStorage,
      workspaceBindingService: this.workspaceBindingService,
      connectMcp: true,
      registerSystemPlugins: this.registerSystemPlugins,
      conversationPrefix: 'desktop-automation',
      surfaceSystemPrompt: DESKTOP_EXPERIENCE_SYSTEM_PROMPT,
      automationService: this.automationService,
      automationScheduling: 'external',
    })
    this.applyDesktopToolPolicy(runtime)
    try {
      runtime.subscribe(event => this.onUsageEvent?.(event))
      await runtime.initializePlatform()
      return runtime
    } catch (error) {
      await runtime.destroy().catch(() => undefined)
      throw error
    }
  }

  private applyDesktopToolPolicy(runtime: WorkbenchRuntime): void {
    runtime.runtime.engine.setDisabledTools(DESKTOP_REMOVED_TOOLS)
  }

  private recordTaskPrompt(conversationId: string, prompt: string, snapshot: ReturnType<WorkbenchRuntime['getSnapshot']>): number {
    const existingTurns = snapshot.conversation.id === conversationId
      ? snapshot.conversation.turns.filter(turn => turn.role === 'user' && turn.metadata?.internal !== true).map(turn => turn.content.trim()).filter(Boolean)
      : []
    const prompts = this.taskPrompts.get(conversationId) || existingTurns.slice(-5)
    if (prompts.at(-1) !== prompt.trim()) prompts.push(prompt.trim())
    this.taskPrompts.set(conversationId, prompts.filter(Boolean).slice(-6))
    const currentCount = this.submittedPromptCounts.get(conversationId) ?? existingTurns.length
    const nextCount = currentCount + 1
    this.submittedPromptCounts.set(conversationId, nextCount)
    return nextCount
  }

  private trackTaskRunPromptCount(conversationId: string, promptCount: number, status: 'started' | 'steering' | 'queued'): void {
    const queue = this.taskRunPromptCounts.get(conversationId) || []
    if (status === 'steering' && queue.length > 0) queue[0] = promptCount
    else queue.push(promptCount)
    this.taskRunPromptCounts.set(conversationId, queue)
  }

  private scheduleTaskTitleUpdate(
    conversationId: string,
    promptCount: number,
    applyGate?: TaskTitleApplyGate,
  ): void {
    const runtime = this.requireRuntime()
    const runtimeEpoch = this.runtimeEpoch
    const config = this.runtimeConfig
    const titleRevision = this.taskTitleRevisions.get(conversationId) || 0
    const previous = this.taskTitleUpdates.get(conversationId) || Promise.resolve()
    const update = previous
      .catch(() => undefined)
      .then(() => this.updateTaskTitle(runtime, runtimeEpoch, config, conversationId, promptCount, titleRevision, applyGate))
      .catch(() => undefined)
      .finally(() => {
        if (this.taskTitleUpdates.get(conversationId) === update) this.taskTitleUpdates.delete(conversationId)
      })
    this.taskTitleUpdates.set(conversationId, update)
  }

  private async updateTaskTitle(
    runtime: WorkbenchRuntime,
    runtimeEpoch: number,
    config: TurboFluxConfig | null,
    conversationId: string,
    promptCount: number,
    titleRevision: number,
    applyGate?: TaskTitleApplyGate,
  ): Promise<void> {
    if (this.runtime !== runtime || this.runtimeEpoch !== runtimeEpoch) return
    if ((this.taskTitleRevisions.get(conversationId) || 0) !== titleRevision) return
    if (!config?.apiKey || !config.baseUrl || !config.model) return
    const snapshot = runtime.getSnapshot()
    const conversation = snapshot.conversations.find(item => item.id === conversationId)
    if (!conversation) return
    const managed = this.managedTaskTitles.get(conversationId)
    if (conversation.titleSource === 'custom' && !managed) return
    if (managed && managed.evaluatedPromptCount >= promptCount) return
    const prompts = this.taskPrompts.get(conversationId) || []
    if (prompts.length === 0) return
    const currentTitle = isPlaceholderTaskTitle(conversation.title) ? '新任务' : conversation.title.trim()
    let title = currentTitle
    try {
      title = await generateTaskTitle(config, { currentTitle, prompts })
    } catch {
      if (isPlaceholderTaskTitle(currentTitle)) title = fallbackTaskTitle(prompts[0])
    }
    title = title.trim().slice(0, 32)
    if (!title || isPlaceholderTaskTitle(title)) {
      title = isPlaceholderTaskTitle(currentTitle) ? fallbackTaskTitle(prompts[0]) : currentTitle
    }
    if (!title || isPlaceholderTaskTitle(title)) return
    if (applyGate) await applyGate.wait
    if (this.runtime !== runtime || this.runtimeEpoch !== runtimeEpoch) return
    if ((this.taskTitleRevisions.get(conversationId) || 0) !== titleRevision) return
    const latestConversation = runtime.getSnapshot().conversations.find(item => item.id === conversationId)
    const latestManaged = this.managedTaskTitles.get(conversationId)
    if (!latestConversation || (latestConversation.titleSource === 'custom' && !latestManaged)) return
    if (latestConversation.title.trim() !== title) {
      const renamed = await runtime.renameConversation(conversationId, title, 'generated')
      if (!renamed) return
    }
    this.managedTaskTitles.set(conversationId, { title, evaluatedPromptCount: promptCount })
    await this.saveManagedTaskTitles()
  }

  private clearTransientTaskState(): void {
    this.taskPrompts.clear()
    this.submittedPromptCounts.clear()
    this.taskRunPromptCounts.clear()
    this.taskTitleUpdates.clear()
    this.taskTitleApplyGates.clear()
    this.taskTitleRevisions.clear()
    this.historyRewriteConversations.clear()
  }

  private notifyAutomationDefinitionsChanged(): void {
    this.automationCoordinator.notifyDefinitionsChanged()
  }

  private assertRuntimeAvailable(): void {
    const externalBlocker = this.externalTransitionBlocker?.()
    if (externalBlocker) throw new Error(externalBlocker)
    if (this.runtimeTransitioning) throw new Error('正在更新工作环境，请稍后再试')
  }

  private assertRuntimeReadyForRun(): void {
    this.assertRuntimeAvailable()
    const foregroundWorkspace = resolve(this.requireRuntime().getSnapshot().workspace.path)
    if (this.workspaceRuntimePool.snapshot().activeWorkspaces.includes(foregroundWorkspace)) {
      throw new Error('A background automation currently owns this workspace; wait for it to finish or cancel it first.')
    }
  }

  private workspaceAttachmentsRoot(): string {
    const overlayRoot = this.runtime?.workspaceOverlayRoot
    return overlayRoot
      ? join(overlayRoot, 'attachments')
      : join(this.workspacePath, '.turboflux', 'attachments')
  }

  private assertRuntimeTransitionAllowed(
    runtime = this.requireRuntime(),
    options: { allowRecoverableError?: boolean } = {},
  ): void {
    this.assertRuntimeAvailable()
    const blocker = runtimeTransitionBlocker(runtime.getSnapshot(), options)
    if (blocker) throw new Error(blocker)
  }

  private managedTaskTitlesPath(): string | null {
    return this.profileStorage?.managedTaskTitlesPath
      ?? (this.storagePath ? join(this.storagePath, 'managed-task-titles.json') : null)
  }

  private async loadManagedTaskTitles(): Promise<void> {
    const path = this.managedTaskTitlesPath()
    if (!path) return
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as { entries?: Record<string, ManagedTaskTitleState> }
      for (const [id, entry] of Object.entries(value.entries || {})) {
        if (typeof entry?.title !== 'string' || !Number.isSafeInteger(entry.evaluatedPromptCount)) continue
        this.managedTaskTitles.set(id, { title: entry.title, evaluatedPromptCount: Math.max(0, entry.evaluatedPromptCount) })
      }
    } catch {}
  }

  private async saveManagedTaskTitles(): Promise<void> {
    const path = this.managedTaskTitlesPath()
    if (!path) return
    const content = `${JSON.stringify({ version: 1, entries: Object.fromEntries(this.managedTaskTitles) }, null, 2)}\n`
    this.managedTaskTitleSave = this.managedTaskTitleSave.catch(() => undefined).then(async () => {
      await mkdir(dirname(path), { recursive: true })
      const temporaryPath = `${path}.${process.pid}.tmp`
      await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryPath, path)
    })
    await this.managedTaskTitleSave
  }

  private requireRuntime(): WorkbenchRuntime {
    if (!this.runtime) throw new Error('Desktop runtime is not ready')
    return this.runtime
  }






}
