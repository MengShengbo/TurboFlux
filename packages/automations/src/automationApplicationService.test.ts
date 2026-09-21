import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AutomationApplicationService, type AutomationApplicationServiceOptions } from './automationApplicationService'
import {
  AutomationCoordinator,
  type AutomationExecutionHandle,
  type AutomationExecutionPool,
} from './automationCoordinator'
import { AutomationRepository } from './automationRepository'
import { AutomationService, type AutomationClaim, type AutomationRecord, type AutomationRunRecord } from './automationService'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

class ApplicationTestPool implements AutomationExecutionPool {
  private readonly releases = new Map<string, () => void>()

  constructor(private readonly service: AutomationService) {}

  foregroundWorkspacePath(): string | undefined {
    return undefined
  }

  canStart(_automation: AutomationRecord): { ok: true } {
    return { ok: true }
  }

  async start(claim: AutomationClaim): Promise<AutomationExecutionHandle> {
    const conversationId = `conversation-${claim.run.id}`
    this.service.markRunStatus(claim.automation.id, claim.run.id, 'running', { conversationId })
    let release!: () => void
    const completion = new Promise<AutomationRunRecord>(resolve => {
      release = () => {
        const current = this.service.getRun(claim.automation.id, claim.run.id)
        if (!current || !['completed', 'failed', 'canceled', 'interrupted', 'needs_review', 'skipped', 'missed', 'retry_scheduled'].includes(current.status)) {
          this.service.markRunStatus(claim.automation.id, claim.run.id, 'completed', {
            conversationId,
            resultSummary: 'Application service test completed.',
            result: {
              outcome: 'success',
              summary: 'Application service test completed.',
              successCriteria: [],
              artifactIds: [],
              sideEffectSummary: [],
              durationMs: 5,
            },
          })
        }
        resolve(this.service.getRun(claim.automation.id, claim.run.id)!)
      }
    })
    this.releases.set(claim.run.id, release)
    return {
      started: {
        status: 'started',
        inputId: `input-${claim.run.id}`,
        automationId: claim.automation.id,
        automationRunId: claim.run.id,
        conversationId,
      },
      completion,
    }
  }

  async interrupt(runId: string, reason: string): Promise<boolean> {
    const run = this.service.list().automations
      .map(automation => this.service.getRun(automation.id, runId))
      .find((candidate): candidate is AutomationRunRecord => Boolean(candidate))
    if (!run) return false
    this.service.markRunStatus(run.automationId, run.id, 'interrupted', { error: reason, suppressRetry: true })
    this.releases.get(runId)?.()
    this.releases.delete(runId)
    return true
  }

  finish(runId: string): void {
    this.releases.get(runId)?.()
    this.releases.delete(runId)
  }
}

function harness(options: AutomationApplicationServiceOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-application-'))
  directories.push(root)
  const service = new AutomationService(join(root, 'automations.json'))
  const repository = new AutomationRepository(join(root, 'automations-v3'))
  const pool = new ApplicationTestPool(service)
  const coordinator = new AutomationCoordinator(service, repository, pool, { ownerId: 'application-test-host' })
  coordinator.initialize()
  const application = new AutomationApplicationService(service, repository, coordinator, options)
  return { root, service, repository, pool, coordinator, application }
}

function draftInput(workspacePath: string) {
  return {
    name: 'Daily project review',
    prompt: 'Review the project and produce a report.',
    objective: {
      goal: 'Produce a verified project report.',
      successCriteria: ['Report exists'],
      deliverables: ['report.md'],
    },
    workspacePath,
    schedule: { kind: 'daily' as const, time: '09:00' },
    timezone: 'Asia/Shanghai',
    mode: 'isolated' as const,
    contextPolicy: {
      mode: 'isolated' as const,
      includeAutomationMemory: true,
      includePreviousRunSummary: true,
      fileRefs: ['spec.md'],
      skillIds: ['reporting'],
    },
    capabilityPolicy: {
      paths: [{ path: workspacePath, access: 'write' as const }],
      networkDomains: ['api.example.com'],
    },
    approvalPolicy: 'ask' as const,
    reliabilityPolicy: {
      maxRuntimeMinutes: 30,
      maxToolCalls: 50,
      maxInputTokens: 20_000,
      maxOutputTokens: 4_000,
    },
    deliveryPolicy: {
      desktop: ['success', 'failed', 'approval'] as Array<'success' | 'failed' | 'approval'>,
      remoteMobile: ['approval', 'failed'] as Array<'approval' | 'failed'>,
      digest: 'immediate' as const,
    },
  }
}

