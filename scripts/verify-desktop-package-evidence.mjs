import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatEvidenceFailure, validateEvidenceReportOutputPath, writeEvidenceReportAtomically } from './evidence-report-output.mjs'
import { normalizeEvidenceIdentity } from './evidence-artifact-layout.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultEvidenceRoot = join(repositoryRoot, 'apps', 'desktop', 'generated', 'package-evidence')
const digestPattern = /^[a-f0-9]{64}$/u
const sharedProvenanceKeys = ['gitCommit', 'repository', 'workflowName', 'workflowRef', 'workflowRunId', 'workflowRunAttempt']

function check(condition, errors, message) {
  if (!condition) errors.push(message)
}

function exactKeys(value, expected, errors, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`)
    return false
  }
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  check(actual.length === wanted.length && actual.every((key, index) => key === wanted[index]), errors, `${label} fields must be exactly: ${wanted.join(', ')}`)
  return true
}

function safeRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.startsWith('/')
    && !/^[A-Za-z]:/u.test(value)
    && !value.split('/').some(segment => segment === '..' || segment === '')
}

function sameMembers(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && [...actual].sort().every((value, index) => value === [...expected].sort()[index])
}

async function findReportFiles(directory, reportPath) {
  const files = []
  const errors = []
  const resolvedReportPath = reportPath ? resolve(reportPath) : undefined
  const reportPathAllowed = validateEvidenceReportOutputPath(directory, resolvedReportPath, errors)
  const allowedAggregatePath = resolvedReportPath && dirname(resolvedReportPath) === directory
    ? resolvedReportPath
    : undefined

  let rootEntries
  try {
    rootEntries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { errors, files, reportPathAllowed }
    errors.push(formatEvidenceFailure('package evidence root cannot be read', error))
    return { errors, files, reportPathAllowed }
  }

  const artifactDirectories = []
  for (const entry of rootEntries) {
    const entryPath = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      errors.push('symbolic links are not allowed in package evidence root')
      continue
    }
    if (entry.isFile()) {
      if (entryPath !== allowedAggregatePath) errors.push('unexpected file in package evidence root')
      continue
    }
    if (!entry.isDirectory()) {
      errors.push('unexpected entry in package evidence root')
      continue
    }
    artifactDirectories.push({ entryPath, name: entry.name })
  }

  const artifactResults = await Promise.all(artifactDirectories.map(async ({ entryPath, name }) => {
    const artifactErrors = []
    let artifactEntries
    try {
      artifactEntries = await readdir(entryPath, { withFileTypes: true })
    } catch (error) {
      return { errors: [formatEvidenceFailure('package artifact cannot be read', error)], file: undefined }
    }
    const reportEntry = artifactEntries.find(artifactEntry => artifactEntry.name === 'package-report.json')
    if (artifactEntries.length !== 1 || !reportEntry?.isFile()) {
      artifactErrors.push('package artifact must contain exactly one package-report.json file')
    }
    for (const artifactEntry of artifactEntries) {
      if (artifactEntry.isSymbolicLink()) {
        artifactErrors.push('package artifact contains a symbolic link')
      } else if (artifactEntry.isDirectory()) {
        artifactErrors.push('package artifact contains a nested directory')
      } else if (!artifactEntry.isFile() || artifactEntry.name !== 'package-report.json') {
        artifactErrors.push('package artifact contains an unexpected entry')
      }
    }
    return {
      errors: artifactErrors,
      file: artifactEntries.length === 1 && reportEntry?.isFile() ? join(entryPath, reportEntry.name) : undefined,
    }
  }))
  for (const artifactResult of artifactResults) {
    errors.push(...artifactResult.errors)
    if (artifactResult.file) files.push(artifactResult.file)
  }
  return { errors, files, reportPathAllowed }
}

function expectedPackagePath(platform, value) {
  if (platform === 'darwin') return /^release\/mac(?:-[^/]+)?\/[^/]+\.app$/u.test(value)
  if (platform === 'win32') return value === 'release/win-unpacked'
  if (platform === 'linux') return value === 'release/linux-unpacked'
  return false
}

function expectedAsarPath(platform) {
  return platform === 'darwin' ? 'Contents/Resources/app.asar' : 'resources/app.asar'
}

function expectedRemoteMobilePath(platform) {
  return platform === 'darwin' ? 'Contents/Resources/remote-mobile' : 'resources/remote-mobile'
}

function expectedRuntimeSuffixes(platform) {
  if (platform === 'darwin') return ['/pty.node', '/spawn-helper', '/esbuild', '/native/TurboFluxComputerHelper']
  if (platform === 'linux') return ['/pty.node', '/esbuild']
  return ['/pty.node', '/conpty.node', '/conpty_console_list.node', '/esbuild.exe']
}

function expectedModuleExports(platform) {
  if (platform !== 'win32') return new Map([['pty.node', ['fork', 'open', 'process', 'resize']]])
  return new Map([
    ['pty.node', ['startProcess', 'resize', 'kill', 'getExitCode', 'getProcessList']],
    ['conpty.node', ['startProcess', 'connect', 'resize', 'clear', 'kill']],
    ['conpty_console_list.node', ['getConsoleProcessList']],
  ])
}

function inspectProvenance(provenance, platform, arch, errors) {
  const initialErrorCount = errors.length
  if (!exactKeys(provenance, ['gitCommit', 'repository', 'workflowName', 'workflowRef', 'workflowRunId', 'workflowRunAttempt', 'jobId', 'runnerOs', 'runnerArch'], errors, 'provenance')) return undefined
  check(/^[a-f0-9]{40}$/u.test(provenance.gitCommit), errors, 'provenance.gitCommit is invalid')
  check(typeof provenance.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(provenance.repository), errors, 'provenance.repository is invalid')
  check(typeof provenance.workflowName === 'string' && provenance.workflowName.length > 0 && provenance.workflowName.length <= 256 && !/[\r\n]/u.test(provenance.workflowName) && safeFailureMessage(provenance.workflowName), errors, 'provenance.workflowName is invalid')
  check(typeof provenance.workflowRef === 'string' && provenance.workflowRef.startsWith(`${provenance.repository}/.github/workflows/`) && provenance.workflowRef.includes('@refs/') && safeFailureMessage(provenance.workflowRef), errors, 'provenance.workflowRef is invalid')
  check(typeof provenance.workflowRunId === 'string' && /^\d+$/u.test(provenance.workflowRunId), errors, 'provenance.workflowRunId is invalid')
  check(Number.isSafeInteger(provenance.workflowRunAttempt) && provenance.workflowRunAttempt > 0, errors, 'provenance.workflowRunAttempt is invalid')
  check(typeof provenance.jobId === 'string' && /^[A-Za-z0-9_-]+$/u.test(provenance.jobId), errors, 'provenance.jobId is invalid')
  const expectedRunnerOs = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[platform]
  const expectedRunnerArch = { arm64: 'ARM64', x64: 'X64' }[arch]
  check(provenance.runnerOs === expectedRunnerOs, errors, `runnerOs must be ${expectedRunnerOs}`)
  check(provenance.runnerArch === expectedRunnerArch, errors, `runnerArch must be ${expectedRunnerArch}`)
  if (errors.length !== initialErrorCount) return undefined
  return Object.fromEntries(['gitCommit', 'repository', 'workflowName', 'workflowRef', 'workflowRunId', 'workflowRunAttempt', 'jobId', 'runnerOs', 'runnerArch'].map(key => [key, provenance[key]]))
}

function safeFailureMessage(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 1_000
    && ![...value].some(character => {
      const codePoint = character.codePointAt(0)
      return codePoint <= 31 || codePoint === 127
    })
    && !/(?:^|[\s:(])(?:\/|[A-Za-z]:[\\/])/u.test(value)
    && !/(?:https?:\/\/|file:\/\/|\b(?:token|secret|password|api[_-]?key|authorization|bearer)\b\s*[:=])/iu.test(value)
}

function inspectPackageReport(resultFile, evidenceRoot, report) {
  const errors = []
  const identity = normalizeEvidenceIdentity(report?.platform, report?.arch, ['darwin', 'win32', 'linux'])
  const platform = identity.platform
  const arch = identity.arch
  check(report?.schemaVersion === 2, errors, 'schemaVersion must be 2')
  const supportedPlatform = platform !== 'unknown'
  const supportedArch = arch !== 'unknown'
  const resultPath = supportedPlatform && supportedArch ? `${platform}-${arch}/package-report.json` : 'untrusted/package-report.json'
  check(supportedPlatform, errors, 'unsupported platform')
  check(supportedArch, errors, 'unsupported architecture')
  const provenance = inspectProvenance(report?.provenance, platform, arch, errors)

  if (report?.status === 'failed') {
    exactKeys(report, ['schemaVersion', 'status', 'platform', 'arch', 'provenance', 'failure'], errors, 'failure report')
    if (exactKeys(report?.failure, ['code', 'message'], errors, 'failure')) {
      check(report.failure.code === 'DESKTOP_PACKAGE_VERIFICATION_FAILED', errors, 'failure.code is invalid')
      check(safeFailureMessage(report.failure.message), errors, 'failure.message is invalid or contains a local path')
      errors.push(report.failure.code === 'DESKTOP_PACKAGE_VERIFICATION_FAILED' && safeFailureMessage(report.failure.message)
        ? `package verification failed (DESKTOP_PACKAGE_VERIFICATION_FAILED): ${report.failure.message}`
        : 'package verification failed (redacted invalid failure)')
    }
    return {
      resultFile,
      path: resultPath,
      platform,
      arch,
      provenance,
      packageSha256: undefined,
      asarSha256: undefined,
      remoteMobileSha256: undefined,
      errors,
    }
  }

  exactKeys(report, ['schemaVersion', 'status', 'platform', 'arch', 'provenance', 'packagePath', 'package', 'asar', 'remoteMobile', 'resources', 'runtimeFiles', 'nativeRuntimeProbe'], errors, 'report')
  check(report?.status === 'passed', errors, 'status must be passed or failed')
  check(safeRelativePath(report?.packagePath) && expectedPackagePath(platform, report.packagePath), errors, 'invalid packagePath')

  if (exactKeys(report?.package, ['bytes', 'entryCount', 'fileCount', 'symlinkCount', 'sha256'], errors, 'package')) {
    check(Number.isSafeInteger(report.package.bytes) && report.package.bytes > 0, errors, 'package.bytes is invalid')
    check(Number.isSafeInteger(report.package.entryCount) && report.package.entryCount > 0, errors, 'package.entryCount is invalid')
    check(Number.isSafeInteger(report.package.fileCount) && report.package.fileCount > 0, errors, 'package.fileCount is invalid')
    check(Number.isSafeInteger(report.package.symlinkCount) && report.package.symlinkCount >= 0, errors, 'package.symlinkCount is invalid')
    check(digestPattern.test(report.package.sha256), errors, 'package.sha256 is invalid')
  }

  if (exactKeys(report?.asar, ['path', 'bytes', 'entryCount', 'sha256'], errors, 'asar')) {
    check(report.asar.path === expectedAsarPath(platform), errors, `asar.path must be ${expectedAsarPath(platform)}`)
    check(Number.isSafeInteger(report.asar.bytes) && report.asar.bytes > 0, errors, 'asar.bytes is invalid')
    check(Number.isSafeInteger(report.asar.entryCount) && report.asar.entryCount > 0, errors, 'asar.entryCount is invalid')
    check(digestPattern.test(report.asar.sha256), errors, 'asar.sha256 is invalid')
  }
  if (exactKeys(report?.remoteMobile, ['path', 'bytes', 'fileCount', 'sha256'], errors, 'remoteMobile')) {
    check(report.remoteMobile.path === expectedRemoteMobilePath(platform), errors, `remoteMobile.path must be ${expectedRemoteMobilePath(platform)}`)
    check(Number.isSafeInteger(report.remoteMobile.bytes) && report.remoteMobile.bytes > 0, errors, 'remoteMobile.bytes is invalid')
    check(Number.isSafeInteger(report.remoteMobile.fileCount) && report.remoteMobile.fileCount > 0, errors, 'remoteMobile.fileCount is invalid')
    check(digestPattern.test(report.remoteMobile.sha256), errors, 'remoteMobile.sha256 is invalid')
  }
  if (exactKeys(report?.resources, ['fileCount'], errors, 'resources')) check(Number.isSafeInteger(report.resources.fileCount) && report.resources.fileCount > 0, errors, 'resources.fileCount is invalid')

  const expectedTarget = `${platform}-${arch}`
  const expectedSuffixes = expectedRuntimeSuffixes(platform)
  check(Array.isArray(report?.runtimeFiles) && report.runtimeFiles.length === expectedSuffixes.length, errors, `runtimeFiles must contain ${expectedSuffixes.length} entries`)
  const runtimePaths = []
  for (const [index, runtimeFile] of (Array.isArray(report?.runtimeFiles) ? report.runtimeFiles : []).entries()) {
    if (!exactKeys(runtimeFile, ['path', 'bytes', 'sha256', 'targets'], errors, `runtimeFiles[${index}]`)) continue
    check(safeRelativePath(runtimeFile.path), errors, `runtimeFiles[${index}].path is invalid`)
    runtimePaths.push(runtimeFile.path)
    check(Number.isSafeInteger(runtimeFile.bytes) && runtimeFile.bytes > 0, errors, `runtimeFiles[${index}].bytes is invalid`)
    check(digestPattern.test(runtimeFile.sha256), errors, `runtimeFiles[${index}].sha256 is invalid`)
    check(sameMembers(runtimeFile.targets, [expectedTarget]), errors, `runtimeFiles[${index}].targets must be ${expectedTarget}`)
  }
  check(new Set(runtimePaths).size === runtimePaths.length, errors, 'runtimeFiles paths must be unique')
  for (const suffix of expectedSuffixes) check(runtimePaths.some(path => path.endsWith(suffix)), errors, `runtimeFiles is missing ${suffix}`)

  if (exactKeys(report?.nativeRuntimeProbe, ['loadedModules', 'ptyOpenSmoke', 'esbuildVersion'], errors, 'nativeRuntimeProbe')) {
    check(report.nativeRuntimeProbe.ptyOpenSmoke === (platform !== 'win32'), errors, `ptyOpenSmoke must be ${platform !== 'win32'}`)
    check(typeof report.nativeRuntimeProbe.esbuildVersion === 'string' && /^\d+\.\d+\.\d+/u.test(report.nativeRuntimeProbe.esbuildVersion), errors, 'esbuildVersion is invalid')
    const modules = Array.isArray(report.nativeRuntimeProbe.loadedModules) ? report.nativeRuntimeProbe.loadedModules : []
    const expectedModules = expectedModuleExports(platform)
    check(modules.length === expectedModules.size, errors, `loadedModules must contain ${expectedModules.size} entries`)
    const filenames = []
    for (const [index, module] of modules.entries()) {
      if (!exactKeys(module, ['filename', 'exports'], errors, `loadedModules[${index}]`)) continue
      filenames.push(module.filename)
      const exports = expectedModules.get(module.filename)
      check(exports && sameMembers(module.exports, exports), errors, `loadedModules[${index}] exports are invalid`)
    }
    check(new Set(filenames).size === filenames.length, errors, 'loadedModules filenames must be unique')
    for (const filename of expectedModules.keys()) check(filenames.includes(filename), errors, `loadedModules is missing ${filename}`)
  }

  return {
    resultFile,
    path: resultPath,
    platform,
    arch,
    provenance,
    packageSha256: report?.package?.sha256,
    asarSha256: report?.asar?.sha256,
    remoteMobileSha256: report?.remoteMobile?.sha256,
    errors,
  }
}

function currentWorkflowProvenance(environment = process.env) {
  if (environment.GITHUB_ACTIONS !== 'true') return undefined
  const runAttempt = Number.parseInt(environment.GITHUB_RUN_ATTEMPT ?? '', 10)
  return {
    gitCommit: environment.GITHUB_SHA?.toLowerCase(),
    repository: environment.GITHUB_REPOSITORY,
    workflowName: environment.GITHUB_WORKFLOW,
    workflowRef: environment.GITHUB_WORKFLOW_REF,
    workflowRunId: environment.GITHUB_RUN_ID,
    workflowRunAttempt: runAttempt,
  }
}

export async function verifyDesktopPackageEvidence(options = {}) {
  const evidenceRoot = resolve(options.evidenceRoot ?? defaultEvidenceRoot)
  const requiredPlatforms = options.requiredPlatforms ?? ['darwin', 'win32', 'linux']
  const discovered = await findReportFiles(evidenceRoot, options.reportPath)
  const artifacts = await Promise.all(discovered.files.map(async resultFile => {
    try {
      return inspectPackageReport(resultFile, evidenceRoot, JSON.parse(await readFile(resultFile, 'utf8')))
    } catch (error) {
      return { resultFile, path: 'untrusted/package-report.json', platform: 'unknown', arch: 'unknown', provenance: undefined, errors: [formatEvidenceFailure('invalid package report', error)] }
    }
  }))
  artifacts.sort((left, right) => left.path.localeCompare(right.path))
  const errors = [...discovered.errors, ...artifacts.flatMap(artifact => artifact.errors.map(message => `${artifact.path}: ${message}`))]
  for (const platform of requiredPlatforms) {
    const matches = artifacts.filter(artifact => artifact.platform === platform)
    check(matches.length === 1, errors, `${platform}: expected exactly one package report, found ${matches.length}`)
  }
  for (const key of sharedProvenanceKeys) {
    const values = new Set(artifacts.map(artifact => artifact.provenance?.[key]).filter(value => value !== undefined && value !== null))
    check(values.size === 1 && artifacts.length === requiredPlatforms.length, errors, `all package reports must share one ${key}`)
  }
  const remoteMobileDigests = new Set(artifacts.map(artifact => artifact.remoteMobileSha256).filter(Boolean))
  check(remoteMobileDigests.size === 1 && artifacts.length === requiredPlatforms.length, errors, 'all package reports must share one Remote Mobile SHA-256')
  const jobIds = new Set(artifacts.map(artifact => artifact.provenance?.jobId).filter(Boolean))
  check(jobIds.size === 1 && artifacts.length === requiredPlatforms.length, errors, 'all package reports must share one jobId')
  if (options.expectedSourceJob) check(jobIds.size === 1 && jobIds.has(options.expectedSourceJob), errors, `all package reports must come from job ${options.expectedSourceJob}`)
  const expectedProvenance = options.expectedProvenance ?? currentWorkflowProvenance(options.environment)
  if (expectedProvenance) {
    for (const key of sharedProvenanceKeys) {
      check(expectedProvenance[key] !== undefined && expectedProvenance[key] !== null && expectedProvenance[key] !== '', errors, `current workflow ${key} is unavailable`)
      for (const artifact of artifacts) check(artifact.provenance?.[key] === expectedProvenance[key], errors, `${artifact.path}: provenance.${key} does not match the current workflow run`)
    }
  }
  const aggregateProvenance = artifacts.length === requiredPlatforms.length && artifacts[0]?.provenance
    ? Object.fromEntries([...sharedProvenanceKeys, 'jobId'].map(key => [key, artifacts[0].provenance[key]]))
    : null
  const report = {
    schemaVersion: 2,
    status: errors.length === 0 ? 'passed' : 'failed',
    requiredPlatforms,
    provenance: aggregateProvenance,
    artifacts: artifacts.map(artifact => ({
      path: artifact.path,
      platform: artifact.platform,
      arch: artifact.arch,
      packageSha256: artifact.packageSha256,
      asarSha256: artifact.asarSha256,
      remoteMobileSha256: artifact.remoteMobileSha256,
      status: artifact.errors.length === 0 ? 'passed' : 'failed',
      errors: artifact.errors,
    })),
    errors,
  }
  if (options.reportPath && discovered.reportPathAllowed) {
    const reportPath = resolve(options.reportPath)
    await writeEvidenceReportAtomically(reportPath, report)
  }
  return report
}

function parseArguments(argumentsList) {
  const evidenceRoot = argumentsList.find(argument => !argument.startsWith('--')) ?? defaultEvidenceRoot
  const requiredPlatformsArgument = argumentsList.find(argument => argument.startsWith('--require-platforms='))
  const reportArgument = argumentsList.find(argument => argument.startsWith('--report='))
  return {
    evidenceRoot,
    requiredPlatforms: requiredPlatformsArgument?.slice('--require-platforms='.length).split(',').filter(Boolean) ?? ['darwin', 'win32', 'linux'],
    reportPath: reportArgument?.slice('--report='.length),
    expectedSourceJob: argumentsList.find(argument => argument.startsWith('--expected-source-job='))?.slice('--expected-source-job='.length),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await verifyDesktopPackageEvidence(parseArguments(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (report.status !== 'passed') process.exitCode = 1
}
