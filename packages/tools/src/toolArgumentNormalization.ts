export interface ToolArgumentNormalizationOptions {
  workspacePath: string
  isFile(path: string): boolean
  resolvePath(basePath: string, path: string): string
}

export function normalizeBuiltInToolArguments(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  _options: ToolArgumentNormalizationOptions,
): Record<string, unknown> {
  const normalized = { ...args }

  if (toolName === 'list_directory') {
    const path = typeof normalized.path === 'string' ? normalized.path.trim() : ''
    normalized.path = path || '.'
    return normalized
  }

  if (toolName !== 'search_content') return normalized

  if (typeof normalized.glob === 'string' && !normalized.file_pattern) {
    normalized.file_pattern = normalized.glob
  }
  delete normalized.glob

  const searchPath = typeof normalized.path === 'string' ? normalized.path.trim() : ''
  normalized.path = searchPath || '.'
  return normalized
}
