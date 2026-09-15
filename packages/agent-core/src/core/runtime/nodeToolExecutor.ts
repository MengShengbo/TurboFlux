import { createReadStream, readFileSync, existsSync, mkdirSync, rmSync, renameSync, readdirSync, statSync, writeFileSync, promises as fsPromises } from 'fs'
import { basename, join, dirname, relative, resolve as resolveNativePath, isAbsolute } from 'path'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { constants as osConstants, setPriority } from 'node:os'
import { createInterface } from 'readline'
import { promisify } from 'node:util'

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
  WebFetchResponse,
  WebSearchResponse,
} from '../../tools/executor'
import type { TreeNode } from '../../shared/types'
import type { Memory, MemoryConfidence, MemoryKind, MemoryScope, MemorySnapshot } from '../../shared/memoryTypes'
import type { TerminalOutputChunk, TerminalSessionInfo, TerminalStartCommandResult } from '../../shared/terminalTypes'
import type { CapabilityProfile } from '../../shared/agentTypes'
import type { RuntimeTaskPresentation } from '../../shared/runtimeTaskTypes'
import { MemoryService } from '../../tools/memory/service'
import { hashText, writeFileAtomic } from '../fileIO'
import { RuntimeTaskManager } from './runtimeTaskManager'
import { getChildProcessSpawnOptions, getDefaultShellSpec, getProcessGroupSignal, usesProcessGroup } from '../../platform/process'
import { RuntimeLogWriter } from './runtimeLogWriter'
import { CapabilityBoundary, type FilesystemAccess } from './capabilityBoundary'
import { WebResearchService } from './webResearchService'
import { searchWorkspaceContent, searchWorkspaceFiles } from './workspaceSearch'
import { emitStreamTimingTrace, streamTimingTraceEnabled, summarizeTimings } from './streamTimingTrace'

const RETRYABLE_HTTP_STATUS = new Set([408, 409, 425, 429])
const STREAM_RETRY_DELAYS_MS = [300, 900, 1800, 3600]
const MAX_STREAM_DIAGNOSTIC_CHARS = 64 * 1024
const MAX_STREAM_BUFFER_CHARS = 1 * 1024 * 1024

function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUS.has(status) || (status >= 500 && status <= 599)
}

export interface NodeToolExecutorOptions {
  runtimeTaskManager?: RuntimeTaskManager
  ownerSessionId?: string
  capabilityProfile?: CapabilityProfile
  memoryRoot?: string
  runtimeLogsRoot?: string
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
const MODEL_REQUEST_TIMEOUT_MS = 2 * 60 * 1000
const DEFAULT_SHELL = getDefaultShellSpec()
const CODE_SEARCH_SKIPPED_DIRS = new Set([
  '.git', '.hg', '.svn', '.claude', '.turboflux', '.vscode', '.cache', '.next', '.turbo',
  '.gradle', '.m2', '.npm', '.pnpm-store', '.rustup', '.venv',
  'AppData', 'appdata', 'Library', 'library', 'node_modules', 'vendor', 'venv', 'dist', 'dist-desktop', 'build', 'out',
  'coverage', 'target', 'tmp', 'temp',
])
const SAFE_ENV_TEMPLATE_NAMES = new Set(['.env.example', '.env.sample', '.env.template', '.env.defaults'])
const DEFAULT_READ_RANGE_LINES = 180
const DEFAULT_READ_RANGE_BYTES = 64 * 1024

export class NodeToolExecutor implements ToolExecutor {
  private memoryService: MemoryService
  private workspaceRoot: string
  private capabilityBoundary: CapabilityBoundary
  private backgroundTerminals: Map<string, BackgroundTerminalSession> = new Map()
  private activeStreams: Map<number, AbortController> = new Map()
  private runtimeTaskManager: RuntimeTaskManager
  private readonly webResearchService = new WebResearchService()
  private readonly runtimeLogsRoot?: string

