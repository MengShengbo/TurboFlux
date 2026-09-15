import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyProfileHiddenEvidence } from '../../scripts/verify-profile-hidden-evidence.mjs'

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
const screenshotFields = {
  lightSwitcher: 'profile-switcher-light.png',
  light: 'profile-center-light-1440-overview.png',
  wallpaperMaterial: 'profile-center-light-background-material.png',
  create1440: 'profile-create-light-1440.png',
  light1024: 'profile-center-light-1024-overview.png',
  create1024: 'profile-create-light-1024.png',
  workspaces1024: 'profile-center-light-1024-workspaces.png',
  transfer1024: 'profile-center-light-1024-transfer.png',
  narrowList: 'profile-center-light-760-list.png',
  create760: 'profile-create-light-760.png',
  narrowDetail: 'profile-center-light-760-detail.png',
  zoom200: 'profile-center-light-200-percent-effective.png',
  createZoom200: 'profile-create-light-200-percent-effective.png',
  darkSwitcher: 'profile-switcher-dark.png',
  dark: 'profile-center-dark-1440-overview.png',
  createDark: 'profile-create-dark-1440.png',
  exportDialog: 'profile-export-dark-reduced-motion.png',
  importDialog: 'profile-import-dark-reduced-motion.png',
  exportCompletion: 'profile-export-completed.png',
  rebindBefore: 'profile-import-completed-unbound.png',
  readonlyBeforeRebind: 'profile-import-history-readonly.png',
  rebindAfter: 'profile-import-workspace-rebound.png',
  readonlyAfterRebind: 'profile-import-history-after-rebind.png',
  finalProfiles: 'profile-center-after-roundtrip.png',
  eightUsers: 'profile-center-dark-eight-users-search.png',
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

function page(theme: 'light' | 'dark', width: number, screenshot: string) {
  return {
    theme,
    expectedTheme: theme,
    viewport: { width, height: 900 },
    document: { scrollWidth: width, scrollHeight: 900 },
    tabs: 3,
    metrics: 0,
    headerBacks: 1,
    closeActions: 1,
    settingsVisible: true,
    settingsOpacity: '1',
    settingsVisibility: 'visible',
    screenshot,
  }
}

function createSheet(screenshot: string) {
  return {
    visible: true,
    modal: 'true',
    backgroundInert: true,
    colorChoices: 8,
    templateChoices: 2,
    footerActions: 2,
    overflow: [],
    focusRestored: true,
    screenshot,
  }
}

function result(platform: 'darwin' | 'win32' | 'linux' = 'darwin', arch: 'arm64' | 'x64' = platform === 'darwin' ? 'arm64' : 'x64') {
  const switcher = (screenshot: string) => ({
    visible: true,
    currentUsers: 1,
    actions: 3,
    expanded: 'true',
    manageLabel: '管理用户资料…',
    screenshot,
  })
  const dialog = (stepCount: number, screenshot: string) => ({ open: true, stepCount, theme: 'dark', overflow: [], screenshot })
  const readonly = (screenshot: string) => ({
    heading: '界面迁移验证会话',
    hasBackButton: true,
    turns: ['第一条界面迁移历史', '第二条界面迁移历史'],
    screenshot,
  })
  return {
    schemaVersion: 2,
    platform,
    arch,
    provenance: provenance(platform, arch),
    applicationMode: 'packaged-app',
    packageEvidence: { packageSha256: 'c'.repeat(64), asarSha256: 'd'.repeat(64) },
    mode: 'hidden-electron',
    lightSwitcher: switcher(screenshotFields.lightSwitcher),
    light: page('light', 1440, screenshotFields.light),
    wallpaperMaterial: { screenshot: screenshotFields.wallpaperMaterial },
    create1440: createSheet(screenshotFields.create1440),
    light1024: page('light', 1024, screenshotFields.light1024),
    create1024: createSheet(screenshotFields.create1024),
    workspaces1024: page('light', 1024, screenshotFields.workspaces1024),
    transfer1024: page('light', 1024, screenshotFields.transfer1024),
    narrowList: { viewport: { width: 760 }, mobileView: 'list', listVisible: true, contentVisible: false, screenshot: screenshotFields.narrowList },
    create760: createSheet(screenshotFields.create760),
    narrowDetail: { viewport: { width: 760 }, mobileView: 'detail', listVisible: false, contentVisible: true, mobileBackVisible: true, screenshot: screenshotFields.narrowDetail },
    zoom200: { viewport: { width: 720, height: 450 }, document: { scrollWidth: 720 }, screenshot: screenshotFields.zoom200 },
    createZoom200: createSheet(screenshotFields.createZoom200),
    darkSwitcher: switcher(screenshotFields.darkSwitcher),
    dark: page('dark', 1440, screenshotFields.dark),
    createDark: createSheet(screenshotFields.createDark),
    reducedMotion: { matches: true, animationDuration: '0s', transitionDuration: '0s' },
    exportDialog: dialog(5, screenshotFields.exportDialog),
    exportFocusTrap: { lastFocused: true, wrapped: true, focusRestored: true },
    importDialog: dialog(6, screenshotFields.importDialog),
    importFocusTrap: { lastFocused: true, wrapped: true, focusRestored: true },
    exportCompletion: { heading: '资料包已导出', target: 'hidden-ui-roundtrip.turboflux-profile', hash: 'a'.repeat(64), screenshot: screenshotFields.exportCompletion },
    rebindBefore: { workspaceCount: 1, unboundWorkspaces: 1, boundWorkspaces: 0, conversationCount: 1, screenshot: screenshotFields.rebindBefore },
    readonlyBeforeRebind: readonly(screenshotFields.readonlyBeforeRebind),
    rebindAfter: { workspaceCount: 1, unboundWorkspaces: 0, boundWorkspaces: 1, screenshot: screenshotFields.rebindAfter },
    readonlyAfterRebind: readonly(screenshotFields.readonlyAfterRebind),
    finalProfiles: { profiles: 2, activeProfiles: 1, rebindActions: 0, screenshot: screenshotFields.finalProfiles },
    eightUsers: { profiles: 8, searchFields: 1, screenshot: screenshotFields.eightUsers },
    rendererErrors: [],
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

function writeArtifact(root: string, platform: 'darwin' | 'win32' | 'linux' = 'darwin', patch: Record<string, unknown> = {}) {
  const arch = platform === 'darwin' ? 'arm64' : 'x64'
  const directory = join(root, `${platform}-${arch}`)
  mkdirSync(directory)
  writeFileSync(join(directory, 'result.json'), `${JSON.stringify({ ...result(platform, arch), ...patch })}\n`)
  for (const filename of Object.values(screenshotFields)) writeFileSync(join(directory, filename), screenshotFixture)
  return directory
}

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

describe('Profile hidden evidence verifier', () => {
  it('accepts a complete hidden Profile artifact with provenance', async () => {
    const root = temporaryRoot()
    writeArtifact(root, 'darwin')
    writeArtifact(root, 'win32')
    writeArtifact(root, 'linux')

    await expect(verifyProfileHiddenEvidence({
      evidenceRoot: root,
      requiredPlatforms: ['darwin', 'win32', 'linux'],
      expectedSourceJob: 'desktop-package',
      requiredApplicationMode: 'packaged-app',
      packageEvidenceRoot: join(root, 'package-evidence'),
      packageEvidenceVerifier: async () => packageReport(),
      environment: workflowEnvironment,
    })).resolves.toMatchObject({
      status: 'passed',
      packageCorrelation: { status: 'passed' },
      provenance: expect.objectContaining({ workflowRunId: '123456', jobId: 'desktop-package' }),
      artifacts: expect.arrayContaining([
        expect.objectContaining({ platform: 'darwin', arch: 'arm64', status: 'passed', errors: [], path: 'darwin-arm64/result.json', screenshotMetrics: expect.any(Object) }),
        expect.objectContaining({ platform: 'win32', arch: 'x64', status: 'passed', errors: [], path: 'win32-x64/result.json', screenshotMetrics: expect.any(Object) }),
        expect.objectContaining({ platform: 'linux', arch: 'x64', status: 'passed', errors: [], path: 'linux-x64/result.json', screenshotMetrics: expect.any(Object) }),
      ]),
      errors: [],
    })
  })

  it('rejects a Profile artifact whose package hash does not match', async () => {
    const root = temporaryRoot()
    writeArtifact(root, 'darwin')
    writeArtifact(root, 'win32')
    writeArtifact(root, 'linux')
    const mismatched = packageReport()
    mismatched.artifacts[1]!.packageSha256 = 'e'.repeat(64)

    const report = await verifyProfileHiddenEvidence({
      evidenceRoot: root,
      requiredPlatforms: ['darwin', 'win32', 'linux'],
      requiredApplicationMode: 'packaged-app',
      packageEvidenceRoot: join(root, 'package-evidence'),
      packageEvidenceVerifier: async () => mismatched,
    })
    expect(report.status).toBe('failed')
    expect(report.errors).toContain('win32-x64/result.json: package SHA-256 does not match package report')
  })

  it('rejects unknown result fields and missing screenshots', async () => {
    const root = temporaryRoot()
    const directory = writeArtifact(root, 'darwin', {
      unexpected: 'must-not-pass',
      eightUsers: { profiles: 8, searchFields: 1, screenshot: [] },
    })
    rmSync(join(directory, screenshotFields.eightUsers))

    const report = await verifyProfileHiddenEvidence({ evidenceRoot: root, requiredPlatforms: ['darwin'] })
    expect(report.status).toBe('failed')
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('result.json contains unexpected fields'),
      expect.stringContaining('eightUsers screenshot reference is invalid'),
      expect.stringContaining(`screenshot file is missing: ${screenshotFields.eightUsers}`),
      expect.stringContaining(`missing evidence entry: ${screenshotFields.eightUsers}`),
    ]))
  })

  it('writes a fixed failure report for a valid JSON non-object result', async () => {
    const root = temporaryRoot()
    const directory = join(root, 'darwin-arm64')
    const reportPath = join(root, 'profile-hidden-evidence-report.json')
    mkdirSync(directory)
    writeFileSync(join(directory, 'result.json'), 'null\n')

    const report = await verifyProfileHiddenEvidence({ evidenceRoot: root, requiredPlatforms: ['darwin'], reportPath })
    expect(report.status).toBe('failed')
    expect(report.errors).toContain('darwin-arm64/result.json: result.json must be an object')
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual(report)
  })
})
