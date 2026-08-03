import type { TreeNode } from '../shared/types'
import type { CodeMapNode, CodeSearchHit } from '../shared/codeIndexTypes'
import type { MemoryKind, MemoryScope } from '../shared/memoryTypes'
import type { TerminalBufferResult, TerminalSessionInfo, TerminalStartCommandResult } from '../shared/terminalTypes'

export interface Result<T = any> {
  success: boolean
  data?: T
  error?: string
  retryAfterMs?: number
  receivedStreamData?: boolean
  // TODO: remove this index signature once all IPC/tool results migrate to
  // the `data` envelope pattern instead of flat extra properties.
  [key: string]: any
}

export interface SearchContentHit {
  file: string
  line: number
  text: string
  context?: string
}

export interface SearchContentOptions {
  offset?: number
  limit?: number
  contextBefore?: number
  contextAfter?: number
  multiline?: boolean
  fileType?: string
  maxColumns?: number
  maxMatchesPerFile?: number
  signal?: AbortSignal
}

export interface SearchContentPage {
  hits: SearchContentHit[]
  totalMatches: number
  offset: number
  limit: number
  truncated: boolean
}

export interface SearchContentBatchRequest {
  pattern: string
  basePath: string
  filePattern?: string
  caseInsensitive?: boolean
  options?: SearchContentOptions
}

export interface SearchFilesOptions {
  offset?: number
  limit?: number
  signal?: AbortSignal
}

export interface FileRangeResult {
  content: string
  startLine: number
  endLine: number
  truncated: boolean
  bytesRead: number
  partialLine?: boolean
}

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
  source?: string
  publishedDate?: string
}

export interface CommandOutput {
  stdout: string
  stderr: string
  exitCode: number
  timedOut?: boolean
  aborted?: boolean
  truncated?: boolean
  logPath?: string
  outputBytes?: number
}

export interface RequestOptions {
  signal?: AbortSignal
  streamId?: number
  timeoutMs?: number
  retry?: boolean
}

export interface ListTreeOptions {
  maxDepth?: number
  maxEntriesPerDirectory?: number
  maxNodes?: number
}

export interface ToolExecutor {
  // File operations
  readFile(path: string): Promise<Result<string>>
  readFileRange?(path: string, offset?: number, limit?: number, maxBytes?: number): Promise<Result<FileRangeResult>>
  writeFile(path: string, content: string, metadata?: Record<string, unknown>): Promise<Result<void>>
  deleteFile(path: string, options?: Record<string, any>): Promise<Result<void>>
  moveFile?(sourcePath: string, destinationPath: string, options?: { expectedHash?: string; expectedDestinationHash?: string }): Promise<Result<void>>
  listTree(path: string, options?: ListTreeOptions): Promise<Result<TreeNode>>

  // Search operations
  searchFiles(pattern: string, basePath: string, options?: SearchFilesOptions): Promise<Result<{ matches: string[]; truncated?: boolean; offset?: number; limit?: number }>>
  searchContent(pattern: string, basePath: string, filePattern?: string, caseInsensitive?: boolean): Promise<Result<SearchContentHit[]>>
  searchContentPage?(pattern: string, basePath: string, filePattern?: string, caseInsensitive?: boolean, options?: SearchContentOptions): Promise<Result<SearchContentPage>>
  searchContentBatch?(requests: SearchContentBatchRequest[]): Promise<Array<Result<SearchContentPage>>>
  webSearch?(query: Record<string, any>): Promise<Result<{ results: WebSearchResult[]; provider: string; query: string }>>

  // Code lookup operations
  searchCodeSymbols(query: Record<string, any>): Promise<Result<any>>
  getCodeMap(query: Record<string, any>): Promise<Result<any>>

  // Memory operations
  memoryQuery(query: Record<string, any>): Promise<Result<any>>
  memoryRemember(data: Record<string, any>): Promise<Result<any>>
  memoryForget(data: Record<string, any>): Promise<Result<void>>
  memoryList(workspacePath: string): Promise<Result<any>>
  memoryGetRelevantInjection?(query: Record<string, any>): Promise<Result<any>>

  // Terminal operations
  runCommand(command: string, cwd: string, env?: Record<string, string>, timeout?: number, approved?: boolean, signal?: AbortSignal): Promise<Result<CommandOutput>>
  /** Execute a process while resolving its working directory through read access. */
  readOnlyProcess?(command: string, args: string[], cwd: string, env?: Record<string, string>, timeout?: number, signal?: AbortSignal): Promise<Result<CommandOutput>>
  runProcess?(command: string, args: string[], cwd: string, env?: Record<string, string>, timeout?: number, signal?: AbortSignal): Promise<Result<CommandOutput>>
  validateCommand?(command: string, cwd: string): Promise<Result<void>>
  startBackgroundCommand?(command: string, cwd: string, env?: Record<string, string>, approved?: boolean): Promise<Result<TerminalStartCommandResult>>
  ptyCreate?(options?: { shell?: string; cwd?: string; env?: Record<string, string> }): Promise<Result<{ sessionId: string; session?: TerminalSessionInfo }>>
  ptyWrite?(sessionId: string, data: string): Promise<Result<void>>
  ptyGetBuffer?(sessionId: string, sinceSeq?: number): Promise<Result<string> & TerminalBufferResult>
  ptyInterruptCommand?(sessionId: string): Promise<Result<void>>
  ptyKill?(sessionId: string): Promise<Result<void>>
  ptyList?(): Promise<Result<TerminalSessionInfo[]>>
  ptyKillAll?(): Promise<Result<void>>

  // Stream operations (API calls)
  sendMessage(url: string, headers: Record<string, string>, body: string, options?: RequestOptions): Promise<Result<string>>
  streamMessage(url: string, headers: Record<string, string>, body: string, onLine: (line: string) => void, options?: RequestOptions): Promise<Result<string>>
  streamAbort?(streamId: number): Promise<void>
}
