import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutomationService, type WorkbenchEvent, type WorkbenchRuntime } from '@turboflux/agent-core/workbench'
import { WorkspaceRuntimePool } from './workspaceRuntimePool'

const directories: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function createHarness(options: { approvalTtlMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-runtime-pool-'))
  directories.push(root)
  const service = new AutomationService(join(root, 'automations.json'))
  const listeners = new Map<string, (event: WorkbenchEvent) => void>()
  const destroyed: string[] = []
  const resolvedRequests: Array<{ workspacePath: string; conversationId: string; requestId: string; response: string }> = []
  const deletedConversations: string[] = []
  const artifacts = new Map<string, Array<Record<string, unknown>>>()
  const createRuntime = vi.fn(async (workspacePath: string) => ({
    getSnapshot: () => ({ runtime: { provider: 'openai', model: 'test-model' } }),
    executeAutomationClaim: vi.fn(async claim => {
      service.markRunStatus(claim.automation.id, claim.run.id, 'running', {
        inputId: `input-${claim.run.id}`,
        conversationId: `conversation-${claim.run.id}`,
      })
      return {
        status: 'started' as const,
        inputId: `input-${claim.run.id}`,
        automationId: claim.automation.id,
        automationRunId: claim.run.id,
        conversationId: `conversation-${claim.run.id}`,
        snapshot: {} as never,
      }
    }),
    subscribe(listener: (event: WorkbenchEvent) => void) {
      listeners.set(workspacePath, listener)
      return () => listeners.delete(workspacePath)
    },
    async resolveRequestForConversation(conversationId: string, requestId: string, response: string) {
      resolvedRequests.push({ workspacePath, conversationId, requestId, response })
      listeners.get(workspacePath)?.(conversationEvent(conversationId, 'approval.resolved', requestId, { requestId, decision: response }))
      return true
    },
    async cancelAutomationRun(automationId: string) {
      service.cancelActiveRun(automationId)
      listeners.get(workspacePath)?.({ type: 'conversation-run', conversationId: `conversation-${automationId}`, status: 'interrupted' })
      return service.list(workspacePath)
    },
    async deleteConversation(conversationId: string) { deletedConversations.push(conversationId); return true },
    listArtifacts() { return { schemaVersion: 1, warnings: [], artifacts: artifacts.get(workspacePath) ?? [] } },
    removeArtifact(artifactId: string) {
      artifacts.set(workspacePath, (artifacts.get(workspacePath) ?? []).filter(artifact => artifact.id !== artifactId))
      return { schemaVersion: 1, warnings: [], artifacts: artifacts.get(workspacePath) ?? [] }
    },
    async destroy() { destroyed.push(workspacePath) },
  } as unknown as WorkbenchRuntime))
  let foreground = { workspacePath: join(root, 'foreground'), busy: false }
  const pool = new WorkspaceRuntimePool({
    automationService: service,
    createRuntime,
    foregroundState: () => foreground,
    maxRetainedRuntimes: 1,
    approvalTtlMs: options.approvalTtlMs,
  })
  return {
    root,
    service,
    pool,
    createRuntime,
    listeners,
    resolvedRequests,
    deletedConversations,
    artifacts,
    destroyed,
    setForeground(next: typeof foreground) { foreground = next },
  }
}

function workspace(root: string, name: string): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  return path
}

function conversationEvent(
  conversationId: string,
  type: 'approval.requested' | 'approval.resolved' | 'approval.cancelled',
  itemId: string,
  payload: Record<string, unknown>,
): WorkbenchEvent {
  return {
    type: 'conversation-event',
    conversationId,
    event: {
      schemaVersion: 1,
      eventId: `event-${type}-${itemId}`,
      conversationId,
      threadId: conversationId,
      runId: 'flow-run-1',
      itemId,
      seq: 1,
      at: Date.now(),
      source: 'flow',
      provenance: 'live',
      type,
      payload,
    } as never,
  }
}

