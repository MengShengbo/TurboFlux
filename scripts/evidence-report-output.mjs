import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const filesystemFailureCategories = new Map([
  ['ENOENT', 'not-found'],
  ['EACCES', 'permission-denied'],
  ['EPERM', 'permission-denied'],
  ['ENOTDIR', 'invalid-path'],
  ['EISDIR', 'invalid-path'],
  ['ELOOP', 'symbolic-link-loop'],
  ['EMFILE', 'resource-exhausted'],
  ['ENFILE', 'resource-exhausted'],
])

export function formatEvidenceFailure(label, error) {
  const category = error instanceof SyntaxError
    ? 'invalid-json'
    : filesystemFailureCategories.get(error?.code) ?? 'unexpected-error'
  return `${label} (${category})`
}

export function validateEvidenceReportOutputPath(evidenceRoot, reportPath, errors) {
  if (!reportPath) return true
  const root = resolve(evidenceRoot)
  const output = resolve(reportPath)
  const relativePath = relative(root, output)
  const insideRoot = relativePath === ''
    || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
  if (!insideRoot || dirname(output) === root) return true
  errors.push('aggregate report path must be a direct file in the evidence root')
  return false
}

export async function writeEvidenceFileAtomically(path, contents) {
  const output = resolve(path)
  const directory = dirname(output)
  await mkdir(directory, { recursive: true })
  const temporaryPath = join(directory, `.${basename(output)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporaryPath, contents, { flag: 'wx', mode: 0o600 })
    await rename(temporaryPath, output)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

export async function writeEvidenceReportAtomically(reportPath, report) {
  await writeEvidenceFileAtomically(reportPath, `${JSON.stringify(report, null, 2)}\n`)
}
