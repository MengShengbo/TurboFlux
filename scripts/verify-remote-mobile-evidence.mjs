import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyCrossPlatformGithubProvenance } from './github-actions-provenance.mjs'
import { correlatePackagedApplicationEvidence } from './packaged-application-evidence-correlation.mjs'
import { verifyDesktopPackageEvidence } from './verify-desktop-package-evidence.mjs'
import { discoverEvidenceResultFiles, isEvidenceRecord, normalizeEvidenceIdentity, portableRelative, rejectUnexpectedKeys, sanitizePackageEvidence, verifyEvidenceArtifactLayout } from './evidence-artifact-layout.mjs'
import { formatEvidenceFailure, writeEvidenceReportAtomically } from './evidence-report-output.mjs'

const verifierRequire = createRequire(import.meta.url)
const { PNG } = verifierRequire('pngjs')
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultEvidenceRoot = join(repositoryRoot, 'apps', 'remote-mobile', 'generated', 'automation-qa')
const requiredScreenshots = [
  'remote-mobile-workspace-light.png',
  'remote-mobile-session-drawer-light.png',
  'remote-mobile-workspace-dark-reduced-motion.png',
]
const requiredCapabilities = [
  'session.read', 'session.create', 'session.submit', 'session.steer', 'session.control',
  'approval.resolve', 'artifact.list', 'artifact.read',
]

function check(condition, errors, message) {
  if (!condition) errors.push(message)
}

function hasExactStringSet(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && new Set(value).size === value.length
    && expected.every(item => value.includes(item))
}

function isStableId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
}

function rejectRectKeys(value, errors, label) {
  rejectUnexpectedKeys(value, ['x', 'y', 'width', 'height'], errors, label)
}

