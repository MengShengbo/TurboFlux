import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyProfileStableBenchmarkEvidence } from '../../scripts/verify-profile-stable-benchmark-evidence.mjs'

const roots: string[] = []
const workflowEnvironment = {
  GITHUB_ACTIONS: 'true',
  GITHUB_SHA: 'b'.repeat(40),
  GITHUB_REPOSITORY: 'TurboFlux/TurboFlux',
  GITHUB_WORKFLOW: 'CI',
  GITHUB_WORKFLOW_REF: 'TurboFlux/TurboFlux/.github/workflows/ci.yml@refs/heads/main',
  GITHUB_RUN_ID: '123456',
  GITHUB_RUN_ATTEMPT: '1',
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-profile-stable-evidence-'))
  roots.push(root)
  return root
}

function provenance(runId = '123456') {
  return {
    gitCommit: workflowEnvironment.GITHUB_SHA,
    repository: workflowEnvironment.GITHUB_REPOSITORY,
    workflowName: workflowEnvironment.GITHUB_WORKFLOW,
    workflowRef: workflowEnvironment.GITHUB_WORKFLOW_REF,
    workflowRunId: runId,
    workflowRunAttempt: 1,
    jobId: 'desktop-package',
    runnerOs: 'Linux',
    runnerArch: 'X64',
  }
}

function writeReports(root: string, conversationRunId = '123456'): void {
  const common = { schemaVersion: 2, qualification: 'stable', passed: true }
  writeFileSync(join(root, 'profile-archive-stable-linux-x64.json'), JSON.stringify({
    ...common,
    provenance: provenance(),
    completedAt: new Date(0).toISOString(),
    command: 'npm run perf:profiles:stable',
    host: { platform: 'linux', arch: 'x64' },
    dataset: { blobMiB: 1024, entries: 10_001 },
    kdfMs: 1,
    roundTripMs: 2,
    peakRssDeltaMiB: 3,
    archiveMiB: 4,
    expandedMiB: 5,
    verifiedEntries: 10_001,
    budgets: {},
    failures: [],
  }))
  writeFileSync(join(root, 'conversation-v2-stable-linux-x64.json'), JSON.stringify({
    ...common,
    provenance: provenance(conversationRunId),
    generatedAt: new Date(0).toISOString(),
    command: 'npm run perf:conversations-v2:stable',
    environment: { platform: 'linux', arch: 'x64' },
    replay: { passed: true, eventCount: 100_000 },
    runtimeRestore: { passed: true, turnCount: 8_000, elapsedMs: 100, budgetMs: 2_000 },
    catalog: { passed: true, conversationCount: 10_000, profileEventCount: 1_000_000 },
    firstPage: { passed: true, itemCount: 10_000, bytesRead: 64, journalBytes: 128 },
  }))
  writeFileSync(join(root, 'profile-switch-stable-linux-x64.json'), JSON.stringify({
    ...common,
    provenance: provenance(),
    completedAt: new Date(0).toISOString(),
    command: 'npm run perf:profile-switch:stable',
    host: { platform: 'linux', arch: 'x64' },
    samples: Array.from({ length: 20 }, () => 10),
    p50Ms: 10,
    p95Ms: 10,
    maxMs: 10,
    budgetMs: 2_000,
  }))
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('Profile Stable benchmark evidence verifier', () => {
  it('rejects runtime restoration that exceeds the budget even when marked passed', async () => {
    const root = temporaryRoot()
    writeReports(root)
    const path = join(root, 'conversation-v2-stable-linux-x64.json')
    const report = JSON.parse(readFileSync(path, 'utf8'))
    report.runtimeRestore.elapsedMs = 2_001
    writeFileSync(path, JSON.stringify(report))
    const result = await verifyProfileStableBenchmarkEvidence({ evidenceRoot: root, environment: workflowEnvironment })
    expect(result.status).toBe('failed')
    expect(result.errors).toContain('conversation-v2 runtime restoration evidence is incomplete or exceeds its budget')
  })

  it('accepts all three same-run Linux Stable reports', async () => {
    const root = temporaryRoot()
    writeReports(root)
    await expect(verifyProfileStableBenchmarkEvidence({
      evidenceRoot: root,
      expectedSourceJob: 'desktop-package',
      environment: workflowEnvironment,
    })).resolves.toMatchObject({
      status: 'passed',
      platform: 'linux',
      arch: 'x64',
      artifacts: [{ kind: 'profile-archive' }, { kind: 'conversation-v2' }, { kind: 'profile-switch' }],
      errors: [],
    })
  })

  it('rejects a missing report, stale JSON, and mixed workflow runs', async () => {
    const root = temporaryRoot()
    writeReports(root, '999999')
    rmSync(join(root, 'profile-switch-stable-linux-x64.json'))
    writeFileSync(join(root, 'stale.json'), '{}')
    const report = await verifyProfileStableBenchmarkEvidence({ evidenceRoot: root })
    expect(report.status).toBe('failed')
    expect(report.errors).toEqual(expect.arrayContaining([
      'unexpected Stable benchmark evidence entry',
      'profile-switch report cannot be read (not-found)',
    ]))
  })

  it('rejects reports mixed across workflow runs', async () => {
    const root = temporaryRoot()
    writeReports(root, '999999')
    const report = await verifyProfileStableBenchmarkEvidence({
      evidenceRoot: root,
      expectedSourceJob: 'desktop-package',
      environment: workflowEnvironment,
    })
    expect(report.status).toBe('failed')
    expect(report.provenance).toBeNull()
    expect(report.errors).toEqual(expect.arrayContaining([
      'all evidence artifacts must share one workflowRunId',
      expect.stringContaining('provenance.workflowRunId does not match the current workflow run'),
    ]))
  })

  it('atomically replaces a failure report without retaining sensitive input', async () => {
    const root = temporaryRoot()
    const reportPath = join(root, 'stable-benchmark-evidence-report.json')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'conversation-v2-stable-linux-x64.json'), '/Users/runner/private?token=secret')
    writeFileSync(reportPath, 'old report')
    const report = await verifyProfileStableBenchmarkEvidence({ evidenceRoot: root, reportPath })
    expect(report.status).toBe('failed')
    expect(JSON.stringify(report)).not.toContain('/Users/runner')
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual(report)
  })

  it('keeps the verifier in the Linux package workflow and Stable artifact', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
    const packageFile = readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    expect(workflow).toContain('npm run verify:profiles:stable-benchmarks')
    expect(workflow).toContain('path: apps/desktop/generated/profile-benchmarks/*.json')
    expect(packageFile).toContain('verify-profile-stable-benchmark-evidence.mjs')
  })
})