describe('WorkspaceRuntimePool', () => {
  it('reports startup failure only through start and destroys the failed runtime before reuse', async () => {
    const harness = createHarness()
    const workspacePath = workspace(harness.root, 'failed-start')
    const automation = harness.service.create({ name: 'Failed start', prompt: 'Start', workspacePath, schedule: { kind: 'manual' } }).automations[0]!
    const runtime = await harness.createRuntime(workspacePath)
    vi.mocked(runtime.executeAutomationClaim).mockRejectedValueOnce(new Error('startup failed'))
    harness.createRuntime.mockResolvedValueOnce(runtime)

    await expect(harness.pool.start(harness.service.claimManual(automation.id))).rejects.toThrow('startup failed')

    expect(harness.destroyed).toEqual([workspacePath])
    expect(harness.listeners.size).toBe(0)
    expect(harness.pool.snapshot()).toEqual({ workspaces: [], activeWorkspaces: [], computerLeaseRunId: null })
    await harness.pool.destroy()
  })

  it('settles the execution handle and reports shutdown failure when runtime disposal rejects', async () => {
    const harness = createHarness()
    const workspacePath = workspace(harness.root, 'failed-disposal')
    const automation = harness.service.create({ name: 'Failed disposal', prompt: 'Start', workspacePath, schedule: { kind: 'manual' } }).automations[0]!
    const runtime = await harness.createRuntime(workspacePath)
    const failure = new Error('runtime disposal failed')
    vi.spyOn(runtime, 'destroy').mockRejectedValue(failure)
    harness.createRuntime.mockResolvedValueOnce(runtime)
    const handle = await harness.pool.start(harness.service.claimManual(automation.id))
    const completed = vi.fn()
    void handle.completion.then(completed, completed)

    const result = await harness.pool.destroy().catch(error => error)

    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ status: 'interrupted' }))
    expect(result).toBeInstanceOf(AggregateError)
    expect(result.errors).toContain(failure)
    expect(harness.listeners.size).toBe(0)
  })

  it('settles an interrupted run even when disposing its runtime fails', async () => {
    const harness = createHarness()
    const workspacePath = workspace(harness.root, 'failed-interruption')
    const automation = harness.service.create({ name: 'Failed interruption', prompt: 'Start', workspacePath, schedule: { kind: 'manual' } }).automations[0]!
    const runtime = await harness.createRuntime(workspacePath)
    vi.spyOn(runtime, 'destroy').mockRejectedValue(new Error('disposal failed'))
    harness.createRuntime.mockResolvedValueOnce(runtime)
    const claim = harness.service.claimManual(automation.id)
    const handle = await harness.pool.start(claim)
    const completed = vi.fn()
    void handle.completion.then(completed, completed)

    await expect(harness.pool.interrupt(claim.run.id, 'ownership lost')).rejects.toThrow('disposal failed')

    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ status: 'interrupted' }))
    expect(harness.listeners.size).toBe(0)
    await expect(harness.pool.destroy()).rejects.toBeInstanceOf(AggregateError)
  })

  it('still destroys runtimes and rejects completion when persisting shutdown state fails', async () => {
    const harness = createHarness()
    const workspacePath = workspace(harness.root, 'failed-shutdown-persistence')
    const automation = harness.service.create({ name: 'Failed persistence', prompt: 'Start', workspacePath, schedule: { kind: 'manual' } }).automations[0]!
    const handle = await harness.pool.start(harness.service.claimManual(automation.id))
    const failure = new Error('disk full')
    const markStatus = vi.spyOn(harness.service, 'markRunStatus').mockImplementationOnce(() => { throw failure })
    const completed = vi.fn()
    const rejected = vi.fn()
    void handle.completion.then(completed, rejected)

    const result = await harness.pool.destroy().catch(error => error)

    expect(harness.destroyed).toEqual([workspacePath])
    expect(completed).not.toHaveBeenCalled()
    expect(rejected).toHaveBeenCalledWith(failure)
    expect(result).toBeInstanceOf(AggregateError)
    expect(result.errors).toContain(failure)
    expect(harness.listeners.size).toBe(0)
    markStatus.mockRestore()
  })

  it('makes concurrent shutdown callers wait for the same resource disposal', async () => {
    const harness = createHarness()
    const workspacePath = workspace(harness.root, 'concurrent-shutdown')
    const automation = harness.service.create({ name: 'Concurrent shutdown', prompt: 'Start', workspacePath, schedule: { kind: 'manual' } }).automations[0]!
    const runtime = await harness.createRuntime(workspacePath)
    let finishDisposal!: () => void
    const disposal = new Promise<void>(resolve => { finishDisposal = resolve })
    vi.spyOn(runtime, 'destroy').mockReturnValue(disposal)
    harness.createRuntime.mockResolvedValueOnce(runtime)
    const handle = await harness.pool.start(harness.service.claimManual(automation.id))
    const first = harness.pool.destroy()
    let secondFinished = false
    const second = harness.pool.destroy().then(() => { secondFinished = true })
    try {
      await Promise.resolve()
      expect(secondFinished).toBe(false)
    } finally {
      finishDisposal()
      await Promise.all([first, second])
    }
    await expect(handle.completion).resolves.toMatchObject({ status: 'interrupted' })
    expect(runtime.destroy).toHaveBeenCalledTimes(1)
  })

  it.each(['automation', 'retention'] as const)('waits for %s initialization and its disposal before shutdown finishes', async operation => {
    const harness = createHarness()
    const workspacePath = workspace(harness.root, 'initializing')
    const runtime = await harness.createRuntime(workspacePath)
    let finishInitialization!: () => void
    const initialization = new Promise<void>(resolve => { finishInitialization = resolve })
    harness.createRuntime.mockImplementationOnce(async () => { await initialization; return runtime })
    const automation = harness.service.create({ name: 'Initializing', prompt: 'Start', workspacePath, schedule: { kind: 'manual' } }).automations[0]!
    const pending = operation === 'automation'
      ? harness.pool.start(harness.service.claimManual(automation.id))
      : harness.pool.deleteConversations(workspacePath, ['old-conversation'])
    const outcome = pending.catch(error => error)
    let shutdownFinished = false
    const shutdown = harness.pool.destroy().then(() => { shutdownFinished = true })
    try {
      await Promise.resolve()
      await Promise.resolve()
      expect(shutdownFinished).toBe(false)
    } finally {
      finishInitialization()
      await shutdown
    }

    expect(await outcome).toBeInstanceOf(Error)
    expect(runtime.executeAutomationClaim).not.toHaveBeenCalled()
    expect(harness.deletedConversations).toEqual([])
    expect(harness.destroyed).toEqual([workspacePath])
    expect(harness.pool.snapshot()).toEqual({ workspaces: [], activeWorkspaces: [], computerLeaseRunId: null })
  })

  it('shares a single runtime initialization across simultaneous retention requests', async () => {
    const harness = createHarness()
    const workspacePath = workspace(harness.root, 'shared-initialization')
    await Promise.all([
      harness.pool.deleteConversations(workspacePath, ['first']),
      harness.pool.deleteConversations(workspacePath, ['second']),
    ])
    expect(harness.createRuntime).toHaveBeenCalledTimes(1)
    expect(harness.deletedConversations).toEqual(['first', 'second'])
    await harness.pool.destroy()
    expect(harness.destroyed).toEqual([workspacePath])
  })

  it('runs a background workspace without changing the foreground state', async () => {
    const harness = createHarness()
    const backgroundWorkspace = workspace(harness.root, 'background')
    const automation = harness.service.create({
      name: 'Background',
      prompt: 'Run without navigation',
      workspacePath: backgroundWorkspace,
      schedule: { kind: 'manual' },
    }).automations[0]!
    const claim = harness.service.claimManual(automation.id)

    const handle = await harness.pool.start(claim)

    expect(harness.createRuntime).toHaveBeenCalledWith(backgroundWorkspace)
    expect(harness.pool.foregroundWorkspacePath()).toBe(join(harness.root, 'foreground'))
    expect(harness.pool.snapshot()).toMatchObject({ activeWorkspaces: [backgroundWorkspace] })
    harness.service.markRunStatus(automation.id, claim.run.id, 'completed')
    harness.listeners.get(backgroundWorkspace)?.({
      type: 'conversation-run',
      conversationId: handle.started.conversationId,
      status: 'completed',
    })
    await expect(handle.completion).resolves.toMatchObject({ status: 'completed' })
    expect(harness.pool.snapshot().activeWorkspaces).toEqual([])
    await harness.pool.destroy()
  })

  it('interrupts one active runtime by run ID and removes it from the reusable pool', async () => {
    const harness = createHarness()
    const workspacePath = workspace(harness.root, 'ownership-lost')
    const automation = harness.service.create({
      name: 'Ownership lost',
      prompt: 'Stop the local engine immediately',
      workspacePath,
      schedule: { kind: 'manual' },
    }).automations[0]!
    const claim = harness.service.claimManual(automation.id)
    const handle = await harness.pool.start(claim)

    await expect(harness.pool.interrupt(claim.run.id, 'Lease ownership moved to another host.')).resolves.toBe(true)

    await expect(handle.completion).resolves.toMatchObject({
      status: 'interrupted',
      error: 'Lease ownership moved to another host.',
    })
    expect(harness.destroyed).toContain(workspacePath)
    expect(harness.pool.snapshot()).toEqual({ workspaces: [], activeWorkspaces: [], computerLeaseRunId: null })
    await expect(harness.pool.interrupt(claim.run.id, 'Duplicate stop')).resolves.toBe(false)
    await harness.pool.destroy()
  })

  it('deletes selected conversations and only expired artifacts inside their workspace', async () => {
    const harness = createHarness()
    const workspacePath = workspace(harness.root, 'retention')
    const oldArtifactPath = join(workspacePath, 'old.png')
    const freshArtifactPath = join(workspacePath, 'fresh.png')
    writeFileSync(oldArtifactPath, 'old')
    writeFileSync(freshArtifactPath, 'fresh')
    harness.artifacts.set(workspacePath, [
      { id: 'old', path: oldArtifactPath, source: 'browser', updatedAt: 10, available: true, metadata: {}, workspacePath },
      { id: 'fresh', path: freshArtifactPath, source: 'automation', updatedAt: 90, available: true, metadata: {}, workspacePath },
    ])

    await expect(harness.pool.deleteConversations(workspacePath, ['conversation-old'])).resolves.toBe(1)
    await expect(harness.pool.deleteArtifacts(workspacePath, [
      { id: 'old', runCompletedAt: 10 },
      { id: 'fresh', runCompletedAt: 90 },
    ], { screenshot: 50, artifact: 50 })).resolves.toEqual({ deletedRecords: 1, deletedFiles: 1, skippedFiles: 0 })
    expect(harness.deletedConversations).toEqual(['conversation-old'])
    expect(existsSync(oldArtifactPath)).toBe(false)
    expect(existsSync(freshArtifactPath)).toBe(true)
    await harness.pool.destroy()
  })

  it('prioritizes foreground work and enforces exclusive Computer control', async () => {
    const harness = createHarness()
    const foregroundWorkspace = workspace(harness.root, 'foreground')
    harness.setForeground({ workspacePath: foregroundWorkspace, busy: true })
    const foreground = harness.service.create({
      name: 'Foreground collision',
      prompt: 'Wait for foreground work',
      workspacePath: foregroundWorkspace,
      schedule: { kind: 'manual' },
    }).automations[0]!
    expect(harness.pool.canStart(foreground)).toEqual({
      ok: false,
      reason: 'Foreground work currently owns this workspace.',
    })

    const background = harness.service.create({
      name: 'Computer background denied',
      prompt: 'Use Computer',
      workspacePath: workspace(harness.root, 'other'),
      schedule: { kind: 'manual' },
      capabilityPolicy: { allowComputerUse: true, allowBackgroundComputerUse: false },
    }).automations[0]!
    expect(harness.pool.canStart(background)).toEqual({
      ok: false,
      reason: 'Computer control was not approved for background execution.',
    })
    await harness.pool.destroy()
  })

  it('marks a missing workspace definition invalid instead of repeatedly retrying it', async () => {
    const harness = createHarness()
    const missingWorkspace = join(harness.root, 'missing')
    const automation = harness.service.create({
      name: 'Missing workspace',
      prompt: 'Do not retry forever',
      workspacePath: missingWorkspace,
      schedule: { kind: 'manual' },
    }).automations[0]!

    expect(harness.pool.canStart(automation)).toEqual({
      ok: false,
      reason: 'Automation workspace is missing or is not a directory.',
    })
    expect(harness.service.get(automation.id)).toMatchObject({
      lifecycleStatus: 'invalid',
      enabled: false,
      validationIssues: [expect.objectContaining({ code: 'workspace_missing' })],
    })
    await harness.pool.destroy()
  })

  it('evicts only idle background runtimes', async () => {
    const harness = createHarness()
    const workspaceA = workspace(harness.root, 'a')
    const workspaceB = workspace(harness.root, 'b')
    const automationA = harness.service.create({ name: 'A', prompt: 'A', workspacePath: workspaceA, schedule: { kind: 'manual' } }).automations[0]!
    const automationB = harness.service.create({ name: 'B', prompt: 'B', workspacePath: workspaceB, schedule: { kind: 'manual' } }).automations[0]!
    const claimA = harness.service.claimManual(automationA.id)
    const handleA = await harness.pool.start(claimA)
    harness.service.markRunStatus(automationA.id, claimA.run.id, 'completed')
    harness.listeners.get(workspaceA)?.({ type: 'conversation-run', conversationId: handleA.started.conversationId, status: 'completed' })
    await handleA.completion

    const claimB = harness.service.claimManual(automationB.id)
    const handleB = await harness.pool.start(claimB)
    expect(harness.destroyed).toContain(workspaceA)
    harness.service.markRunStatus(automationB.id, claimB.run.id, 'completed')
    harness.listeners.get(workspaceB)?.({ type: 'conversation-run', conversationId: handleB.started.conversationId, status: 'completed' })
    await handleB.completion
    await harness.pool.destroy()
  })

  it('marks active work interrupted during bounded pool shutdown', async () => {
    const harness = createHarness()
    const workspacePath = workspace(harness.root, 'shutdown')
    const automation = harness.service.create({
      name: 'Shutdown recovery',
      prompt: 'Remain explainable',
      workspacePath,
      schedule: { kind: 'manual' },
      retryPolicy: { maxRetries: 2, backoffMinutes: 1 },
    }).automations[0]!
    const claim = harness.service.claimManual(automation.id)
    const handle = await harness.pool.start(claim)

    await harness.pool.destroy()

    await expect(handle.completion).resolves.toMatchObject({
      status: 'interrupted',
      retryAt: undefined,
      error: 'TurboFlux exited while this background automation was running.',
    })
    expect(harness.service.get(automation.id)).toMatchObject({
      activeRunId: undefined,
      lastStatus: 'interrupted',
    })
    expect(harness.pool.snapshot().activeWorkspaces).toEqual([])
  })

  it('persists background approvals and resolves them through the owning runtime without changing foreground state', async () => {
    const harness = createHarness()
    const workspacePath = workspace(harness.root, 'approval')
    const automation = harness.service.create({
      name: 'Approval review',
      prompt: 'Request a scoped write',
      workspacePath,
      schedule: { kind: 'manual' },
      approvalPolicy: 'ask',
    }).automations[0]!
    const claim = harness.service.claimManual(automation.id)
    const handle = await harness.pool.start(claim)
    const requestId = 'approval-background-1'

    harness.listeners.get(workspacePath)?.(conversationEvent(handle.started.conversationId, 'approval.requested', requestId, {
      requestId,
      kind: 'permission',
      question: 'Allow writing the report?',
      options: ['allow-once', 'allow-run', 'deny'],
      reason: 'The report is the requested deliverable.',
      toolName: 'write_file',
      path: join(workspacePath, 'report.md'),
    }))

    expect(harness.service.getApproval(requestId)).toMatchObject({
      automationId: automation.id,
      runId: claim.run.id,
      definitionRevision: claim.run.definitionRevision,
      permissionSnapshotId: claim.run.permissionSnapshot.id,
      status: 'pending',
      riskCategory: 'filesystem',
      path: join(workspacePath, 'report.md'),
    })
    expect(harness.pool.foregroundWorkspacePath()).toBe(join(harness.root, 'foreground'))

    await expect(harness.pool.resolveApproval(requestId, 'allow-once', 'remote', 'phone-1')).resolves.toMatchObject({
      status: 'approved',
      decision: 'allow-once',
      responseChannel: 'remote',
      responseDeviceId: 'phone-1',
    })
    expect(harness.resolvedRequests).toContainEqual({
      workspacePath,
      conversationId: handle.started.conversationId,
      requestId,
      response: 'allow-once',
    })
    await expect(harness.pool.resolveApproval(requestId, 'allow-once', 'desktop')).rejects.toThrow('already approved')

    harness.service.markRunStatus(automation.id, claim.run.id, 'completed')
    harness.listeners.get(workspacePath)?.({ type: 'conversation-run', conversationId: handle.started.conversationId, status: 'completed' })
    await handle.completion
    await harness.pool.destroy()
  })

  it('denies an expired approval and records the system channel', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-09-01T00:00:00.000Z'))
    const harness = createHarness({ approvalTtlMs: 5 * 60_000 })
    const workspacePath = workspace(harness.root, 'expiry')
    const automation = harness.service.create({ name: 'Expiry', prompt: 'Wait for approval', workspacePath, schedule: { kind: 'manual' } }).automations[0]!
    const claim = harness.service.claimManual(automation.id)
    const handle = await harness.pool.start(claim)
    const requestId = 'approval-expiry-1'
    harness.listeners.get(workspacePath)?.(conversationEvent(handle.started.conversationId, 'approval.requested', requestId, {
      requestId,
      kind: 'permission',
      question: 'Allow operation?',
      options: ['allow-once', 'deny'],
      toolName: 'run_command',
    }))

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1)

    expect(harness.resolvedRequests.at(-1)).toMatchObject({ requestId, response: 'deny' })
    expect(harness.service.getApproval(requestId)).toMatchObject({
      status: 'expired',
      decision: 'deny',
      responseChannel: 'system',
    })
    harness.service.markRunStatus(automation.id, claim.run.id, 'completed')
    harness.listeners.get(workspacePath)?.({ type: 'conversation-run', conversationId: handle.started.conversationId, status: 'completed' })
    await handle.completion
    await harness.pool.destroy()
  })

  it('stops and releases the background runtime before handing its conversation to the foreground', async () => {
    const harness = createHarness()
    const workspacePath = workspace(harness.root, 'takeover')
    const automation = harness.service.create({ name: 'Takeover', prompt: 'Hand control back', workspacePath, schedule: { kind: 'manual' } }).automations[0]!
    const claim = harness.service.claimManual(automation.id)
    const handle = await harness.pool.start(claim)

    const takeover = await harness.pool.takeOver(automation.id)

    expect(takeover).toEqual({ workspacePath, conversationId: handle.started.conversationId, runId: claim.run.id })
    expect(harness.destroyed).toContain(workspacePath)
    expect(harness.pool.snapshot().workspaces).not.toContain(workspacePath)
    expect(harness.service.getRun(automation.id, claim.run.id)).toMatchObject({ status: 'canceled' })
    await expect(handle.completion).resolves.toMatchObject({ status: 'canceled' })
    await harness.pool.destroy()
  })
})
