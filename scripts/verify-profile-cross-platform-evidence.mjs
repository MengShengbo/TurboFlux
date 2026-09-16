import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isEvidenceRecord, normalizeEvidenceIdentity, portableRelative, rejectUnexpectedKeys } from './evidence-artifact-layout.mjs'
import { formatEvidenceFailure, writeEvidenceReportAtomically } from './evidence-report-output.mjs'
import { verifyCrossPlatformGithubProvenance } from './github-actions-provenance.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultEvidenceRoot = join(repositoryRoot, 'apps', 'desktop', 'generated', 'profile-smoke')
const requiredBooleanEvidence = [
  'encryptedArchive',
  'importedProfileCreated',
  'originalProfilePreserved',
  'workspaceInitiallyUnbound',
  'executionBlockedBeforeRebind',
  'workspaceRebound',
  'historicalEventsPreserved',
  'importedHistorySearchable',
  'agentContinuedInReboundWorkspace',
  'continuedConversationSearchable',
  'automationRemainedDisabled',
  'safeDraftMigrated',
  'activeInteractionStateDiscarded',
]

function check(condition, errors, message) {
  if (!condition) errors.push(message)
}

async function findResultFiles(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    return {
      files: [],
      errors: error?.code === 'ENOENT' ? [] : [formatEvidenceFailure('profile evidence discovery failed', error)],
    }
  }
  const discovered = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return findResultFiles(path)
    return {
      files: entry.isFile() && /^result-[^.]+-[^.]+\.json$/u.test(entry.name) ? [path] : [],
      errors: [],
    }
  }))
  return {
    files: discovered.flatMap(result => result.files),
    errors: discovered.flatMap(result => result.errors),
  }
}

async function inspectResult(resultFile) {
  const errors = []
  let result
  try {
    result = JSON.parse(await readFile(resultFile, 'utf8'))
  } catch (error) {
    return { resultFile, platform: 'unknown', arch: 'unknown', errors: [formatEvidenceFailure('invalid profile smoke result', error)] }
  }
  if (!isEvidenceRecord(result)) return { resultFile, platform: 'unknown', arch: 'unknown', errors: ['result.json must be an object'] }
  rejectUnexpectedKeys(result, ['schemaVersion', 'platform', 'arch', 'provenance', 'encryptedArchive', 'archiveSha256', 'archiveBytes', 'componentCount', 'importedProfileCreated', 'originalProfilePreserved', 'workspaceInitiallyUnbound', 'executionBlockedBeforeRebind', 'workspaceRebound', 'historicalEventsPreserved', 'importedHistorySearchable', 'agentContinuedInReboundWorkspace', 'continuedConversationSearchable', 'automationRemainedDisabled', 'conversationTurnsVerified', 'safeDraftMigrated', 'activeInteractionStateDiscarded'], errors, 'profile smoke result')
  const identity = normalizeEvidenceIdentity(result.platform, result.arch, ['darwin', 'win32', 'linux'])
  const platform = identity.platform
  const arch = identity.arch
  check(result.schemaVersion === 2, errors, 'schemaVersion must be 2')
  check(platform !== 'unknown', errors, 'unsupported platform')
  check(arch !== 'unknown', errors, 'unsupported architecture')
  check(typeof result.archiveSha256 === 'string' && /^[a-f0-9]{64}$/u.test(result.archiveSha256), errors, 'archive SHA-256 is invalid')
  check(Number.isSafeInteger(result.archiveBytes) && result.archiveBytes > 0, errors, 'archive byte count is invalid')
  check(Number.isSafeInteger(result.componentCount) && result.componentCount >= 1, errors, 'component count is invalid')
  check(Number.isSafeInteger(result.conversationTurnsVerified) && result.conversationTurnsVerified >= 2, errors, 'conversation history was not fully verified')
  for (const field of requiredBooleanEvidence) check(result[field] === true, errors, `${field} evidence is missing or false`)
  return { resultFile, platform, arch, provenance: result.provenance, errors }
}

export async function verifyProfileCrossPlatformEvidence(options = {}) {
  const evidenceRoot = resolve(options.evidenceRoot ?? defaultEvidenceRoot)
  const requiredPlatforms = options.requiredPlatforms ?? ['darwin', 'win32', 'linux']
  const discovered = await findResultFiles(evidenceRoot)
  const resultFiles = discovered.files
  const artifacts = await Promise.all(resultFiles.map(inspectResult))
  const errors = [
    ...discovered.errors,
    ...artifacts.flatMap(artifact => artifact.errors.map(message => `${portableRelative(evidenceRoot, artifact.resultFile)}: ${message}`)),
  ]
  for (const platform of requiredPlatforms) {
    const matches = artifacts.filter(artifact => artifact.platform === platform)
    check(matches.length === 1, errors, `${platform}: expected exactly one profile smoke result, found ${matches.length}`)
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
  const report = {
    schemaVersion: 2,
    status: errors.length === 0 ? 'passed' : 'failed',
    requiredPlatforms,
    provenance,
    artifacts: artifacts.map(artifact => ({
      path: portableRelative(evidenceRoot, artifact.resultFile),
      platform: artifact.platform,
      arch: artifact.arch,
      status: artifact.errors.length === 0 ? 'passed' : 'failed',
      errors: artifact.errors,
    })),
    errors,
  }
  if (options.reportPath) {
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
  const report = await verifyProfileCrossPlatformEvidence(parseArguments(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (report.status !== 'passed') process.exitCode = 1
}