describe('AutomationApplicationService', () => {
  it('updates the persisted trigger when an edited schedule changes', () => {
    const { root, application } = harness()
    const draft = application.saveDraft(draftInput(root))
    const edited = application.saveDraft({ ...draftInput(root), id: draft.definition.id, expectedRevision: draft.definition.revision, schedule: { kind: 'weekly', weekday: 1, time: '10:30' } })
    expect(edited.definition.triggers).toEqual([expect.objectContaining({ kind: 'schedule', schedule: { kind: 'weekly', weekday: 1, time: '10:30' } })])
  })

  it('supports the draft, validation, testing and publish lifecycle with immutable revisions', () => {
    const { root, application } = harness()
    const draft = application.saveDraft(draftInput(root))

    expect(draft.definition).toMatchObject({
      revision: 1,
      status: 'draft',
      context: { includeAutomationMemory: true, includePreviousRunSummary: true, fileRefs: ['spec.md'], skillIds: ['reporting'] },
      reliability: { maxRuntimeMinutes: 30, maxToolCalls: 50, maxInputTokens: 20_000, maxOutputTokens: 4_000 },
      delivery: {
        desktop: ['success', 'failed', 'approval', 'timeout', 'budget', 'recovered'],
        remoteMobile: ['approval', 'failed', 'timeout', 'budget', 'recovered'],
        digest: 'immediate',
      },
    })
    expect(draft.validation).toMatchObject({ valid: true, riskLevel: 'medium' })
    expect(draft.validation.riskSummary).toEqual(expect.arrayContaining([
      expect.stringContaining('可写入'),
      expect.stringContaining('网络域名'),
    ]))

    const testing = application.setDefinitionStatus(draft.definition.id, 'testing')
    expect(testing.definition).toMatchObject({ revision: 2, status: 'testing' })
    const published = application.publishDefinition(testing.definition.id, testing.definition.revision)
    expect(published.definition).toMatchObject({ revision: 3, status: 'active' })
    expect(published.compatibility).toMatchObject({ enabled: true, lifecycleStatus: 'active' })
    expect(published.revisions.map(revision => revision.revision)).toEqual([3, 2, 1])
  })

  it('rolls back a historical definition as a new disabled draft revision', () => {
    const { root, application, repository } = harness()
    const original = application.saveDraft(draftInput(root))
    const changed = application.saveDraft({
      ...draftInput(root),
      id: original.definition.id,
      expectedRevision: original.definition.revision,
      name: 'Changed review',
      prompt: 'Use a changed objective.',
    })
    const published = application.publishDefinition(changed.definition.id, changed.definition.revision)

    const rolledBack = application.rollbackDefinition(published.definition.id, 1, published.definition.revision)

    expect(rolledBack.definition).toMatchObject({
      revision: published.definition.revision + 1,
      status: 'draft',
      name: original.definition.name,
      objective: { originalPrompt: original.definition.objective.originalPrompt },
    })
    expect(rolledBack.compatibility).toMatchObject({ enabled: false, lifecycleStatus: 'draft' })
    expect(repository.getRevision(rolledBack.definition.id, rolledBack.definition.revision)).toMatchObject({
      source: 'rollback',
      parentRevision: published.definition.revision,
    })
    expect(() => application.rollbackDefinition(rolledBack.definition.id, 1, published.definition.revision)).toThrow('revision conflict')
  })

  it('rotates a continuation conversation for future runs without rewriting history', async () => {
    const { root, application, service, repository, coordinator, pool } = harness()
    const draft = application.saveDraft({
      ...draftInput(root),
      mode: 'continuation',
      contextPolicy: { ...draftInput(root).contextPolicy, mode: 'continuation' },
    })
    service.attachConversation(draft.definition.id, 'conversation-original')
    const historicalRun = await coordinator.runManual(draft.definition.id, true)
    pool.finish(historicalRun.automationRunId)
    await coordinator.waitForIdle()
    const current = application.getDefinition(draft.definition.id)

    const rotated = application.resetContinuationConversation(draft.definition.id, current.definition.revision)

    expect(rotated.definition).toMatchObject({
      revision: current.definition.revision + 1,
      context: { mode: 'continuation' },
    })
    expect(rotated.definition.context.continuationConversationId).toBeUndefined()
    expect(rotated.compatibility).toMatchObject({ conversationId: undefined })
    expect(repository.getContextSnapshot(`context-${historicalRun.automationRunId}`)).toMatchObject({
      conversationId: 'conversation-original',
    })
    expect(repository.getRevision(draft.definition.id, rotated.definition.revision)).toMatchObject({
      changeSummary: 'Reset the dedicated continuation conversation for the next Run.',
    })
  })

  it('archives definitions and only deletes explicitly selected local data', () => {
    const { root, application, repository } = harness()
    const draft = application.saveDraft(draftInput(root))
    writeFileSync(join(repository.rootPath, 'memory', draft.definition.id + '.json'), JSON.stringify({ schemaVersion: 3, definitionId: draft.definition.id, revision: 1, entries: [{ id: 'legacy', text: 'Keep until explicitly removed.', evidence: [] }] }))

    const archived = application.archiveDefinition(draft.definition.id)
    expect(archived).toMatchObject({ detail: { definition: { status: 'archived' } }, deletedRuns: 0, deletedMemory: false })
    expect(repository.listMemory(draft.definition.id).entries).toHaveLength(1)

    const cleaned = application.archiveDefinition(draft.definition.id, { deleteMemory: true })
    expect(cleaned.deletedMemory).toBe(true)
    expect(repository.listMemory(draft.definition.id).entries).toEqual([])
  })

  it('rejects stale revisions and invalid workspace, path, tool and domain scopes', () => {
    const { root, application } = harness()
    const draft = application.saveDraft({
      ...draftInput(join(root, 'missing-workspace')),
      capabilityPolicy: {
        paths: [{ path: join(root, 'outside'), access: 'write' }],
        allowedTools: ['shell'],
        deniedTools: ['shell'],
        networkDomains: ['example.com', '*.example.com', 'not a domain'],
        allowBackgroundComputerUse: true,
        allowComputerUse: false,
      },
    })

    expect(draft.validation.valid).toBe(false)
    expect(draft.validation.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'workspace_missing',
      'path_outside_workspace',
      'tool_policy_conflict',
      'invalid_network_domain',
      'network_domain_overlap',
    ]))
    expect(draft.compatibility.capabilityPolicy.allowBackgroundComputerUse).toBe(false)
    expect(() => application.publishDefinition(draft.definition.id, draft.definition.revision)).toThrow('validation errors')
    expect(() => application.saveDraft({ ...draftInput(root), id: draft.definition.id, expectedRevision: 99 })).toThrow('revision conflict')
  })

  it('reports missing Skill, Plugin, and Secret dependencies with repairable issue codes', () => {
    const { root, application } = harness({ hasSkill: () => false, hasPlugin: () => false, hasSecretRef: () => false })
    const input = draftInput(root)
    const detail = application.saveDraft({
      ...input,
      capabilityPolicy: {
        ...input.capabilityPolicy,
        secretRefs: ['REPORT_TOKEN'],
        pluginIds: ['reporting-plugin'],
      },
    })

    expect(detail.validation.valid).toBe(false)
    expect(detail.validation.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'skill_missing',
      'plugin_missing',
      'secret_ref_missing',
    ]))
  })

  it('paginates definitions and runs with exact totals and builds a run timeline', async () => {
    const { root, pool, coordinator, application, repository } = harness()
    const first = application.saveDraft(draftInput(root))
    application.saveDraft({ ...draftInput(root), name: 'Second review' })

    expect(application.listDefinitions({ offset: 0, limit: 1 })).toMatchObject({ total: 2, offset: 0, limit: 1 })
    const firstRun = await coordinator.runManual(first.definition.id, true)
    pool.finish(firstRun.automationRunId)
    await coordinator.waitForIdle()
    const secondRun = await coordinator.runManual(first.definition.id, true)
    pool.finish(secondRun.automationRunId)
    await coordinator.waitForIdle()

    expect(application.listRuns({ definitionId: first.definition.id, offset: 1, limit: 1 })).toMatchObject({ total: 2, offset: 1, limit: 1 })
    const detail = application.getRun(secondRun.automationRunId)
    expect(detail).toMatchObject({
      run: { id: secondRun.automationRunId, status: 'completed', dryRun: true },
      definition: { id: first.definition.id },
      permissionSnapshot: { approvalPolicy: 'ask' },
      contextSnapshot: { mode: 'isolated' },
    })
    expect(detail.timeline.map(item => item.kind)).toEqual(expect.arrayContaining(['trigger', 'queued', 'lease', 'started', 'completed']))
    expect(application.setRunPinned(secondRun.automationRunId, true).run).toMatchObject({ pinned: true, pinnedAt: expect.any(Number) })
    expect(application.setRunPinned(secondRun.automationRunId, false).run).not.toHaveProperty('pinned')
  })
})
