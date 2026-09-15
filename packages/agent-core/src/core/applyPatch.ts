export type ApplyPatchOperation =
  | {
      kind: 'add'
      path: string
      content: string
    }
  | {
      kind: 'delete'
      path: string
    }
  | {
      kind: 'update'
      path: string
      moveTo?: string
      hunks: ApplyPatchHunk[]
    }

export interface ApplyPatchHunk {
  header: string
  lines: string[]
}

export const MAX_APPLY_PATCH_CHARS = 1_000_000
export const MAX_APPLY_PATCH_OPERATIONS = 200
export const MAX_APPLY_PATCH_HUNKS = 1_000
export const MAX_APPLY_PATCH_LINE_CHARS = 256_000

export function parseApplyPatch(source: string): ApplyPatchOperation[] {
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new Error('Patch must be a non-empty string')
  }
  if (source.length > MAX_APPLY_PATCH_CHARS) {
    throw new Error(`Patch exceeds the ${MAX_APPLY_PATCH_CHARS.toLocaleString()} character limit`)
  }

  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0] !== '*** Begin Patch') {
    throw new Error("Patch must start with '*** Begin Patch'")
  }
  if (lines[lines.length - 1] === '') lines.pop()
  if (lines[lines.length - 1] !== '*** End Patch') {
    throw new Error("Patch must end with '*** End Patch'")
  }

  const operations: ApplyPatchOperation[] = []
  const seenPaths = new Set<string>()
  let index = 1
  while (index < lines.length - 1) {
    if (operations.length >= MAX_APPLY_PATCH_OPERATIONS) {
      throw new Error(`Patch exceeds the ${MAX_APPLY_PATCH_OPERATIONS} file operation limit`)
    }
    const header = lines[index]
    const match = header.match(/^\*\*\* (Add|Delete|Update) File: (.+)$/)
    if (!match) throw new Error(`Invalid patch header on line ${index + 1}: ${header || '(empty)'}`)

    const kind = match[1].toLowerCase() as 'add' | 'delete' | 'update'
    const path = match[2].trim()
    if (!path) throw new Error(`Patch path is empty on line ${index + 1}`)
    const pathKey = path.replace(/\\/g, '/').toLowerCase()
    if (seenPaths.has(pathKey)) throw new Error(`Patch contains duplicate file path: ${path}`)
    seenPaths.add(pathKey)
    index += 1

    if (kind === 'add') {
      const contentLines: string[] = []
      while (index < lines.length - 1 && !isFileHeader(lines[index])) {
        const line = lines[index]
        if (line.length > MAX_APPLY_PATCH_LINE_CHARS) {
          throw new Error(`Patch line ${index + 1} exceeds the ${MAX_APPLY_PATCH_LINE_CHARS.toLocaleString()} character limit`)
        }
        if (!line.startsWith('+')) {
          throw new Error(`Add file content must use '+' prefixes on line ${index + 1}`)
        }
        contentLines.push(line.slice(1))
        index += 1
      }
      operations.push({ kind, path, content: withTrailingNewline(contentLines.join('\n')) })
      continue
    }

    if (kind === 'delete') {
      if (index < lines.length - 1 && !isFileHeader(lines[index])) {
        throw new Error(`Delete file entry cannot contain content on line ${index + 1}`)
      }
      operations.push({ kind, path })
      continue
    }

    let moveTo: string | undefined
    if (index < lines.length - 1 && lines[index].startsWith('*** Move to:')) {
      moveTo = lines[index].slice('*** Move to:'.length).trim()
      if (!moveTo) throw new Error(`Move destination is empty on line ${index + 1}`)
      index += 1
    }

    const hunks: ApplyPatchHunk[] = []
    while (index < lines.length - 1 && !isFileHeader(lines[index])) {
      const hunkHeader = lines[index]
      if (!hunkHeader.startsWith('@@')) {
        throw new Error(`Update file hunk must start with '@@' on line ${index + 1}`)
      }
      index += 1
      const hunkLines: string[] = []
      while (index < lines.length - 1 && !isFileHeader(lines[index]) && !lines[index].startsWith('@@')) {
        const line = lines[index]
        if (line.length > MAX_APPLY_PATCH_LINE_CHARS) {
          throw new Error(`Patch line ${index + 1} exceeds the ${MAX_APPLY_PATCH_LINE_CHARS.toLocaleString()} character limit`)
        }
        if (!line.startsWith(' ') && !line.startsWith('+') && !line.startsWith('-')) {
          throw new Error(`Invalid patch line on line ${index + 1}: ${line || '(empty)'}`)
        }
        hunkLines.push(line)
        index += 1
      }
      if (hunkLines.length === 0 || !hunkLines.some(line => line.startsWith('+') || line.startsWith('-'))) {
        throw new Error(`Update hunk on line ${index} must contain an addition or deletion`)
      }
      if (hunks.length >= MAX_APPLY_PATCH_HUNKS) {
        throw new Error(`Patch exceeds the ${MAX_APPLY_PATCH_HUNKS.toLocaleString()} hunk limit`)
      }
      hunks.push({ header: hunkHeader, lines: hunkLines })
    }
    if (hunks.length === 0) throw new Error(`Update file '${path}' has no hunks`)
    operations.push({ kind, path, ...(moveTo ? { moveTo } : {}), hunks })
  }

  if (operations.length === 0) throw new Error('Patch contains no file operations')
  return operations
}

export function applyPatchHunks(original: string, hunks: ApplyPatchHunk[], path: string): string {
  const normalized = original.replace(/\r\n?/g, '\n')
  let lines = splitLines(normalized)

  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter(line => line.startsWith(' ') || line.startsWith('-')).map(line => line.slice(1))
    const newLines = hunk.lines.filter(line => line.startsWith(' ') || line.startsWith('+')).map(line => line.slice(1))
    const start = findUniqueSequence(lines, oldLines, path, hunk.header)
    lines = [...lines.slice(0, start), ...newLines, ...lines.slice(start + oldLines.length)]
  }

  return withTrailingNewline(lines.join('\n'))
}

export function applyPatchAdd(content: string): string {
  return withTrailingNewline(content.replace(/\r\n?/g, '\n').replace(/\n$/, ''))
}

function isFileHeader(line: string): boolean {
  return /^\*\*\* (?:Add|Delete|Update) File: /.test(line) || line === '*** End Patch'
}

function splitLines(content: string): string[] {
  if (content === '') return []
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function withTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`
}

function findUniqueSequence(lines: string[], expected: string[], path: string, header: string): number {
  if (expected.length === 0) {
    const location = parseHunkStart(header)
    return location === undefined ? lines.length : Math.min(location, lines.length)
  }

  const matches: number[] = []
  for (let index = 0; index <= lines.length - expected.length; index += 1) {
    if (expected.every((line, offset) => lines[index + offset] === line)) matches.push(index)
  }
  if (matches.length === 0) {
    throw new Error(`Failed to find expected lines in ${path}:\n${expected.join('\n')}`)
  }
  if (matches.length > 1) {
    throw new Error(`Patch context is ambiguous in ${path}: found ${matches.length} matching locations for ${header}`)
  }
  return matches[0]
}

function parseHunkStart(header: string): number | undefined {
  const match = header.match(/^@@(?: -([0-9]+)(?:,[0-9]+)?(?: \+[0-9]+(?:,[0-9]+)?)?)?/)
  if (!match?.[1]) return undefined
  return Math.max(0, Number(match[1]) - 1)
}
