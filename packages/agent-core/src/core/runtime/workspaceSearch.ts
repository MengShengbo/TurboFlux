import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { basename, dirname, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { rgPath } from '@vscode/ripgrep'
import { Minimatch } from 'minimatch'
import type { Result, SearchContentOptions, SearchContentPage, SearchFilesOptions, SearchFilesPage } from '../../tools/executor'

const execFileAsync = promisify(execFile)
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024
const MAX_PAGE_CHARS = 24_000
const INTERNAL_DIRECTORIES = ['.git', '.hg', '.svn', '.turboflux']
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template', '.env.defaults'])

function searchable(path: string): boolean {
  const name = basename(path).toLowerCase()
  return !name.startsWith('.env') || ENV_TEMPLATES.has(name)
}

function searchArguments(includeIgnored: boolean): string[] {
  return [
    '--no-config', '--hidden', '--no-require-git', '--sort=path',
    ...(includeIgnored ? ['--no-ignore'] : []),
    ...INTERNAL_DIRECTORIES.map(directory => `--glob=!**/${directory}/**`),
  ]
}

function globMatcher(pattern: string): Minimatch {
  return new Minimatch(pattern.replace(/\\/g, '/'), { dot: true, matchBase: true, nonegate: true, nocomment: true })
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value!))) : fallback
}

async function capture(args: string[], cwd: string, signal?: AbortSignal): Promise<{ output: string; complete: boolean; warning?: string }> {
  type SearchProcessError = Error & { code?: string | number; stdout?: string; stderr?: string; killed?: boolean }
  try {
    const packagedPath = rgPath.replace(/\.asar([\\/])/, '.asar.unpacked$1')
    const executable = process.platform === 'win32' && !/\.exe$/i.test(packagedPath) ? `${packagedPath}.exe` : packagedPath
    const { stdout } = await execFileAsync(executable, args, {
      cwd, signal, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: MAX_CAPTURE_BYTES,
    })
    return { output: stdout, complete: true }
  } catch (error) {
    const failure = error as SearchProcessError
    if (signal?.aborted || failure.code === 'ABORT_ERR') throw new Error('Search cancelled', { cause: error })
    if (failure.code === 1) return { output: String(failure.stdout || ''), complete: true }
    const output = String(failure.stdout || '')
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || failure.killed || (failure.code === 2 && output)) {
      const reason = failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        ? 'output budget reached'
        : failure.killed ? 'time budget reached' : 'some paths could not be searched'
      return { output, complete: false, warning: `Search incomplete: ${reason}. Narrow the path or pattern; these results do not cover the full scope.` }
    }
    throw new Error(String(failure.stderr || failure.message || failure).trim(), { cause: error })
  }
}

function page<T, U>(items: T[], options: { offset?: number; limit?: number }, complete: boolean, project: (item: T) => U, size: (item: U) => number) {
  const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER)
  const limit = boundedInteger(options.limit, 50, 1, 500)
  const selected: U[] = []
  let chars = 0
  for (const source of items.slice(offset, offset + limit)) {
    const item = project(source)
    const itemChars = size(item)
    if (selected.length > 0 && chars + itemChars > MAX_PAGE_CHARS) break
    selected.push(item)
    chars += itemChars
  }
  const hasMore = offset + selected.length < items.length
  return {
    selected, offset, limit, totalMatches: items.length, totalIsExact: complete,
    truncated: hasMore || !complete,
    ...(hasMore ? { nextOffset: offset + selected.length } : {}),
  }
}

