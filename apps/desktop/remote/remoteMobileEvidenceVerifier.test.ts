import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyRemoteMobileEvidence } from '../../../scripts/verify-remote-mobile-evidence.mjs'

const testRequire = createRequire(import.meta.url)
const { PNG } = testRequire('pngjs')
const roots: string[] = []
const digest = 'a'.repeat(64)

beforeEach(() => vi.stubEnv('GITHUB_ACTIONS', 'false'))
afterEach(() => vi.unstubAllEnvs())
const screenshotNames = [
  'remote-mobile-workspace-light.png',
  'remote-mobile-session-drawer-light.png',
  'remote-mobile-workspace-dark-reduced-motion.png',
]
const capabilities = [
  'session.read', 'session.create', 'session.submit', 'session.steer',
  'session.control', 'approval.resolve', 'artifact.list', 'artifact.read',
]

function provenance(platform: 'darwin' | 'win32') {
  return {
    gitCommit: 'b'.repeat(40), repository: 'TurboFlux/TurboFlux', workflowName: 'CI',
    workflowRef: 'TurboFlux/TurboFlux/.github/workflows/ci.yml@refs/heads/main', workflowRunId: '123456', workflowRunAttempt: 1,
    jobId: 'desktop-package', runnerOs: platform === 'darwin' ? 'macOS' : 'Windows', runnerArch: 'X64',
  }
}

function packageAggregate(overrides: { winPackageSha256?: string } = {}) {
  const source = provenance('darwin')
  return {
    schemaVersion: 2,
    status: 'passed',
    requiredPlatforms: ['darwin', 'win32', 'linux'],
    provenance: {
      gitCommit: source.gitCommit,
      repository: source.repository,
      workflowName: source.workflowName,
      workflowRef: source.workflowRef,
      workflowRunId: source.workflowRunId,
      workflowRunAttempt: source.workflowRunAttempt,
      jobId: source.jobId,
    },
    artifacts: [
      { platform: 'darwin', arch: 'x64', packageSha256: digest, asarSha256: digest, remoteMobileSha256: digest, status: 'passed', errors: [] },
      { platform: 'win32', arch: 'x64', packageSha256: overrides.winPackageSha256 ?? digest, asarSha256: digest, remoteMobileSha256: digest, status: 'passed', errors: [] },
      { platform: 'linux', arch: 'x64', packageSha256: digest, asarSha256: digest, remoteMobileSha256: digest, status: 'passed', errors: [] },
    ],
    errors: [],
  }
}

function result(platform: 'darwin' | 'win32') {
  return {
    schemaVersion: 3,
    mode: 'hidden-electron-remote-mobile',
    platform,
    arch: 'x64',
    provenance: provenance(platform),
    hostApplicationMode: 'development-electron',
    packageEvidence: { packageSha256: digest, asarSha256: digest, remoteMobileSha256: digest },
    windowNeverFocused: true,
    pairing: {
      approved: true,
      requestId: 'pairing-request-1',
      hostDeviceId: 'host-device-1',
      requestedDeviceId: 'mobile-device-1',
      pairedDeviceId: 'mobile-device-1',
      controlDeviceId: 'mobile-device-1',
      controlClientInstanceId: 'mobile-page-1',
      pairedDeviceCount: 1,
      controlSessionActive: true,
      workspaceId: 'workspace-1',
      requestedWorkspaceIds: ['workspace-1'],
      grantedWorkspaceIds: ['workspace-1'],
      workspaceRestricted: true,
      offeredCapabilities: capabilities,
      requestedCapabilities: capabilities,
      grantedCapabilities: capabilities,
    },
    workflow: {
      sessionId: 'remote-session-1',
      activeSessionId: 'remote-session-1',
      sessionIds: ['remote-session-1', 'remote-session-2'],
      messageIds: ['message-user-1', 'message-assistant-1'],
      approval: { id: 'approval-1', sessionId: 'remote-session-1', runId: 'run-1' },
      artifact: { id: 'artifact-1', sessionId: 'remote-session-1', runId: 'run-1' },
      resolution: { approvalId: 'approval-1', response: 'allow-once', channel: 'remote', deviceId: 'mobile-device-1' },
      remainingApprovalIds: [],
      artifactReadIds: ['artifact-1'],
    },
    workspace: {
      viewport: { width: 390, height: 844, devicePixelRatio: 1 },
      document: { width: 390, height: 844 },
      hasFocus: false,
      secureContext: true,
      approvalVisibility: { width: 356, height: 180, hitWithinTarget: true, ancestors: [{ display: 'block', visibility: 'visible', opacity: '1' }] },
      text: '端到端已连接 自动化日报 仅这次允许 拒绝 验收报告.pdf',
    },
    drawer: { viewport: { width: 390 }, documentWidth: 390, hasFocus: false, rect: { x: 0, width: 310 } },
    darkReducedMotion: {
      dark: true,
      reducedMotion: true,
      animationDuration: '0s',
      transitionDuration: '0s',
      documentWidth: 390,
      viewportWidth: 390,
      hasFocus: false,
    },
    interaction: {
      artifactClicked: true,
      artifactDownloadPrevented: true,
      artifactDownloadName: '验收报告.pdf',
      artifactDownloadMime: 'application/pdf',
      approvalClicked: true,
      approvalCardsAfterResolution: 0,
    },
    rendererErrors: [],
    screenshots: [...screenshotNames],
  }
}

