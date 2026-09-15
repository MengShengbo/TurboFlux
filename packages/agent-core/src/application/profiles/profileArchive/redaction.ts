import { isAbsolute, relative, sep } from 'node:path'

export interface ExportWorkspacePath {
  id: string
  localPath?: string
}

export interface ExportRedactionPolicy {
  version: 1
  workspaces: ExportWorkspacePath[]
  allowSecrets: boolean
}

const SECRET_KEY_PATTERN = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|passwd|secret|cookie|private[-_]?key|client[-_]?secret|webhook[-_]?secret)/iu
const DEVICE_KEY_PATTERN = /^(?:installationId|remoteIdentity|pairedDevices|grants|controlLeases|browserSession|terminalPid|windowBounds|debugPort)$/u
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}\b/giu,
  /\bsk-[A-Za-z0-9_-]{12,}\b/gu,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s,"']{8,}/giu,
]
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\(?:[^\s<>:"|?*]+\\)*[^\s<>:"|?*]*/gu
const UNIX_HOME_PATH_PATTERN = /\/(?:Users|home|private|tmp|var\/folders)\/[A-Za-z0-9._~+@/-]+/gu

function workspaceUri(workspaceId: string, child: string): string {
  const suffix = child.split(sep).join('/').replace(/^\/+/, '')
  return suffix ? `workspace://${workspaceId}/${suffix}` : `workspace://${workspaceId}`
}

function replaceKnownPaths(value: string, workspaces: ExportWorkspacePath[]): string {
  let result = value
  for (const workspace of workspaces) {
    if (!workspace.localPath) continue
    const root = workspace.localPath.replace(/[\\/]+$/u, '')
    result = result.split(root).join(`workspace://${workspace.id}`)
    if (value === workspace.localPath) return workspaceUri(workspace.id, '')
  }
  return result
}

export function virtualizeExportPath(value: string, workspaces: ExportWorkspacePath[]): string {
  for (const workspace of workspaces) {
    if (!workspace.localPath) continue
    const child = relative(workspace.localPath, value)
    if (!child || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))) return workspaceUri(workspace.id, child)
  }
  return '<local-path-removed>'
}

export function redactExportText(value: string, policy: ExportRedactionPolicy): string {
  let result = replaceKnownPaths(value.normalize('NFC'), policy.workspaces)
  if (!policy.allowSecrets) {
    for (const pattern of SECRET_VALUE_PATTERNS) result = result.replace(pattern, '[secret-redacted]')
  }
  result = result.replace(WINDOWS_PATH_PATTERN, '<local-path-removed>')
  result = result.replace(UNIX_HOME_PATH_PATTERN, '<local-path-removed>')
  return result
}

export function redactExportValue(value: unknown, policy: ExportRedactionPolicy, key = ''): unknown {
  if (DEVICE_KEY_PATTERN.test(key)) return undefined
  if (!policy.allowSecrets && SECRET_KEY_PATTERN.test(key)) return ''
  if (typeof value === 'string') {
    if (/path$/iu.test(key) && (isAbsolute(value) || WINDOWS_PATH_PATTERN.test(value))) {
      WINDOWS_PATH_PATTERN.lastIndex = 0
      return virtualizeExportPath(value, policy.workspaces)
    }
    WINDOWS_PATH_PATTERN.lastIndex = 0
    return redactExportText(value, policy)
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) return value.map(item => redactExportValue(item, policy)).filter(item => item !== undefined)
  if (!value || typeof value !== 'object') return undefined
  const result: Record<string, unknown> = {}
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    const redacted = redactExportValue(child, policy, childKey)
    if (redacted !== undefined) result[childKey] = redacted
  }
  return result
}

export function containsForbiddenExportData(value: string): boolean {
  WINDOWS_PATH_PATTERN.lastIndex = 0
  return WINDOWS_PATH_PATTERN.test(value)
    || UNIX_HOME_PATH_PATTERN.test(value)
    || SECRET_VALUE_PATTERNS.some(pattern => {
      pattern.lastIndex = 0
      return pattern.test(value)
    })
    || /"(?:installationId|remoteIdentity|pairedDevices|controlLeases)"\s*:/u.test(value)
}
