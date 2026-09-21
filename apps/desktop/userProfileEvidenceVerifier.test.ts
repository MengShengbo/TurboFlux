import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyUserProfileEvidence } from '../../scripts/verify-user-profile-evidence.mjs'

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
function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-profile-hidden-evidence-'))
  roots.push(root)
  return root
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

function pngFixture() {
  const image = new PNG({ width: 720, height: 450 })
  for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
    const offset = pixel * 4
    image.data[offset] = (pixel * 17) % 256
    image.data[offset + 1] = (pixel * 29) % 256
    image.data[offset + 2] = (pixel * 43) % 256
    image.data[offset + 3] = 255
  }
  return PNG.sync.write(image)
}

const screenshotFixture = pngFixture()

function packageReport(patch: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    status: 'passed',
    provenance: {
      gitCommit: workflowEnvironment.GITHUB_SHA,
      repository: workflowEnvironment.GITHUB_REPOSITORY,
      workflowName: workflowEnvironment.GITHUB_WORKFLOW,
      workflowRef: workflowEnvironment.GITHUB_WORKFLOW_REF,
      workflowRunId: workflowEnvironment.GITHUB_RUN_ID,
      workflowRunAttempt: 1,
      jobId: 'desktop-package',
    },
    artifacts: (['darwin', 'win32', 'linux'] as const).map(platform => ({
      platform,
      arch: platform === 'darwin' ? 'arm64' : 'x64',
      packageSha256: 'c'.repeat(64),
      asarSha256: 'd'.repeat(64),
      status: 'passed',
      errors: [],
    })),
    errors: [],
    ...patch,
  }
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

const screenshotFields = { light: 'user-profile-light.png', dark: 'user-profile-dark.png', narrow: 'user-profile-narrow.png', zoom200: 'user-profile-zoom200.png' }

function result(platform: 'darwin' | 'win32' | 'linux') {
  const arch = platform === 'darwin' ? 'arm64' : 'x64'
  const page = (theme: string, width: number, height: number, screenshot: string) => ({
    visible: true, modal: true, backgroundInert: true, expanded: true, theme,
    viewport: { width, height }, rect: { x: 24, y: 24, width: 520, height: height - 48 },
    noHorizontalOverflow: true, activityDays: 365, activityHalves: 2, name: 'Desktop QA', title: '用户资料', screenshot,
  })
  return {
    schemaVersion: 3, platform, arch, provenance: provenance(platform, arch), applicationMode: 'packaged-app',
    packageEvidence: { packageSha256: 'c'.repeat(64), asarSha256: 'd'.repeat(64) }, mode: 'hidden-electron',
    light: page('light', 1440, 900, screenshotFields.light), dark: page('dark', 1440, 900, screenshotFields.dark),
    narrow: page('light', 760, 720, screenshotFields.narrow), zoom200: page('light', 720, 450, screenshotFields.zoom200),
    identity: { saved: true, persisted: true, reopened: true, sidebarUpdated: true }, focusRestored: true, keyboardNavigation: true,
    terminal: { shell: platform === 'win32' ? 'powershell' : 'bash', outputVerified: true, resized: true, exitCode: 0, closed: true }, rendererErrors: [],
  }
}
function writeArtifacts(root: string, patch: Record<string, unknown> = {}) {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const artifact = { ...result(platform), ...patch }
    const directory = join(root, `${platform}-${artifact.arch}`)
    mkdirSync(directory)
    writeFileSync(join(directory, 'result.json'), JSON.stringify(artifact))
    for (const filename of Object.values(screenshotFields)) writeFileSync(join(directory, filename), screenshotFixture)
  }
}
function verify(root: string, packageEvidence = packageReport()) {
  return verifyUserProfileEvidence({
    evidenceRoot: root, requiredPlatforms: ['darwin', 'win32', 'linux'], expectedSourceJob: 'desktop-package',
    requiredApplicationMode: 'packaged-app', packageEvidenceRoot: join(root, 'package-evidence'),
    packageEvidenceVerifier: async () => packageEvidence, environment: workflowEnvironment,
  })
}
describe('current personal profile evidence', () => {
  it('accepts complete packaged evidence for all three platforms', async () => {
    const root = temporaryRoot(); writeArtifacts(root)
    await expect(verify(root)).resolves.toMatchObject({ status: 'passed', errors: [], packageCorrelation: { status: 'passed' } })
  })
  it.each([
    { identity: { saved: true, persisted: false, reopened: true, sidebarUpdated: true } },
    { keyboardNavigation: false },
    { terminal: { shell: 'bash', outputVerified: false, resized: true, exitCode: 0, closed: true } },
    { rendererErrors: ['unexpected'] },
    { schemaVersion: 2 },
  ])('rejects incomplete behavior evidence %j', async patch => {
    const root = temporaryRoot(); writeArtifacts(root, patch)
    expect((await verify(root)).status).toBe('failed')
  })
  it('rejects screenshots that are missing or outside the artifact', async () => {
    const root = temporaryRoot(); writeArtifacts(root)
    rmSync(join(root, 'darwin-arm64', screenshotFields.light))
    expect((await verify(root)).status).toBe('failed')
  })
  it('rejects evidence produced by a different package', async () => {
    const root = temporaryRoot(); writeArtifacts(root)
    const other = packageReport(); other.artifacts[1]!.packageSha256 = 'e'.repeat(64)
    expect((await verify(root, other)).status).toBe('failed')
  })
})
