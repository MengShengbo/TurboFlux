import { unlink } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import type {
  AutomationClaim,
  AutomationCheckpointState,
  AutomationExecutionHandle,
  AutomationExecutionPool,
  AutomationRecord,
  AutomationRepository,
  AutomationRuntimeBoundary,
  AutomationRunRecord,
  AutomationService,
  AutomationApprovalRequest,
  WorkbenchEvent,
  WorkbenchRuntime,
} from '@turboflux/agent-core/workbench'
import {
  captureAutomationWorkspaceIdentity,
  createAutomationCheckpoint,
  automationToolEffectNeedsReview,
} from '@turboflux/agent-core/workbench'

export interface WorkspaceRuntimePoolOptions {
  automationService: AutomationService
  automationRepository?: AutomationRepository
  createRuntime(workspacePath: string): Promise<WorkbenchRuntime>
  foregroundState(): { workspacePath: string; busy: boolean }
  maxRetainedRuntimes?: number
  approvalTtlMs?: number
  onApprovalChanged?: () => void
}

interface RuntimeEntry {
  runtime: WorkbenchRuntime
  workspacePath: string
  lastUsedAt: number
}

function terminalRun(status: AutomationRunRecord['status']): boolean {
  return ['completed', 'failed', 'canceled', 'interrupted', 'needs_review', 'skipped', 'missed', 'retry_scheduled'].includes(status)
}

export class WorkspaceRuntimePool implements AutomationExecutionPool {
  private readonly entries = new Map<string, RuntimeEntry>()
  private readonly activeWorkspaces = new Set<string>()
  private readonly completionInspectors = new Map<string, () => void>()
  private readonly completionRejectors = new Map<string, (error: unknown) => void>()
  private readonly pendingStarts = new Set<Promise<AutomationExecutionHandle>>()
  private readonly pendingInitializations = new Map<string, Promise<RuntimeEntry>>()
  private readonly runtimeDisposals = new WeakMap<WorkbenchRuntime, Promise<void>>()
  private readonly pendingDisposals = new Set<Promise<void>>()
  private readonly disposalErrors: unknown[] = []
  private readonly activeClaims = new Map<string, AutomationClaim>()
  private readonly checkpointStates = new Map<string, AutomationCheckpointState>()
  private readonly staleWorkspaces = new Set<string>()
  private readonly maxRetainedRuntimes: number
  private readonly approvalTtlMs: number
  private readonly approvalTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly approvalResponseChannels = new Map<string, AutomationApprovalRequest['responseChannel']>()
  private readonly approvalResponseDevices = new Map<string, string>()
  private computerLeaseRunId: string | null = null
  private destroyed = false
  private destroyPromise?: Promise<void>

  constructor(private readonly options: WorkspaceRuntimePoolOptions) {
    this.maxRetainedRuntimes = Math.max(1, Math.min(8, Math.floor(options.maxRetainedRuntimes ?? 3)))
    this.approvalTtlMs = Math.max(5 * 60_000, Math.min(7 * 24 * 60 * 60_000, Math.floor(options.approvalTtlMs ?? 24 * 60 * 60_000)))
  }

  foregroundWorkspacePath(): string | undefined {
    return this.options.foregroundState().workspacePath
  }

  canStart(automation: AutomationRecord): { ok: true } | { ok: false; reason: string } {
    if (!this.workspaceAvailable(automation.workspacePath)) {
      this.invalidateMissingWorkspace(automation)
      return { ok: false, reason: 'Automation workspace is missing or is not a directory.' }
    }
    const workspacePermission = this.canStartWorkspace(automation.workspacePath)
    if (!workspacePermission.ok) return workspacePermission
    if (automation.capabilityPolicy.allowComputerUse && !automation.capabilityPolicy.allowBackgroundComputerUse) {
      return { ok: false, reason: 'Computer control was not approved for background execution.' }
    }
    if (automation.capabilityPolicy.allowComputerUse && this.computerLeaseRunId) {
      return { ok: false, reason: 'Another run currently owns the exclusive Computer resource.' }
    }
    return { ok: true }
  }

