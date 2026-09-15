/**
 * Path resolution and normalization utilities for the agent engine.
 *
 * These functions handle cross-platform path resolution and relative path
 * conversion. Extracted from agentEngine.ts
 * to keep the engine focused on orchestration.
 */

/**
 * Normalize a path: forward slashes, collapse `.` and `..` segments.
 */
export function normalizePath(p: string): string {
  const normalized = p.replace(/\\/g, '/').replace(/\/+/g, '/')
  const segments = normalized.split('/')
  const resolved: string[] = []
  for (const seg of segments) {
    if (seg === '..') {
      if (resolved.length > 0) {
        resolved.pop()
      }
    } else if (seg !== '.' && seg !== '') {
      resolved.push(seg)
    }
  }
  const result = resolved.join('/')
  return normalized.startsWith('/') ? '/' + result : result
}

/**
 * Resolve a relative (or absolute) path against a workspace base path.
 *
 * Handles common AI model quirks:
 * - Prefixing relative paths with `/` on Windows
 * - Using backslashes vs forward slashes
 * - `./` prefix
 */
export function resolvePath(basePath: string, relativePath: string): string {
  const normalizedBase = basePath.replace(/\\/g, '/')

  // Treat as absolute when the path starts with `/`, a Windows drive letter
  // followed by `\` OR `/` (e.g. `C:\foo`, `C:/foo`), or a UNC `\\server\` /
  // `//server/`. The previous regex only matched the backslash form, which
  // let `C:/Users/...` slip through as a relative path and get joined onto
  // the workspace root.
  //
  // EXCEPTION: On Windows, a bare `/src/...` (no drive letter) is almost
  // certainly a relative path the AI model prefixed with `/` by mistake
  // (common for models trained on Unix). Treat it as relative.
  const isWindowsEnv = /^[A-Za-z]:/.test(normalizedBase)
  const startsWithSlash = relativePath.startsWith('/')
  const hasDriveLetter = /^[A-Za-z]:[\\/]/.test(relativePath)
  const isUNC = /^\\\\/.test(relativePath) || /^\/\//.test(relativePath)

  const isAbsolute = hasDriveLetter || isUNC || (startsWithSlash && !isWindowsEnv)

  if (isAbsolute) {
    return normalizePath(relativePath)
  }

  // Strip leading `/` or `./` — AI models often prefix relative paths with
  // these on Windows.
  const normalizedRelative = relativePath.replace(/\\/g, '/').replace(/^\.?\/+/, '')
  const resolvedPath = `${normalizedBase}/${normalizedRelative}`
  const normalizedResolved = normalizePath(resolvedPath)
  return normalizedResolved
}

/**
 * Convert an absolute path to a workspace-relative path.
 * Returns the path relative to basePath, or the normalized absolute path
 * if it cannot be made relative (should not happen in normal operation).
 */
export function toWorkspaceRelative(basePath: string, filePath: string): string {
  const normalizedBase = normalizePath(basePath.replace(/\\/g, '/'))
  const normalizedFile = normalizePath(filePath.replace(/\\/g, '/'))
  const isWindows = /^[A-Za-z]:/.test(normalizedBase)
  const a = isWindows ? normalizedFile.toLowerCase() : normalizedFile
  const b = isWindows ? normalizedBase.toLowerCase() : normalizedBase
  if (a === b) return '.'
  if (a.startsWith(b + '/')) {
    return normalizedFile.slice(normalizedBase.length + 1)
  }
  return normalizedFile
}
