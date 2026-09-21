import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AutomationApplicationService,
  AutomationCoordinator,
  AutomationRepository,
  AutomationService,
  type AutomationClaim,
  type AutomationRuntimeBoundaryHandler,
  type WorkbenchEvent,
  type WorkbenchRuntime,
} from '@turboflux/workbench'
import { WorkspaceRuntimePool } from './workspaceRuntimePool'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function approvalEvent(claim: AutomationClaim, conversationId: string, type: 'approval.requested' | 'approval.resolved', decision?: string): WorkbenchEvent {
  const requestId = `approval-${claim.run.id}`
  return {
    type: 'conversation-event',
    conversationId,
    event: {
      schemaVersion: 1,
      eventId: `${type}-${requestId}`,
      conversationId,
      threadId: conversationId,
      runId: `flow-${claim.run.id}`,
      itemId: requestId,
      seq: type === 'approval.requested' ? 1 : 2,
      at: Date.now(),
      source: 'flow',
      provenance: 'live',
      type,
      payload: type === 'approval.requested'
        ? {
            requestId,
            kind: 'permission',
            question: 'Allow writing the product report?',
            options: ['allow-once', 'allow-run', 'deny'],
            reason: 'The report is the declared deliverable.',
            toolName: 'write_file',
            path: join(claim.automation.workspacePath, 'report.md'),
          }
        : { requestId, decision },
    } as never,
  }
}