  private canStartWorkspace(workspacePathInput: string): { ok: true } | { ok: false; reason: string } {
    if (this.destroyed) return { ok: false, reason: 'The background workspace runtime pool is shutting down.' }
    const workspacePath = resolve(workspacePathInput)
    const foreground = this.options.foregroundState()
    if (this.activeWorkspaces.has(workspacePath)) {
      return { ok: false, reason: 'Another automation already owns this workspace.' }
    }
    if (foreground.busy && resolve(foreground.workspacePath) === workspacePath) {
      return { ok: false, reason: 'Foreground work currently owns this workspace.' }
    }
    return { ok: true }
  }

  start(claim: AutomationClaim): Promise<AutomationExecutionHandle> {
    const pending = this.performStart(claim)
    this.pendingStarts.add(pending)
    void pending.then(
      () => { this.pendingStarts.delete(pending) },
      () => { this.pendingStarts.delete(pending) },
    )
    return pending
  }

  private async performStart(claim: AutomationClaim): Promise<AutomationExecutionHandle> {
    const permission = this.canStartFrozenClaim(claim)
    if (!permission.ok) throw new Error(permission.reason)
    const workspacePath = resolve(claim.automation.workspacePath)
    this.activeWorkspaces.add(workspacePath)
    this.activeClaims.set(workspacePath, claim)
    if (claim.run.permissionSnapshot.allowComputerUse) this.computerLeaseRunId = claim.run.id
    let entry: RuntimeEntry | undefined
    let unsubscribe: () => void = () => undefined
    let cleanup: () => void = () => undefined
    try {
      entry = await this.runtimeFor(workspacePath)
      if (this.destroyed) throw new Error('The background workspace runtime pool is shutting down.')
      let resolveCompletion!: (run: AutomationRunRecord) => void
      let rejectCompletion!: (error: unknown) => void
      let settled = false
      let startupComplete = false
      cleanup = () => {
        if (settled) return
        settled = true
        unsubscribe()
        this.activeWorkspaces.delete(workspacePath)
        if (this.computerLeaseRunId === claim.run.id) this.computerLeaseRunId = null
        const current = this.entries.get(workspacePath)
        if (current) current.lastUsedAt = Date.now()
        this.completionInspectors.delete(workspacePath)
        this.completionRejectors.delete(workspacePath)
        this.activeClaims.delete(workspacePath)
        this.checkpointStates.delete(claim.run.id)
        if (this.destroyed) return
        if (current && this.staleWorkspaces.delete(workspacePath)) {
          this.entries.delete(workspacePath)
          void this.disposeRuntime(current.runtime)
        } else {
          void this.evictIdleRuntimes().catch(() => undefined)
        }
      }
      const completion = new Promise<AutomationRunRecord>((resolvePromise, rejectPromise) => {
        resolveCompletion = run => {
          cleanup()
          resolvePromise(run)
        }
        rejectCompletion = error => {
          cleanup()
          rejectPromise(error)
        }
      })
      // Shutdown can settle this promise before start has returned its handle.
      void completion.catch(() => undefined)
      const inspectCompletion = () => {
        if (!startupComplete && !this.destroyed) return
        const run = this.options.automationService.getRun(claim.automation.id, claim.run.id)
        if (run && terminalRun(run.status)) resolveCompletion(run)
      }
      this.completionInspectors.set(workspacePath, inspectCompletion)
      this.completionRejectors.set(workspacePath, rejectCompletion)
      unsubscribe = entry.runtime.subscribe(event => {
        this.handleRuntimeEvent(claim, entry!.runtime, event)
        inspectCompletion()
      })
      const started = await entry.runtime.executeAutomationClaim(claim)
      if (this.destroyed) throw new Error('The background workspace runtime pool shut down during startup.')
      const runtimeSnapshot = typeof entry.runtime.getSnapshot === 'function'
        ? entry.runtime.getSnapshot()
        : started.snapshot
      if (runtimeSnapshot?.runtime?.provider && runtimeSnapshot.runtime.model) {
        this.options.automationRepository?.recordRunExecution(claim.run.id, {
          provider: runtimeSnapshot.runtime.provider,
          model: runtimeSnapshot.runtime.model,
        })
      }
      startupComplete = true
      inspectCompletion()
      return {
        started: {
          ...started,
          automationId: claim.automation.id,
          automationRunId: claim.run.id,
          conversationId: started.conversationId,
        },
        completion,
      }
    } catch (error) {
      unsubscribe()
      try {
        if (entry) {
          this.entries.delete(workspacePath)
          await this.disposeRuntime(entry.runtime)
        }
      } catch (disposalError) {
        throw new AggregateError([error, disposalError], 'Background automation startup and cleanup failed', { cause: error })
      } finally {
        cleanup()
        this.activeWorkspaces.delete(workspacePath)
        this.activeClaims.delete(workspacePath)
        this.staleWorkspaces.delete(workspacePath)
        if (this.computerLeaseRunId === claim.run.id) this.computerLeaseRunId = null
      }
      throw error
    }
  }

