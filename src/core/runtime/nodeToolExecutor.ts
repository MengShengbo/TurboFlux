import { createReadStream, readFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join, dirname, relative, resolve as resolveNativePath, isAbsolute } from 'path'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { promisify } from 'util'
import { createInterface } from 'readline'

const execFileAsync = promisify(execFile)
import type {
  ToolExecutor,
  Result,
  SearchContentHit,
  SearchContentBatchRequest,
  SearchContentOptions,
  SearchFilesOptions,
  SearchContentPage,
  FileRangeResult,
  CommandOutput,
  RequestOptions,
  ListTreeOptions,
  WebSearchResult,
} from '../../tools/executor'
import type { TreeNode } from '../../shared/types'
import type { CodeMapNode, CodeSearchHit } from '../../shared/codeIndexTypes'
import type { MemoryKind, MemoryScope } from '../../shared/memoryTypes'
import type { TerminalOutputChunk, TerminalSessionInfo, TerminalStartCommandResult } from '../../shared/terminalTypes'
import type { CapabilityProfile } from '../../shared/agentTypes'
import { MemoryService } from '../../tools/memory/service'
import { hashText, writeFileAtomicSync } from '../fileIO'
import { RuntimeTaskManager } from './runtimeTaskManager'
import { getChildProcessSpawnOptions, getDefaultShellSpec, getProcessGroupSignal, usesProcessGroup } from '../../platform/process'
import { RuntimeLogWriter } from './runtimeLogWriter'
import { CapabilityBoundary, type FilesystemAccess } from './capabilityBoundary'

const RETRYABLE_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const STREAM_RETRY_DELAYS_MS = [300, 900, 1800]

export interface NodeToolExecutorOptions {
  runtimeTaskManager?: RuntimeTaskManager
  ownerSessionId?: string
  capabilityProfile?: CapabilityProfile
}

interface BackgroundTerminalSession {
  info: TerminalSessionInfo
  proc: ChildProcessWithoutNullStreams
  chunks: TerminalOutputChunk[]
  nextSeq: number
  bufferChars: number
  runtimeTaskId: string
  logPath: string
  outputBytes: number
  omittedBytes: number
  writer: RuntimeLogWriter
  commandSession: boolean
  pausedForLog: boolean
  lastRuntimeSnapshotAt: number
  stopRequested: boolean
  logError?: string
}

const MAX_TERMINAL_CHUNKS = 500
const MAX_TERMINAL_BUFFER_CHARS = 1_000_000
const MAX_RECOVERED_TERMINAL_READ_BYTES = 2 * 1024 * 1024
const MAX_COMMAND_OUTPUT_CHARS = 2_000_000
const COMMAND_TERMINATION_GRACE_MS = 2000
const RUNTIME_LOG_DIRECTORY = join('.turboflux', 'runtime-logs')
const TERMINAL_KILL_TIMEOUT_MS = 5000
const RUNTIME_TASK_SNAPSHOT_INTERVAL_MS = 5000
const MODEL_REQUEST_TIMEOUT_MS = 5 * 60 * 1000
const WEB_SEARCH_TIMEOUT_MS = 8000
const WEB_SEARCH_USER_AGENT = 'TurboFlux/0.1 (+https://github.com/MengShengbo/TurboFluxCli)'
const DEFAULT_SHELL = getDefaultShellSpec()
const CODE_SEARCH_SKIPPED_DIRS = new Set([
  '.git', '.hg', '.svn', '.claude', '.turboflux', '.vscode', '.cache', '.next', '.turbo',
  '.gradle', '.m2', '.npm', '.pnpm-store', '.rustup', '.venv',
  'AppData', 'appdata', 'Library', 'library', 'node_modules', 'vendor', 'venv', 'dist', 'dist-desktop', 'build', 'out',
  'coverage', 'target', 'tmp', 'temp',
])
const CODE_SEARCH_EXCLUDE_GLOBS = Array.from(CODE_SEARCH_SKIPPED_DIRS, directory => `**/${directory}/**`)
const DEFAULT_SEARCH_LIMIT = 50
const MAX_SEARCH_LIMIT = 500
const DEFAULT_READ_RANGE_LINES = 180
const DEFAULT_READ_RANGE_BYTES = 64 * 1024

export class NodeToolExecutor implements ToolExecutor {
  private memoryService: MemoryService
  private workspaceRoot: string
  private capabilityBoundary: CapabilityBoundary
  private backgroundTerminals: Map<string, BackgroundTerminalSession> = new Map()
  private activeStreams: Map<number, AbortController> = new Map()
  private runtimeTaskManager: RuntimeTaskManager

  constructor(private workspacePath: string, options: NodeToolExecutorOptions = {}) {
    this.memoryService = new MemoryService()
    this.capabilityBoundary = new CapabilityBoundary(workspacePath, options.capabilityProfile)
    this.workspaceRoot = this.capabilityBoundary.workspaceRoot
    this.runtimeTaskManager = options.runtimeTaskManager || new RuntimeTaskManager({
      defaultOwnerSessionId: options.ownerSessionId,
    })
  }

  getRuntimeTaskManager(): RuntimeTaskManager {
    return this.runtimeTaskManager
  }

  getCapabilityProfile(): CapabilityProfile {
    return this.capabilityBoundary.getProfile()
  }

  setCapabilityProfile(profile: CapabilityProfile): void {
    this.capabilityBoundary.setProfile(profile)
  }

  private createRuntimeTaskLog(taskId: string): string {
    const directory = this.resolvePath(join(this.workspaceRoot, RUNTIME_LOG_DIRECTORY), 'write')
    mkdirSync(directory, { recursive: true })
    return this.resolvePath(join(directory, `${taskId}.jsonl`), 'write')
  }

