import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverEvidenceResultFiles, isEvidenceRecord, normalizeEvidenceIdentity, portableRelative, rejectUnexpectedKeys, sanitizePackageEvidence, verifyEvidenceArtifactLayout } from './evidence-artifact-layout.mjs'
import { formatEvidenceFailure, writeEvidenceReportAtomically } from './evidence-report-output.mjs'
import { verifyCrossPlatformGithubProvenance } from './github-actions-provenance.mjs'
import { correlatePackagedApplicationEvidence } from './packaged-application-evidence-correlation.mjs'
import { verifyDesktopPackageEvidence } from './verify-desktop-package-evidence.mjs'

const verifierRequire = createRequire(import.meta.url)
const { PNG } = verifierRequire('pngjs')
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultEvidenceRoot = join(repositoryRoot, 'apps', 'desktop', 'generated', 'profile-qa')

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
const requiredScreenshots = Object.values(screenshotFields)
const topLevelFields = [
  'schemaVersion', 'platform', 'arch', 'provenance', 'mode',
  'applicationMode', 'packageEvidence',
  ...Object.keys(screenshotFields),
  'reducedMotion', 'exportFocusTrap', 'importFocusTrap', 'rendererErrors', 'terminal',
]

function check(condition, errors, message) {
  if (!condition) errors.push(message)
}

function inspectPixels(contents) {
  const image = PNG.sync.read(contents)
  const colors = new Map()
  const pixelCount = image.width * image.height
  const stride = Math.max(1, Math.floor(pixelCount / 100_000))
  let sampledPixels = 0
  for (let pixel = 0; pixel < pixelCount; pixel += stride) {
    const offset = pixel * 4
    if (image.data[offset + 3] < 16) continue
    const key = `${image.data[offset] >> 4}:${image.data[offset + 1] >> 4}:${image.data[offset + 2] >> 4}`
    colors.set(key, (colors.get(key) ?? 0) + 1)
    sampledPixels += 1
  }
  return {
    width: image.width,
    height: image.height,
    uniqueColors: colors.size,
    dominantColorShare: sampledPixels > 0 ? Math.max(0, ...colors.values()) / sampledPixels : 1,
  }
}

function checkPage(page, theme, width, errors, label) {
  check(page?.theme === theme && page?.expectedTheme === theme, errors, `${label} theme evidence is invalid`)
  check(page?.viewport?.width === width && page?.document?.scrollWidth <= width, errors, `${label} viewport evidence is invalid`)
  check(page?.tabs === 3 && page?.metrics === 0 && page?.title === '用户资料' && page?.closeActions === 1, errors, `${label} information architecture is invalid`)
  check(page?.settingsVisible === true && page?.settingsOpacity === '1' && page?.settingsVisibility === 'visible', errors, `${label} is not visibly painted`)
}

