import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateAutomationV2Store, planAutomationV2Migration } from './automationMigration'
import { AutomationRepository } from './automationRepository'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-migration-'))
  directories.push(root)
  const sourcePath = join(root, 'automations.json')
  const fixturePath = join(import.meta.dirname, 'fixtures', 'automation-v2.json')
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { automations: Array<{ workspacePath: string }> }
  fixture.automations[0]!.workspacePath = join(root, 'workspace')
  writeFileSync(sourcePath, `${JSON.stringify(fixture, null, 2)}\n`)
  const repository = new AutomationRepository(join(root, 'automations-v3'))
  repository.initialize()
  return { root, sourcePath, repository }
}

describe('automation v2 migration', () => {
  it('previews and migrates the real v2 fixture without losing continuation or run history', () => {
    const { sourcePath, repository } = createFixture()
    const plan = planAutomationV2Migration(repository, sourcePath)

    expect(plan).toMatchObject({ definitionCount: 1, runCount: 1, activeRunCount: 0, warnings: [] })
    expect(existsSync(plan.backupPath)).toBe(false)
    expect(existsSync(plan.markerPath)).toBe(false)

    const report = migrateAutomationV2Store(repository, sourcePath, 1_788_192_000_000)
    expect(report).toMatchObject({ alreadyMigrated: false, definitionCount: 1, runCount: 1, completedAt: 1_788_192_000_000 })
    expect(existsSync(report.backupPath)).toBe(true)
    expect(existsSync(report.markerPath)).toBe(true)
    expect(repository.getDefinition('automation-v2-fixture')).toMatchObject({
      revision: 1,
      status: 'active',
      context: { mode: 'continuation', continuationConversationId: 'desktop-v2-automation-conversation' },
      reliability: { overlapPolicy: 'queue-one', retry: { maxRetries: 3, backoffMinutes: 4 } },
    })
    const runs = repository.listRuns({ definitionId: 'automation-v2-fixture' })
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      status: 'completed',
      mode: 'continuation',
      conversationId: 'desktop-v2-automation-conversation',
      result: { outcome: 'success', summary: 'Persisted V2 run completed.' },
      migration: { schemaVersion: 2, legacyRunId: 'automation-run-v2-fixture', legacyInputId: 'v2-input-1' },
    })
    expect(repository.getPermissionSnapshot(runs[0]!.permissionSnapshotId)).toMatchObject({ approvalPolicy: 'ask', maxRuntimeMinutes: 90 })
    expect(repository.getContextSnapshot(runs[0]!.contextSnapshotId)).toMatchObject({ mode: 'continuation' })

    const repeated = migrateAutomationV2Store(repository, sourcePath, 1_788_192_100_000)
    expect(repeated.alreadyMigrated).toBe(true)
    expect(repository.listRuns({ definitionId: 'automation-v2-fixture' })).toHaveLength(1)
  })

  it('turns an active v2 run into an explicit interrupted record', () => {
    const { sourcePath, repository } = createFixture()
    const store = JSON.parse(readFileSync(sourcePath, 'utf8'))
    store.automations[0].activeRunId = store.automations[0].history[0].id
    store.automations[0].history[0].status = 'running'
    delete store.automations[0].history[0].completedAt
    delete store.automations[0].history[0].durationMs
    writeFileSync(sourcePath, `${JSON.stringify(store, null, 2)}\n`)

    expect(planAutomationV2Migration(repository, sourcePath)).toMatchObject({ activeRunCount: 1 })
    migrateAutomationV2Store(repository, sourcePath)

    expect(repository.listRuns()[0]).toMatchObject({
      status: 'interrupted',
      error: { code: 'migrated_active_run_interrupted', category: 'host_interrupted', retryable: false },
    })
  })

  it('preserves enriched v2 isolation, objective, capabilities, snapshots, and result', () => {
    const { sourcePath, repository } = createFixture()
    const store = JSON.parse(readFileSync(sourcePath, 'utf8'))
    const automation = store.automations[0]
    const run = automation.history[0]
    automation.mode = 'isolated'
    automation.objective = {
      originalPrompt: automation.prompt,
      goal: 'Produce a verified report.',
      successCriteria: ['Report is complete.'],
      deliverables: ['report.md'],
      constraints: ['Do not publish.'],
      noChangeBehavior: 'Return no_change.',
      failureBehavior: 'Preserve evidence.',
    }
    automation.capabilityPolicy = {
      approvalPolicy: 'agent',
      allowedTools: ['read_file'],
      deniedTools: ['shell'],
      paths: [{ path: automation.workspacePath, access: 'read' }],
      networkDomains: ['example.com'],
      secretRefs: ['local-token'],
      mcpServerIds: ['local-mcp'],
      pluginIds: ['report-plugin'],
      allowComputerUse: false,
      allowBackgroundComputerUse: false,
    }
    delete run.conversationId
    run.definitionRevision = 4
    run.permissionSnapshot = {
      id: 'legacy-permission',
      definitionId: automation.id,
      definitionRevision: 4,
      approvalPolicy: 'agent',
      allowedTools: ['read_file'],
      deniedTools: ['shell'],
      paths: [{ path: automation.workspacePath, access: 'read' }],
      networkDomains: ['example.com'],
      secretRefs: ['local-token'],
      mcpServerIds: ['local-mcp'],
      pluginIds: ['report-plugin'],
      allowComputerUse: false,
      allowBackgroundComputerUse: false,
      maxRuntimeMinutes: 12,
      maxToolCalls: 7,
      riskSummary: ['Read-only report generation.'],
      createdAt: run.startedAt - 100,
    }
    run.contextSnapshot = {
      id: 'legacy-context',
      definitionId: automation.id,
      definitionRevision: 4,
      mode: 'isolated',
      conversationId: 'isolated-run-conversation',
      memoryRevision: 3,
      fileRefs: ['report-source.md'],
      skillIds: ['report-skill'],
      estimatedInputTokens: 1200,
      createdAt: run.startedAt - 50,
    }
    run.result = {
      outcome: 'no_change',
      summary: 'The report was already current.',
      successCriteria: [{ criterion: 'Report is complete.', status: 'met', evidence: 'report.md' }],
      artifactIds: ['artifact-report'],
      sideEffectSummary: ['No files changed.'],
      durationMs: 1234,
      inputTokens: 321,
      outputTokens: 45,
    }
    writeFileSync(sourcePath, `${JSON.stringify(store, null, 2)}\n`)

    migrateAutomationV2Store(repository, sourcePath)

    const migratedDefinition = repository.getDefinition(automation.id)!
    expect(migratedDefinition).toMatchObject({
      context: { mode: 'isolated' },
      objective: automation.objective,
      capabilities: automation.capabilityPolicy,
    })
    expect(migratedDefinition.context).not.toHaveProperty('continuationConversationId')
    const migratedRun = repository.listRuns({ definitionId: automation.id })[0]!
    expect(migratedRun).toMatchObject({
      definitionRevision: 1,
      mode: 'isolated',
      conversationId: 'isolated-run-conversation',
      result: run.result,
    })
    expect(repository.getPermissionSnapshot(migratedRun.permissionSnapshotId)).toMatchObject({
      definitionRevision: 1,
      approvalPolicy: 'agent',
      allowedTools: ['read_file'],
      deniedTools: ['shell'],
      maxRuntimeMinutes: 12,
      maxToolCalls: 7,
      riskSummary: ['Read-only report generation.'],
      createdAt: run.startedAt - 100,
    })
    expect(repository.getContextSnapshot(migratedRun.contextSnapshotId)).toMatchObject({
      definitionRevision: 1,
      mode: 'isolated',
      conversationId: 'isolated-run-conversation',
      memoryRevision: 3,
      fileRefs: ['report-source.md'],
      skillIds: ['report-skill'],
      estimatedInputTokens: 1200,
      createdAt: run.startedAt - 50,
    })
  })

  it('preserves persisted event trigger definitions during v2 migration', () => {
    const { sourcePath, repository } = createFixture()
    const store = JSON.parse(readFileSync(sourcePath, 'utf8'))
    store.automations[0].triggers = [{
      id: 'git-primary',
      kind: 'git',
      events: ['head', 'worktree'],
      pathFilters: ['src/**'],
      debounceMs: 750,
      filters: [{ field: 'ref', operator: 'prefix', value: 'refs/heads/' }],
    }]
    writeFileSync(sourcePath, `${JSON.stringify(store, null, 2)}\n`)

    migrateAutomationV2Store(repository, sourcePath)

    expect(repository.getDefinition('automation-v2-fixture')?.triggers).toEqual(store.automations[0].triggers)
  })

  it('leaves an invalid v2 source untouched and does not create migration evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-migration-'))
    directories.push(root)
    const sourcePath = join(root, 'automations.json')
    const original = '{"schemaVersion":2,"automations":"invalid"}\n'
    writeFileSync(sourcePath, original)
    const repository = new AutomationRepository(join(root, 'automations-v3'))
    repository.initialize()

    expect(() => migrateAutomationV2Store(repository, sourcePath)).toThrow('unsupported or invalid schema')
    expect(readFileSync(sourcePath, 'utf8')).toBe(original)
    expect(existsSync(join(root, 'automations.v2.backup.json'))).toBe(false)
    expect(existsSync(join(root, 'automations-v3', 'migrations', 'v2.json'))).toBe(false)
  })
})