export async function searchWorkspaceFiles(pattern: string, scope: string, options: SearchFilesOptions = {}): Promise<Result<SearchFilesPage>> {
  try {
    if (!pattern.trim()) throw new Error('File search pattern is required')
    if (!statSync(scope).isDirectory()) throw new Error('File search path must be a directory')
    const matcher = globMatcher(pattern)
    // Filtering the inventory preserves ignore rules. Positive rg --glob flags override them.
    const captured = await capture([...searchArguments(options.includeIgnored === true), '--files', '--null', '--', '.'], scope, options.signal)
    const records = captured.output.split('\0')
    records.pop()
    const files = records.filter(path => searchable(path) && matcher.match(path.replace(/\\/g, '/').replace(/^\.\//, ''))).map(path => resolve(scope, path))
    const { selected, ...pagination } = page(files, options, captured.complete, path => path, path => path.length + 1)
    return { success: true, data: { matches: selected, ...pagination, ...(captured.warning ? { warning: captured.warning } : {}) } }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

interface SearchEvent {
  type: 'match' | 'context'
  file: string
  line: number
  endLine: number
  text: string
}

function rgText(value: { text?: string; bytes?: string } | undefined): string {
  return value?.text ?? (value?.bytes ? Buffer.from(value.bytes, 'base64').toString('utf8') : '')
}

export async function searchWorkspaceContent(
  pattern: string, scope: string, filePattern?: string, caseInsensitive = true, options: SearchContentOptions = {},
): Promise<Result<SearchContentPage>> {
  try {
    if (!pattern) throw new Error('Content search pattern is required')
    const fileScope = statSync(scope).isFile()
    if (fileScope && !searchable(scope)) throw new Error('Environment secrets are excluded from search')
    const cwd = fileScope ? dirname(scope) : scope
    const target = fileScope ? basename(scope) : '.'
    const outputMode = options.outputMode || 'content'
    const before = boundedInteger(options.contextBefore, 0, 0, 20)
    const after = boundedInteger(options.contextAfter, 0, 0, 20)
    const maxColumns = boundedInteger(options.maxColumns, 500, 120, 2_000)
    const matcher = filePattern ? globMatcher(filePattern) : undefined
    const args = searchArguments(options.includeIgnored === true)
    args.push(outputMode === 'files' ? '--files-with-matches' : '--json')
    if (outputMode === 'files') args.push('--null')
    if (caseInsensitive) args.push('--ignore-case')
    if (options.fixedStrings) args.push('--fixed-strings')
    if (options.multiline) args.push('--multiline', '--multiline-dotall')
    if (options.fileType) args.push('--type', options.fileType)
    else if (filePattern && !filePattern.includes('/')) args.push('--type-add', `turboflux:${filePattern}`, '--type', 'turboflux')
    if (outputMode === 'content') args.push('-B', String(before), '-A', String(after))
    args.push('--', pattern, target)
    const captured = await capture(args, cwd, options.signal)
    const accepts = (path: string) => searchable(path) && (!matcher || matcher.match(relative(cwd, path).replace(/\\/g, '/')))
    if (outputMode === 'files') {
      const records = captured.output.split('\0')
      records.pop()
      const files = records.map(path => ({ file: resolve(cwd, path) })).filter(item => accepts(item.file))
      const { selected, ...pagination } = page(files, options, captured.complete, item => item, item => item.file.length + 1)
      return { success: true, data: { hits: [], files: selected, outputMode, ...pagination, ...(captured.warning ? { warning: captured.warning } : {}) } }
    }

    const events: SearchEvent[] = []
    let complete = captured.complete
    let warning = captured.warning
    const records = captured.output.split('\n')
    records.pop()
    for (const record of records) {
      if (!record) continue
      try {
        const event = JSON.parse(record)
        if (event.type !== 'match' && event.type !== 'context') continue
        const file = resolve(cwd, rgText(event.data.path))
        if (!accepts(file)) continue
        const line = Number(event.data.line_number)
        if (!Number.isFinite(line)) throw new Error('Missing match line')
        const text = rgText(event.data.lines).replace(/\r?\n$/, '')
        events.push({ type: event.type, file, line, endLine: line + text.split('\n').length - 1, text })
      } catch {
        complete = false
        warning = 'Search incomplete: a result could not be decoded. Narrow the query before drawing conclusions.'
      }
    }
    const matches = events.filter(event => event.type === 'match')
    if (outputMode === 'count') {
      const counts = new Map<string, number>()
      for (const match of matches) counts.set(match.file, (counts.get(match.file) || 0) + 1)
      const files = [...counts].map(([file, count]) => ({ file, count }))
      const { selected, ...pagination } = page(files, options, complete, item => item, item => item.file.length + 20)
      return { success: true, data: { hits: [], files: selected, outputMode, ...pagination, ...(warning ? { warning } : {}) } }
    }
    const byFile = new Map<string, SearchEvent[]>()
    if (before || after) {
      for (const event of events) {
        const fileEvents = byFile.get(event.file) || []
        fileEvents.push(event)
        byFile.set(event.file, fileEvents)
      }
    }
    const toHit = (match: SearchEvent) => {
      const fileEvents = byFile.get(match.file) || []
      // Ripgrep emits each file in line order. Locate only this page's context.
      let low = 0
      let high = fileEvents.length
      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        if (fileEvents[middle].endLine < match.line - before) low = middle + 1
        else high = middle
      }
      const contextLines: Array<{ line: number; text: string; matched: boolean }> = []
      let contextChars = 0
      let textTruncated = match.text.length > maxColumns
      for (let index = low; index < fileEvents.length && fileEvents[index].line <= match.endLine + after; index++) {
        const event = fileEvents[index]
        if (event === match) continue
        for (const [offset, text] of event.text.split('\n').entries()) {
          const line = event.line + offset
          if (line < match.line - before || line > match.endLine + after) continue
          const boundedText = text.slice(0, maxColumns)
          contextChars += boundedText.length + 20
          if (contextChars <= 8_000) contextLines.push({ line, text: boundedText, matched: event.type === 'match' })
          else textTruncated = true
          textTruncated ||= text.length > maxColumns
        }
      }
      const context = contextLines.map(item => `${item.line}: ${item.text}`).join('\n')
      return {
        file: match.file, line: match.line, endLine: match.endLine, text: match.text.slice(0, maxColumns),
        ...(context ? { context, contextLines } : {}),
        ...(textTruncated ? { textTruncated: true } : {}),
      }
    }
    const { selected, ...pagination } = page(matches, options, complete, toHit, hit => hit.file.length + hit.text.length + (hit.context?.length || 0) + 160)
    return { success: true, data: { hits: selected, outputMode, ...pagination, ...(warning ? { warning } : {}) } }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