describe('Automation product flow', () => {
  it('closes the product lifecycle from draft through pause, cancellation, retry, result, and archive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-product-flow-'))
    directories.push(root)
    const workspacePath = join(root, 'workspace')
    mkdirSync(workspacePath)
    const service = new AutomationService(join(root, 'state', 'automations.json'))
    const repository = new AutomationRepository(join(root, 'state', 'automations-v3'))
    const listeners = new Map<string, (event: WorkbenchEvent) => void>()
    const boundaryHandlers = new Map<string, AutomationRuntimeBoundaryHandler>()
    const claims = new Map<string, AutomationClaim>()
    const pool = new WorkspaceRuntimePool({
      automationService: service,
      automationRepository: repository,
      foregroundState: () => ({ workspacePath: join(root, 'foreground'), busy: false }),
      createRuntime: async backgroundWorkspacePath => ({
        setAutomationRuntimeBoundaryHandler(handler: AutomationRuntimeBoundaryHandler | null) {
          if (handler) boundaryHandlers.set(backgroundWorkspacePath, handler)
          else boundaryHandlers.delete(backgroundWorkspacePath)
        },
        subscribe(listener: (event: WorkbenchEvent) => void) {
          listeners.set(backgroundWorkspacePath, listener)
          return () => listeners.delete(backgroundWorkspacePath)
        },
        async executeAutomationClaim(claim: AutomationClaim) {
          claims.set(claim.run.id, claim)
          const conversationId = `conversation-${claim.run.id}`
          service.markRunStatus(claim.automation.id, claim.run.id, 'running', { conversationId })
          boundaryHandlers.get(backgroundWorkspacePath)?.({
            kind: 'budget',
            automationId: claim.automation.id,
            runId: claim.run.id,
            conversationId,
            canonicalEventSequence: 0,
            source: 'main',
            toolCalls: 1,
            inputTokens: 25,
            outputTokens: 5,
            at: Date.now(),
          })
          boundaryHandlers.get(backgroundWorkspacePath)?.({
            kind: 'budget',
            automationId: claim.automation.id,
            runId: claim.run.id,
            conversationId,
            canonicalEventSequence: 0,
            source: 'subagent',
            toolCalls: 1,
            inputTokens: 10,
            outputTokens: 4,
            at: Date.now(),
          })
          boundaryHandlers.get(backgroundWorkspacePath)?.({
            kind: 'tool_proposed',
            automationId: claim.automation.id,
            runId: claim.run.id,
            conversationId,
            canonicalEventSequence: 0,
            effect: {
              toolCallId: `tool-${claim.run.id}`,
              toolName: 'write_file',
              classification: 'idempotent_write',
              idempotencyKey: `stable-${claim.run.id}`,
              targetSummary: join(claim.automation.workspacePath, 'report.md'),
              status: 'proposed',
              startedAt: Date.now(),
            },
          })
          boundaryHandlers.get(backgroundWorkspacePath)?.({
            kind: 'approval',
            automationId: claim.automation.id,
            runId: claim.run.id,
            conversationId,
            canonicalEventSequence: 1,
            approvalId: `approval-${claim.run.id}`,
            status: 'requested',
            at: Date.now(),
          })
          listeners.get(backgroundWorkspacePath)?.(approvalEvent(claim, conversationId, 'approval.requested'))
          return {
            status: 'started' as const,
            inputId: `input-${claim.run.id}`,
            automationId: claim.automation.id,
            automationRunId: claim.run.id,
            conversationId,
            snapshot: {} as never,
          }
        },
        async resolveRequestForConversation(conversationId: string, requestId: string, response: string) {
          const claim = [...claims.values()].find(item => `approval-${item.run.id}` === requestId)!
          listeners.get(backgroundWorkspacePath)?.(approvalEvent(claim, conversationId, 'approval.resolved', response))
          boundaryHandlers.get(backgroundWorkspacePath)?.({
            kind: 'tool_completed',
            automationId: claim.automation.id,
            runId: claim.run.id,
            conversationId,
            canonicalEventSequence: 3,
            toolCallId: `tool-${claim.run.id}`,
            toolName: 'write_file',
            outcome: response === 'deny' ? 'cancelled' : 'completed',
            artifactIds: response === 'deny' ? [] : ['artifact-report'],
            completedAt: Date.now(),
          })
          service.markRunStatus(claim.automation.id, claim.run.id, response === 'deny' ? 'failed' : 'completed', {
            conversationId,
            error: response === 'deny' ? 'Approval denied' : undefined,
            resultSummary: response === 'deny' ? undefined : 'Product report completed.',
            result: response === 'deny' ? undefined : {
              outcome: 'success',
              summary: 'Product report completed.',
              successCriteria: [{ criterion: 'Report exists', status: 'met', evidence: 'report.md' }],
              artifactIds: ['artifact-report'],
              sideEffectSummary: ['Created report.md'],
              durationMs: 100,
            },
          })
          listeners.get(backgroundWorkspacePath)?.({ type: 'conversation-run', conversationId, status: response === 'deny' ? 'failed' : 'completed' })
          return true
        },
        async cancelAutomationRun(automationId: string) { return service.cancelActiveRun(automationId) },
        async destroy() {},
      } as unknown as WorkbenchRuntime),
    })
    const coordinator = new AutomationCoordinator(service, repository, pool, { ownerId: 'product-flow-host' })
    coordinator.initialize()
    const application = new AutomationApplicationService(service, repository, coordinator, {
      onDefinitionsChanged: () => coordinator.notifyDefinitionsChanged(),
    })

    const draft = application.saveDraft({
      name: 'Product report',
      prompt: 'Create a verified product report.',
      objective: { successCriteria: ['Report exists'], deliverables: ['report.md'] },
      workspacePath,
      schedule: { kind: 'manual' },
      contextPolicy: { includeAutomationMemory: true, includePreviousRunSummary: true },
      approvalPolicy: 'ask',
      capabilityPolicy: { paths: [{ path: workspacePath, access: 'write' }] },
    })
    expect(draft.validation.valid).toBe(true)
    const testing = application.setDefinitionStatus(draft.definition.id, 'testing')
    const dryRun = await coordinator.runManual(testing.definition.id, true)
    expect(service.getApproval(`approval-${dryRun.automationRunId}`)).toMatchObject({ status: 'pending' })
    await pool.resolveApproval(`approval-${dryRun.automationRunId}`, 'allow-once', 'desktop')
    await coordinator.waitForIdle()
    expect(application.getRun(dryRun.automationRunId).run).toMatchObject({ status: 'completed' })

    const published = application.publishDefinition(testing.definition.id, testing.definition.revision)
    expect(published.definition.status).toBe('active')
    const paused = application.setDefinitionStatus(published.definition.id, 'paused')
    expect(paused.definition.status).toBe('paused')
    expect(paused.compatibility.enabled).toBe(false)
    const resumed = application.publishDefinition(paused.definition.id, paused.definition.revision)
    expect(resumed.definition.status).toBe('active')
    expect(resumed.compatibility.enabled).toBe(true)

    const formalRun = await coordinator.runManual(resumed.definition.id)
    const approvalId = `approval-${formalRun.automationRunId}`
    expect(service.getApproval(approvalId)).toMatchObject({ status: 'pending', path: join(workspacePath, 'report.md') })
    await pool.resolveApproval(approvalId, 'allow-once', 'remote', 'phone-client')
    await coordinator.waitForIdle()

    const result = application.getRun(formalRun.automationRunId)
    expect(result.run).toMatchObject({ status: 'completed', result: { outcome: 'success', artifactIds: ['artifact-report'] } })
    expect(result.approvals).toEqual([expect.objectContaining({ status: 'approved', responseChannel: 'remote', responseDeviceId: 'phone-client' })])
    expect(result.timeline.map(item => item.title)).toEqual(expect.arrayContaining(['请求审批', '审批已允许', '运行完成']))
    expect(repository.listCheckpoints(formalRun.automationRunId).map(checkpoint => checkpoint.reason)).toEqual(expect.arrayContaining([
      'before_tool',
      'approval',
      'after_tool',
      'artifact',
    ]))
    expect(repository.getLatestCheckpoint(formalRun.automationRunId)).toMatchObject({
      toolEffects: [expect.objectContaining({ toolName: 'write_file', status: 'completed' })],
      artifactIds: ['artifact-report'],
    })
    expect(repository.getLatestCheckpoint(formalRun.automationRunId)?.inFlightToolEffect).toBeUndefined()
    expect(repository.getRun(formalRun.automationRunId)?.budgetUsage).toMatchObject({
      toolCalls: 2,
      inputTokens: 35,
      outputTokens: 9,
    })
    expect(repository.getContextSnapshot(repository.getRun(formalRun.automationRunId)!.contextSnapshotId)?.previousRunSummary).toMatchObject({
      runId: dryRun.automationRunId,
      summary: 'Product report completed.',
      outcome: 'success',
    })

    const cancellation = await coordinator.runManual(resumed.definition.id)
    expect(service.getApproval(`approval-${cancellation.automationRunId}`)).toMatchObject({ status: 'pending' })
    await expect(pool.cancel(resumed.definition.id)).resolves.toBe(true)
    await coordinator.waitForIdle()
    expect(application.getRun(cancellation.automationRunId).run).toMatchObject({ status: 'canceled' })

    const retry = await coordinator.retry(resumed.definition.id, cancellation.automationRunId)
    const retryApprovalId = `approval-${retry.automationRunId}`
    expect(service.getApproval(retryApprovalId)).toMatchObject({ status: 'pending' })
    await pool.resolveApproval(retryApprovalId, 'allow-once', 'desktop')
    await coordinator.waitForIdle()
    const retried = application.getRun(retry.automationRunId)
    expect(retried.run).toMatchObject({ status: 'completed', attempt: 2 })
    expect(service.getRun(resumed.definition.id, retry.automationRunId)?.trigger).toBe('retry')
    expect(retried.timeline.map(item => item.title)).toEqual(expect.arrayContaining(['请求审批', '审批已允许', '运行完成']))

    const archived = application.archiveDefinition(resumed.definition.id)
    expect(archived.detail.definition.status).toBe('archived')
    expect(archived.detail.compatibility.enabled).toBe(false)
    expect(archived).toMatchObject({ deletedRuns: 0, deletedMemory: false })
    expect(application.listDefinitions({ status: 'archived' }).items).toEqual([
      expect.objectContaining({ id: resumed.definition.id, status: 'archived' }),
    ])
    await pool.destroy()
  }, 20_000)
})