async function inspectResult(resultFile) {
  const errors = []
  let result
  try {
    result = JSON.parse(await readFile(resultFile, 'utf8'))
  } catch (error) {
    return { resultFile, platform: 'unknown', arch: 'unknown', errors: [formatEvidenceFailure('invalid result.json', error)] }
  }
  if (!isEvidenceRecord(result)) return { resultFile, platform: 'unknown', arch: 'unknown', errors: ['result.json must be an object'] }
  rejectUnexpectedKeys(result, topLevelFields, errors, 'result.json')
  rejectUnexpectedKeys(result.packageEvidence, ['packageSha256', 'asarSha256'], errors, 'package evidence')
  const identity = normalizeEvidenceIdentity(result.platform, result.arch, ['darwin', 'win32', 'linux'])
  const packageEvidence = sanitizePackageEvidence(result.packageEvidence)
  check(result.schemaVersion === 2, errors, 'schemaVersion must be 2')
  check(result.mode === 'hidden-electron', errors, 'mode must be hidden-electron')
  check(identity.platform !== 'unknown', errors, 'unsupported platform')
  check(identity.arch !== 'unknown', errors, 'unsupported architecture')
  check(['development-electron', 'packaged-app'].includes(result.applicationMode), errors, 'applicationMode is invalid')
  check(result.packageEvidence === null || packageEvidence !== null, errors, 'package evidence is invalid')
  check(result.applicationMode !== 'packaged-app' || packageEvidence !== null, errors, 'packaged application evidence is missing')
  check(Array.isArray(result.rendererErrors) && result.rendererErrors.length === 0, errors, 'Renderer errors were recorded')
  rejectUnexpectedKeys(result.terminal, ['shell', 'outputVerified', 'resized', 'exitCode', 'closed'], errors, 'terminal')
  check(result.terminal?.outputVerified === true && result.terminal?.resized === true && result.terminal?.exitCode === 0 && result.terminal?.closed === true, errors, 'native terminal round-trip evidence is invalid')
  check(typeof result.terminal?.shell === 'string' && result.terminal.shell.length > 0, errors, 'terminal shell is missing')

  for (const [field, filename] of Object.entries(screenshotFields)) {
    const reference = result[field]?.screenshot
    const safeReference = typeof reference === 'string' ? reference : ''
    check(reference === filename && !isAbsolute(safeReference) && basename(safeReference) === reference, errors, `${field} screenshot reference is invalid`)
  }
  for (const field of ['lightSwitcher', 'darkSwitcher']) {
    const switcher = result[field]
    check(switcher?.visible === true && switcher?.currentUsers === 1 && switcher?.actions === 3, errors, `${field} hierarchy is invalid`)
    check(switcher?.expanded === 'true' && switcher?.manageLabel === '管理用户资料…', errors, `${field} identity is invalid`)
  }
  checkPage(result.light, 'light', 1440, errors, 'light desktop')
  checkPage(result.light1024, 'light', 1024, errors, 'light 1024')
  checkPage(result.workspaces1024, 'light', 1024, errors, 'workspace 1024')
  checkPage(result.transfer1024, 'light', 1024, errors, 'transfer 1024')
  checkPage(result.dark, 'dark', 1440, errors, 'dark desktop')
  check(result.narrowList?.viewport?.width === 760 && result.narrowList?.mobileView === 'list' && result.narrowList?.listVisible === true && result.narrowList?.contentVisible === false, errors, '760 list evidence is invalid')
  check(result.narrowDetail?.viewport?.width === 760 && result.narrowDetail?.mobileView === 'detail' && result.narrowDetail?.listVisible === false && result.narrowDetail?.contentVisible === true && result.narrowDetail?.mobileBackVisible === true, errors, '760 detail evidence is invalid')
  check(result.zoom200?.viewport?.width === 720 && result.zoom200?.viewport?.height === 450 && result.zoom200?.document?.scrollWidth <= 720, errors, '200 percent effective viewport evidence is invalid')

  for (const field of ['create1440', 'create1024', 'create760', 'createZoom200', 'createDark']) {
    const sheet = result[field]
    check(sheet?.visible === true && sheet?.modal === 'true' && sheet?.backgroundInert === true, errors, `${field} modal evidence is invalid`)
    check(sheet?.colorChoices === 8 && sheet?.templateChoices === 2 && sheet?.footerActions === 2, errors, `${field} option evidence is invalid`)
    check(Array.isArray(sheet?.overflow) && sheet.overflow.length === 0 && sheet?.focusRestored === true, errors, `${field} layout or focus evidence is invalid`)
  }
  check(result.reducedMotion?.matches === true && Number.parseFloat(result.reducedMotion?.animationDuration) <= 0.001 && Number.parseFloat(result.reducedMotion?.transitionDuration) <= 0.001, errors, 'reduced-motion evidence is invalid')
  check(result.exportDialog?.open === true && result.exportDialog?.stepCount === 5 && result.exportDialog?.theme === 'dark' && result.exportDialog?.overflow?.length === 0, errors, 'export dialog evidence is invalid')
  check(result.importDialog?.open === true && result.importDialog?.stepCount === 6 && result.importDialog?.theme === 'dark' && result.importDialog?.overflow?.length === 0, errors, 'import dialog evidence is invalid')
  for (const field of ['exportFocusTrap', 'importFocusTrap']) {
    check(result[field]?.lastFocused === true && result[field]?.wrapped === true && result[field]?.focusRestored === true, errors, `${field} evidence is invalid`)
  }
  check(result.exportCompletion?.heading === '资料包已导出' && result.exportCompletion?.target === 'hidden-ui-roundtrip.turboflux-profile' && /^[a-f0-9]{64}$/u.test(result.exportCompletion?.hash ?? ''), errors, 'encrypted export completion evidence is invalid')
  check(result.rebindBefore?.workspaceCount === 1 && result.rebindBefore?.unboundWorkspaces === 1 && result.rebindBefore?.boundWorkspaces === 0 && result.rebindBefore?.conversationCount === 1, errors, 'pre-rebind isolation evidence is invalid')
  check(result.rebindAfter?.workspaceCount === 1 && result.rebindAfter?.unboundWorkspaces === 0 && result.rebindAfter?.boundWorkspaces === 1, errors, 'workspace rebind evidence is invalid')
  for (const field of ['readonlyBeforeRebind', 'readonlyAfterRebind']) {
    check(result[field]?.heading === '界面迁移验证会话' && result[field]?.hasBackButton === true, errors, `${field} presentation evidence is invalid`)
    check(Array.isArray(result[field]?.turns) && result[field].turns.join('|') === '第一条界面迁移历史|第二条界面迁移历史', errors, `${field} history evidence is invalid`)
  }
  check(result.finalProfiles?.profiles === 2 && result.finalProfiles?.activeProfiles === 1 && result.finalProfiles?.rebindActions === 0, errors, 'round-trip profile evidence is invalid')
  check(result.eightUsers?.profiles === 8 && result.eightUsers?.searchFields === 1, errors, 'eight-user search evidence is invalid')

  const screenshotMetrics = {}
  await Promise.all(requiredScreenshots.map(async filename => {
    try {
      const metrics = inspectPixels(await readFile(join(dirname(resultFile), filename)))
      screenshotMetrics[filename] = metrics
      check(metrics.width >= 720 && metrics.height >= 450, errors, `screenshot dimensions are too small: ${filename}`)
      check(metrics.uniqueColors >= 8, errors, `screenshot has insufficient visual detail: ${filename}`)
      check(metrics.dominantColorShare <= 0.97, errors, `screenshot is nearly uniform: ${filename}`)
    } catch (error) {
      errors.push(error?.code === 'ENOENT' ? `screenshot file is missing: ${filename}` : `screenshot cannot be decoded: ${filename}`)
    }
  }))
  return {
    resultFile,
    platform: identity.platform,
    arch: identity.arch,
    provenance: result.provenance,
    applicationMode: result.applicationMode,
    packageEvidence,
    screenshotMetrics,
    errors,
  }
}