  snapshot(): { workspaces: string[]; activeWorkspaces: string[]; computerLeaseRunId: string | null } {
    return {
      workspaces: [...this.entries.keys()],
      activeWorkspaces: [...this.activeWorkspaces],
      computerLeaseRunId: this.computerLeaseRunId,
    }
  }

  async cancel(automationId: string): Promise<boolean> {
    const automation = this.options.automationService.get(automationId)
    if (!automation?.activeRunId) return false
    const entry = this.entries.get(resolve(automation.workspacePath))
    if (!entry) return false
    await entry.runtime.cancelAutomationRun(automationId)
    this.completionInspectors.get(resolve(automation.workspacePath))?.()
    return true
  }

  async interrupt(runId: string, reason: string): Promise<boolean> {
    const active = [...this.activeClaims.entries()].find(([, claim]) => claim.run.id === runId)
    if (!active) return false
    const [workspacePath, claim] = active
    const entry = this.entries.get(workspacePath)
    if (!entry) return false
    const run = this.options.automationService.getRun(claim.automation.id, claim.run.id)
    if (run && !terminalRun(run.status)) {
      this.options.automationService.markRunStatus(claim.automation.id, claim.run.id, 'interrupted', {
        error: reason,
        suppressRetry: true,
      })
    }
    this.entries.delete(workspacePath)
    this.staleWorkspaces.delete(workspacePath)
    try {
      await this.disposeRuntime(entry.runtime)
    } finally {
      this.completionInspectors.get(workspacePath)?.()
    }
    return true
  }

  async takeOver(automationId: string): Promise<{ workspacePath: string; conversationId: string; runId: string }> {
    const automation = this.options.automationService.get(automationId)
    if (!automation?.activeRunId) throw new Error('Automation has no active run to take over')
    const run = this.options.automationService.getRun(automationId, automation.activeRunId)
    if (!run?.conversationId) throw new Error('Automation run has no conversation to take over')
    const workspacePath = resolve(automation.workspacePath)
    const entry = this.entries.get(workspacePath)
    if (!entry) throw new Error('Automation background runtime is unavailable')
    const claim = this.activeClaims.get(workspacePath)
    if (claim?.run.id === run.id) this.saveCheckpoint(claim, 'manual')
    await entry.runtime.cancelAutomationRun(automationId)
    this.completionInspectors.get(workspacePath)?.()
    await Promise.resolve()
    this.entries.delete(workspacePath)
    this.staleWorkspaces.delete(workspacePath)
    await this.disposeRuntime(entry.runtime)
    return { workspacePath, conversationId: run.conversationId, runId: run.id }
  }

  async deleteConversations(workspacePathInput: string, conversationIds: string[]): Promise<number> {
    const workspacePath = resolve(workspacePathInput)
    if (this.activeWorkspaces.has(workspacePath)) throw new Error('Stop the active workspace automation before deleting its conversations')
    const entry = await this.runtimeFor(workspacePath)
    let deleted = 0
    for (const conversationId of [...new Set(conversationIds)]) {
      if (await entry.runtime.deleteConversation(conversationId)) deleted += 1
    }
    entry.lastUsedAt = Date.now()
    return deleted
  }

