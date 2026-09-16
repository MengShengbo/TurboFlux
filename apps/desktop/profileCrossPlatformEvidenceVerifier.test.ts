import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyProfileCrossPlatformEvidence } from '../../scripts/verify-profile-cross-platform-evidence.mjs'

const roots: string[] = []
const profileSmokeSource = readFileSync(
  new URL('../../scripts/profile-archive-cross-platform-smoke.ts', import.meta.url),
  'utf8',
)

const workflowEnvironment = {
  GITHUB_ACTIONS: 'true',
  GITHUB_SHA: 'b'.repeat(40),
  GITHUB_REPOSITORY: 'TurboFlux/TurboFlux',
  GITHUB_WORKFLOW: 'CI',
  GITHUB_WORKFLOW_REF: 'TurboFlux/TurboFlux/.github/workflows/ci.yml@refs/heads/main',
  GITHUB_RUN_ID: '123456',
  GITHUB_RUN_ATTEMPT: '1',
}

function provenance(platform: 'darwin' | 'win32' | 'linux', arch: 'arm64' | 'x64') {
  return {
    gitCommit: workflowEnvironment.GITHUB_SHA,
    repository: workflowEnvironment.GITHUB_REPOSITORY,
    workflowName: workflowEnvironment.GITHUB_WORKFLOW,
    workflowRef: workflowEnvironment.GITHUB_WORKFLOW_REF,
    workflowRunId: workflowEnvironment.GITHUB_RUN_ID,
    workflowRunAttempt: 1,
    jobId: 'desktop-package',
    runnerOs: { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[platform],
    runnerArch: arch === 'arm64' ? 'ARM64' : 'X64',
  }
}

function evidence(platform: 'darwin' | 'win32' | 'linux', arch = platform === 'darwin' ? 'arm64' : 'x64') {
  return {
    schemaVersion: 2,
    platform,
    arch,
    provenance: provenance(platform, arch as 'arm64' | 'x64'),
    encryptedArchive: true,
    archiveSha256: 'a'.repeat(64),
    archiveBytes: 2_978,
    componentCount: 6,
    importedProfileCreated: true,
    originalProfilePreserved: true,
    workspaceInitiallyUnbound: true,
    executionBlockedBeforeRebind: true,
    workspaceRebound: true,
    historicalEventsPreserved: true,
    importedHistorySearchable: true,
    agentContinuedInReboundWorkspace: true,
    continuedConversationSearchable: true,
    automationRemainedDisabled: true,
    conversationTurnsVerified: 2,
    safeDraftMigrated: true,
    activeInteractionStateDiscarded: true,
  }
}

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-profile-evidence-'))
  roots.push(root)
  return root
}

