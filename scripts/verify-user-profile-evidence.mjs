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
  light: 'user-profile-light.png',
  dark: 'user-profile-dark.png',
  narrow: 'user-profile-narrow.png',
  zoom200: 'user-profile-zoom200.png',
}
const requiredScreenshots = Object.values(screenshotFields)
const topLevelFields = [
  'schemaVersion', 'platform', 'arch', 'provenance', 'mode', 'applicationMode', 'packageEvidence',
  ...Object.keys(screenshotFields), 'identity', 'focusRestored', 'keyboardNavigation', 'rendererErrors', 'terminal',
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
  check(result.schemaVersion === 3, errors, 'schemaVersion must be 3')
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
    const state = result[field]
    rejectUnexpectedKeys(state, ['visible', 'modal', 'backgroundInert', 'expanded', 'theme', 'viewport', 'rect', 'noHorizontalOverflow', 'activityDays', 'activityHalves', 'name', 'title', 'screenshot'], errors, field)
    check(state?.screenshot === filename && basename(filename) === filename && !isAbsolute(filename), errors, `${field} screenshot reference is invalid`)
    check(state?.visible === true && state?.modal === true && state?.backgroundInert === true && state?.expanded === true, errors, `${field} modality is invalid`)
    check(state?.title === '用户资料' && state?.noHorizontalOverflow === true, errors, `${field} layout is invalid`)
    check(state?.activityDays >= 365 && state?.activityDays <= 366 && state?.activityHalves === 2, errors, `${field} activity calendar is incomplete`)
    const viewport = { light: [1440, 900], dark: [1440, 900], narrow: [760, 720], zoom200: [720, 450] }[field]
    check(state?.viewport?.width === viewport[0] && state?.viewport?.height === viewport[1], errors, `${field} viewport is invalid`)
    check(state?.theme === (field === 'dark' ? 'dark' : 'light'), errors, `${field} theme is invalid`)
    check(state?.rect?.width > 0 && state?.rect?.height > 0 && state?.rect?.x >= 0 && state?.rect?.y >= 0 && state.rect.x + state.rect.width <= viewport[0] + 1 && state.rect.y + state.rect.height <= viewport[1] + 1, errors, `${field} dialog is outside the viewport`)
  }
  rejectUnexpectedKeys(result.identity, ['saved', 'persisted', 'reopened', 'sidebarUpdated'], errors, 'identity')
  check(['saved', 'persisted', 'reopened', 'sidebarUpdated'].every(key => result.identity?.[key] === true), errors, 'identity persistence evidence is incomplete')
  check(result.focusRestored === true && result.keyboardNavigation === true, errors, 'keyboard lifecycle evidence is incomplete')

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

export async function verifyUserProfileEvidence(options = {}) {
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
  const report = await verifyUserProfileEvidence(parseArguments(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (report.status !== 'passed') process.exitCode = 1
}