  async deleteArtifacts(
    workspacePathInput: string,
    candidates: Array<{ id: string; runCompletedAt: number }>,
    cutoffs: { artifact: number; screenshot: number },
  ): Promise<{ deletedRecords: number; deletedFiles: number; skippedFiles: number }> {
    const workspacePath = resolve(workspacePathInput)
    if (this.activeWorkspaces.has(workspacePath)) throw new Error('Stop the active workspace automation before deleting its artifacts')
    const entry = await this.runtimeFor(workspacePath)
    const artifacts = new Map(entry.runtime.listArtifacts().artifacts.map(artifact => [artifact.id, artifact]))
    let deletedRecords = 0
    let deletedFiles = 0
    let skippedFiles = 0
    const latestCandidates = new Map<string, number>()
    for (const candidate of candidates) latestCandidates.set(candidate.id, Math.max(latestCandidates.get(candidate.id) ?? 0, candidate.runCompletedAt))
    for (const [artifactId, runCompletedAt] of latestCandidates) {
      const artifact = artifacts.get(artifactId)
      if (!artifact) continue
      const screenshot = artifact.source === 'browser' || artifact.metadata?.visualSource === 'computer'
      const cutoff = screenshot ? cutoffs.screenshot : cutoffs.artifact
      if (Math.max(runCompletedAt, artifact.updatedAt) > cutoff) continue
      if (artifact.available) {
        const artifactRelativePath = relative(workspacePath, resolve(artifact.path))
        const insideWorkspace = artifactRelativePath !== ''
          && artifactRelativePath !== '..'
          && !artifactRelativePath.startsWith(`..${sep}`)
          && !isAbsolute(artifactRelativePath)
        if (insideWorkspace) {
          try {
            await unlink(artifact.path)
            deletedFiles += 1
          } catch {
            skippedFiles += 1
            continue
          }
        } else {
          skippedFiles += 1
          continue
        }
      }
      entry.runtime.removeArtifact(artifactId)
      deletedRecords += 1
    }
    entry.lastUsedAt = Date.now()
    return { deletedRecords, deletedFiles, skippedFiles }
  }

  async resolveApproval(
    approvalId: string,
    response: string,
    channel: Exclude<AutomationApprovalRequest['responseChannel'], undefined>,
    deviceId?: string,
  ): Promise<AutomationApprovalRequest> {
    const approval = this.options.automationService.getApproval(approvalId)
    if (!approval) throw new Error(`Automation approval not found: ${approvalId}`)
    if (approval.status !== 'pending') throw new Error(`Automation approval is already ${approval.status}`)
    const now = Date.now()
    const claim = [...this.activeClaims.values()].find(item => item.run.id === approval.runId)
    const entry = this.entries.get(resolve(approval.workspacePath))
    const automation = this.options.automationService.get(approval.automationId)
    const run = this.options.automationService.getRun(approval.automationId, approval.runId)
    const invalidated = !claim
      || !entry
      || claim.automation.id !== approval.automationId
      || claim.run.definitionRevision !== approval.definitionRevision
      || claim.run.permissionSnapshot.id !== approval.permissionSnapshotId
      || automation?.revision !== approval.definitionRevision
      || run?.permissionSnapshot.id !== approval.permissionSnapshotId
    const expired = approval.expiresAt <= now
    const allowedResponse = approval.kind === 'input'
      || response === 'deny'
      || (approval.options?.length
        ? approval.options.includes(response)
        : ['allow-once', 'allow-run', 'allow-session'].includes(response))
    const effectiveResponse = expired || invalidated || !allowedResponse ? 'deny' : response
    this.approvalResponseChannels.set(approvalId, expired || invalidated ? 'system' : channel)
    if (deviceId && !expired && !invalidated) this.approvalResponseDevices.set(approvalId, deviceId)
    const resolved = entry
      ? await entry.runtime.resolveRequestForConversation(approval.conversationId, approval.id, effectiveResponse)
      : false
    if (!resolved && !expired && !invalidated) {
      this.approvalResponseChannels.delete(approvalId)
      this.approvalResponseDevices.delete(approvalId)
      throw new Error('Automation approval is no longer available in its background runtime')
    }
    let persisted = this.options.automationService.getApproval(approvalId)!
    if (persisted.status === 'pending') {
      persisted = this.options.automationService.resolveApproval(
        approvalId,
        effectiveResponse,
        expired || invalidated ? 'system' : channel,
        now,
        deviceId,
      )
    }
    this.clearApprovalTimer(approvalId)
    this.approvalResponseChannels.delete(approvalId)
    this.approvalResponseDevices.delete(approvalId)
    this.options.onApprovalChanged?.()
    if (invalidated) throw new Error('Automation approval was invalidated because its run or permission version changed')
    if (expired) throw new Error('Automation approval expired and was denied')
    if (!allowedResponse) throw new Error('Automation approval response is not allowed')
    return persisted
  }

