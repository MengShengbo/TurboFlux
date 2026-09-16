import { readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { formatEvidenceFailure, validateEvidenceReportOutputPath } from './evidence-report-output.mjs'

function check(condition, errors, message) {
  if (!condition) errors.push(message)
}

export function portableRelative(root, value) {
  return relative(root, value).split(sep).join('/')
}

const digestPattern = /^[a-f0-9]{64}$/u

export function isEvidenceRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeEvidenceIdentity(platform, arch, supportedPlatforms = ['darwin', 'win32']) {
  return {
    platform: supportedPlatforms.includes(platform) ? platform : 'unknown',
    arch: ['arm64', 'x64'].includes(arch) ? arch : 'unknown',
  }
}

export function sanitizePackageEvidence(value, options = {}) {
  if (!digestPattern.test(value?.packageSha256) || !digestPattern.test(value?.asarSha256)) return null
  const sanitized = { packageSha256: value.packageSha256, asarSha256: value.asarSha256 }
  if (!options.includeRemoteMobileSha256) return sanitized
  return digestPattern.test(value?.remoteMobileSha256)
    ? { ...sanitized, remoteMobileSha256: value.remoteMobileSha256 }
    : null
}

export function rejectUnexpectedKeys(value, allowedKeys, errors, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  check(Object.keys(value).every(key => allowedKeys.includes(key)), errors, `${label} contains unexpected fields`)
}

export async function discoverEvidenceResultFiles(evidenceRoot, errors) {
  const root = resolve(evidenceRoot)
  let rootEntries
  try {
    rootEntries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    errors.push(formatEvidenceFailure('evidence discovery failed', error))
    return []
  }
  const discoveries = await Promise.all(rootEntries.filter(entry => entry.isDirectory() && /^(?:darwin|win32|linux)-(?:arm64|x64)$/u.test(entry.name)).map(async entry => {
    const directory = join(root, entry.name)
    try {
      const entries = await readdir(directory, { withFileTypes: true })
      const result = entries.find(candidate => candidate.name === 'result.json' && candidate.isFile())
      return result ? join(directory, result.name) : undefined
    } catch (error) {
      errors.push(formatEvidenceFailure('artifact evidence discovery failed', error))
      return undefined
    }
  }))
  return discoveries.filter(Boolean)
}

export async function verifyEvidenceArtifactLayout(options) {
  const evidenceRoot = resolve(options.evidenceRoot)
  const reportPath = options.reportPath ? resolve(options.reportPath) : undefined
  const reportPathAllowed = validateEvidenceReportOutputPath(evidenceRoot, reportPath, options.errors)
  const artifactDirectories = new Set(options.resultFiles.map(resultFile => dirname(resultFile)))
  let rootEntries = []
  try {
    rootEntries = await readdir(evidenceRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') options.errors.push(formatEvidenceFailure('evidence root cannot be read', error))
  }
  for (const resultFile of options.resultFiles) {
    check(dirname(dirname(resultFile)) === evidenceRoot, options.errors, 'result.json must be in a direct artifact directory')
  }
  for (const entry of rootEntries) {
    const path = join(evidenceRoot, entry.name)
    const allowedDirectory = entry.isDirectory() && artifactDirectories.has(path)
    const allowedReport = entry.isFile() && path === reportPath
    if (!allowedDirectory && !allowedReport) options.errors.push('unexpected evidence root entry')
  }
  await Promise.all([...artifactDirectories].map(async directory => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      options.errors.push(`${portableRelative(evidenceRoot, directory)}: ${formatEvidenceFailure('evidence directory cannot be read', error)}`)
      return
    }
    const available = new Set()
    for (const entry of entries) {
      if (entry.isFile() && options.allowedArtifactEntries.has(entry.name)) available.add(entry.name)
      else options.errors.push(`${portableRelative(evidenceRoot, directory)}: unexpected evidence entry`)
    }
    for (const name of options.allowedArtifactEntries) {
      if (!available.has(name)) options.errors.push(`${portableRelative(evidenceRoot, directory)}: missing evidence entry: ${name}`)
    }
  }))
  return { reportPathAllowed }
}