function rejectViewportKeys(value, errors, label, includeScale = false) {
  rejectUnexpectedKeys(value, includeScale ? ['width', 'height', 'devicePixelRatio'] : ['width', 'height'], errors, label)
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
    return { resultFile, errors: [formatEvidenceFailure('invalid result.json', error)] }
  }
  if (!isEvidenceRecord(result)) return { resultFile, errors: ['result.json must be an object'] }
  rejectUnexpectedKeys(result, ['schemaVersion', 'mode', 'platform', 'arch', 'provenance', 'hostApplicationMode', 'packageEvidence', 'windowNeverFocused', 'pairing', 'workflow', 'workspace', 'drawer', 'darkReducedMotion', 'interaction', 'rendererErrors', 'screenshots'], errors, 'result.json')
  rejectUnexpectedKeys(result.packageEvidence, ['packageSha256', 'asarSha256', 'remoteMobileSha256'], errors, 'package evidence')
  rejectUnexpectedKeys(result.pairing, [
    'approved', 'requestId', 'hostDeviceId', 'requestedDeviceId', 'pairedDeviceId', 'controlDeviceId', 'controlClientInstanceId',
    'pairedDeviceCount', 'controlSessionActive', 'workspaceId', 'requestedWorkspaceIds', 'grantedWorkspaceIds', 'workspaceRestricted',
    'offeredCapabilities', 'requestedCapabilities', 'grantedCapabilities',
  ], errors, 'pairing evidence')
  rejectUnexpectedKeys(result.workflow, ['sessionId', 'activeSessionId', 'sessionIds', 'messageIds', 'approval', 'artifact', 'resolution', 'remainingApprovalIds', 'artifactReadIds'], errors, 'workflow evidence')
  rejectUnexpectedKeys(result.workflow?.approval, ['id', 'sessionId', 'runId'], errors, 'workflow approval evidence')
  rejectUnexpectedKeys(result.workflow?.artifact, ['id', 'sessionId', 'runId'], errors, 'workflow artifact evidence')
  rejectUnexpectedKeys(result.workflow?.resolution, ['approvalId', 'response', 'channel', 'deviceId'], errors, 'workflow resolution evidence')
  rejectUnexpectedKeys(result.workspace, ['viewport', 'document', 'hasFocus', 'secureContext', 'shell', 'header', 'conversation', 'approval', 'artifact', 'composer', 'approvalVisibility', 'text'], errors, 'workspace evidence')
  rejectUnexpectedKeys(result.drawer, ['viewport', 'documentWidth', 'hasFocus', 'rect'], errors, 'drawer evidence')
  rejectUnexpectedKeys(result.darkReducedMotion, ['dark', 'reducedMotion', 'animationDuration', 'transitionDuration', 'documentWidth', 'viewportWidth', 'hasFocus'], errors, 'dark reduced-motion evidence')
  rejectUnexpectedKeys(result.interaction, ['artifactClicked', 'artifactDownloadPrevented', 'artifactDownloadName', 'artifactDownloadMime', 'approvalClicked', 'approvalCardsAfterResolution'], errors, 'interaction evidence')
  rejectViewportKeys(result.workspace?.viewport, errors, 'workspace viewport', true)
  rejectViewportKeys(result.workspace?.document, errors, 'workspace document')
  for (const key of ['shell', 'header', 'conversation', 'approval', 'artifact', 'composer']) rejectRectKeys(result.workspace?.[key], errors, `workspace ${key}`)
  rejectUnexpectedKeys(result.workspace?.approvalVisibility, ['width', 'height', 'hitWithinTarget', 'ancestors'], errors, 'approval visibility evidence')
  if (Array.isArray(result.workspace?.approvalVisibility?.ancestors)) {
    for (const ancestor of result.workspace.approvalVisibility.ancestors) rejectUnexpectedKeys(ancestor, ['display', 'visibility', 'opacity'], errors, 'approval visibility ancestor')
  }
  rejectViewportKeys(result.drawer?.viewport, errors, 'drawer viewport')
  rejectRectKeys(result.drawer?.rect, errors, 'drawer rect')
  check(result.schemaVersion === 3, errors, 'schemaVersion must be 3')
  check(result.mode === 'hidden-electron-remote-mobile', errors, 'mode must be hidden-electron-remote-mobile')
  const identity = normalizeEvidenceIdentity(result.platform, result.arch)
  check(identity.platform !== 'unknown', errors, 'unsupported platform')
  check(typeof result.arch === 'string' && result.arch.length > 0, errors, 'arch is missing')
  check(result.hostApplicationMode === 'development-electron', errors, 'Remote host application mode must be development-electron')
  if (result.packageEvidence != null) {
    check(/^[a-f0-9]{64}$/u.test(result.packageEvidence?.packageSha256), errors, 'correlated package SHA-256 is invalid')
    check(/^[a-f0-9]{64}$/u.test(result.packageEvidence?.asarSha256), errors, 'correlated ASAR SHA-256 is invalid')
    check(/^[a-f0-9]{64}$/u.test(result.packageEvidence?.remoteMobileSha256), errors, 'correlated Remote Mobile SHA-256 is invalid')
  }
  check(result.windowNeverFocused === true, errors, 'hidden window received focus')
  check(result.pairing?.approved === true && result.pairing?.pairedDeviceCount === 1, errors, 'real Desktop pairing approval evidence is missing')
  check(result.pairing?.controlSessionActive === true, errors, 'real remote control claim evidence is missing')
  check(result.pairing?.workspaceRestricted === true, errors, 'pairing workspace restriction evidence is missing')
  for (const [label, value] of [
    ['pairing request', result.pairing?.requestId],
    ['host device', result.pairing?.hostDeviceId],
    ['requested device', result.pairing?.requestedDeviceId],
    ['paired device', result.pairing?.pairedDeviceId],
    ['control device', result.pairing?.controlDeviceId],
    ['control page', result.pairing?.controlClientInstanceId],
    ['workspace', result.pairing?.workspaceId],
  ]) check(isStableId(value), errors, `${label} identity evidence is missing or invalid`)
  check(result.pairing?.requestedDeviceId === result.pairing?.pairedDeviceId
    && result.pairing?.pairedDeviceId === result.pairing?.controlDeviceId, errors, 'pairing, paired-device, and control-session identities do not match')
  check(Array.isArray(result.pairing?.requestedWorkspaceIds)
    && result.pairing.requestedWorkspaceIds.length === 1
    && result.pairing.requestedWorkspaceIds[0] === result.pairing.workspaceId
    && Array.isArray(result.pairing?.grantedWorkspaceIds)
    && result.pairing.grantedWorkspaceIds.length === 1
    && result.pairing.grantedWorkspaceIds[0] === result.pairing.workspaceId, errors, 'requested and granted workspace identities do not match')
  for (const [label, capabilities] of [
    ['offered', result.pairing?.offeredCapabilities],
    ['requested', result.pairing?.requestedCapabilities],
    ['granted', result.pairing?.grantedCapabilities],
  ]) check(hasExactStringSet(capabilities, requiredCapabilities), errors, `${label} pairing capabilities must match the exact Remote Mobile product grant`)

  const workflow = result.workflow
  for (const [label, value] of [
    ['session', workflow?.sessionId],
    ['active session', workflow?.activeSessionId],
    ['approval', workflow?.approval?.id],
    ['approval session', workflow?.approval?.sessionId],
    ['approval run', workflow?.approval?.runId],
    ['artifact', workflow?.artifact?.id],
    ['artifact session', workflow?.artifact?.sessionId],
    ['artifact run', workflow?.artifact?.runId],
    ['resolved approval', workflow?.resolution?.approvalId],
    ['approval device', workflow?.resolution?.deviceId],
  ]) check(isStableId(value), errors, `${label} workflow identity evidence is missing or invalid`)
  check(workflow?.activeSessionId === workflow?.sessionId, errors, 'active session identity does not match the rendered workflow session')
  check(Array.isArray(workflow?.sessionIds) && new Set(workflow.sessionIds).size === workflow.sessionIds.length
    && workflow.sessionIds.every(isStableId) && workflow.sessionIds.includes(workflow.sessionId), errors, 'session snapshot identities are missing or invalid')
  check(Array.isArray(workflow?.messageIds) && workflow.messageIds.length > 0
    && new Set(workflow.messageIds).size === workflow.messageIds.length && workflow.messageIds.every(isStableId), errors, 'message snapshot identities are missing or invalid')
  check(workflow?.approval?.sessionId === workflow?.sessionId
    && workflow?.artifact?.sessionId === workflow?.sessionId, errors, 'approval and artifact do not belong to the active session snapshot')
  check(workflow?.approval?.runId === workflow?.artifact?.runId, errors, 'approval and artifact do not belong to the same automation Run')
  check(workflow?.resolution?.approvalId === workflow?.approval?.id
    && workflow?.resolution?.response === 'allow-once'
    && workflow?.resolution?.channel === 'remote', errors, 'Remote Mobile approval resolution evidence is invalid')
  check(workflow?.resolution?.deviceId === result.pairing?.controlDeviceId, errors, 'approval was not resolved by the authenticated remote control device')
  check(Array.isArray(workflow?.remainingApprovalIds) && workflow.remainingApprovalIds.length === 0, errors, 'resolved approval remains in the remote snapshot')
  check(Array.isArray(workflow?.artifactReadIds) && workflow.artifactReadIds.length === 1
    && workflow.artifactReadIds[0] === workflow?.artifact?.id, errors, 'artifact was not read through the same Remote Mobile workflow')
  check(result.workspace?.viewport?.width === 390 && result.workspace?.viewport?.height === 844, errors, '390x844 viewport evidence is missing')
  check(result.workspace?.document?.width <= result.workspace?.viewport?.width, errors, 'workspace overflows horizontally')
  check(result.workspace?.hasFocus === false && result.workspace?.secureContext === true, errors, 'workspace focus or secure-context evidence is invalid')
  check(result.workspace?.approvalVisibility?.width > 0 && result.workspace?.approvalVisibility?.height >= 120, errors, 'approval card is not materially visible')
  check(result.workspace?.approvalVisibility?.hitWithinTarget === true, errors, 'approval card is covered')
  const approvalAncestors = result.workspace?.approvalVisibility?.ancestors
  check(Array.isArray(approvalAncestors) && approvalAncestors.length > 0 && approvalAncestors.every(ancestor => ancestor?.display !== 'none' && ancestor?.visibility === 'visible' && Number.parseFloat(ancestor?.opacity) > 0), errors, 'approval card has a hidden or missing ancestor chain')
  check(result.workspace?.text?.includes('仅这次允许') && result.workspace?.text?.includes('拒绝'), errors, 'fixed approval choices are missing')
  check(result.workspace?.text?.includes('自动化日报') && result.workspace?.text?.includes('验收报告.pdf'), errors, 'real snapshot approval or artifact is missing')
  check(result.drawer?.rect?.x === 0 && result.drawer?.rect?.width > 0 && result.drawer?.rect?.width <= 328, errors, 'mobile session drawer evidence is invalid')
  check(result.drawer?.documentWidth <= result.drawer?.viewport?.width, errors, 'session drawer overflows horizontally')
  check(result.drawer?.hasFocus === false, errors, 'session drawer received focus')
  check(result.darkReducedMotion?.dark === true && result.darkReducedMotion?.reducedMotion === true, errors, 'dark reduced-motion evidence is missing')
  check(Number.parseFloat(result.darkReducedMotion?.animationDuration) <= 0.001 && Number.parseFloat(result.darkReducedMotion?.transitionDuration) <= 0.001, errors, 'reduced-motion suppression evidence is missing')
  check(result.darkReducedMotion?.documentWidth <= result.darkReducedMotion?.viewportWidth, errors, 'dark layout overflows horizontally')
  check(result.darkReducedMotion?.hasFocus === false, errors, 'dark layout received focus')
  check(result.interaction?.artifactClicked === true
    && result.interaction?.artifactDownloadPrevented === true
    && result.interaction?.artifactDownloadName === '验收报告.pdf'
    && result.interaction?.artifactDownloadMime === 'application/pdf', errors, 'real Remote Mobile artifact interaction evidence is missing')
  check(result.interaction?.approvalClicked === true && result.interaction?.approvalCardsAfterResolution === 0, errors, 'real Remote Mobile approval interaction evidence is missing')
  check(Array.isArray(result.rendererErrors) && result.rendererErrors.length === 0, errors, 'Renderer errors were recorded')

  const screenshotPaths = Array.isArray(result.screenshots) ? result.screenshots : []
  check(screenshotPaths.length === requiredScreenshots.length, errors, `screenshot references must contain exactly ${requiredScreenshots.length} entries`)
  for (const path of screenshotPaths) check(typeof path === 'string' && !isAbsolute(path) && basename(path) === path, errors, 'screenshot reference must be an artifact filename')
  const references = new Set(screenshotPaths.map(String))
  const screenshotMetrics = {}
  await Promise.all(requiredScreenshots.map(async name => {
    check(references.has(name), errors, `missing screenshot reference: ${name}`)
    try {
      const metrics = inspectPixels(await readFile(join(dirname(resultFile), name)))
      screenshotMetrics[name] = metrics
      const scale = Number(result.workspace?.viewport?.devicePixelRatio) || 1
      check(metrics.width === 390 * scale && metrics.height === 844 * scale, errors, `screenshot pixels do not match the 390x844 viewport at ${scale}x scale: ${name}`)
      check(metrics.uniqueColors >= 8, errors, `screenshot has insufficient visual detail: ${name}`)
      check(metrics.dominantColorShare <= 0.97, errors, `screenshot is nearly uniform: ${name}`)
    } catch (error) {
      errors.push(error?.code === 'ENOENT' ? `screenshot file is missing: ${name}` : `screenshot cannot be decoded: ${name}`)
    }
  }))
  return {
    resultFile,
    platform: identity.platform,
    arch: identity.arch,
    provenance: result.provenance,
    hostApplicationMode: result.hostApplicationMode === 'development-electron' ? result.hostApplicationMode : 'unknown',
    packageEvidence: sanitizePackageEvidence(result.packageEvidence, { includeRemoteMobileSha256: true }),
    screenshotMetrics,
    errors,
  }
}