  async invalidateConfiguration(): Promise<void> {
    const idle = [...this.entries.values()].filter(entry => !this.activeWorkspaces.has(entry.workspacePath))
    for (const entry of this.entries.values()) {
      if (this.activeWorkspaces.has(entry.workspacePath)) this.staleWorkspaces.add(entry.workspacePath)
    }
    await Promise.allSettled(idle.map(async entry => {
      this.entries.delete(entry.workspacePath)
      await this.disposeRuntime(entry.runtime)
    }))
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise
    this.destroyed = true
    this.destroyPromise = this.performDestroy()
    return this.destroyPromise
  }

  private async performDestroy(): Promise<void> {
    const errors: unknown[] = []
    const persistenceErrors = new Map<string, unknown>()
    for (const timer of this.approvalTimers.values()) clearTimeout(timer)
    this.approvalTimers.clear()
    for (const [workspacePath, claim] of this.activeClaims) {
      try {
        this.saveCheckpoint(claim, 'host_exit')
      } catch (error) {
        errors.push(error)
      }
      try {
        const run = this.options.automationService.getRun(claim.automation.id, claim.run.id)
        if (run && !terminalRun(run.status)) {
          this.options.automationService.markRunStatus(claim.automation.id, claim.run.id, 'interrupted', {
            error: 'TurboFlux exited while this background automation was running.',
            suppressRetry: true,
          })
        }
      } catch (error) {
        errors.push(error)
        persistenceErrors.set(workspacePath, error)
      }
    }
    await Promise.allSettled([...this.entries.values()].map(async entry => {
      try {
        await this.disposeRuntime(entry.runtime)
      } finally {
        try {
          this.completionInspectors.get(entry.workspacePath)?.()
        } catch (error) {
          errors.push(error)
          persistenceErrors.set(entry.workspacePath, error)
        }
        this.completionRejectors.get(entry.workspacePath)?.(
          persistenceErrors.get(entry.workspacePath) ?? new Error('Background runtime shut down without a terminal run state'),
        )
      }
    }))
    await Promise.allSettled([...this.pendingStarts])
    await Promise.allSettled([...this.pendingInitializations.values()])
    await Promise.allSettled([...this.pendingDisposals])
    for (const [workspacePath, rejectCompletion] of this.completionRejectors) {
      try {
        this.completionInspectors.get(workspacePath)?.()
      } catch (error) {
        errors.push(error)
        persistenceErrors.set(workspacePath, error)
      } finally {
        rejectCompletion(persistenceErrors.get(workspacePath) ?? new Error('Background runtime shut down without a terminal run state'))
      }
    }
    this.entries.clear()
    this.activeWorkspaces.clear()
    this.activeClaims.clear()
    this.checkpointStates.clear()
    this.staleWorkspaces.clear()
    this.completionInspectors.clear()
    this.completionRejectors.clear()
    for (const timer of this.approvalTimers.values()) clearTimeout(timer)
    this.approvalTimers.clear()
    this.approvalResponseChannels.clear()
    this.approvalResponseDevices.clear()
    this.computerLeaseRunId = null
    errors.push(...this.disposalErrors)
    if (errors.length > 0) throw new AggregateError(errors, 'Background workspace runtime shutdown failed')
  }

