import { writeEvidenceFileAtomically, writeEvidenceReportAtomically } from './evidence-report-output.mjs'

const unsafeCredentialPattern = /(?:file:\/\/|\b(?:token|secret|password|api[_-]?key|authorization)\b\s*[:=]|\bbearer\s+[A-Za-z0-9._~+/-]+)/iu
const webUrlPattern = /https?:\/\/[^\s<>"']+/giu
const webUrlDetectionPattern = /https?:\/\//iu
const embeddedWindowsPathPattern = /[A-Za-z]:[\\/][^\s,;；)\]}"']+/gu
const embeddedUnixPathPattern = /\/(?:Users|private|var|tmp|home|workspace|Volumes|Applications|Library|System|opt|mnt|etc|root)(?:\/[^\s,;；)\]}"']*)?/gu
const windowsPathPattern = /(^|[\s:：([{'"])[A-Za-z]:[\\/][^\s,;；)\]}"']+/gu
const unixPathPattern = /(^|[\s:：([{'"])\/[^\s,;；)\]}"']+/gu
const embeddedWindowsPathDetectionPattern = /[A-Za-z]:[\\/]/u
const embeddedUnixPathDetectionPattern = /\/(?:Users|private|var|tmp|home|workspace|Volumes|Applications|Library|System|opt|mnt|etc|root)(?:\/|$)/u
const windowsPathDetectionPattern = /(?:^|[\s:：([{'"])[A-Za-z]:[\\/]/u
const unixPathDetectionPattern = /(?:^|[\s:：([{'"])\//u
const allowedApiRoutePattern = /^\/v1\/[A-Za-z0-9._/-]+$/u
const fixedUnsafeFailure = 'Source evidence report rejected unsafe metadata'

function sanitizeString(value, path) {
  if (value.length > 100_000 || unsafeCredentialPattern.test(value)) throw new Error(fixedUnsafeFailure)
  let sanitized = value.replace(webUrlPattern, '[URL]')
  sanitized = sanitized.replace(embeddedWindowsPathPattern, '[PATH]')
  sanitized = sanitized.replace(embeddedUnixPathPattern, '[PATH]')
  sanitized = sanitized.replace(windowsPathPattern, '$1[PATH]')
  sanitized = sanitized.replace(unixPathPattern, (match, prefix) => {
    const candidate = match.slice(prefix.length)
    const isApiRoute = path.length === 3
      && path[0] === 'modelRequests'
      && path[1] === 'paths'
      && allowedApiRoutePattern.test(candidate)
    return isApiRoute ? match : `${prefix}[PATH]`
  })
  sanitized = [...sanitized].map(character => {
    const codePoint = character.codePointAt(0)
    return (codePoint < 32 && !['\n', '\r', '\t'].includes(character)) || codePoint === 127 ? ' ' : character
  }).join('')
  if (unsafeCredentialPattern.test(sanitized) || webUrlDetectionPattern.test(sanitized)) throw new Error(fixedUnsafeFailure)
  return sanitized
}

export function sanitizeSourceEvidenceReport(report) {
  const seen = new WeakSet()
  let nodes = 0
  const visit = (value, path, depth) => {
    nodes += 1
    if (nodes > 50_000 || depth > 32) throw new Error(fixedUnsafeFailure)
    if (typeof value === 'string') return sanitizeString(value, path)
    if (value === null || typeof value === 'boolean' || typeof value === 'undefined') return value
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(fixedUnsafeFailure)
      return value
    }
    if (typeof value !== 'object' || seen.has(value)) throw new Error(fixedUnsafeFailure)
    seen.add(value)
    if (Array.isArray(value)) return value.map((item, index) => visit(item, [...path, index], depth + 1))
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error(fixedUnsafeFailure)
    const output = {}
    for (const [key, item] of Object.entries(value)) {
      if (unsafeCredentialPattern.test(key)
        || webUrlDetectionPattern.test(key)
        || embeddedWindowsPathDetectionPattern.test(key)
        || embeddedUnixPathDetectionPattern.test(key)
        || windowsPathDetectionPattern.test(key)
        || unixPathDetectionPattern.test(key)) throw new Error(fixedUnsafeFailure)
      output[key] = visit(item, [...path, key], depth + 1)
    }
    return output
  }
  return visit(report, [], 0)
}

export function projectEvidenceFields(value, schema) {
  if (schema === true) return value
  if (Array.isArray(schema)) return Array.isArray(value) ? value.map(item => projectEvidenceFields(item, schema[0])) : value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(schema)
    .filter(([key]) => Object.hasOwn(value, key))
    .map(([key, childSchema]) => [key, projectEvidenceFields(value[key], childSchema)]))
}

export async function writeSourceEvidenceReportAtomically(reportPath, report) {
  const sanitized = sanitizeSourceEvidenceReport(report)
  await writeEvidenceReportAtomically(reportPath, sanitized)
  return sanitized
}

export async function writeSourceEvidenceTextAtomically(path, contents) {
  const sanitized = sanitizeSourceEvidenceReport({ contents }).contents
  await writeEvidenceFileAtomically(path, sanitized)
  return sanitized
}