function writeEvidence(root: string, platform: 'darwin' | 'win32' | 'linux', patch: Record<string, unknown> = {}) {
  const value = { ...evidence(platform), ...patch }
  writeFileSync(join(root, `result-${value.platform}-${value.arch}.json`), `${JSON.stringify(value)}\n`)
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('Profile cross-platform evidence verifier', () => {
  it('atomically writes schema v2 source evidence with workflow provenance', () => {
    expect(profileSmokeSource).toContain('schemaVersion: 2')
    expect(profileSmokeSource).toContain('provenance: captureGithubActionsProvenance()')
    expect(profileSmokeSource).toContain('await writeSourceEvidenceReportAtomically(')
    expect(profileSmokeSource).toContain('`result-${process.platform}-${process.arch}.json`')
    expect(profileSmokeSource).not.toContain('writeFileSync(join(outputRoot, `result-${process.platform}-${process.arch}.json`)')
  })

  it('accepts one complete native result from every required platform', async () => {
    const root = temporaryRoot()
    writeEvidence(root, 'darwin')
    writeEvidence(root, 'win32')
    writeEvidence(root, 'linux')

    await expect(verifyProfileCrossPlatformEvidence({
      evidenceRoot: root,
      expectedSourceJob: 'desktop-package',
      environment: workflowEnvironment,
    })).resolves.toMatchObject({
      status: 'passed',
      schemaVersion: 2,
      requiredPlatforms: ['darwin', 'win32', 'linux'],
      provenance: expect.objectContaining({ workflowRunId: '123456', jobId: 'desktop-package' }),
      errors: [],
    })
  })

  it('rejects Profile artifacts mixed across workflow runs or source jobs', async () => {
    const root = temporaryRoot()
    writeEvidence(root, 'darwin')
    writeEvidence(root, 'win32', {
      provenance: { ...provenance('win32', 'x64'), workflowRunId: '999999' },
    })
    writeEvidence(root, 'linux', {
      provenance: { ...provenance('linux', 'x64'), jobId: 'untrusted-job' },
    })

    const report = await verifyProfileCrossPlatformEvidence({
      evidenceRoot: root,
      expectedSourceJob: 'desktop-package',
      environment: workflowEnvironment,
    })
    expect(report.status).toBe('failed')
    expect(report.provenance).toBeNull()
    expect(report.errors).toEqual(expect.arrayContaining([
      'all evidence artifacts must share one workflowRunId',
      'all evidence artifacts must share one jobId',
      'all evidence artifacts must come from job desktop-package',
      expect.stringContaining('provenance.workflowRunId does not match the current workflow run'),
    ]))
  })

  it('fails when a platform is absent or the Agent continuation evidence is false', async () => {
    const root = temporaryRoot()
    writeEvidence(root, 'darwin')
    writeEvidence(root, 'win32', { agentContinuedInReboundWorkspace: false })

    const report = await verifyProfileCrossPlatformEvidence({ evidenceRoot: root })
    expect(report.status).toBe('failed')
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('agentContinuedInReboundWorkspace evidence is missing or false'),
      'linux: expected exactly one profile smoke result, found 0',
    ]))
  })

  it('rejects duplicate platform results and writes the aggregate report', async () => {
    const root = temporaryRoot()
    writeEvidence(root, 'darwin')
    const duplicate = join(root, 'duplicate')
    mkdirSync(duplicate)
    writeEvidence(duplicate, 'darwin', { arch: 'x64' })
    writeEvidence(root, 'win32')
    writeEvidence(root, 'linux')
    const reportPath = join(root, 'reports', 'profile-evidence-report.json')

    const report = await verifyProfileCrossPlatformEvidence({ evidenceRoot: root, reportPath })
    expect(report.errors).toContain('darwin: expected exactly one profile smoke result, found 2')
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual(report)
  })

  it('writes a failure report for a valid JSON non-object result', async () => {
    const root = temporaryRoot()
    const reportPath = join(root, 'reports', 'profile-evidence-report.json')
    writeFileSync(join(root, 'result-darwin-x64.json'), 'null\n')

    const report = await verifyProfileCrossPlatformEvidence({ evidenceRoot: root, requiredPlatforms: ['darwin'], reportPath })
    expect(report.status).toBe('failed')
    expect(report.errors).toContain('result-darwin-x64.json: result.json must be an object')
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual(report)
  })

  it('redacts malformed JSON while atomically replacing the previous report', async () => {
    const root = temporaryRoot()
    const reportDirectory = join(root, 'reports')
    const reportPath = join(reportDirectory, 'profile-evidence-report.json')
    const sensitive = '/Users/runner/private/result.json?token=secret'
    mkdirSync(reportDirectory)
    writeFileSync(join(root, 'result-darwin-x64.json'), sensitive)
    writeFileSync(reportPath, 'previous report must be replaced')

    const report = await verifyProfileCrossPlatformEvidence({ evidenceRoot: root, requiredPlatforms: ['darwin'], reportPath })
    expect(report.status).toBe('failed')
    expect(report.errors).toContain('result-darwin-x64.json: invalid profile smoke result (invalid-json)')
    expect(JSON.stringify(report)).not.toContain(sensitive)
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual(report)
    expect(readdirSync(reportDirectory)).toEqual(['profile-evidence-report.json'])
  })

  it('writes a fixed failure report when the evidence root is not a directory', async () => {
    const root = temporaryRoot()
    const sensitive = 'not-a-directory-token-secret'
    const evidenceRoot = join(root, sensitive)
    const reportPath = join(root, 'profile-evidence-report.json')
    writeFileSync(evidenceRoot, 'not an evidence directory')

    const report = await verifyProfileCrossPlatformEvidence({ evidenceRoot, requiredPlatforms: ['darwin'], reportPath })
    expect(report.status).toBe('failed')
    expect(report.errors).toEqual([
      'profile evidence discovery failed (invalid-path)',
      'darwin: expected exactly one profile smoke result, found 0',
    ])
    expect(JSON.stringify(report)).not.toContain(sensitive)
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual(report)
  })
})