  private handleRuntimeEvent(claim: AutomationClaim, runtime: WorkbenchRuntime, event: WorkbenchEvent): void {
    if (event.type !== 'conversation-event') return
    const conversationEvent = event.event
    if (conversationEvent.type === 'approval.requested') {
      const payload = conversationEvent.payload
      const requestedAt = conversationEvent.at
      const toolName = payload.toolName
      const path = payload.path
      const riskCategory: AutomationApprovalRequest['riskCategory'] = payload.kind === 'input'
        ? 'input'
        : path ? 'filesystem'
        : toolName?.startsWith('computer__') ? 'computer'
        : toolName?.includes('network') || toolName?.includes('browser') ? 'network'
        : 'permission'
      this.options.automationService.recordApproval({
        id: conversationEvent.itemId!,
        automationId: claim.automation.id,
        automationName: claim.automation.name,
        runId: claim.run.id,
        definitionRevision: claim.run.definitionRevision,
        permissionSnapshotId: claim.run.permissionSnapshot.id,
        conversationId: event.conversationId,
        workspacePath: claim.automation.workspacePath,
        kind: payload.kind,
        riskCategory,
        question: payload.question,
        options: payload.options,
        reason: payload.reason,
        toolName,
        path,
        targetSummary: path ? `${toolName ?? '工具'} · ${path}` : toolName ?? payload.question,
        triggerSource: claim.run.trigger === 'manual' ? 'manual' : claim.run.trigger === 'recovery' ? 'recovery' : 'schedule',
        requestedAt,
        expiresAt: requestedAt + this.approvalTtlMs,
        status: 'pending',
      })
      this.scheduleApprovalExpiry(conversationEvent.itemId!, runtime)
      this.options.onApprovalChanged?.()
    } else if (conversationEvent.type === 'approval.resolved') {
      const approvalId = conversationEvent.itemId!
      const approval = this.options.automationService.getApproval(approvalId)
      if (approval?.status === 'pending') {
        this.options.automationService.resolveApproval(
          approvalId,
          conversationEvent.payload.decision ?? 'deny',
          this.approvalResponseChannels.get(approvalId) ?? 'system',
          conversationEvent.at,
          this.approvalResponseDevices.get(approvalId),
        )
      }
      this.clearApprovalTimer(approvalId)
      this.options.onApprovalChanged?.()
    } else if (conversationEvent.type === 'approval.cancelled') {
      const approvalId = conversationEvent.itemId!
      if (this.options.automationService.getApproval(approvalId)?.status === 'pending') {
        this.options.automationService.cancelApproval(approvalId, conversationEvent.at)
      }
      this.clearApprovalTimer(approvalId)
      this.options.onApprovalChanged?.()
    }
  }

  private handleAutomationBoundary(workspacePath: string, boundary: AutomationRuntimeBoundary): void {
    const claim = this.activeClaims.get(workspacePath)
    if (!claim || claim.automation.id !== boundary.automationId || claim.run.id !== boundary.runId) {
      throw new Error('Automation runtime boundary does not match the active workspace claim')
    }
    const state = this.checkpointState(claim)
    state.canonicalEventSequence = Math.max(state.canonicalEventSequence, boundary.canonicalEventSequence)
    if (boundary.kind === 'budget') {
      this.options.automationRepository?.consumeRunBudget(claim.run.id, {
        toolCalls: boundary.toolCalls,
        inputTokens: boundary.inputTokens,
        outputTokens: boundary.outputTokens,
        subtasks: boundary.subtasks,
      })
      return
    }
    if (boundary.kind === 'tool_proposed') {
      if (state.completedToolCallIds.includes(boundary.effect.toolCallId)) return
      state.inFlightToolEffect = structuredClone(boundary.effect)
      if (automationToolEffectNeedsReview(boundary.effect.classification)
        && !state.nonReplayableToolCallIds.includes(boundary.effect.toolCallId)) {
        state.nonReplayableToolCallIds.push(boundary.effect.toolCallId)
      }
      this.saveCheckpoint(claim, 'before_tool')
      return
    }
    if (boundary.kind === 'tool_completed') {
      const effect = state.inFlightToolEffect?.toolCallId === boundary.toolCallId
        ? state.inFlightToolEffect
        : state.toolEffects.find(candidate => candidate.toolCallId === boundary.toolCallId)
      const completedEffect = effect ? {
        ...effect,
        toolName: boundary.toolName,
        status: boundary.outcome === 'completed' ? 'completed' as const : 'failed' as const,
        completedAt: boundary.completedAt,
        error: boundary.error,
      } : undefined
      if (completedEffect) {
        state.toolEffects = [
          ...state.toolEffects.filter(candidate => candidate.toolCallId !== boundary.toolCallId),
          completedEffect,
        ]
        state.inFlightToolEffect = undefined
      }
      if (!state.completedToolCallIds.includes(boundary.toolCallId)) state.completedToolCallIds.push(boundary.toolCallId)
      state.artifactIds = [...new Set([...state.artifactIds, ...boundary.artifactIds])]
      if (completedEffect?.classification !== 'read_only') this.saveCheckpoint(claim, 'after_tool')
      if (boundary.artifactIds.length > 0) this.saveCheckpoint(claim, 'artifact')
      return
    }
    if (boundary.kind === 'approval') {
      state.pendingApprovalId = boundary.status === 'requested' ? boundary.approvalId : undefined
      if (boundary.status === 'requested') this.saveCheckpoint(claim, 'approval')
      return
    }
    state.contextSummary = boundary.contextSummary
    this.saveCheckpoint(claim, 'compaction')
  }