export async function verifyRemoteMobileEvidence(options = {}) {
  const evidenceRoot = resolve(options.evidenceRoot ?? defaultEvidenceRoot)
  const requiredPlatforms = options.requiredPlatforms ?? ['darwin', 'win32']
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
    check(matches.length === 1, errors, `${platform}: expected exactly one result.json, found ${matches.length}`)
  }
  for (const artifact of artifacts) check(basename(dirname(artifact.resultFile)) === `${artifact.platform}-${artifact.arch}`, errors, `${portableRelative(evidenceRoot, artifact.resultFile)}: artifact directory must match platform and architecture`)
  if (options.requirePackageCorrelation) {
    check(Boolean(options.packageEvidenceRoot), errors, 'package evidence root is required when Remote package correlation is required')
    for (const artifact of artifacts) check(Boolean(artifact.packageEvidence), errors, `${portableRelative(evidenceRoot, artifact.resultFile)}: correlated package evidence is required`)
  }
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
    })), packageReport, errors, { requiredPlatforms, requireRemoteMobileSha256: true })
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
      hostApplicationMode: artifact.hostApplicationMode,
      packageEvidence: artifact.packageEvidence,
      screenshotMetrics: artifact.screenshotMetrics,
      status: artifact.errors.length === 0 ? 'passed' : 'failed',
      errors: artifact.errors,
    })),
    errors,
  }
  if (options.reportPath && layout.reportPathAllowed) {
    const reportPath = resolve(options.reportPath)
    await writeEvidenceReportAtomically(reportPath, report)
  }
  return report
}

function parseArguments(argumentsList) {
  const evidenceRoot = argumentsList.find(argument => !argument.startsWith('--')) ?? defaultEvidenceRoot
  const platforms = argumentsList.find(argument => argument.startsWith('--require-platforms='))
  const report = argumentsList.find(argument => argument.startsWith('--report='))
  return {
    evidenceRoot,
    requiredPlatforms: platforms?.slice('--require-platforms='.length).split(',').filter(Boolean) ?? ['darwin', 'win32'],
    reportPath: report?.slice('--report='.length),
    expectedSourceJob: argumentsList.find(argument => argument.startsWith('--expected-source-job='))?.slice('--expected-source-job='.length),
    requirePackageCorrelation: argumentsList.includes('--require-package-correlation'),
    packageEvidenceRoot: argumentsList.find(argument => argument.startsWith('--package-evidence-root='))?.slice('--package-evidence-root='.length),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await verifyRemoteMobileEvidence(parseArguments(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (report.status !== 'passed') process.exitCode = 1
}
