import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatEvidenceFailure, validateEvidenceReportOutputPath, writeEvidenceReportAtomically } from './evidence-report-output.mjs'
import { verifyCrossPlatformGithubProvenance } from './github-actions-provenance.mjs'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const defaultEvidenceRoot = join(repositoryRoot, 'apps', 'desktop', 'generated', 'profile-benchmarks')
const kinds = ['profile-archive', 'conversation-v2', 'profile-switch']

function check(condition, errors, message) {
  if (!condition) errors.push(message)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function rejectUnexpectedKeys(value, allowed, errors, label) {
  if (!isRecord(value)) return
  check(Object.keys(value).every(key => allowed.includes(key)), errors, `${label} contains unexpected fields`)
}

function benchmarkFilename(kind, platform, arch) {
  return `${kind}-stable-${platform}-${arch}.json`
}

function validateCommon(report, kind, platform, arch, errors) {
  const label = `${kind} report`
  check(isRecord(report), errors, `${label} must be an object`)
  if (!isRecord(report)) return
  check(report.schemaVersion === 2, errors, `${label} schemaVersion must be 2`)
  check(report.qualification === 'stable', errors, `${label} qualification must be stable`)
  check(report.passed === true, errors, `${label} did not pass`)
  const host = kind === 'conversation-v2' ? report.environment : report.host
  check(isRecord(host), errors, `${label} host evidence is missing`)
  check(host?.platform === platform, errors, `${label} platform does not match the target`)
  check(host?.arch === arch, errors, `${label} architecture does not match the target`)
}

function validateArchive(report, errors) {
  rejectUnexpectedKeys(report, [
    'schemaVersion', 'provenance', 'qualification', 'completedAt', 'command', 'host', 'dataset',
    'kdfMs', 'roundTripMs', 'peakRssDeltaMiB', 'archiveMiB', 'expandedMiB', 'verifiedEntries',
    'budgets', 'passed', 'failures',
  ], errors, 'profile-archive report')
  check(report.command === 'npm run perf:profiles:stable', errors, 'profile-archive command is invalid')
  check(Array.isArray(report.failures) && report.failures.length === 0, errors, 'profile-archive failures are not empty')
  check(Number.isFinite(report.dataset?.blobMiB) && report.dataset.blobMiB >= 1024, errors, 'profile-archive dataset is below the Stable scale')
  check(Number.isFinite(report.verifiedEntries) && report.verifiedEntries === report.dataset?.entries, errors, 'profile-archive verified entry count is inconsistent')
}

function validateConversations(report, errors) {
  rejectUnexpectedKeys(report, [
    'schemaVersion', 'provenance', 'qualification', 'generatedAt', 'command', 'environment',
    'replay', 'runtimeRestore', 'catalog', 'firstPage', 'passed',
  ], errors, 'conversation-v2 report')
  check(report.command === 'npm run perf:conversations-v2:stable', errors, 'conversation-v2 command is invalid')
  check(report.replay?.passed === true && report.replay?.eventCount === 100_000, errors, 'conversation-v2 replay evidence is incomplete')
  check(report.runtimeRestore?.passed === true && report.runtimeRestore?.turnCount === 8_000
    && Number.isFinite(report.runtimeRestore?.elapsedMs) && report.runtimeRestore.elapsedMs >= 0 && report.runtimeRestore.elapsedMs < 2_000,
  errors, 'conversation-v2 runtime restoration evidence is incomplete or exceeds its budget')
  check(report.catalog?.passed === true && report.catalog?.conversationCount === 10_000 && report.catalog?.profileEventCount === 1_000_000, errors, 'conversation-v2 catalog evidence is below the Stable scale')
  check(report.firstPage?.passed === true && report.firstPage?.itemCount === 10_000 && report.firstPage?.bytesRead < report.firstPage?.journalBytes, errors, 'conversation-v2 first-page evidence is incomplete')
}

function validateSwitch(report, errors) {
  rejectUnexpectedKeys(report, [
    'schemaVersion', 'provenance', 'qualification', 'completedAt', 'command', 'host', 'samples',
    'p50Ms', 'p95Ms', 'maxMs', 'budgetMs', 'passed',
  ], errors, 'profile-switch report')
  check(report.command === 'npm run perf:profile-switch:stable', errors, 'profile-switch command is invalid')
  check(Array.isArray(report.samples) && report.samples.length === 20, errors, 'profile-switch sample count must be 20')
  check(Number.isFinite(report.p95Ms) && Number.isFinite(report.budgetMs) && report.p95Ms < report.budgetMs, errors, 'profile-switch p95 exceeds its budget')
}

async function readBenchmark(evidenceRoot, kind, platform, arch, errors) {
  const filename = benchmarkFilename(kind, platform, arch)
  try {
    const report = JSON.parse(await readFile(join(evidenceRoot, filename), 'utf8'))
    validateCommon(report, kind, platform, arch, errors)
    if (isRecord(report)) {
      if (kind === 'profile-archive') validateArchive(report, errors)
      else if (kind === 'conversation-v2') validateConversations(report, errors)
      else validateSwitch(report, errors)
    }
    return { kind, filename, report }
  } catch (error) {
    errors.push(formatEvidenceFailure(`${kind} report cannot be read`, error))
    return null
  }
}

export async function verifyProfileStableBenchmarkEvidence(options = {}) {
  const evidenceRoot = resolve(options.evidenceRoot ?? defaultEvidenceRoot)
  const platform = options.platform ?? 'linux'
  const arch = options.arch ?? 'x64'
  const errors = []
  check(['darwin', 'win32', 'linux'].includes(platform), errors, 'target platform is invalid')
  check(['arm64', 'x64'].includes(arch), errors, 'target architecture is invalid')
  const reportPath = options.reportPath ? resolve(options.reportPath) : undefined
  const reportPathAllowed = validateEvidenceReportOutputPath(evidenceRoot, reportPath, errors)
  const expectedFiles = new Set(kinds.map(kind => benchmarkFilename(kind, platform, arch)))
  if (reportPath) expectedFiles.add(relative(evidenceRoot, reportPath))
  expectedFiles.add('profile-switch-benchmark.mjs')
  try {
    const entries = await readdir(evidenceRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !expectedFiles.has(entry.name)) errors.push('unexpected Stable benchmark evidence entry')
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') errors.push(formatEvidenceFailure('Stable benchmark evidence root cannot be read', error))
  }
  const artifacts = (await Promise.all(kinds.map(kind => readBenchmark(evidenceRoot, kind, platform, arch, errors)))).filter(Boolean)
  let provenance = null
  if (artifacts.length === kinds.length) {
    provenance = verifyCrossPlatformGithubProvenance(artifacts.map(artifact => ({
      path: artifact.filename,
      platform,
      arch,
      provenance: artifact.report?.provenance,
    })), errors, {
      requiredPlatforms: artifacts.map(() => platform),
      expectedSourceJob: options.expectedSourceJob,
      environment: options.environment,
    })
  }
  const report = {
    schemaVersion: 2,
    status: errors.length === 0 ? 'passed' : 'failed',
    platform,
    arch,
    provenance,
    artifacts: artifacts.map(artifact => ({ kind: artifact.kind, path: artifact.filename, passed: artifact.report?.passed === true })),
    errors,
  }
  if (reportPath && reportPathAllowed) await writeEvidenceReportAtomically(reportPath, report)
  return report
}

function parseArguments(argumentsList) {
  const evidenceRoot = argumentsList.find(argument => !argument.startsWith('--')) ?? defaultEvidenceRoot
  return {
    evidenceRoot,
    platform: argumentsList.find(argument => argument.startsWith('--platform='))?.slice('--platform='.length),
    arch: argumentsList.find(argument => argument.startsWith('--arch='))?.slice('--arch='.length),
    expectedSourceJob: argumentsList.find(argument => argument.startsWith('--expected-source-job='))?.slice('--expected-source-job='.length),
    reportPath: argumentsList.find(argument => argument.startsWith('--report='))?.slice('--report='.length),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await verifyProfileStableBenchmarkEvidence(parseArguments(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (report.status !== 'passed') process.exitCode = 1
}