  private checkpointState(claim: AutomationClaim): AutomationCheckpointState {
    const existing = this.checkpointStates.get(claim.run.id)
    if (existing) return existing
    const latest = this.options.automationRepository?.getLatestCheckpoint(claim.run.id) ?? null
    const restored: AutomationCheckpointState = latest ? {
      canonicalEventSequence: latest.canonicalEventSequence,
      completedToolCallIds: [...latest.completedToolCallIds],
      nonReplayableToolCallIds: [...latest.nonReplayableToolCallIds],
      toolEffects: latest.toolEffects.map(effect => structuredClone(effect)),
      inFlightToolEffect: latest.inFlightToolEffect ? structuredClone(latest.inFlightToolEffect) : undefined,
      pendingApprovalId: latest.pendingApprovalId,
      artifactIds: [...latest.artifactIds],
      contextSummary: latest.contextSummary,
    } : {
      canonicalEventSequence: 0,
      completedToolCallIds: [],
      nonReplayableToolCallIds: [],
      toolEffects: [],
      artifactIds: [],
    }
    this.checkpointStates.set(claim.run.id, restored)
    return restored
  }

  private saveCheckpoint(claim: AutomationClaim, reason: Parameters<typeof createAutomationCheckpoint>[0]['reason']): void {
    const repository = this.options.automationRepository
    if (!repository) return
    const run = repository.getRun(claim.run.id)
    if (!run) throw new Error(`Durable automation run not found for checkpoint: ${claim.run.id}`)
    const permissionSnapshot = repository.getPermissionSnapshot(run.permissionSnapshotId)
    const contextSnapshot = repository.getContextSnapshot(run.contextSnapshotId)
    if (!permissionSnapshot || !contextSnapshot) throw new Error(`Automation snapshots are missing for checkpoint: ${run.id}`)
    const checkpoint = createAutomationCheckpoint({
      run,
      permissionSnapshot,
      contextSnapshot,
      state: this.checkpointState(claim),
      reason,
      workspaceIdentity: captureAutomationWorkspaceIdentity(claim.automation.workspacePath),
    })
    repository.saveCheckpoint(checkpoint)
  }

  private scheduleApprovalExpiry(approvalId: string, runtime: WorkbenchRuntime): void {
    this.clearApprovalTimer(approvalId)
    const approval = this.options.automationService.getApproval(approvalId)
    if (!approval || approval.status !== 'pending') return
    const timer = setTimeout(() => {
      void runtime.resolveRequestForConversation(approval.conversationId, approval.id, 'deny').finally(() => {
        if (this.options.automationService.getApproval(approval.id)?.status === 'pending') {
          this.options.automationService.resolveApproval(approval.id, 'deny', 'system', Date.now())
        }
        this.clearApprovalTimer(approval.id)
        this.options.onApprovalChanged?.()
      })
    }, Math.max(0, approval.expiresAt - Date.now()))
    timer.unref?.()
    this.approvalTimers.set(approvalId, timer)
  }

  private clearApprovalTimer(approvalId: string): void {
    const timer = this.approvalTimers.get(approvalId)
    if (timer) clearTimeout(timer)
    this.approvalTimers.delete(approvalId)
  }