  constructor(private workspacePath: string, options: NodeToolExecutorOptions = {}) {
    this.memoryService = new MemoryService(options.memoryRoot)
    this.runtimeLogsRoot = options.runtimeLogsRoot ? resolveNativePath(options.runtimeLogsRoot) : undefined
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
    const directory = this.runtimeLogsRoot
      ?? this.resolvePath(join(this.workspaceRoot, RUNTIME_LOG_DIRECTORY), 'write')
    mkdirSync(directory, { recursive: true })
    return this.runtimeLogsRoot
      ? join(directory, `${taskId}.jsonl`)
      : this.resolvePath(join(directory, `${taskId}.jsonl`), 'write')
  }

  async readFile(path: string): Promise<Result<string>> {
    try {
      const safePath = this.resolvePath(path)
      if (!existsSync(safePath)) return { success: false, error: 'File not found' }
      if (!statSync(safePath).isFile()) return { success: false, error: 'Path is not a file' }
      const content = await fsPromises.readFile(safePath, 'utf-8')
      return { success: true, data: content }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
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
      return { success: false, error: e instanceof Error ? e.message : String(e) }
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
        const actualHash = hashText(await fsPromises.readFile(safePath, 'utf-8'))
        if (actualHash !== metadata.expectedHash) {
          return { success: false, error: `Write conflict: file changed since it was read: ${path}` }
        }
      }
      await writeFileAtomic(safePath, content)
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
        const actualHash = hashText(await fsPromises.readFile(safePath, 'utf-8'))
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

  async moveFile(sourcePath: string, destinationPath: string, options?: { expectedHash?: string; expectedDestinationHash?: string }): Promise<Result<void>> {
    try {
      const safeSourcePath = this.resolvePath(sourcePath, 'write')
      const safeDestinationPath = this.resolvePath(destinationPath, 'write')
      if (!existsSync(safeSourcePath)) return { success: false, error: `File not found: ${sourcePath}` }
      if (statSync(safeSourcePath).isDirectory()) return { success: false, error: `Cannot move directory with moveFile: ${sourcePath}` }
      if (typeof options?.expectedHash === 'string') {
        const actualHash = hashText(await fsPromises.readFile(safeSourcePath, 'utf-8'))
        if (actualHash !== options.expectedHash) {
          return { success: false, error: `Move conflict: source changed since it was read: ${sourcePath}` }
        }
      }
      if (existsSync(safeDestinationPath)) {
        if (statSync(safeDestinationPath).isDirectory()) return { success: false, error: `Cannot overwrite directory: ${destinationPath}` }
        if (typeof options?.expectedDestinationHash === 'string') {
          const actualHash = hashText(await fsPromises.readFile(safeDestinationPath, 'utf-8'))
          if (actualHash !== options.expectedDestinationHash) {
            return { success: false, error: `Move conflict: destination changed since it was read: ${destinationPath}` }
          }
        }
      }
      const parent = dirname(safeDestinationPath)
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
      renameSync(safeSourcePath, safeDestinationPath)
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
      const resolved = this.resolvePath(path)
      if (!statSync(resolved).isDirectory()) return { success: false, error: 'Path is not a directory' }
      const root = this.buildTree(resolved, maxDepth, 0, { remaining: maxNodes }, maxEntriesPerDirectory)
      return { success: true, data: root }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async searchFiles(pattern: string, basePath: string, options: SearchFilesOptions = {}) {
    try {
      return await searchWorkspaceFiles(pattern, this.resolvePath(basePath), options)
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  async searchContent(pattern: string, basePath: string, filePattern?: string, caseInsensitive?: boolean): Promise<Result<SearchContentHit[]>> {
    const result = await this.searchContentPage(pattern, basePath, filePattern, caseInsensitive)
    return result.success ? { success: true, data: result.data?.hits || [] } : { success: false, error: result.error }
  }

  async searchContentBatch(requests: SearchContentBatchRequest[]): Promise<Array<Result<SearchContentPage>>> {
    return Promise.all(requests.map(request => this.searchContentPage(
      request.pattern, request.basePath, request.filePattern, request.caseInsensitive, request.options,
    )))
  }

  async searchContentPage(pattern: string, basePath: string, filePattern?: string, caseInsensitive?: boolean, options: SearchContentOptions = {}): Promise<Result<SearchContentPage>> {
    try {
      return await searchWorkspaceContent(pattern, this.resolvePath(basePath), filePattern, caseInsensitive, options)
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  async webSearch(query: Record<string, any>): Promise<Result<WebSearchResponse>> {
    return this.webResearchService.search(query as any)
  }

  async webFetch(query: Record<string, any>): Promise<Result<WebFetchResponse>> {
    return this.webResearchService.fetchPages(query as any)
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
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async memoryRemember(data: { content?: string; text?: string; kind?: MemoryKind; scope?: MemoryScope; tags?: string[]; confidence?: MemoryConfidence; workspacePath: string; conversationId?: string; messageId?: string }): Promise<Result<{ id: string; deduplicated?: boolean }>> {
    try {
      const safeWorkspacePath = this.resolvePath(data.workspacePath, 'write')
      const result = await this.memoryService.remember({
        workspacePath: safeWorkspacePath,
        text: data.content ?? data.text ?? '',
        kind: data.kind,
        scope: data.scope,
        tags: data.tags,
        confidence: data.confidence,
        conversationId: data.conversationId,
        messageId: data.messageId,
      })
      if (!result.success) return { success: false, error: result.error }
      return { success: true, data: { id: result.id || '', deduplicated: result.deduplicated } }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async memoryForget(data: { id: string; workspacePath: string; reason?: string }): Promise<Result<void>> {
    try {
      const safeWorkspacePath = this.resolvePath(data.workspacePath, 'write')
      const result = await this.memoryService.forget({ workspacePath: safeWorkspacePath, id: data.id, reason: data.reason })
      if (!result.success) return { success: false, error: result.error }
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async memoryUpdate(data: {
    id: string
    workspacePath: string
    text?: string
    scope?: MemoryScope
    kind?: MemoryKind
    confidence?: MemoryConfidence
    tags?: string[]
    pinned?: boolean
    reviewState?: Memory['reviewState']
    status?: Memory['status']
  }): Promise<Result<void>> {
    try {
      const safeWorkspacePath = this.resolvePath(data.workspacePath, 'write')
      const result = await this.memoryService.update({
        workspacePath: safeWorkspacePath,
        id: data.id,
        text: data.text,
        scope: data.scope,
        kind: data.kind,
        confidence: data.confidence,
        tags: data.tags,
        pinned: data.pinned,
        reviewState: data.reviewState,
        status: data.status,
      })
      if (!result.success) return { success: false, error: result.error }
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async memoryList(workspacePath: string, forceReload = false, includeInactive = false): Promise<Result<{ snapshot: MemorySnapshot; items: Array<{ id: string; content: string; kind: string }> }>> {
    try {
      const safeWorkspacePath = this.resolvePath(workspacePath)
      const snapshot = await this.memoryService.getSnapshot(safeWorkspacePath, { force: forceReload, includeInactive })
      const memories = await this.memoryService.query({ workspacePath: safeWorkspacePath, limit: 100 })
      const items = memories.map(m => ({ id: m.id, content: m.text, kind: m.kind }))
      return { success: true, data: { snapshot, items } }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async memoryGetRelevantInjection(params: { workspacePath: string; query: string }): Promise<Result<{ text: string; tokens: number }>> {
    try {
      const safeWorkspacePath = this.resolvePath(params.workspacePath)
      const result = await this.memoryService.getRelevantInjection(safeWorkspacePath, params.query)
      return { success: true, data: { text: result.text, tokens: result.tokens } }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async runCommand(
    command: string,
    cwd: string,
    env?: Record<string, string>,
    timeout?: number,
    approved?: boolean,
    signal?: AbortSignal,
  ): Promise<Result<CommandOutput>> {
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
    return this.executeCommand(command, safeCwd, env, timeout, signal)
  }

  private async executeCommand(
    command: string,
    safeCwd: string,
    env: Record<string, string> | undefined,
    timeout: number | undefined,
    signal?: AbortSignal,
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
      return this.collectProcess(proc, timeout || 30000, runtimeTask.id, logPath, signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.runtimeTaskManager.failTask(runtimeTask.id, message, { logPath, outputBytes: 0 })
      return { success: false, error: message, data: { stdout: '', stderr: message, exitCode: 1, logPath, outputBytes: 0 } }
    }
  }

  async readOnlyProcess(command: string, args: string[], cwd: string, env?: Record<string, string>, timeout?: number, signal?: AbortSignal): Promise<Result<CommandOutput>> {
    return this.runProcess(command, args, cwd, env, timeout, signal, 'read')
  }

  async runProcess(command: string, args: string[], cwd: string, env?: Record<string, string>, timeout?: number, signal?: AbortSignal, access: FilesystemAccess = 'write'): Promise<Result<CommandOutput>> {
    let runtimeTaskId: string | undefined
    let logPath: string | undefined
    try {
      const safeCwd = this.resolvePath(cwd, access)
      const runtimeTask = this.runtimeTaskManager.createTask({
        kind: 'shell',
        command: [command, ...args].join(' '),
        cwd: safeCwd,
        interactive: false,
        metadata: { executable: command, args: [...args] },
      })
      runtimeTaskId = runtimeTask.id
      logPath = access === 'read' && this.getCapabilityProfile() === 'read-only'
        ? undefined
        : this.createRuntimeTaskLog(runtimeTask.id)
      const proc = spawn(command, args, {
        cwd: safeCwd,
        env: this.buildChildEnvironment(env),
        ...getChildProcessSpawnOptions(),
      })
      this.runtimeTaskManager.setControl(runtimeTask.id, {
        stop: () => this.stopProcessAndWait(proc),
      })
      this.runtimeTaskManager.markRunning(runtimeTask.id, { pid: proc.pid, logPath, outputBytes: 0, outputOffset: 0 })
      return await this.collectProcess(proc, timeout || 30000, runtimeTask.id, logPath, signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (runtimeTaskId) this.runtimeTaskManager.failTask(runtimeTaskId, message, { logPath, outputBytes: 0 })
      return { success: false, error: message, data: { stdout: '', stderr: message, exitCode: 1, logPath, outputBytes: 0 } }
    }
  }

  private collectProcess(
    proc: ChildProcessWithoutNullStreams,
    timeout: number,
    runtimeTaskId?: string,
    logPath?: string,
    signal?: AbortSignal,
  ): Promise<Result<CommandOutput>> {
    return new Promise(resolve => {
      const stdoutParts: string[] = []
      const stderrParts: string[] = []
      let stdoutChars = 0
      let stderrChars = 0
      let truncated = false
      let timedOut = false
      let aborted = false
      let settled = false
      let outputBytes = 0
      let logError: string | undefined
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined
      let timeoutCheckImmediate: ReturnType<typeof setImmediate> | undefined
      let terminationGraceTimer: ReturnType<typeof setTimeout> | undefined
      const logWriter = logPath ? new RuntimeLogWriter(logPath, {
        onDrain: () => {
          if (!proc.stdout.destroyed) proc.stdout.resume()
          if (!proc.stderr.destroyed) proc.stderr.resume()
        },
        onError: error => { logError = error.message },
      }) : undefined

      const append = (parts: string[], currentLength: number, value: Buffer | string): number => {
        if (currentLength >= MAX_COMMAND_OUTPUT_CHARS) {
          truncated = true
          return currentLength
        }
        const text = value.toString()
        const remaining = MAX_COMMAND_OUTPUT_CHARS - currentLength
        if (text.length > remaining) truncated = true
        const bounded = text.slice(0, remaining)
        if (bounded) parts.push(bounded)
        return currentLength + bounded.length
      }
      const stdout = () => stdoutParts.join('')
      const stderr = () => stderrParts.join('')
      const finish = async (result: Result<CommandOutput>) => {
        if (settled) return
        settled = true
        if (timeoutTimer) clearTimeout(timeoutTimer)
        if (timeoutCheckImmediate) clearImmediate(timeoutCheckImmediate)
        if (terminationGraceTimer) clearTimeout(terminationGraceTimer)
        proc.stdout.off('data', onStdout)
        proc.stderr.off('data', onStderr)
        proc.off('error', onError)
        proc.off('close', onClose)
        signal?.removeEventListener('abort', onAbort)
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
        stdoutChars = append(stdoutParts, stdoutChars, data)
      }
      const onStderr = (data: Buffer | string) => {
        recordOutput('stderr', data)
        stderrChars = append(stderrParts, stderrChars, data)
      }
      const onError = (error: Error) => {
        recordOutput('stderr', error.message)
        void finish({ success: false, error: aborted ? 'Command aborted' : error.message, data: { stdout: stdout(), stderr: stderr(), exitCode: 1, timedOut, aborted, truncated } })
      }
      const onClose = (code: number | null) => {
        const exitCode = code ?? 1
        const success = code !== null && !timedOut && !aborted
        const error = aborted
          ? 'Command aborted'
          : timedOut
          ? `Command timed out after ${timeout}ms`
          : code === null ? 'Command terminated without an exit code' : undefined
        void finish({ success, error, data: { stdout: stdout(), stderr: stderr(), exitCode, timedOut, aborted, truncated } })
      }
      const onAbort = () => {
        if (settled || aborted) return
        aborted = true
        try {
          this.terminateProcessTree(proc)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          void finish({
            success: false,
            error: `Command aborted; process termination failed: ${message}`,
            data: { stdout: stdout(), stderr: stderr(), exitCode: 1, timedOut, aborted, truncated },
          })
          return
        }
        if (!terminationGraceTimer) {
          terminationGraceTimer = setTimeout(() => {
            void finish({
              success: false,
              error: 'Command aborted; process did not exit within the termination grace period',
              data: { stdout: stdout(), stderr: stderr(), exitCode: 1, timedOut, aborted, truncated },
            })
          }, COMMAND_TERMINATION_GRACE_MS)
        }
      }

      proc.stdout.on('data', onStdout)
      proc.stderr.on('data', onStderr)
      proc.on('error', onError)
      proc.on('close', onClose)
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
      timeoutTimer = setTimeout(() => {
        if (settled || aborted) return
        timeoutCheckImmediate = setImmediate(() => {
          timeoutCheckImmediate = undefined
          if (settled || aborted) return
          if (!this.isChildProcessAlive(proc)) return
          timedOut = true
          try {
            this.terminateProcessTree(proc)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            void finish({
              success: false,
              error: `Command timed out after ${timeout}ms; process termination failed: ${message}`,
              data: { stdout: stdout(), stderr: stderr(), exitCode: 1, timedOut, truncated },
            })
            return
          }
          if (settled) return
          terminationGraceTimer = setTimeout(() => {
            void finish({
              success: false,
              error: `Command timed out after ${timeout}ms; process did not exit within the ${COMMAND_TERMINATION_GRACE_MS}ms termination grace period`,
              data: { stdout: stdout(), stderr: stderr(), exitCode: 1, timedOut, truncated },
            })
          }, COMMAND_TERMINATION_GRACE_MS)
        })
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

  private isChildProcessAlive(proc: ChildProcessWithoutNullStreams): boolean {
    if (proc.exitCode != null || proc.signalCode != null) return false
    if (!proc.pid) return true
    if (typeof proc.kill !== 'function') return true
    try {
      return proc.kill(0)
    } catch {
      return false
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
    if (result.success && (output?.exitCode ?? 0) === 0) {
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
    presentation?: RuntimeTaskPresentation,
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
      presentation,
    })
  }

  async ptyCreate(options?: { shell?: string; cwd?: string; env?: Record<string, string>; presentation?: RuntimeTaskPresentation }): Promise<Result<{ sessionId: string; session: TerminalSessionInfo }>> {
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
      presentation: options?.presentation,
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
    presentation?: RuntimeTaskPresentation
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
        presentation: options.presentation,
        metadata: { sessionId, shellId: options.shellId, commandSession: options.commandSession },
      })
      runtimeTaskId = runtimeTask.id
      const logPath = this.createRuntimeTaskLog(runtimeTask.id)
      proc = spawn(options.shell, options.shellArgs, {
        cwd: options.cwd,
        env: this.buildChildEnvironment(options.env),
        ...getChildProcessSpawnOptions(),
      })
      if (proc.pid) {
        try {
          setPriority(proc.pid, osConstants.priority.PRIORITY_BELOW_NORMAL)
        } catch {}
      }
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
    const maxRetries = options.retry === false ? 0 : STREAM_RETRY_DELAYS_MS.length
    try {
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
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
            const retryAfterMs = this.retryAfterMs(response.headers.get('retry-after'))
            if (attempt < maxRetries && isRetryableHttpStatus(response.status)) {
              await this.delay(Math.max(STREAM_RETRY_DELAYS_MS[attempt]!, retryAfterMs || 0), request.controller.signal)
              continue
            }
            return {
              success: false,
              error,
              status: response.status,
              receivedStreamData: false,
              ...(retryAfterMs ? { retryAfterMs } : {}),
            }
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
          if (attempt < maxRetries) {
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
    const maxRetries = options.retry === false ? 0 : STREAM_RETRY_DELAYS_MS.length
    if (options.streamId !== undefined) {
      this.activeStreams.get(options.streamId)?.abort()
      this.activeStreams.set(options.streamId, request.controller)
    }
    try {
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const traceEnabled = streamTimingTraceEnabled()
        const requestStartedAt = traceEnabled ? performance.now() : 0
        const readWaitDurations: number[] = []
        const dispatchDurations: number[] = []
        let responseReceivedAt = 0
        let rawChunkCount = 0
        let rawByteCount = 0
        let dispatchedLineCount = 0
        let emittedAnyLine = false
        let receivedAnyBytes = false
        let buffer = ''
        const diagnosticChunks: string[] = []
        let diagnosticChars = 0
        const recordDiagnostic = (line: string): void => {
          if (diagnosticChars >= MAX_STREAM_DIAGNOSTIC_CHARS) return
          const remaining = MAX_STREAM_DIAGNOSTIC_CHARS - diagnosticChars
          const bounded = line.slice(0, remaining)
          diagnosticChunks.push(bounded)
          diagnosticChars += bounded.length
        }
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body,
            signal: request.controller.signal,
          })
          if (traceEnabled) responseReceivedAt = performance.now()
          request.refreshTimeout()
          if (!response.ok) {
            const text = await response.text()
            const error = this.formatHttpError(url, response.status, text)
            const retryAfterMs = this.retryAfterMs(response.headers.get('retry-after'))
            if (attempt < maxRetries && isRetryableHttpStatus(response.status)) {
              await this.delay(Math.max(STREAM_RETRY_DELAYS_MS[attempt]!, retryAfterMs || 0), request.controller.signal)
              continue
            }
            return {
              success: false,
              error,
              status: response.status,
              receivedStreamData: false,
              ...(retryAfterMs ? { retryAfterMs } : {}),
            }
          }
          const reader = response.body?.getReader()
          if (!reader) return { success: false, error: 'No response body', receivedStreamData: false }

          const decoder = new TextDecoder()

          while (true) {
            const readStartedAt = traceEnabled ? performance.now() : 0
            const { done, value } = await reader.read()
            if (traceEnabled) readWaitDurations.push(performance.now() - readStartedAt)
            if (done) break
            if (traceEnabled) {
              rawChunkCount += 1
              rawByteCount += value.byteLength
            }
            if (value.byteLength > 0) {
              receivedAnyBytes = true
              request.refreshTimeout()
            }
            buffer += decoder.decode(value, { stream: true })
            if (buffer.length > MAX_STREAM_BUFFER_CHARS) {
              const lastNewline = buffer.lastIndexOf('\n')
              buffer = lastNewline >= 0 && lastNewline <= MAX_STREAM_BUFFER_CHARS
                ? buffer.slice(0, lastNewline + 1)
                : ''
            }
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''
            for (const line of lines) {
              if (line.trim()) {
                emittedAnyLine = true
                const dispatchStartedAt = traceEnabled ? performance.now() : 0
                onLine(line)
                if (traceEnabled) {
                  dispatchDurations.push(performance.now() - dispatchStartedAt)
                  dispatchedLineCount += 1
                }
                recordDiagnostic(`${line}\n`)
              }
            }
          }
          if (buffer.trim()) {
            emittedAnyLine = true
            const dispatchStartedAt = traceEnabled ? performance.now() : 0
            onLine(buffer)
            if (traceEnabled) {
              dispatchDurations.push(performance.now() - dispatchStartedAt)
              dispatchedLineCount += 1
            }
            recordDiagnostic(buffer)
          }
          if (traceEnabled) {
            const completedAt = performance.now()
            let endpoint = url
            try {
              const parsed = new URL(url)
              endpoint = `${parsed.origin}${parsed.pathname}`
            } catch {}
            emitStreamTimingTrace('node-tool-executor', {
              attempt,
              endpoint,
              status: response.status,
              headerMs: Number((responseReceivedAt - requestStartedAt).toFixed(3)),
              totalMs: Number((completedAt - requestStartedAt).toFixed(3)),
              rawChunkCount,
              rawByteCount,
              dispatchedLineCount,
              readWait: summarizeTimings(readWaitDurations),
              lineDispatch: summarizeTimings(dispatchDurations),
            })
          }
          return { success: true }
        } catch (error) {
          if (request.controller.signal.aborted || this.isAbortError(error)) {
            return {
              success: false,
              error: request.timedOut() && !options.signal?.aborted
                ? `Request timed out after ${request.timeoutMs}ms`
                : 'Request aborted',
              receivedStreamData: emittedAnyLine || receivedAnyBytes,
            }
          }
          if (buffer.trim()) {
            emittedAnyLine = true
            onLine(buffer)
            recordDiagnostic(buffer)
            buffer = ''
          }
          if (!emittedAnyLine && !receivedAnyBytes && attempt < maxRetries) {
            await this.delay(STREAM_RETRY_DELAYS_MS[attempt], request.controller.signal)
            continue
          }
          return {
            success: false,
            error: this.formatNetworkError(url, error),
            receivedStreamData: emittedAnyLine || receivedAnyBytes,
            ...(diagnosticChunks.length > 0 ? { data: diagnosticChunks.join('') } : {}),
          }
        }
      }
      return { success: false, error: 'Stream request failed', receivedStreamData: false }
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
    refreshTimeout: () => void
    timedOut: () => boolean
    timeoutMs: number
  } {
    const controller = new AbortController()
    const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs || 0) > 0
      ? Math.floor(options.timeoutMs as number)
      : MODEL_REQUEST_TIMEOUT_MS
    let timedOut = false
    const abortFromParent = () => controller.abort()
    if (options.signal?.aborted) controller.abort()
    else options.signal?.addEventListener('abort', abortFromParent, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const refreshTimeout = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
    }
    refreshTimeout()
    return {
      controller,
      timeoutMs,
      timedOut: () => timedOut,
      refreshTimeout,
      cleanup: () => {
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', abortFromParent)
      },
    }
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
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

    if (depth >= maxDepth) return node
    if (budget.remaining <= 0) return { ...node, truncated: true }

    try {
      const entries = readdirSync(dirPath, { withFileTypes: true })
        .filter(entry => !entry.isSymbolicLink() && !this.shouldSkipEntry(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name))
      if (entries.length > maxEntriesPerDirectory) node.truncated = true
      for (const entry of entries.slice(0, maxEntriesPerDirectory)) {
        if (budget.remaining <= 0) { node.truncated = true; break }
        const fullPath = join(dirPath, entry.name)
        if (entry.isDirectory()) {
          const child = this.buildTree(fullPath, maxDepth, depth + 1, budget, maxEntriesPerDirectory)
          node.children!.push(child)
          if (child.truncated) node.truncated = true
        } else {
          budget.remaining -= 1
          node.children!.push({ name: entry.name, type: 'file' })
        }
      }
    } catch (error) {
      if (depth === 0) throw error
      node.truncated = true
    }

    return node
  }


  private shouldSkipEntry(name: string): boolean {
    if (CODE_SEARCH_SKIPPED_DIRS.has(name.toLowerCase())) return true
    return this.isSensitiveEnvironmentFileName(name)
  }

  private isSensitiveEnvironmentFileName(name: string): boolean {
    const normalized = name.toLowerCase()
    return normalized.startsWith('.env') && !SAFE_ENV_TEMPLATE_NAMES.has(normalized)
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

  private retryAfterMs(value: string | null): number | undefined {
    if (!value) return undefined
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(120_000, Math.round(seconds * 1000))
    const date = Date.parse(value)
    if (!Number.isFinite(date)) return undefined
    return Math.min(120_000, Math.max(0, date - Date.now()))
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