  async readFile(path: string): Promise<Result<string>> {
    try {
      const safePath = this.resolvePath(path)
      if (!existsSync(safePath)) return { success: false, error: 'File not found' }
      if (!statSync(safePath).isFile()) return { success: false, error: 'Path is not a file' }
      const content = readFileSync(safePath, 'utf-8')
      return { success: true, data: content }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async readFileRange(path: string, offset = 0, limit = DEFAULT_READ_RANGE_LINES, maxBytes = DEFAULT_READ_RANGE_BYTES): Promise<Result<FileRangeResult>> {
    let stream: ReturnType<typeof createReadStream> | undefined
    let reader: ReturnType<typeof createInterface> | undefined
    try {
      const safePath = this.resolvePath(path)
      if (!existsSync(safePath)) return { success: false, error: 'File not found' }
      if (!statSync(safePath).isFile()) return { success: false, error: 'Path is not a file' }

      const normalizedOffset = Math.max(0, Math.floor(offset))
      const normalizedLimit = Math.max(1, Math.min(2_000, Math.floor(limit)))
      const normalizedMaxBytes = Math.max(4_096, Math.min(2 * 1024 * 1024, Math.floor(maxBytes)))
      const lines: string[] = []
      let lineIndex = 0
      let bytesRead = 0
      let truncated = false
      let partialLine = false

      stream = createReadStream(safePath, { encoding: 'utf-8' })
      reader = createInterface({ input: stream, crlfDelay: Infinity })
      for await (const rawLine of reader) {
        if (lineIndex < normalizedOffset) {
          lineIndex += 1
          continue
        }
        if (lines.length >= normalizedLimit) {
          truncated = true
          break
        }
        const remainingBytes = normalizedMaxBytes - bytesRead
        if (remainingBytes <= 0) {
          truncated = true
          break
        }
        const rawBytes = Buffer.byteLength(rawLine, 'utf-8')
        if (rawBytes > remainingBytes && lines.length > 0) {
          truncated = true
          break
        }
        const line = rawBytes > remainingBytes
          ? Buffer.from(rawLine, 'utf-8').subarray(0, remainingBytes).toString('utf-8').replace(/�$/, '')
          : rawLine
        lines.push(line)
        bytesRead += Buffer.byteLength(line, 'utf-8') + 1
        lineIndex += 1
        if (rawBytes > remainingBytes) {
          truncated = true
          partialLine = true
          break
        }
      }

      return {
        success: true,
        data: {
          content: lines.join('\n'),
          startLine: normalizedOffset + 1,
          endLine: normalizedOffset + lines.length,
          truncated,
          bytesRead,
          partialLine,
        },
      }
    } catch (e) {
      return { success: false, error: String(e) }
    } finally {
      reader?.close()
      stream?.destroy()
    }
  }

  async writeFile(path: string, content: string, metadata?: Record<string, unknown>): Promise<Result<void>> {
    try {
      let safePath = this.resolvePath(path, 'write')
      const dir = dirname(safePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      safePath = this.resolvePath(safePath, 'write')
      if (metadata?.expectNotExists === true && existsSync(safePath)) {
        return { success: false, error: `Write conflict: file already exists: ${path}` }
      }
      if (typeof metadata?.expectedHash === 'string') {
        if (!existsSync(safePath)) return { success: false, error: `Write conflict: file was deleted: ${path}` }
        const actualHash = hashText(readFileSync(safePath, 'utf-8'))
        if (actualHash !== metadata.expectedHash) {
          return { success: false, error: `Write conflict: file changed since it was read: ${path}` }
        }
      }
      writeFileAtomicSync(safePath, content)
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async deleteFile(path: string, options?: { recursive?: boolean; expectedHash?: string }): Promise<Result<void>> {
    try {
      const safePath = this.resolvePath(path, 'write')
      if (!existsSync(safePath)) return { success: false, error: 'File not found' }
      const expectedHash = options?.expectedHash
      if (typeof expectedHash === 'string') {
        const actualHash = hashText(readFileSync(safePath, 'utf-8'))
        if (actualHash !== expectedHash) {
          return { success: false, error: `Delete conflict: file changed since it was read: ${path}` }
        }
      }
      rmSync(safePath, { recursive: options?.recursive, force: true })
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async listTree(path: string, options: ListTreeOptions = {}): Promise<Result<TreeNode>> {
    try {
      const maxDepth = Math.max(0, Math.min(5, Math.floor(options.maxDepth ?? 3)))
      const maxEntriesPerDirectory = Math.max(1, Math.min(500, Math.floor(options.maxEntriesPerDirectory ?? 500)))
      const maxNodes = Math.max(1, Math.min(20_000, Math.floor(options.maxNodes ?? 20_000)))
      const root = this.buildTree(this.resolvePath(path), maxDepth, 0, { remaining: maxNodes }, maxEntriesPerDirectory)
      return { success: true, data: root }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async searchFiles(pattern: string, basePath: string, options: SearchFilesOptions = {}): Promise<Result<{ matches: string[]; truncated?: boolean; offset?: number; limit?: number }>> {
    let safeBasePath: string
    try {
      safeBasePath = this.resolvePath(basePath)
    } catch (e) {
      return { success: false, error: String(e) }
    }

    const normalizedPattern = String(pattern || '').trim().replace(/\\/g, '/')
    if (!normalizedPattern) return { success: false, error: 'File search pattern is required' }
    const offset = Math.max(0, Math.floor(options.offset || 0))
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit || 100)))
    if (options.signal?.aborted) {
      return { success: false, error: 'File search aborted', data: { matches: [], offset, limit, truncated: false } }
    }

    try {
      const args = [
        '--files',
        '--hidden',
        `--glob=${normalizedPattern}`,
        ...CODE_SEARCH_EXCLUDE_GLOBS.map(pattern => `--glob=!${pattern}`),
        '--glob=!**/.env',
        '--glob=!**/.env.local',
        '--glob=!**/.env.*.local',
        '.',
      ]
      const { stdout } = await execFileAsync('rg', args, {
        cwd: safeBasePath,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        signal: options.signal,
      })
      const matches = stdout
        .split(/\r?\n/)
        .map(path => path.trim())
        .filter(Boolean)
        .map(path => resolveNativePath(safeBasePath, path))
        .sort((left, right) => {
          const leftRelative = relative(safeBasePath, left).replace(/\\/g, '/')
          const rightRelative = relative(safeBasePath, right).replace(/\\/g, '/')
          const depthDelta = leftRelative.split('/').length - rightRelative.split('/').length
          return depthDelta || leftRelative.localeCompare(rightRelative)
        })
      return { success: true, data: { matches: matches.slice(offset, offset + limit), offset, limit, truncated: matches.length > offset + limit } }
    } catch (e: any) {
      if (this.isAbortError(e) || e.code === 'ABORT_ERR') {
        await this.delay(50)
        return { success: false, error: 'File search aborted' }
      }
      if (e.code === 1 || e.exitCode === 1) return { success: true, data: { matches: [] } }
      if (e.code !== 'ENOENT') {
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
      const matches = this.globSync(normalizedPattern, safeBasePath)
      return { success: true, data: { matches: matches.slice(offset, offset + limit), offset, limit, truncated: matches.length > offset + limit } }
    }
  }

  async searchContent(pattern: string, basePath: string, filePattern?: string, caseInsensitive?: boolean): Promise<Result<SearchContentHit[]>> {
    const result = await this.searchContentPage(pattern, basePath, filePattern, caseInsensitive)
    return result.success
      ? { success: true, data: result.data?.hits || [] }
      : { success: false, error: result.error, data: [] }
  }

  async searchContentBatch(requests: SearchContentBatchRequest[]): Promise<Array<Result<SearchContentPage>>> {
    if (requests.length < 2) {
      return Promise.all(requests.map(request => this.searchContentPage(
        request.pattern,
        request.basePath,
        request.filePattern,
        request.caseInsensitive,
        request.options,
      )))
    }

    const first = requests[0]
    const batchKey = (request: SearchContentBatchRequest) => JSON.stringify({
      basePath: resolveNativePath(request.basePath),
      filePattern: request.filePattern || '',
      caseInsensitive: Boolean(request.caseInsensitive),
      contextBefore: Math.max(0, Math.min(20, Math.floor(request.options?.contextBefore || 0))),
      contextAfter: Math.max(0, Math.min(20, Math.floor(request.options?.contextAfter || 0))),
      multiline: Boolean(request.options?.multiline),
      fileType: request.options?.fileType || '',
      maxColumns: Math.max(120, Math.min(2_000, Math.floor(request.options?.maxColumns || 500))),
    })
    const compatible = requests.every(request => batchKey(request) === batchKey(first))
      && !first.options?.multiline
      && requests.every(request => {
        try {
          void new RegExp(request.pattern, request.caseInsensitive ? 'i' : '')
          return true
        } catch {
          return false
        }
      })
    if (!compatible) {
      return Promise.all(requests.map(request => this.searchContentPage(
        request.pattern,
        request.basePath,
        request.filePattern,
        request.caseInsensitive,
        request.options,
      )))
    }

    let safeBasePath: string
    try {
      safeBasePath = this.resolvePath(first.basePath)
    } catch (error) {
      return requests.map(request => ({
        success: false,
        error: String(error),
        data: {
          hits: [],
          totalMatches: 0,
          offset: Math.max(0, Math.floor(request.options?.offset || 0)),
          limit: Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(request.options?.limit || DEFAULT_SEARCH_LIMIT))),
          truncated: false,
        },
      }))
    }

    const contextBefore = Math.max(0, Math.min(20, Math.floor(first.options?.contextBefore || 0)))
    const contextAfter = Math.max(0, Math.min(20, Math.floor(first.options?.contextAfter || 0)))
    const maxColumns = Math.max(120, Math.min(2_000, Math.floor(first.options?.maxColumns || 500)))
    const args = [
      '--json',
      '--hidden',
      `--max-columns=${maxColumns}`,
      '--max-columns-preview',
      ...CODE_SEARCH_EXCLUDE_GLOBS.map(pattern => `--glob=!${pattern}`),
      '--glob=!.env',
      '--glob=!.env.local',
      '--glob=!.env.*.local',
    ]
    if (first.caseInsensitive) args.push('--ignore-case')
    if (contextBefore > 0) args.push('-B', String(contextBefore))
    if (contextAfter > 0) args.push('-A', String(contextAfter))
    if (first.options?.fileType) args.push('--type', first.options.fileType)
    if (first.filePattern) args.push(`--glob=${first.filePattern}`)
    for (const request of requests) args.push('-e', request.pattern)
    args.push('--', '.')

    try {
      const { stdout } = await execFileAsync('rg', args, {
        cwd: safeBasePath,
        timeout: 15_000,
        maxBuffer: 8 * 1024 * 1024,
        signal: first.options?.signal,
      })
      const events: Array<{ type: 'match' | 'context'; file: string; line: number; text: string }> = []
      for (const line of stdout.split(/\r?\n/)) {
        if (!line) continue
        try {
          const event = JSON.parse(line) as Record<string, any>
          if (event.type !== 'match' && event.type !== 'context') continue
          const relativePath = event.data?.path?.text
          const lineNumber = Number(event.data?.line_number)
          const text = String(event.data?.lines?.text || '').replace(/\r?\n$/, '')
          if (!relativePath || !Number.isFinite(lineNumber)) continue
          events.push({ type: event.type, file: resolveNativePath(safeBasePath, relativePath), line: lineNumber, text })
        } catch {}
      }
      const matches = events.filter(event => event.type === 'match')
      return requests.map(request => {
        const tester = new RegExp(request.pattern, request.caseInsensitive ? 'i' : '')
        const matching = matches.filter(match => tester.test(match.text))
        const offset = Math.max(0, Math.floor(request.options?.offset || 0))
        const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(request.options?.limit || DEFAULT_SEARCH_LIMIT)))
        const selected = matching.slice(offset, offset + limit)
        const hits = selected.map(match => {
          const context = events
            .filter(event => event.type === 'context' && event.file === match.file && event.line >= match.line - contextBefore && event.line <= match.line + contextAfter)
            .map(event => `${event.line}: ${event.text}`)
            .join('\n')
          return { file: match.file, line: match.line, text: match.text, ...(context ? { context } : {}) }
        })
        return {
          success: true,
          data: { hits, totalMatches: matching.length, offset, limit, truncated: matching.length > offset + limit },
        }
      })
    } catch {
      return Promise.all(requests.map(request => this.searchContentPage(
        request.pattern,
        request.basePath,
        request.filePattern,
        request.caseInsensitive,
        request.options,
      )))
    }
  }

  async searchContentPage(
    pattern: string,
    basePath: string,
    filePattern?: string,
    caseInsensitive?: boolean,
    options: SearchContentOptions = {},
  ): Promise<Result<SearchContentPage>> {
    let safeBasePath: string
    try {
      safeBasePath = this.resolvePath(basePath)
    } catch (e) {
      return { success: false, error: String(e), data: { hits: [], totalMatches: 0, offset: 0, limit: DEFAULT_SEARCH_LIMIT, truncated: false } }
    }

    const offset = Math.max(0, Math.floor(options.offset || 0))
    const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(options.limit || DEFAULT_SEARCH_LIMIT)))
    const contextBefore = Math.max(0, Math.min(20, Math.floor(options.contextBefore || 0)))
    const contextAfter = Math.max(0, Math.min(20, Math.floor(options.contextAfter || 0)))
    const maxColumns = Math.max(120, Math.min(2_000, Math.floor(options.maxColumns || 500)))
    const maxMatchesPerFile = options.maxMatchesPerFile === undefined
      ? (limit >= 100 && offset === 0 ? 24 : 0)
      : Math.max(1, Math.min(100, Math.floor(options.maxMatchesPerFile)))
    if (options.signal?.aborted) {
      return { success: false, error: 'Content search aborted', data: { hits: [], totalMatches: 0, offset, limit, truncated: false } }
    }

    try {
      const args = [
        '--json',
        '--hidden',
        `--max-columns=${maxColumns}`,
        '--max-columns-preview',
        ...CODE_SEARCH_EXCLUDE_GLOBS.map(pattern => `--glob=!${pattern}`),
        '--glob=!.env',
        '--glob=!.env.local',
        '--glob=!.env.*.local',
      ]
      if (caseInsensitive) args.push('--ignore-case')
      if (maxMatchesPerFile > 0) args.push(`--max-count=${maxMatchesPerFile}`)
      if (options.multiline) args.push('-U', '--multiline-dotall')
      if (contextBefore > 0) args.push('-B', String(contextBefore))
      if (contextAfter > 0) args.push('-A', String(contextAfter))
      if (options.fileType) args.push('--type', options.fileType)
      if (filePattern) {
        args.push(`--glob=${filePattern}`)
      }
      args.push('--', pattern, '.')
      const { stdout } = await execFileAsync('rg', args, { cwd: safeBasePath, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, signal: options.signal })
      const output = stdout.trim()
      if (!output) return { success: true, data: { hits: [], totalMatches: 0, offset, limit, truncated: false } }

      const events: Array<{ type: 'match' | 'context'; file: string; line: number; text: string }> = []
      for (const line of output.split(/\r?\n/)) {
        try {
          const event = JSON.parse(line) as Record<string, any>
          if (event.type !== 'match' && event.type !== 'context') continue
          const relativePath = event.data?.path?.text
          const lineNumber = Number(event.data?.line_number)
          const text = String(event.data?.lines?.text || '').replace(/\r?\n$/, '')
          if (!relativePath || !Number.isFinite(lineNumber)) continue
          events.push({
            type: event.type,
            file: resolveNativePath(safeBasePath, relativePath),
            line: lineNumber,
            text,
          })
        } catch {}
      }

      const matches = events.filter(event => event.type === 'match')
      const selected = matches.slice(offset, offset + limit)
      const hits = selected.map(match => {
        const context = events
          .filter(event => event.type === 'context' && event.file === match.file && event.line >= match.line - contextBefore && event.line <= match.line + contextAfter)
          .map(event => `${event.line}: ${event.text}`)
          .join('\n')
        return {
          file: match.file,
          line: match.line,
          text: match.text,
          ...(context ? { context } : {}),
        }
      })
      return {
        success: true,
        data: {
          hits,
          totalMatches: matches.length,
          offset,
          limit,
          truncated: matches.length > offset + limit,
        },
      }
    } catch (e: any) {
      if (this.isAbortError(e) || e.code === 'ABORT_ERR') {
        await this.delay(50)
        return { success: false, error: 'Content search aborted', data: { hits: [], totalMatches: 0, offset, limit, truncated: false } }
      }
      if (e.code === 1 || e.exitCode === 1) return { success: true, data: { hits: [], totalMatches: 0, offset, limit, truncated: false } }
      if (e.code === 'ENOENT') {
        const matches = this.searchContentFallback(pattern, safeBasePath, filePattern, caseInsensitive, {
          contextBefore,
          contextAfter,
          maxMatchesPerFile,
          signal: options.signal,
        })
        return {
          success: true,
          data: {
            hits: matches.slice(offset, offset + limit),
            totalMatches: matches.length,
            offset,
            limit,
            truncated: matches.length > offset + limit,
          },
        }
      }
      return { success: false, error: e instanceof Error ? e.message : String(e), data: { hits: [], totalMatches: 0, offset, limit, truncated: false } }
    }
  }

  async webSearch(query: { query: string; limit?: number; region?: string; freshness?: string; domains?: string[] }): Promise<Result<{ results: WebSearchResult[]; provider: string; query: string }>> {
    const searchQuery = String(query.query || '').trim()
    if (!searchQuery) return { success: false, error: 'Search query is required' }
    const limit = Math.max(1, Math.min(10, Number(query.limit) || 5))
    const region = String(query.region || 'wt-wt')
    const freshness = typeof query.freshness === 'string' ? query.freshness : undefined
    const domains = Array.isArray(query.domains)
      ? query.domains.map(domain => this.normalizeDomainFilter(domain)).filter(Boolean)
      : []
    const effectiveQuery = domains.length > 0
      ? `${searchQuery} ${domains.map(domain => `site:${domain}`).join(' OR ')}`
      : searchQuery

    const errors: string[] = []
    if (!freshness) {
      try {
        const results = await this.searchDuckDuckGoInstant(effectiveQuery, limit, region)
        if (results.length > 0) {
          return { success: true, data: { results, provider: 'duckduckgo_instant', query: effectiveQuery } }
        }
      } catch (e) {
        errors.push(`duckduckgo_instant: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    try {
      const htmlResults = await this.searchDuckDuckGoHtml(effectiveQuery, limit, region, freshness)
      if (htmlResults.length > 0) {
        return { success: true, data: { results: htmlResults, provider: 'duckduckgo_html', query: effectiveQuery } }
      }
    } catch (e) {
      errors.push(`duckduckgo_html: ${e instanceof Error ? e.message : String(e)}`)
    }

    try {
      const bingResults = await this.searchBingHtml(effectiveQuery, limit, freshness)
      if (bingResults.length > 0) {
        return { success: true, data: { results: bingResults, provider: 'bing_html', query: effectiveQuery } }
      }
    } catch (e) {
      errors.push(`bing_html: ${e instanceof Error ? e.message : String(e)}`)
    }

    return errors.length > 0
      ? { success: false, error: `No web search provider returned results. ${errors.join('; ')}` }
      : { success: true, data: { results: [], provider: 'none', query: effectiveQuery } }
  }

  async searchCodeSymbols(query: { query: string; workspacePath: string; kind?: string; limit?: number; exact?: boolean }): Promise<Result<CodeSearchHit[]>> {
    try {
      const safeRootPath = this.resolvePath(query.workspacePath)
      const requestedPath = typeof (query as any).path === 'string' && (query as any).path.trim()
        ? resolveNativePath(safeRootPath, (query as any).path)
        : safeRootPath
      const requestedFile = existsSync(requestedPath) && statSync(requestedPath).isFile()
      const safeWorkspacePath = this.resolvePath(requestedFile ? dirname(requestedPath) : requestedPath)
      const exactRequestedFile = requestedFile ? resolveNativePath(requestedPath).toLowerCase() : undefined
      const limit = query.limit || 10
      const escapedQuery = this.escapeRegex(query.query)
      const symbolPattern = query.exact ? escapedQuery : `\\w*${escapedQuery}\\w*`
      const pattern = [
        `(?:function|class|interface|type|enum|const|let|var)\\s+${symbolPattern}\\b`,
        `(?:async\\s+)?def\\s+${symbolPattern}\\b`,
        `(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${symbolPattern}\\b`,
        `func\\s+(?:\\([^)]*\\)\\s*)?${symbolPattern}\\b`,
        `(?:class|interface|record|struct|enum|trait|protocol|object)\\s+${symbolPattern}\\b`,
      ].map(value => `(?:${value})`).join('|')
      const results: CodeSearchHit[] = []
      let ripgrepUnavailable = false
      const args = [
        '--line-number',
        '--no-heading',
        '--hidden',
        '--ignore-case',
        '--max-count=80',
        '--max-columns=500',
        '--max-columns-preview',
        '--glob=*.{ts,tsx,js,jsx,mjs,cjs,py,pyi,rs,go,java,kt,kts,cs,c,cc,cpp,cxx,h,hpp,swift,scala,rb,php}',
        ...CODE_SEARCH_EXCLUDE_GLOBS.map(exclude => `--glob=!${exclude}`),
        '--',
        pattern,
        '.',
      ]
      try {
        const { stdout } = await execFileAsync('rg', args, { cwd: safeWorkspacePath, timeout: 8000, maxBuffer: 512 * 1024 })
        const output = stdout.trim()
        if (output) {
          for (const line of output.split('\n').slice(0, Math.max(40, (query.limit || 10) * 8))) {
            const match = line.match(/^(.+?):(\d+):(.*)$/)
            if (!match) continue
            const filePath = resolveNativePath(safeWorkspacePath, match[1])
            if (exactRequestedFile && filePath.toLowerCase() !== exactRequestedFile) continue
            const lineNum = parseInt(match[2])
            const text = match[3].trim()
            const declaration = this.extractSymbolDeclaration(text)
            if (!declaration) continue
            const requestedKinds = Array.isArray((query as any).kinds)
              ? (query as any).kinds.map((kind: unknown) => String(kind))
              : query.kind ? [query.kind] : []
            if (requestedKinds.length > 0 && !requestedKinds.includes(declaration.kind)) continue
            const queryLower = query.query.toLowerCase()
            const symbolLower = declaration.name.toLowerCase()
            const score = symbolLower === queryLower
              ? 1
              : symbolLower.startsWith(queryLower)
                ? 0.9
                : symbolLower.includes(queryLower)
                  ? 0.75
                  : 0.5
            results.push({
              id: `sym_${lineNum}_${filePath.slice(-20)}`,
              path: relative(safeRootPath, filePath).replace(/\\/g, '/'),
              title: declaration.name,
              subtitle: text.slice(0, 120),
              line: lineNum,
              startLine: lineNum,
              endLine: lineNum + 5,
              score,
              source: 'symbol',
              symbolKind: declaration.kind as CodeSearchHit['symbolKind'],
              preview: text,
            })
          }
        }
      } catch (e: any) {
        if (e.code === 'ENOENT') ripgrepUnavailable = true
        else if (e.code !== 1 && e.exitCode !== 1) {
          return { success: false, error: e instanceof Error ? e.message : String(e), data: [] }
        }
      }
      const fallback = ripgrepUnavailable
        ? this.searchCodeSymbolsFallback(query.query, safeWorkspacePath, limit, safeRootPath, query.exact === true)
            .filter(hit => !exactRequestedFile || resolveNativePath(safeRootPath, hit.path).toLowerCase() === exactRequestedFile)
        : []
      return {
        success: true,
        data: results.length > 0
          ? results
              .filter((hit, index, all) => all.findIndex(other => other.path.toLowerCase() === hit.path.toLowerCase()
                && other.title.toLowerCase() === hit.title.toLowerCase()) === index)
              .sort((left, right) => (right.score || 0) - (left.score || 0) || left.path.localeCompare(right.path) || (left.line || 0) - (right.line || 0))
              .slice(0, limit)
          : fallback,
      }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e), data: [] }
    }
  }

  private inferSymbolKind(text: string): string {
    if (/\bclass\b/.test(text)) return 'class'
    if (/\binterface\b/.test(text)) return 'interface'
    if (/\btype\b/.test(text)) return 'type'
    if (/\benum\b/.test(text)) return 'enum'
    if (/\bfunction\b/.test(text)) return 'function'
    return 'constant'
  }

  private extractSymbolDeclaration(text: string): { name: string; kind: string } | null {
    const patterns: Array<{ regex: RegExp; kind: string }> = [
      { regex: /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: 'function' },
      { regex: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function' },
      { regex: /\b(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function' },
      { regex: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'function' },
      { regex: /\bclass\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
      { regex: /\binterface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
      { regex: /\b(?:type|record|struct)\s+([A-Za-z_$][\w$]*)/, kind: 'type' },
      { regex: /\b(?:enum)\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
      { regex: /\b(?:trait|protocol)\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
      { regex: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: 'constant' },
    ]
    for (const pattern of patterns) {
      const match = text.match(pattern.regex)
      if (match?.[1]) return { name: match[1], kind: pattern.kind }
    }
    return null
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  async getCodeMap(query: { workspacePath: string; targetPaths?: string[]; path?: string; query?: string; depth?: number; maxPaths?: number; maxChildrenPerPath?: number }): Promise<Result<{ map: CodeMapNode[]; relatedPaths?: string[]; source?: 'filesystem' }>> {
    try {
      const basePath = this.resolvePath(query.workspacePath)
      for (const target of query.targetPaths || (query.path ? [query.path] : [])) {
        this.resolvePath(isAbsolute(target) ? target : join(basePath, target))
      }
      const targetPaths = this.resolveCodeMapTargets(basePath, query)
      const map: CodeMapNode[] = []

      for (const target of targetPaths) {
        const fullPath = this.resolvePath(isAbsolute(target) ? target : join(basePath, target))
        if (!existsSync(fullPath)) continue
        const node = this.buildCodeMapNode(fullPath, basePath, query.depth || 2, 0, query.maxChildrenPerPath || 24)
        if (node) map.push(node)
      }

      return { success: true, data: { map, source: 'filesystem' } }
    } catch (e) {
      return { success: false, error: String(e), data: { map: [] } }
    }
  }

  private resolveCodeMapTargets(basePath: string, query: { targetPaths?: string[]; path?: string; query?: string; maxPaths?: number }): string[] {
    const explicit = query.targetPaths?.length ? query.targetPaths : query.path ? [query.path] : []
    if (explicit.length > 0) return explicit

    const roots = ['src', 'app', 'pages', 'components', 'packages', 'frontend', 'client', 'web', 'electron', 'main', 'renderer']
      .filter(target => existsSync(join(basePath, target)))
    const tokens = String(query.query || '')
      .toLowerCase()
      .replace(/[^a-z0-9_\u4e00-\u9fa5]+/g, ' ')
      .split(/\s+/)
      .filter(token => token.length >= 2)
      .slice(0, 12)
    const scored = roots
      .map(root => {
        const lower = root.toLowerCase()
        const score = tokens.some(token => lower.includes(token) || token.includes(lower)) ? 2 : 1
        return { root, score }
      })
      .sort((a, b) => b.score - a.score || a.root.localeCompare(b.root))
      .map(item => item.root)

    return (scored.length > 0 ? scored : ['src']).slice(0, query.maxPaths || 8)
  }

  private buildCodeMapNode(absPath: string, basePath: string, maxDepth: number, depth: number, maxChildrenPerPath: number): CodeMapNode | null {
    const relPath = relative(basePath, absPath).replace(/\\/g, '/')
    const stat = statSync(absPath)

    if (stat.isFile()) {
      if (!/\.(ts|tsx|js|jsx)$/.test(absPath)) return null
      const exports = this.extractExports(absPath)
      if (exports.length === 0) return null
      return {
        id: `map_${relPath}`,
        kind: 'symbol',
        title: relPath.split('/').pop() || relPath,
        path: relPath,
        summary: exports.slice(0, 5).join(', '),
        score: exports.length * 0.1,
        children: [],
      }
    }

    if (!stat.isDirectory() || depth >= maxDepth) return null
    const name = relPath.split('/').pop() || relPath
    if (['node_modules', '.git', 'dist', 'build', '.turboflux'].includes(name)) return null

    const children: CodeMapNode[] = []
    try {
      const entries = readdirSync(absPath, { withFileTypes: true })
        .filter(e => !e.isSymbolicLink() && !this.shouldSkipEntry(e.name))
        .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))

      for (const entry of entries.slice(0, Math.max(1, maxChildrenPerPath))) {
        const child = this.buildCodeMapNode(join(absPath, entry.name), basePath, maxDepth, depth + 1, maxChildrenPerPath)
        if (child) children.push(child)
      }
    } catch {}

    if (children.length === 0) return null
    return {
      id: `map_${relPath}`,
      kind: 'module',
      title: name,
      path: relPath,
      summary: `${children.length} items`,
      score: children.reduce((s, c) => s + (c.score || 0), 0),
      children,
    }
  }

  private extractExports(filePath: string): string[] {
    try {
      const content = readFileSync(filePath, 'utf-8')
      const exports: string[] = []
      const regex = /export\s+(?:default\s+)?(?:function|const|let|var|class|interface|type|enum)\s+(\w+)/g
      let match
      while ((match = regex.exec(content)) !== null) {
        exports.push(match[1])
      }
      return exports
    } catch {
      return []
    }
  }

  async memoryQuery(query: { query?: string; workspacePath: string; kind?: MemoryKind; scope?: MemoryScope; limit?: number }): Promise<Result<{ items: Array<{ id: string; text: string; content: string; kind: string; confidence: string; source: string; tags: string[]; score: number }> }>> {
    try {
      const safeWorkspacePath = this.resolvePath(query.workspacePath)
      const memories = await this.memoryService.query({
        workspacePath: safeWorkspacePath,
        query: query.query,
        kind: query.kind,
        scope: query.scope,
        limit: query.limit,
      })
      const items = memories.map(m => ({
        id: m.id,
        text: m.text,
        content: m.text,
        kind: m.kind,
        confidence: m.confidence,
        source: m.source,
        tags: m.tags,
        score: 1,
      }))
      return { success: true, data: { items } }
    } catch (e) {
      return { success: true, data: { items: [] } }
    }
  }

  async memoryRemember(data: { content?: string; text?: string; kind: MemoryKind; scope: MemoryScope; workspacePath: string; conversationId?: string }): Promise<Result<{ id: string; deduplicated?: boolean }>> {
    try {
      const safeWorkspacePath = this.resolvePath(data.workspacePath, 'write')
      const result = await this.memoryService.remember({
        workspacePath: safeWorkspacePath,
        text: data.content ?? data.text ?? '',
        kind: data.kind,
        scope: data.scope,
        conversationId: data.conversationId,
      })
      if (!result.success) return { success: false, error: result.error }
      return { success: true, data: { id: result.id || '', deduplicated: result.deduplicated } }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async memoryForget(data: { id: string; workspacePath: string }): Promise<Result<void>> {
    try {
      const safeWorkspacePath = this.resolvePath(data.workspacePath, 'write')
      const result = await this.memoryService.forget({ workspacePath: safeWorkspacePath, id: data.id })
      if (!result.success) return { success: false, error: result.error }
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async memoryList(workspacePath: string): Promise<Result<{ items: Array<{ id: string; content: string; kind: string }> }>> {
    try {
      const safeWorkspacePath = this.resolvePath(workspacePath)
      const memories = await this.memoryService.query({ workspacePath: safeWorkspacePath, limit: 100 })
      const items = memories.map(m => ({ id: m.id, content: m.text, kind: m.kind }))
      return { success: true, data: { items } }
    } catch (e) {
      return { success: true, data: { items: [] } }
    }
  }

  async memoryGetRelevantInjection(params: { workspacePath: string; query: string }): Promise<Result<{ text: string; tokens: number }>> {
    try {
      const safeWorkspacePath = this.resolvePath(params.workspacePath)
      const result = await this.memoryService.getRelevantInjection(safeWorkspacePath, params.query)
      return { success: true, data: { text: result.text, tokens: result.tokens } }
    } catch {
      return { success: true, data: { text: '', tokens: 0 } }
    }
  }

  async runCommand(command: string, cwd: string, env?: Record<string, string>, timeout?: number, approved?: boolean): Promise<Result<CommandOutput>> {
    let safeCwd: string
    try {
      const validation = this.validateCommandSync(command, cwd)
      if (!validation.success) {
        return { success: false, error: validation.error, data: { stdout: '', stderr: validation.error || '', exitCode: 1 } }
      }
      if (approved !== true) {
        const error = 'Command execution requires an explicit permission decision'
        return { success: false, error, data: { stdout: '', stderr: error, exitCode: 1 } }
      }
      safeCwd = validation.cwd
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
    return this.executeCommand(command, safeCwd, env, timeout)
  }

  private async executeCommand(
    command: string,
    safeCwd: string,
    env: Record<string, string> | undefined,
    timeout: number | undefined,
  ): Promise<Result<CommandOutput>> {
    const { shell, shellArgs } = getShellCommand(command)
    const runtimeTask = this.runtimeTaskManager.createTask({
      kind: 'shell',
      command,
      cwd: safeCwd,
      interactive: false,
    })
    let logPath: string | undefined
    try {
      logPath = this.createRuntimeTaskLog(runtimeTask.id)
      const proc = spawn(shell, shellArgs, {
        cwd: safeCwd,
        env: this.buildChildEnvironment(env),
        ...getChildProcessSpawnOptions(),
      })
      this.runtimeTaskManager.setControl(runtimeTask.id, {
        stop: () => this.stopProcessAndWait(proc),
      })
      this.runtimeTaskManager.markRunning(runtimeTask.id, { pid: proc.pid, logPath, outputBytes: 0, outputOffset: 0 })
      return this.collectProcess(proc, timeout || 30000, runtimeTask.id, logPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.runtimeTaskManager.failTask(runtimeTask.id, message, { logPath, outputBytes: 0 })
      return { success: false, error: message, data: { stdout: '', stderr: message, exitCode: 1, logPath, outputBytes: 0 } }
    }
  }

  async runProcess(command: string, args: string[], cwd: string, env?: Record<string, string>, timeout?: number): Promise<Result<CommandOutput>> {
    let runtimeTaskId: string | undefined
    let logPath: string | undefined
    try {
      const safeCwd = this.resolvePath(cwd, 'write')
      const runtimeTask = this.runtimeTaskManager.createTask({
        kind: 'shell',
        command: [command, ...args].join(' '),
        cwd: safeCwd,
        interactive: false,
        metadata: { executable: command, args: [...args] },
      })
      runtimeTaskId = runtimeTask.id
      logPath = this.createRuntimeTaskLog(runtimeTask.id)
      const proc = spawn(command, args, {
        cwd: safeCwd,
        env: this.buildChildEnvironment(env),
        ...getChildProcessSpawnOptions(),
      })
      this.runtimeTaskManager.setControl(runtimeTask.id, {
        stop: () => this.stopProcessAndWait(proc),
      })
      this.runtimeTaskManager.markRunning(runtimeTask.id, { pid: proc.pid, logPath, outputBytes: 0, outputOffset: 0 })
      return await this.collectProcess(proc, timeout || 30000, runtimeTask.id, logPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (runtimeTaskId) this.runtimeTaskManager.failTask(runtimeTaskId, message, { logPath, outputBytes: 0 })
      return { success: false, error: message, data: { stdout: '', stderr: message, exitCode: 1, logPath, outputBytes: 0 } }
    }
  }

  private collectProcess(proc: ChildProcessWithoutNullStreams, timeout: number, runtimeTaskId?: string, logPath?: string): Promise<Result<CommandOutput>> {
    return new Promise(resolve => {
      let stdout = ''
      let stderr = ''
      let truncated = false
      let timedOut = false
      let settled = false
      let outputBytes = 0
      let logError: string | undefined
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined
      let terminationGraceTimer: ReturnType<typeof setTimeout> | undefined
      const logWriter = logPath ? new RuntimeLogWriter(logPath, {
        onDrain: () => {
          if (!proc.stdout.destroyed) proc.stdout.resume()
          if (!proc.stderr.destroyed) proc.stderr.resume()
        },
        onError: error => { logError = error.message },
      }) : undefined

      const append = (current: string, value: Buffer | string): string => {
        if (current.length >= MAX_COMMAND_OUTPUT_CHARS) {
          truncated = true
          return current
        }
        const text = value.toString()
        const remaining = MAX_COMMAND_OUTPUT_CHARS - current.length
        if (text.length > remaining) truncated = true
        return current + text.slice(0, remaining)
      }
      const finish = async (result: Result<CommandOutput>) => {
        if (settled) return
        settled = true
        if (timeoutTimer) clearTimeout(timeoutTimer)
        if (terminationGraceTimer) clearTimeout(terminationGraceTimer)
        proc.stdout.off('data', onStdout)
        proc.stderr.off('data', onStderr)
        proc.off('error', onError)
        proc.off('close', onClose)
        await logWriter?.close()
        const finalizedResult: Result<CommandOutput> = result.data
          ? { ...result, data: { ...result.data, logPath, outputBytes } }
          : result
        if (runtimeTaskId) this.finishProcessRuntimeTask(runtimeTaskId, finalizedResult, logError)
        resolve(finalizedResult)
      }
      const recordOutput = (channel: 'stdout' | 'stderr', data: Buffer | string) => {
        outputBytes += Buffer.byteLength(data)
        if (!logWriter || logError) return
        if (!logWriter.append(channel, data)) {
          proc.stdout.pause()
          proc.stderr.pause()
        }
      }
      const onStdout = (data: Buffer | string) => {
        recordOutput('stdout', data)
        stdout = append(stdout, data)
      }
      const onStderr = (data: Buffer | string) => {
        recordOutput('stderr', data)
        stderr = append(stderr, data)
      }
      const onError = (error: Error) => {
        recordOutput('stderr', error.message)
        void finish({ success: false, error: error.message, data: { stdout, stderr, exitCode: 1, timedOut, truncated } })
      }
      const onClose = (code: number | null) => {
        const exitCode = code ?? 1
        const success = exitCode === 0 && !timedOut
        const error = timedOut
          ? `Command timed out after ${timeout}ms`
          : success ? undefined : `Command exited with code ${exitCode}`
        void finish({ success, error, data: { stdout, stderr, exitCode, timedOut, truncated } })
      }

      proc.stdout.on('data', onStdout)
      proc.stderr.on('data', onStderr)
      proc.on('error', onError)
      proc.on('close', onClose)
      timeoutTimer = setTimeout(() => {
        timedOut = true
        try {
          this.terminateProcessTree(proc)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          void finish({
            success: false,
            error: `Command timed out after ${timeout}ms; process termination failed: ${message}`,
            data: { stdout, stderr, exitCode: 1, timedOut, truncated },
          })
          return
        }
        if (settled) return
        terminationGraceTimer = setTimeout(() => {
          void finish({
            success: false,
            error: `Command timed out after ${timeout}ms; process did not exit within the ${COMMAND_TERMINATION_GRACE_MS}ms termination grace period`,
            data: { stdout, stderr, exitCode: 1, timedOut, truncated },
          })
        }, COMMAND_TERMINATION_GRACE_MS)
      }, Math.max(1, timeout))
    })
  }

  private terminateProcessTree(proc: ChildProcessWithoutNullStreams): void {
    if (!proc.pid) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.unref()
      return
    }
    try {
      process.kill(usesProcessGroup() ? -proc.pid : proc.pid, getProcessGroupSignal())
    } catch {
      proc.kill('SIGTERM')
    }
  }

  private stopProcessAndWait(proc: ChildProcessWithoutNullStreams): Promise<void> {
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        proc.off('close', onClose)
        proc.off('error', onError)
        if (error) reject(error)
        else resolve()
      }
      const onClose = () => finish()
      const onError = (error: Error) => finish(error)
      const timer = setTimeout(() => {
        finish(new Error(`Process did not exit within ${COMMAND_TERMINATION_GRACE_MS}ms`))
      }, COMMAND_TERMINATION_GRACE_MS)
      proc.once('close', onClose)
      proc.once('error', onError)
      try {
        this.terminateProcessTree(proc)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private finishProcessRuntimeTask(taskId: string, result: Result<CommandOutput>, logError?: string): void {
    const output = result.data
    const patch = {
      exitCode: output?.exitCode ?? 1,
      outputBytes: output?.outputBytes || 0,
      logPath: output?.logPath,
      metadata: {
        timedOut: output?.timedOut === true,
        truncated: output?.truncated === true,
        ...(logError ? { logError } : {}),
      },
    }
    if (result.success) {
      this.runtimeTaskManager.completeTask(taskId, patch)
      return
    }
    this.runtimeTaskManager.failTask(taskId, result.error || `Process exited with code ${patch.exitCode}`, patch)
  }

  async validateCommand(command: string, cwd: string): Promise<Result<void>> {
    const validation = this.validateCommandSync(command, cwd)
    if (!validation.success) return { success: false, error: validation.error }
    return { success: true }
  }

  private validateCommandSync(command: string, cwd: string): { success: true; cwd: string } | { success: false; error: string } {
    try {
      this.capabilityBoundary.assertCommandAllowed()
      const safeCwd = this.resolvePath(cwd, 'write')
      return { success: true, cwd: safeCwd }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async startBackgroundCommand(
    command: string,
    cwd: string,
    env?: Record<string, string>,
    approved?: boolean,
  ): Promise<Result<TerminalStartCommandResult>> {
    const validation = this.validateCommandSync(command, cwd)
    if (!validation.success) return { success: false, error: validation.error }
    if (approved !== true) return { success: false, error: 'Command execution requires an explicit permission decision' }
    const { shell, shellArgs } = getShellCommand(command)
    return this.spawnTerminalSession({
      shell,
      shellArgs,
      shellId: DEFAULT_SHELL.id,
      shellLabel: DEFAULT_SHELL.label,
      command,
      cwd: validation.cwd,
      env,
      commandSession: true,
    })
  }

  async ptyCreate(options?: { shell?: string; cwd?: string; env?: Record<string, string> }): Promise<Result<{ sessionId: string; session: TerminalSessionInfo }>> {
    let safeCwd: string
    try {
      this.capabilityBoundary.assertCommandAllowed()
      safeCwd = this.resolvePath(options?.cwd || this.workspaceRoot, 'write')
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
    const shell = options?.shell || DEFAULT_SHELL.command
    return this.spawnTerminalSession({
      shell,
      shellArgs: options?.shell ? [] : DEFAULT_SHELL.args,
      shellId: options?.shell ? 'custom' : DEFAULT_SHELL.id,
      shellLabel: options?.shell ? shell : DEFAULT_SHELL.label,
      command: shell,
      cwd: safeCwd,
      env: options?.env,
      commandSession: false,
    })
  }

  private async spawnTerminalSession(options: {
    shell: string
    shellArgs: string[]
    shellId: string
    shellLabel: string
    command: string
    cwd: string
    env?: Record<string, string>
    commandSession: boolean
  }): Promise<Result<TerminalStartCommandResult>> {
    let runtimeTaskId: string | undefined
    let proc: ChildProcessWithoutNullStreams | undefined
    try {
      const now = Date.now()
      const sessionId = `term_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      const runtimeTask = this.runtimeTaskManager.createTask({
        kind: 'terminal',
        command: options.command,
        cwd: options.cwd,
        interactive: true,
        metadata: { sessionId, shellId: options.shellId, commandSession: options.commandSession },
      })
      runtimeTaskId = runtimeTask.id
      const logPath = this.createRuntimeTaskLog(runtimeTask.id)
      proc = spawn(options.shell, options.shellArgs, {
        cwd: options.cwd,
        env: this.buildChildEnvironment(options.env),
        ...getChildProcessSpawnOptions(),
      })
      const info: TerminalSessionInfo = {
        id: sessionId,
        pid: proc.pid ?? 0,
        shell: options.shell,
        shellId: options.shellId,
        shellLabel: options.shellLabel,
        cwd: options.cwd,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        isAgentSession: true,
        title: options.command,
        command: options.command,
        runtimeTaskId: runtimeTask.id,
        logPath,
        outputBytes: 0,
        omittedBytes: 0,
        firstSeq: 1,
        lastSeq: 0,
        canWrite: true,
      }
      const writer = new RuntimeLogWriter(logPath, {
        onDrain: () => {
          const active = this.backgroundTerminals.get(sessionId)
          if (!active?.pausedForLog) return
          active.pausedForLog = false
          if (!active.proc.stdout.destroyed) active.proc.stdout.resume()
          if (!active.proc.stderr.destroyed) active.proc.stderr.resume()
        },
        onError: error => {
          const active = this.backgroundTerminals.get(sessionId)
          if (active) active.logError = error.message
        },
      })
      const session: BackgroundTerminalSession = {
        info,
        proc,
        chunks: [],
        nextSeq: 1,
        bufferChars: 0,
        runtimeTaskId: runtimeTask.id,
        logPath,
        outputBytes: 0,
        omittedBytes: 0,
        writer,
        commandSession: options.commandSession,
        pausedForLog: false,
        lastRuntimeSnapshotAt: now,
        stopRequested: false,
      }
      this.backgroundTerminals.set(sessionId, session)
      this.runtimeTaskManager.setControl(runtimeTask.id, {
        stop: async () => {
          const result = await this.ptyKill(sessionId)
          if (!result.success) throw new Error(result.error || `Failed to stop terminal ${sessionId}`)
        },
        write: async data => {
          const result = await this.ptyWrite(sessionId, data)
          if (!result.success) throw new Error(result.error || `Failed to write terminal ${sessionId}`)
        },
      })
      this.runtimeTaskManager.markRunning(runtimeTask.id, {
        pid: proc.pid,
        logPath,
        outputBytes: 0,
        outputOffset: 0,
      })

      const append = (channel: 'stdout' | 'stderr', data: Buffer | string) => {
        const text = data.toString()
        if (!text) return
        const seq = session.nextSeq++
        session.outputBytes += Buffer.byteLength(data)
        if (!session.logError && !session.writer.append(channel, data, seq)) {
          session.pausedForLog = true
          session.proc.stdout.pause()
          session.proc.stderr.pause()
        }
        session.chunks.push({
          seq,
          data: text,
          timestamp: Date.now(),
        })
        session.bufferChars += text.length
        if (session.chunks.length > MAX_TERMINAL_CHUNKS) {
          const removed = session.chunks.splice(0, session.chunks.length - MAX_TERMINAL_CHUNKS)
          session.bufferChars -= removed.reduce((sum, chunk) => sum + chunk.data.length, 0)
          session.omittedBytes += removed.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.data), 0)
        }
        while (session.bufferChars > MAX_TERMINAL_BUFFER_CHARS && session.chunks.length > 1) {
          const removed = session.chunks.shift()
          if (removed) {
            session.bufferChars -= removed.data.length
            session.omittedBytes += Buffer.byteLength(removed.data)
          }
        }
        const updatedAt = Date.now()
        session.info.updatedAt = updatedAt
        session.info.outputBytes = session.outputBytes
        session.info.omittedBytes = session.omittedBytes
        session.info.firstSeq = session.chunks[0]?.seq ?? session.nextSeq
        session.info.lastSeq = session.nextSeq - 1
        if (updatedAt - session.lastRuntimeSnapshotAt >= RUNTIME_TASK_SNAPSHOT_INTERVAL_MS) {
          session.lastRuntimeSnapshotAt = updatedAt
          this.runtimeTaskManager.updateTask(session.runtimeTaskId, {
            outputBytes: session.outputBytes,
            outputOffset: session.outputBytes,
            metadata: {
              firstSeq: session.info.firstSeq,
              lastSeq: session.info.lastSeq,
              omittedBytes: session.omittedBytes,
            },
          })
        }
      }

      proc.stdout.on('data', data => append('stdout', data))
      proc.stderr.on('data', data => append('stderr', data))
      let processError: string | undefined
      proc.on('error', (err) => {
        processError = err.message
        session.info.error = err.message
        session.info.updatedAt = Date.now()
        append('stderr', `\n[terminal error] ${err.message}\n`)
      })
      proc.on('close', async (code, signal) => {
        await session.writer.close()
        const stopped = session.stopRequested
          || ['stopping', 'stopped'].includes(this.runtimeTaskManager.getTask(session.runtimeTaskId)?.status || '')
        const failed = !stopped && Boolean(processError || signal || (code ?? 1) !== 0)
        session.info.status = failed ? 'error' : 'exited'
        session.info.exitCode = code
        session.info.exitSignal = signal ?? null
        session.info.canWrite = false
        session.info.error = failed
          ? processError || (signal ? `Terminal exited with signal ${signal}` : `Terminal exited with code ${code ?? 1}`)
          : undefined
        session.info.updatedAt = Date.now()
        const patch = {
          exitCode: code,
          outputBytes: session.outputBytes,
          outputOffset: session.outputBytes,
          logPath: session.logPath,
          error: undefined,
          metadata: {
            exitSignal: signal ?? null,
            durationMs: Date.now() - session.info.createdAt,
            omittedBytes: session.omittedBytes,
            firstSeq: session.info.firstSeq,
            lastSeq: session.info.lastSeq,
            ...(session.logError ? { logError: session.logError } : {}),
          },
        }
        if (stopped) this.runtimeTaskManager.markStopped(session.runtimeTaskId, 'Terminal stopped', patch)
        else if (!failed) this.runtimeTaskManager.completeTask(session.runtimeTaskId, patch)
        else this.runtimeTaskManager.failTask(
          session.runtimeTaskId,
          session.info.error!,
          patch,
        )
        this.backgroundTerminals.delete(sessionId)
      })

      return { success: true, data: { sessionId, session: info }, session, sessionId }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (proc) this.terminateProcessTree(proc)
      if (runtimeTaskId) this.runtimeTaskManager.failTask(runtimeTaskId, message)
      return { success: false, error: message }
    }
  }

  async ptyWrite(sessionId: string, data: string): Promise<Result<void>> {
    const session = this.backgroundTerminals.get(sessionId)
    if (!session) return { success: false, error: `Terminal not found: ${sessionId}` }
    if (session.info.status !== 'running') return { success: false, error: `Terminal ${sessionId} is ${session.info.status}` }

    try {
      session.proc.stdin.write(data)
      session.info.updatedAt = Date.now()
      const firstLine = data.split(/\r?\n/).find(line => line.trim())
      if (firstLine && !session.commandSession) {
        session.info.title = firstLine.trim()
        this.runtimeTaskManager.updateTask(session.runtimeTaskId, { command: firstLine.trim() })
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async ptyGetBuffer(sessionId: string, sinceSeq = 0): Promise<Result<string>> {
    const session = this.backgroundTerminals.get(sessionId)
    if (!session) return this.readRecoveredTerminal(sessionId, sinceSeq)
    const chunks = sinceSeq > 0
      ? session.chunks.filter(chunk => chunk.seq > sinceSeq)
      : session.chunks
    const firstSeq = session.chunks[0]?.seq ?? session.nextSeq
    const lastSeq = session.nextSeq - 1
    return {
      success: true,
      data: chunks.map(chunk => chunk.data).join(''),
      chunks: [...chunks],
      session: { ...session.info },
      firstSeq,
      lastSeq,
      omittedBytes: sinceSeq < firstSeq - 1 ? session.omittedBytes : 0,
    }
  }

  async ptyInterruptCommand(sessionId: string): Promise<Result<void>> {
    const session = this.backgroundTerminals.get(sessionId)
    if (!session) return { success: false, error: `Terminal not found: ${sessionId}` }
    if (session.info.status !== 'running') return { success: false, error: `Terminal ${sessionId} is ${session.info.status}` }

    try {
      if (session.commandSession || process.platform === 'win32') {
        session.stopRequested = true
      }
      if (process.platform === 'win32') {
        await this.killTerminalProcessTree(session)
      } else {
        try {
          process.kill(-session.info.pid, 'SIGINT')
        } catch {
          session.proc.kill('SIGINT')
        }
      }
      if (session.stopRequested) this.runtimeTaskManager.markStopping(session.runtimeTaskId)
      session.info.updatedAt = Date.now()
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async ptyKill(sessionId: string): Promise<Result<void>> {
    const session = this.backgroundTerminals.get(sessionId)
    if (!session) return { success: false, error: `Terminal not found: ${sessionId}` }

    try {
      if (session.info.status === 'running') {
        session.stopRequested = true
        this.runtimeTaskManager.markStopping(session.runtimeTaskId)
        const closed = this.waitForTerminalClose(session, TERMINAL_KILL_TIMEOUT_MS)
        if (!session.proc.stdin.destroyed) {
          session.proc.stdin.end()
        }
        const exitedAfterStdinClose = await this.waitForTerminalClose(session, 1000)
        if (!exitedAfterStdinClose) {
          await this.killTerminalProcessTree(session)
        }
        const didClose = await closed
        if (!didClose && session.info.status === 'running') {
          this.runtimeTaskManager.updateTask(session.runtimeTaskId, {
            error: `Terminal did not exit within ${TERMINAL_KILL_TIMEOUT_MS}ms`,
          })
          return { success: false, error: `Terminal ${sessionId} did not exit within ${TERMINAL_KILL_TIMEOUT_MS}ms` }
        }
        await session.writer.close()
      }
      session.info.status = 'exited'
      session.info.canWrite = false
      session.info.error = undefined
      session.info.updatedAt = Date.now()
      this.runtimeTaskManager.markStopped(session.runtimeTaskId, 'Terminal stopped', {
        exitCode: session.info.exitCode,
        outputBytes: session.outputBytes,
        outputOffset: session.outputBytes,
        logPath: session.logPath,
        error: undefined,
        metadata: {
          omittedBytes: session.omittedBytes,
          firstSeq: session.info.firstSeq,
          lastSeq: session.info.lastSeq,
          ...(session.logError ? { logError: session.logError } : {}),
        },
      })
      return { success: true }
    } catch (e) {
      this.runtimeTaskManager.updateTask(session.runtimeTaskId, {
        error: e instanceof Error ? e.message : String(e),
      })
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async ptyList(): Promise<Result<TerminalSessionInfo[]>> {
    const sessions = Array.from(this.backgroundTerminals.values())
      .map(session => ({ ...session.info }))
    const knownIds = new Set(sessions.map(session => session.id))
    for (const task of this.runtimeTaskManager.listTasks({ kind: 'terminal' })) {
      const sessionId = typeof task.metadata?.sessionId === 'string' ? task.metadata.sessionId : undefined
      if (!sessionId || knownIds.has(sessionId)) continue
      const shellId = typeof task.metadata?.shellId === 'string' ? task.metadata.shellId : 'recovered'
      sessions.push({
        id: sessionId,
        pid: task.pid ?? 0,
        shell: shellId,
        shellId,
        shellLabel: shellId,
        cwd: task.cwd || this.workspaceRoot,
        status: task.status === 'running' || task.status === 'starting'
          ? 'running'
          : task.status === 'failed' || task.status === 'orphaned' ? 'error' : 'exited',
        createdAt: task.startedAt,
        updatedAt: task.updatedAt,
        isAgentSession: true,
        title: task.command || shellId,
        command: task.command,
        runtimeTaskId: task.id,
        logPath: task.logPath,
        outputBytes: task.outputBytes,
        omittedBytes: typeof task.metadata?.omittedBytes === 'number' ? task.metadata.omittedBytes : 0,
        firstSeq: typeof task.metadata?.firstSeq === 'number' ? task.metadata.firstSeq : undefined,
        lastSeq: typeof task.metadata?.lastSeq === 'number' ? task.metadata.lastSeq : undefined,
        exitCode: task.exitCode,
        error: task.error,
        recovered: task.metadata?.recovered === true,
        canWrite: false,
      })
    }
    sessions
      .sort((a, b) => a.createdAt - b.createdAt)
    return { success: true, data: sessions, sessions }
  }

  private readRecoveredTerminal(sessionId: string, sinceSeq: number): Result<string> {
    const task = this.runtimeTaskManager.listTasks({ kind: 'terminal' }).find(item => item.metadata?.sessionId === sessionId)
    if (!task) return { success: false, error: `Terminal not found: ${sessionId}` }
    const listed = this.runtimeTaskToSession(task)
    if (!task.logPath || !existsSync(task.logPath)) {
      return { success: true, data: '', chunks: [], session: listed, firstSeq: 1, lastSeq: 0, omittedBytes: 0 }
    }
    try {
      const fileSize = statSync(task.logPath).size
      const requestedOffset = Math.max(0, fileSize - MAX_RECOVERED_TERMINAL_READ_BYTES)
      const output = this.runtimeTaskManager.readTaskOutput(task.id, requestedOffset, MAX_RECOVERED_TERMINAL_READ_BYTES)
      const lines = output.content.split(/\r?\n/)
      if (requestedOffset > 0) lines.shift()
      const records = lines.filter(Boolean).flatMap((line, index) => {
        try {
          const record = JSON.parse(line) as { timestamp?: number; data?: string; seq?: number }
          return [{
            seq: typeof record.seq === 'number' ? record.seq : index + 1,
            timestamp: record.timestamp || task.startedAt,
            data: String(record.data || ''),
          }]
        } catch {
          return []
        }
      })
      const chunks = sinceSeq > 0 ? records.filter(record => record.seq > sinceSeq) : records
      const firstSeq = records[0]?.seq ?? 1
      const currentOutputBytes = records.reduce((total, record) => total + Buffer.byteLength(record.data), 0)
      const knownOmittedBytes = Math.max(
        typeof task.metadata?.omittedBytes === 'number' ? task.metadata.omittedBytes : 0,
        Math.max(0, (task.outputBytes || 0) - currentOutputBytes),
      )
      return {
        success: true,
        data: chunks.map(chunk => chunk.data).join(''),
        chunks,
        session: listed,
        firstSeq,
        lastSeq: records.at(-1)?.seq ?? 0,
        omittedBytes: sinceSeq < firstSeq - 1 ? knownOmittedBytes : 0,
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private runtimeTaskToSession(task: import('../../shared/runtimeTaskTypes').RuntimeTask): TerminalSessionInfo {
    const sessionId = typeof task.metadata?.sessionId === 'string' ? task.metadata.sessionId : task.id
    const shellId = typeof task.metadata?.shellId === 'string' ? task.metadata.shellId : 'recovered'
    return {
      id: sessionId,
      pid: task.pid ?? 0,
      shell: shellId,
      shellId,
      shellLabel: shellId,
      cwd: task.cwd || this.workspaceRoot,
      status: task.status === 'running' || task.status === 'starting'
        ? 'running'
        : task.status === 'failed' || task.status === 'orphaned' ? 'error' : 'exited',
      createdAt: task.startedAt,
      updatedAt: task.updatedAt,
      isAgentSession: true,
      title: task.command || shellId,
      command: task.command,
      runtimeTaskId: task.id,
      logPath: task.logPath,
      outputBytes: task.outputBytes,
      firstSeq: typeof task.metadata?.firstSeq === 'number' ? task.metadata.firstSeq : undefined,
      lastSeq: typeof task.metadata?.lastSeq === 'number' ? task.metadata.lastSeq : undefined,
      exitCode: task.exitCode,
      error: task.error,
      recovered: task.metadata?.recovered === true,
      canWrite: false,
    }
  }

  async ptyKillAll(): Promise<Result<void>> {
    const errors: string[] = []
    for (const sessionId of this.backgroundTerminals.keys()) {
      const result = await this.ptyKill(sessionId)
      if (!result.success) errors.push(`${sessionId}: ${result.error || 'unknown error'}`)
    }
    if (errors.length > 0) return { success: false, error: errors.join('\n') }
    return { success: true }
  }

  private async killTerminalProcessTree(session: BackgroundTerminalSession): Promise<void> {
    const pid = session.info.pid
    if (!pid) {
      session.proc.kill()
      return
    }

    if (process.platform === 'win32') {
      try {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'])
        return
      } catch {
        session.proc.kill()
        return
      }
    }

    try {
      process.kill(usesProcessGroup() ? -pid : pid, getProcessGroupSignal())
      return
    } catch {
      session.proc.kill('SIGTERM')
    }
  }

  private waitForTerminalClose(session: BackgroundTerminalSession, timeoutMs: number): Promise<boolean> {
    if (session.info.status !== 'running') return Promise.resolve(true)
    return new Promise(resolve => {
      let settled = false
      const done = (closed: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(closed)
      }
      const timer = setTimeout(() => done(false), timeoutMs)
      session.proc.once('close', () => done(true))
    })
  }

  async sendMessage(url: string, headers: Record<string, string>, body: string, options: RequestOptions = {}): Promise<Result<string>> {
    const request = this.createRequestController(options)
    try {
      for (let attempt = 0; attempt <= STREAM_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body,
            signal: request.controller.signal,
          })
          const text = await response.text()
          if (!response.ok) {
            const error = this.formatHttpError(url, response.status, text)
            if (attempt < STREAM_RETRY_DELAYS_MS.length && RETRYABLE_HTTP_STATUS.has(response.status)) {
              await this.delay(STREAM_RETRY_DELAYS_MS[attempt], request.controller.signal)
              continue
            }
            return { success: false, error, status: response.status }
          }
          return { success: true, data: text }
        } catch (error) {
          if (request.controller.signal.aborted || this.isAbortError(error)) {
            return {
              success: false,
              error: request.timedOut() && !options.signal?.aborted
                ? `Request timed out after ${request.timeoutMs}ms`
                : 'Request aborted',
            }
          }
          if (attempt < STREAM_RETRY_DELAYS_MS.length) {
            await this.delay(STREAM_RETRY_DELAYS_MS[attempt], request.controller.signal)
            continue
          }
          return { success: false, error: this.formatNetworkError(url, error) }
        }
      }
      return { success: false, error: 'Request failed' }
    } finally {
      request.cleanup()
    }
  }

  async streamMessage(
    url: string,
    headers: Record<string, string>,
    body: string,
    onLine: (line: string) => void,
    options: RequestOptions = {},
  ): Promise<Result<string>> {
    const request = this.createRequestController(options)
    if (options.streamId !== undefined) {
      this.activeStreams.get(options.streamId)?.abort()
      this.activeStreams.set(options.streamId, request.controller)
    }
    try {
      for (let attempt = 0; attempt <= STREAM_RETRY_DELAYS_MS.length; attempt += 1) {
        let emittedAnyLine = false
        let receivedAnyBytes = false
        let buffer = ''
        let fullResponse = ''
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body,
            signal: request.controller.signal,
          })
          if (!response.ok) {
            const text = await response.text()
            const error = this.formatHttpError(url, response.status, text)
            if (attempt < STREAM_RETRY_DELAYS_MS.length && RETRYABLE_HTTP_STATUS.has(response.status)) {
              await this.delay(STREAM_RETRY_DELAYS_MS[attempt], request.controller.signal)
              continue
            }
            return { success: false, error, status: response.status }
          }
          const reader = response.body?.getReader()
          if (!reader) return { success: false, error: 'No response body' }

          const decoder = new TextDecoder()

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (value.byteLength > 0) receivedAnyBytes = true
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''
            for (const line of lines) {
              if (line.trim()) {
                emittedAnyLine = true
                onLine(line)
                fullResponse += line + '\n'
              }
            }
          }
          if (buffer.trim()) {
            emittedAnyLine = true
            onLine(buffer)
            fullResponse += buffer
          }
          return { success: true, data: fullResponse }
        } catch (error) {
          if (request.controller.signal.aborted || this.isAbortError(error)) {
            return {
              success: false,
              error: request.timedOut() && !options.signal?.aborted
                ? `Request timed out after ${request.timeoutMs}ms`
                : 'Request aborted',
            }
          }
          if (buffer.trim()) {
            emittedAnyLine = true
            onLine(buffer)
            fullResponse += buffer
            buffer = ''
          }
          if (!emittedAnyLine && !receivedAnyBytes && attempt < STREAM_RETRY_DELAYS_MS.length) {
            await this.delay(STREAM_RETRY_DELAYS_MS[attempt], request.controller.signal)
            continue
          }
          return { success: false, error: this.formatNetworkError(url, error), data: fullResponse }
        }
      }
      return { success: false, error: 'Stream request failed' }
    } finally {
      if (options.streamId !== undefined && this.activeStreams.get(options.streamId) === request.controller) {
        this.activeStreams.delete(options.streamId)
      }
      request.cleanup()
    }
  }

  async streamAbort(streamId: number): Promise<void> {
    this.activeStreams.get(streamId)?.abort()
  }

  private createRequestController(options: RequestOptions): {
    controller: AbortController
    cleanup: () => void
    timedOut: () => boolean
    timeoutMs: number
  } {
    const controller = new AbortController()
    const timeoutMs = options.timeoutMs || MODEL_REQUEST_TIMEOUT_MS
    let timedOut = false
    const abortFromParent = () => controller.abort()
    if (options.signal?.aborted) controller.abort()
    else options.signal?.addEventListener('abort', abortFromParent, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    return {
      controller,
      timeoutMs,
      timedOut: () => timedOut,
      cleanup: () => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abortFromParent)
      },
    }
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
  }

  private async searchDuckDuckGoInstant(query: string, limit: number, region: string): Promise<WebSearchResult[]> {
    const url = new URL('https://api.duckduckgo.com/')
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    url.searchParams.set('no_html', '1')
    url.searchParams.set('skip_disambig', '1')
    url.searchParams.set('kl', region)

    const json = await this.fetchJsonWithTimeout(url.toString())
    const results: WebSearchResult[] = []

    if (typeof json.AbstractURL === 'string' && json.AbstractURL && typeof json.AbstractText === 'string' && json.AbstractText) {
      results.push({
        title: this.cleanText(json.Heading || query),
        url: json.AbstractURL,
        snippet: this.cleanText(json.AbstractText),
        source: json.AbstractSource || 'DuckDuckGo',
      })
    }

    const collectTopic = (topic: any): void => {
      if (!topic || typeof topic !== 'object') return
      if (typeof topic.FirstURL === 'string' && typeof topic.Text === 'string') {
        results.push({
          title: this.cleanText(topic.Text.split(' - ')[0] || topic.Text).slice(0, 120),
          url: topic.FirstURL,
          snippet: this.cleanText(topic.Text),
          source: 'DuckDuckGo',
        })
      }
      if (Array.isArray(topic.Topics)) {
        for (const child of topic.Topics) collectTopic(child)
      }
    }
    for (const topic of Array.isArray(json.RelatedTopics) ? json.RelatedTopics : []) collectTopic(topic)

    return this.dedupeWebResults(results).slice(0, limit)
  }

  private async searchDuckDuckGoHtml(query: string, limit: number, region: string, freshness?: string): Promise<WebSearchResult[]> {
    const url = new URL('https://duckduckgo.com/html/')
    url.searchParams.set('q', query)
    url.searchParams.set('kl', region)
    const df = this.freshnessToDuckDuckGoDf(freshness)
    if (df) url.searchParams.set('df', df)

    const html = await this.fetchTextWithTimeout(url.toString(), {
      'User-Agent': WEB_SEARCH_USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
    })
    const results: WebSearchResult[] = []
    const blockRe = /<div[^>]+class="result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi
    let match: RegExpExecArray | null
    while ((match = blockRe.exec(html)) && results.length < limit * 2) {
      const block = match[1]
      const link = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      if (!link) continue
      const rawUrl = this.decodeHtml(link[1])
      const title = this.cleanText(this.stripHtml(link[2]))
      const snippetMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
        || block.match(/<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i)
      const snippet = snippetMatch ? this.cleanText(this.stripHtml(snippetMatch[1])) : ''
      const normalizedUrl = this.normalizeDuckDuckGoUrl(rawUrl)
      if (!title || !normalizedUrl) continue
      results.push({ title, url: normalizedUrl, snippet, source: 'DuckDuckGo' })
    }
    return this.dedupeWebResults(results).slice(0, limit)
  }

  private async searchBingHtml(query: string, limit: number, freshness?: string): Promise<WebSearchResult[]> {
    const url = new URL('https://www.bing.com/search')
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(Math.max(limit, 5)))
    const freshnessFilter = this.freshnessToBingFilter(freshness)
    if (freshnessFilter) url.searchParams.set('qft', freshnessFilter)

    const html = await this.fetchTextWithTimeout(url.toString(), {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TurboFlux/0.1',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
    })
    const results: WebSearchResult[] = []
    const blockRe = /<li[^>]+class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi
    let match: RegExpExecArray | null
    while ((match = blockRe.exec(html)) && results.length < limit * 2) {
      const block = match[1]
      const link = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i)
        || block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      if (!link) continue
      const title = this.cleanText(this.stripHtml(link[2]))
      const normalizedUrl = this.normalizeBingUrl(this.decodeHtml(link[1]))
      const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
        || block.match(/<div[^>]+class="b_caption"[^>]*>([\s\S]*?)<\/div>/i)
      const snippet = snippetMatch ? this.cleanText(this.stripHtml(snippetMatch[1])) : ''
      if (!title || !normalizedUrl || normalizedUrl.startsWith('javascript:')) continue
      results.push({ title, url: normalizedUrl, snippet, source: 'Bing' })
    }
    return this.dedupeWebResults(results).slice(0, limit)
  }

  private async fetchJsonWithTimeout(url: string): Promise<any> {
    const text = await this.fetchTextWithTimeout(url, {
      'User-Agent': WEB_SEARCH_USER_AGENT,
      'Accept': 'application/json',
    })
    return JSON.parse(text)
  }

  private async fetchTextWithTimeout(url: string, headers: Record<string, string>): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS)
    try {
      const response = await fetch(url, { headers, signal: controller.signal })
      const text = await response.text()
      if (!response.ok) throw new Error(this.formatHttpError(url, response.status, text))
      return text
    } finally {
      clearTimeout(timer)
    }
  }

  private dedupeWebResults(results: WebSearchResult[]): WebSearchResult[] {
    const seen = new Set<string>()
    const deduped: WebSearchResult[] = []
    for (const result of results) {
      const url = result.url.trim()
      if (!url || seen.has(url)) continue
      seen.add(url)
      deduped.push({
        title: this.cleanText(result.title).slice(0, 160),
        url,
        snippet: this.cleanText(result.snippet).slice(0, 500),
        source: result.source,
        publishedDate: result.publishedDate,
      })
    }
    return deduped
  }

  private normalizeDuckDuckGoUrl(value: string): string {
    try {
      const decoded = this.decodeHtml(value)
      const url = new URL(decoded, 'https://duckduckgo.com')
      const uddg = url.searchParams.get('uddg')
      return uddg ? decodeURIComponent(uddg) : url.toString()
    } catch {
      return value
    }
  }

  private normalizeBingUrl(value: string): string {
    try {
      const decoded = this.decodeHtml(value)
      const url = new URL(decoded, 'https://www.bing.com')
      const rawU = url.searchParams.get('u')
      if (url.hostname.endsWith('bing.com') && rawU) {
        const target = this.decodeBingEncodedUrl(rawU)
        if (target) return target
      }
      return url.toString()
    } catch {
      return value
    }
  }

  private decodeBingEncodedUrl(value: string): string {
    try {
      const raw = value.startsWith('a1') ? value.slice(2) : value
      const padded = raw.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(raw.length / 4) * 4, '=')
      const decoded = Buffer.from(padded, 'base64').toString('utf-8')
      return /^https?:\/\//i.test(decoded) ? decoded : ''
    } catch {
      return ''
    }
  }

  private normalizeDomainFilter(value: string): string {
    const raw = String(value || '').trim()
    if (!raw) return ''
    try {
      const withProtocol = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`
      return new URL(withProtocol).hostname.replace(/^www\./i, '')
    } catch {
      return raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0]
    }
  }

  private freshnessToDuckDuckGoDf(freshness?: string): string {
    switch (freshness) {
      case 'day': return 'd'
      case 'week': return 'w'
      case 'month': return 'm'
      case 'year': return 'y'
      default: return ''
    }
  }

  private freshnessToBingFilter(freshness?: string): string {
    switch (freshness) {
      case 'day': return '+filterui:age-lt1440'
      case 'week': return '+filterui:age-lt10080'
      case 'month': return '+filterui:age-lt43200'
      case 'year': return '+filterui:age-lt525600'
      default: return ''
    }
  }

  private stripHtml(value: string): string {
    return value.replace(/<[^>]+>/g, ' ')
  }

  private decodeHtml(value: string): string {
    return value
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;|&ensp;|&emsp;/g, ' ')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#(\d+);/g, (_match, code) => {
        try { return String.fromCodePoint(Number(code)) } catch { return _match }
      })
      .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
        try { return String.fromCodePoint(parseInt(code, 16)) } catch { return _match }
      })
  }

  private cleanText(value: string): string {
    return this.decodeHtml(String(value || '').replace(/\s+/g, ' ').trim())
  }

  // Helper methods
  private resolvePath(path: string, access: FilesystemAccess = 'read'): string {
    return this.capabilityBoundary.resolvePath(path, access)
  }

  private buildTree(
    dirPath: string,
    maxDepth: number,
    depth = 0,
    budget: { remaining: number } = { remaining: 20_000 },
    maxEntriesPerDirectory = 500,
  ): TreeNode {
    const name = depth === 0 ? dirPath : dirPath.split(/[\\/]/).pop() || dirPath
    const node: TreeNode = { name, type: 'directory', children: [] }
    budget.remaining = Math.max(0, budget.remaining - 1)

    if (depth >= maxDepth || budget.remaining <= 0) return node

    try {
      const entries = readdirSync(dirPath, { withFileTypes: true })
        .filter(entry => !entry.isSymbolicLink() && !this.shouldSkipEntry(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, maxEntriesPerDirectory)
      for (const entry of entries) {
        if (budget.remaining <= 0) break
        const fullPath = join(dirPath, entry.name)
        if (entry.isDirectory()) {
          node.children!.push(this.buildTree(fullPath, maxDepth, depth + 1, budget, maxEntriesPerDirectory))
        } else {
          budget.remaining -= 1
          node.children!.push({ name: entry.name, type: 'file' })
        }
      }
    } catch { /* permission denied etc */ }

    return node
  }

  private globSync(pattern: string, basePath: string): string[] {
    // Simple glob implementation using recursive directory scan
    const results: string[] = []
    const regex = this.globToRegex(pattern)
    this.walkDir(basePath, (filePath) => {
      const rel = relative(basePath, filePath).replace(/\\/g, '/')
      if (regex.test(rel)) results.push(filePath)
    })
    return results
  }

  private searchContentFallback(
    pattern: string,
    basePath: string,
    filePattern?: string,
    caseInsensitive?: boolean,
    options: Pick<SearchContentOptions, 'contextBefore' | 'contextAfter' | 'maxMatchesPerFile' | 'signal'> = {},
  ): SearchContentHit[] {
    const matcher = new RegExp(pattern, caseInsensitive ? 'i' : '')
    const fileMatcher = filePattern ? this.globToRegex(filePattern) : null
    const contextBefore = Math.max(0, Math.min(20, Math.floor(options.contextBefore || 0)))
    const contextAfter = Math.max(0, Math.min(20, Math.floor(options.contextAfter || 0)))
    const maxMatchesPerFile = options.maxMatchesPerFile === undefined
      ? 0
      : Math.max(1, Math.min(100, Math.floor(options.maxMatchesPerFile)))
    const results: SearchContentHit[] = []
    this.walkDir(basePath, filePath => {
      if (options.signal?.aborted || results.length >= 500) return
      const rel = relative(basePath, filePath).replace(/\\/g, '/')
      if (fileMatcher && !fileMatcher.test(filePattern?.includes('/') ? rel : filePath.split(/[\\/]/).pop() || rel)) return
      try {
        const lines = readFileSync(filePath, 'utf-8').split(/\r?\n/)
        let fileMatches = 0
        for (let index = 0; index < lines.length && results.length < 500; index += 1) {
          if (options.signal?.aborted) return
          if (!matcher.test(lines[index])) {
            matcher.lastIndex = 0
            continue
          }
          matcher.lastIndex = 0
          if (maxMatchesPerFile > 0 && fileMatches >= maxMatchesPerFile) continue
          fileMatches += 1
          const contextLines: string[] = []
          const start = Math.max(0, index - contextBefore)
          const end = Math.min(lines.length - 1, index + contextAfter)
          for (let contextIndex = start; contextIndex <= end; contextIndex += 1) {
            if (contextIndex === index) continue
            contextLines.push(`${contextIndex + 1}: ${lines[contextIndex]}`)
          }
          results.push({
            file: filePath,
            line: index + 1,
            text: lines[index],
            ...(contextLines.length > 0 ? { context: contextLines.join('\n') } : {}),
          })
        }
      } catch {}
    })
    return results
  }

  private searchCodeSymbolsFallback(query: string, basePath: string, limit: number, workspacePath = basePath, exact = false): CodeSearchHit[] {
    const results: CodeSearchHit[] = []
    const queryLower = query.toLowerCase()
    this.walkDir(basePath, filePath => {
      if (results.length >= limit || !/\.(?:ts|tsx|js|jsx|mjs|cjs|py|pyi|rs|go|java|kt|kts|cs|c|cc|cpp|cxx|h|hpp|swift|scala|rb|php)$/i.test(filePath)) return
      try {
        const lines = readFileSync(filePath, 'utf-8').split(/\r?\n/)
        for (let index = 0; index < lines.length && results.length < limit; index += 1) {
          const declaration = this.extractSymbolDeclaration(lines[index])
          if (!declaration || (exact
            ? declaration.name.toLowerCase() !== queryLower
            : !declaration.name.toLowerCase().includes(queryLower))) continue
          const text = lines[index].trim()
          results.push({
            id: `sym_${index + 1}_${filePath.slice(-20)}`,
            path: relative(workspacePath, filePath).replace(/\\/g, '/'),
            title: declaration.name,
            subtitle: text.slice(0, 120),
            line: index + 1,
            startLine: index + 1,
            endLine: index + 6,
            score: 1,
            source: 'symbol',
            symbolKind: declaration.kind as CodeSearchHit['symbolKind'],
            preview: text,
          })
        }
      } catch {}
    })
    return results
  }

  private walkDir(dir: string, callback: (path: string) => void, depth = 0): void {
    if (depth > 10) return
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isSymbolicLink() || this.shouldSkipEntry(entry.name)) continue
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          this.walkDir(fullPath, callback, depth + 1)
        } else {
          callback(fullPath)
        }
      }
    } catch { /* skip */ }
  }

  private globToRegex(pattern: string): RegExp {
    const alternatives = this.expandGlobBraces(pattern.replace(/\\/g, '/'))
      .map(alternative => {
        let regex = ''
        for (let index = 0; index < alternative.length; index += 1) {
          const character = alternative[index]
          if (character === '*' && alternative[index + 1] === '*') {
            if (alternative[index + 2] === '/') {
              regex += '(?:.*/)?'
              index += 2
            } else {
              regex += '.*'
              index += 1
            }
          } else if (character === '*') {
            regex += '[^/]*'
          } else if (character === '?') {
            regex += '[^/]'
          } else {
            regex += character.replace(/[.+^$()|[\]{}\\]/g, '\\$&')
          }
        }
        return regex
      })
    return new RegExp(`^(?:${alternatives.join('|')})$`, 'i')
  }

  private expandGlobBraces(pattern: string): string[] {
    const open = pattern.indexOf('{')
    if (open < 0) return [pattern]
    const close = pattern.indexOf('}', open + 1)
    if (close < 0) return [pattern]
    const choices = pattern.slice(open + 1, close).split(',').filter(Boolean)
    if (choices.length < 2) return [pattern]
    const prefix = pattern.slice(0, open)
    const suffix = pattern.slice(close + 1)
    return choices.flatMap(choice => this.expandGlobBraces(`${prefix}${choice}${suffix}`))
  }

  private shouldSkipEntry(name: string): boolean {
    if (CODE_SEARCH_SKIPPED_DIRS.has(name.toLowerCase())) return true
    return name === '.env' || name === '.env.local' || /^\.env\..+\.local$/i.test(name)
  }

  private buildChildEnvironment(overrides?: Record<string, string>): NodeJS.ProcessEnv {
    return { ...process.env, ...overrides }
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve()
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, ms)
      signal?.addEventListener('abort', finish, { once: true })
    })
  }

  private formatHttpError(url: string, status: number, text: string): string {
    const detail = text.trim() || 'empty response'
    return `HTTP ${status}: ${detail}`
  }

  private formatNetworkError(url: string, error: unknown): string {
    const parts: string[] = []
    const seen = new Set<unknown>()
    let current: unknown = error
    for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
      if (seen.has(current)) break
      seen.add(current)
      if (current instanceof Error) {
        const record = current as Error & {
          code?: unknown
          errno?: unknown
          syscall?: unknown
          address?: unknown
          port?: unknown
          cause?: unknown
        }
        const metadata = [
          record.code ? `code=${String(record.code)}` : '',
          record.errno ? `errno=${String(record.errno)}` : '',
          record.syscall ? `syscall=${String(record.syscall)}` : '',
          record.address ? `address=${String(record.address)}` : '',
          record.port ? `port=${String(record.port)}` : '',
        ].filter(Boolean)
        parts.push(`${record.message || record.name}${metadata.length > 0 ? ` (${metadata.join(', ')})` : ''}`)
        current = record.cause
        continue
      }
      if (typeof current === 'object') {
        const record = current as Record<string, unknown>
        const metadata = ['code', 'errno', 'syscall', 'address', 'port']
          .filter(key => record[key] !== undefined)
          .map(key => `${key}=${String(record[key])}`)
        const message = typeof record.message === 'string' ? record.message : String(current)
        parts.push(`${message}${metadata.length > 0 ? ` (${metadata.join(', ')})` : ''}`)
        current = record.cause
        continue
      }
      parts.push(String(current))
      break
    }
    return `Network request to ${url} failed: ${parts.filter(Boolean).join(' <- caused by: ') || 'unknown network error'}`
  }
}

function getShellCommand(command: string): { shell: string; shellArgs: string[] } {
  if (process.platform !== 'win32') {
    return { shell: DEFAULT_SHELL.command, shellArgs: ['-lc', command] }
  }
  const wrapped = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding',
    command,
    '$turbofluxSucceeded = $?',
    '$turbofluxExitCode = $LASTEXITCODE',
    'if (-not $turbofluxSucceeded) { if ($null -ne $turbofluxExitCode) { exit $turbofluxExitCode }; exit 1 }',
  ].join('\n')
  return {
    shell: DEFAULT_SHELL.command,
    shellArgs: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', wrapped],
  }
}