export async function verifyProfileHiddenEvidence(options = {}) {
  const evidenceRoot = resolve(options.evidenceRoot ?? defaultEvidenceRoot)
  const requiredPlatforms = options.requiredPlatforms ?? ['darwin', 'win32', 'linux']
  const errors = []
  const resultFiles = await discoverEvidenceResultFiles(evidenceRoot, errors)
  const artifacts = await Promise.all(resultFiles.map(inspectResult))
  errors.push(...artifacts.flatMap(artifact => artifact.errors.map(message => `${portableRelative(evidenceRoot, artifact.resultFile)}: ${message}`)))
  const layout = await verifyEvidenceArtifactLayout({
    evidenceRoot,
    resultFiles,
    reportPath: options.reportPath,
    allowedArtifactEntries: new Set(['result.json', ...requiredScreenshots]),
    errors,
  })
  for (const platform of requiredPlatforms) {
    const matches = artifacts.filter(artifact => artifact.platform === platform)
    check(matches.length === 1, errors, `${platform}: expected exactly one Profile hidden result, found ${matches.length}`)
  }
  for (const artifact of artifacts) check(basename(dirname(artifact.resultFile)) === `${artifact.platform}-${artifact.arch}`, errors, `${portableRelative(evidenceRoot, artifact.resultFile)}: artifact directory must match platform and architecture`)
  if (options.requiredApplicationMode) {
    for (const artifact of artifacts) check(artifact.applicationMode === options.requiredApplicationMode, errors, `${portableRelative(evidenceRoot, artifact.resultFile)}: applicationMode must be ${options.requiredApplicationMode}`)
  }
  check(options.requiredApplicationMode !== 'packaged-app' || Boolean(options.packageEvidenceRoot), errors, 'package evidence root is required when packaged-app evidence is required')
  const provenance = verifyCrossPlatformGithubProvenance(artifacts.map(artifact => ({
    ...artifact,
    path: portableRelative(evidenceRoot, artifact.resultFile),
  })), errors, {
    requiredPlatforms,
    expectedSourceJob: options.expectedSourceJob,
    expectedProvenance: options.expectedProvenance,
    environment: options.environment,
  })
  let packageCorrelation = null
  if (options.packageEvidenceRoot) {
    const packageVerifier = options.packageEvidenceVerifier ?? verifyDesktopPackageEvidence
    const packageReport = await packageVerifier({
      evidenceRoot: resolve(options.packageEvidenceRoot),
      requiredPlatforms: ['darwin', 'win32', 'linux'],
      expectedSourceJob: 'desktop-package',
      expectedProvenance: options.expectedProvenance,
      environment: options.environment,
    })
    packageCorrelation = correlatePackagedApplicationEvidence(artifacts.map(artifact => ({
      ...artifact,
      path: portableRelative(evidenceRoot, artifact.resultFile),
    })), packageReport, errors, { requiredPlatforms })
  }
  const report = {
    schemaVersion: 2,
    status: errors.length === 0 ? 'passed' : 'failed',
    requiredPlatforms,
    provenance,
    packageCorrelation,
    artifacts: artifacts.map(artifact => ({
      path: portableRelative(evidenceRoot, artifact.resultFile),
      platform: artifact.platform,
      arch: artifact.arch,
      applicationMode: artifact.applicationMode,
      packageEvidence: artifact.packageEvidence,
      screenshotMetrics: artifact.screenshotMetrics,
      status: artifact.errors.length === 0 ? 'passed' : 'failed',
      errors: artifact.errors,
    })),
    errors,
  }
  if (options.reportPath && layout.reportPathAllowed) await writeEvidenceReportAtomically(resolve(options.reportPath), report)
  return report
}

function parseArguments(argumentsList) {
  const evidenceRoot = argumentsList.find(argument => !argument.startsWith('--')) ?? defaultEvidenceRoot
  const platforms = argumentsList.find(argument => argument.startsWith('--require-platforms='))
  const report = argumentsList.find(argument => argument.startsWith('--report='))
  return {
    evidenceRoot,
    requiredPlatforms: platforms?.slice('--require-platforms='.length).split(',').filter(Boolean) ?? ['darwin', 'win32', 'linux'],
    reportPath: report?.slice('--report='.length),
    expectedSourceJob: argumentsList.find(argument => argument.startsWith('--expected-source-job='))?.slice('--expected-source-job='.length),
    requiredApplicationMode: argumentsList.find(argument => argument.startsWith('--require-application-mode='))?.slice('--require-application-mode='.length),
    packageEvidenceRoot: argumentsList.find(argument => argument.startsWith('--package-evidence-root='))?.slice('--package-evidence-root='.length),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await verifyProfileHiddenEvidence(parseArguments(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (report.status !== 'passed') process.exitCode = 1
}