  private runtimeFor(workspacePath: string): Promise<RuntimeEntry> {
    if (this.destroyed) return Promise.reject(new Error('The background workspace runtime pool is shutting down.'))
    const existing = this.entries.get(workspacePath)
    if (existing) {
      existing.lastUsedAt = Date.now()
      return Promise.resolve(existing)
    }
    const pending = this.pendingInitializations.get(workspacePath)
    if (pending) return pending
    const initialization = this.initializeRuntime(workspacePath)
    this.pendingInitializations.set(workspacePath, initialization)
    void initialization.then(
      () => { this.pendingInitializations.delete(workspacePath) },
      () => { this.pendingInitializations.delete(workspacePath) },
    )
    return initialization
  }

  private async initializeRuntime(workspacePath: string): Promise<RuntimeEntry> {
    const runtime = await this.options.createRuntime(workspacePath)
    if (this.destroyed) {
      await this.disposeRuntime(runtime)
      throw new Error('The background workspace runtime pool was shut down during initialization.')
    }
    const entry = { runtime, workspacePath, lastUsedAt: Date.now() }
    runtime.setAutomationRuntimeBoundaryHandler?.(boundary => this.handleAutomationBoundary(workspacePath, boundary))
    this.entries.set(workspacePath, entry)
    await this.evictIdleRuntimes()
    return entry
  }

  private canStartFrozenClaim(claim: AutomationClaim): { ok: true } | { ok: false; reason: string } {
    if (!this.workspaceAvailable(claim.automation.workspacePath)) {
      this.invalidateMissingWorkspace(claim.automation)
      return { ok: false, reason: 'Automation workspace is missing or is not a directory.' }
    }
    const workspacePermission = this.canStartWorkspace(claim.automation.workspacePath)
    if (!workspacePermission.ok) return workspacePermission
    const snapshot = claim.run.permissionSnapshot
    if (snapshot.allowComputerUse && !snapshot.allowBackgroundComputerUse) {
      return { ok: false, reason: 'Computer control was not approved for this background run.' }
    }
    if (snapshot.allowComputerUse && this.computerLeaseRunId) {
      return { ok: false, reason: 'Another run currently owns the exclusive Computer resource.' }
    }
    return { ok: true }
  }

  private workspaceAvailable(workspacePath: string): boolean {
    try {
      return existsSync(workspacePath) && statSync(workspacePath).isDirectory()
    } catch {
      return false
    }
  }

  private invalidateMissingWorkspace(automation: AutomationRecord): void {
    const current = this.options.automationService.get(automation.id)
    if (!current || current.lifecycleStatus === 'invalid') return
    this.options.automationService.update(automation.id, { lifecycleStatus: 'invalid', enabled: false })
    this.options.automationService.recordValidation(automation.id, [{
      code: 'workspace_missing',
      severity: 'error',
      path: 'workspacePath',
      message: '工作区不存在或不是文件夹。',
    }], ['工作区不可用，已阻止新的自动化运行。'])
    this.options.onApprovalChanged?.()
  }

  private async evictIdleRuntimes(): Promise<void> {
    if (this.entries.size <= this.maxRetainedRuntimes) return
    const candidates = [...this.entries.values()]
      .filter(entry => !this.activeWorkspaces.has(entry.workspacePath))
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)
    while (this.entries.size > this.maxRetainedRuntimes && candidates.length > 0) {
      const entry = candidates.shift()!
      this.entries.delete(entry.workspacePath)
      await this.disposeRuntime(entry.runtime)
    }
  }

  private disposeRuntime(runtime: WorkbenchRuntime): Promise<void> {
    const existing = this.runtimeDisposals.get(runtime)
    if (existing) return existing
    const disposal = Promise.resolve().then(() => runtime.destroy())
    this.runtimeDisposals.set(runtime, disposal)
    this.pendingDisposals.add(disposal)
    void disposal.then(
      () => { this.pendingDisposals.delete(disposal) },
      error => {
        this.pendingDisposals.delete(disposal)
        this.disposalErrors.push(error)
      },
    )
    return disposal
  }
}