function writeArtifact(root: string, platform: 'darwin' | 'win32') {
  const directory = join(root, `${platform}-x64`)
  mkdirSync(directory, { recursive: true })
  for (const name of screenshotNames) {
    const image = new PNG({ width: 390, height: 844 })
    for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
      const offset = pixel * 4
      image.data[offset] = (pixel * 3) % 256
      image.data[offset + 1] = (pixel * 7) % 256
      image.data[offset + 2] = (pixel * 11) % 256
      image.data[offset + 3] = 255
    }
    writeFileSync(join(directory, name), PNG.sync.write(image))
  }
  writeFileSync(join(directory, 'result.json'), JSON.stringify(result(platform)))
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('Remote Mobile evidence verifier', () => {
  it('accepts complete macOS and Windows hidden artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-remote-mobile-evidence-'))
    roots.push(root)
    writeArtifact(root, 'darwin')
    writeArtifact(root, 'win32')
    await expect(verifyRemoteMobileEvidence({
      evidenceRoot: root,
      requirePackageCorrelation: true,
      packageEvidenceRoot: join(root, 'package-evidence'),
      packageEvidenceVerifier: async () => packageAggregate(),
    })).resolves.toMatchObject({ status: 'passed', errors: [], packageCorrelation: { status: 'passed' } })
  })

  it('rejects artifacts mixed across workflow runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-remote-mobile-evidence-'))
    roots.push(root)
    writeArtifact(root, 'darwin')
    writeArtifact(root, 'win32')
    writeFileSync(join(root, 'win32-x64', 'result.json'), JSON.stringify({
      ...result('win32'),
      provenance: { ...provenance('win32'), workflowRunId: '999999' },
    }))
    const report = await verifyRemoteMobileEvidence({ evidenceRoot: root })
    expect(report.status).toBe('failed')
    expect(report.errors).toContain('all evidence artifacts must share one workflowRunId')
  })

  it('requires independent package reports for formal Remote correlation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-remote-mobile-evidence-'))
    roots.push(root)
    writeArtifact(root, 'darwin')
    writeArtifact(root, 'win32')
    const report = await verifyRemoteMobileEvidence({ evidenceRoot: root, requirePackageCorrelation: true })
    expect(report.status).toBe('failed')
    expect(report.packageCorrelation).toBeNull()
    expect(report.errors).toContain('package evidence root is required when Remote package correlation is required')
  })

  it('rejects missing or mismatched same-run package identities', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-remote-mobile-evidence-'))
    roots.push(root)
    writeArtifact(root, 'darwin')
    writeArtifact(root, 'win32')
    const darwin = result('darwin')
    writeFileSync(join(root, 'darwin-x64', 'result.json'), JSON.stringify({ ...darwin, packageEvidence: null }))
    const report = await verifyRemoteMobileEvidence({
      evidenceRoot: root,
      requirePackageCorrelation: true,
      packageEvidenceRoot: join(root, 'package-evidence'),
      packageEvidenceVerifier: async () => packageAggregate({ winPackageSha256: 'c'.repeat(64) }),
    })
    expect(report.status).toBe('failed')
    expect(report.packageCorrelation).toMatchObject({ status: 'failed' })
    expect(report.errors).toEqual(expect.arrayContaining([
      'darwin-x64/result.json: correlated package evidence is required',
      'darwin-x64/result.json: package SHA-256 does not match package report',
      'win32-x64/result.json: package SHA-256 does not match package report',
    ]))
  })

  it('rejects a Remote Mobile build hash that differs from the package report', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-remote-mobile-evidence-'))
    roots.push(root)
    writeArtifact(root, 'darwin')
    writeArtifact(root, 'win32')
    const windows = result('win32')
    writeFileSync(join(root, 'win32-x64', 'result.json'), JSON.stringify({
      ...windows,
      packageEvidence: { ...windows.packageEvidence, remoteMobileSha256: 'c'.repeat(64) },
    }))
    const report = await verifyRemoteMobileEvidence({
      evidenceRoot: root,
      requirePackageCorrelation: true,
      packageEvidenceRoot: join(root, 'package-evidence'),
      packageEvidenceVerifier: async () => packageAggregate(),
    })
    expect(report.status).toBe('failed')
    expect(report.errors).toContain('win32-x64/result.json: Remote Mobile SHA-256 does not match package report')
  })

  it('writes a failure report when the evidence root and report directory do not exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-remote-mobile-evidence-'))
    roots.push(root)
    const reportPath = join(root, 'reports', 'nested', 'remote-mobile-evidence-report.json')
    const report = await verifyRemoteMobileEvidence({
      evidenceRoot: join(root, 'missing-evidence'),
      reportPath,
    })

    expect(report.status).toBe('failed')
    expect(report.errors).toEqual(expect.arrayContaining([
      'darwin: expected exactly one result.json, found 0',
      'win32: expected exactly one result.json, found 0',
    ]))
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual(report)
  })

  it('fails focused, overflowing, or visually blank evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-remote-mobile-evidence-'))
    roots.push(root)
    writeArtifact(root, 'darwin')
    writeArtifact(root, 'win32')
    const path = join(root, 'darwin-x64', 'result.json')
    writeFileSync(path, JSON.stringify({ ...result('darwin'), windowNeverFocused: false, workspace: { ...result('darwin').workspace, document: { width: 391, height: 844 } } }))
    const blank = new PNG({ width: 390, height: 844 })
    blank.data.fill(24)
    for (let offset = 3; offset < blank.data.length; offset += 4) blank.data[offset] = 255
    writeFileSync(join(root, 'win32-x64', screenshotNames[0]!), PNG.sync.write(blank))
    const report = await verifyRemoteMobileEvidence({ evidenceRoot: root })
    expect(report.status).toBe('failed')
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('hidden window received focus'),
      expect.stringContaining('workspace overflows horizontally'),
      expect.stringContaining('screenshot is nearly uniform'),
    ]))
  })

  it('rejects local screenshot paths and unexpected artifact contents', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-remote-mobile-evidence-'))
    roots.push(root)
    writeArtifact(root, 'darwin')
    writeArtifact(root, 'win32')
    const sensitive = '/Users/runner/private?token=secret'
    writeFileSync(join(root, 'darwin-x64', 'result.json'), JSON.stringify({
      ...result('darwin'),
      screenshots: screenshotNames.map(name => `${sensitive}/${name}`),
      [sensitive]: 'must-not-pass',
    }))
    writeFileSync(join(root, 'darwin-x64', 'paired-device-secret.json'), '{}')
    writeFileSync(join(root, 'old-report.json'), '{}')
    const report = await verifyRemoteMobileEvidence({ evidenceRoot: root })
    expect(report.status).toBe('failed')
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('screenshot reference must be an artifact filename'),
      expect.stringContaining('result.json contains unexpected fields'),
      'darwin-x64: unexpected evidence entry',
      'unexpected evidence root entry',
    ]))
    expect(JSON.stringify(report)).not.toContain(sensitive)
  })

  it('rejects unexpected nested layout fields and unknown capabilities', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-remote-mobile-evidence-'))
    roots.push(root)
    writeArtifact(root, 'darwin')
    writeArtifact(root, 'win32')
    const candidate = result('darwin')
    writeFileSync(join(root, 'darwin-x64', 'result.json'), JSON.stringify({
      ...candidate,
      pairing: { ...candidate.pairing, grantedCapabilities: [...capabilities, 'secret.read'] },
      workspace: {
        ...candidate.workspace,
        viewport: { ...candidate.workspace.viewport, localPath: '/private/workspace' },
        approvalVisibility: { ...candidate.workspace.approvalVisibility, debugToken: 'must-not-pass' },
      },
      drawer: { ...candidate.drawer, rect: { ...candidate.drawer.rect, secret: 'must-not-pass' } },
    }))
    const report = await verifyRemoteMobileEvidence({ evidenceRoot: root })
    expect(report.status).toBe('failed')
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('workspace viewport contains unexpected fields'),
      expect.stringContaining('approval visibility evidence contains unexpected fields'),
      expect.stringContaining('drawer rect contains unexpected fields'),
      expect.stringContaining('granted pairing capabilities must match the exact Remote Mobile product grant'),
    ]))
  })

  it('rejects mismatched pairing, control-page, and grant identities', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-remote-mobile-evidence-'))
    roots.push(root)
    writeArtifact(root, 'darwin')
    writeArtifact(root, 'win32')
    const candidate = result('darwin')
    writeFileSync(join(root, 'darwin-x64', 'result.json'), JSON.stringify({
      ...candidate,
      pairing: {
        ...candidate.pairing,
        controlDeviceId: 'different-mobile-device',
        requestedCapabilities: candidate.pairing.requestedCapabilities.slice(0, -1),
      },
      workflow: {
        ...candidate.workflow,
        resolution: { ...candidate.workflow.resolution, deviceId: 'different-approval-device' },
      },
    }))
    const report = await verifyRemoteMobileEvidence({ evidenceRoot: root })
    expect(report.status).toBe('failed')
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('pairing, paired-device, and control-session identities do not match'),
      expect.stringContaining('requested pairing capabilities must match the exact Remote Mobile product grant'),
      expect.stringContaining('approval was not resolved by the authenticated remote control device'),
    ]))
  })

  it('rejects approval, Run, artifact, and interaction evidence from different workflows', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-remote-mobile-evidence-'))
    roots.push(root)
    writeArtifact(root, 'darwin')
    writeArtifact(root, 'win32')
    const candidate = result('darwin')
    writeFileSync(join(root, 'darwin-x64', 'result.json'), JSON.stringify({
      ...candidate,
      workflow: {
        ...candidate.workflow,
        artifact: { ...candidate.workflow.artifact, sessionId: 'remote-session-2', runId: 'run-2' },
        resolution: { ...candidate.workflow.resolution, approvalId: 'approval-2' },
        remainingApprovalIds: ['approval-1'],
        artifactReadIds: ['artifact-2'],
      },
      interaction: { ...candidate.interaction, approvalCardsAfterResolution: 1, artifactClicked: false },
    }))
    const report = await verifyRemoteMobileEvidence({ evidenceRoot: root })
    expect(report.status).toBe('failed')
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('approval and artifact do not belong to the active session snapshot'),
      expect.stringContaining('approval and artifact do not belong to the same automation Run'),
      expect.stringContaining('Remote Mobile approval resolution evidence is invalid'),
      expect.stringContaining('resolved approval remains in the remote snapshot'),
      expect.stringContaining('artifact was not read through the same Remote Mobile workflow'),
      expect.stringContaining('real Remote Mobile artifact interaction evidence is missing'),
      expect.stringContaining('real Remote Mobile approval interaction evidence is missing'),
    ]))
  })

  it('writes a failure report for a valid JSON non-object result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-remote-mobile-evidence-'))
    roots.push(root)
    const directory = join(root, 'darwin-x64')
    const reportPath = join(root, 'remote-mobile-evidence-report.json')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'result.json'), '"invalid-shape"\n')

    const report = await verifyRemoteMobileEvidence({ evidenceRoot: root, requiredPlatforms: ['darwin'], reportPath })
    expect(report.status).toBe('failed')
    expect(report.errors).toContain('darwin-x64/result.json: result.json must be an object')
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual(report)
  })
})
