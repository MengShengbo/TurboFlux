import type { TreeNode } from '../shared/types'
import type { CodeMapNode, CodeSearchHit } from '../shared/codeIndexTypes'
import type { MemoryKind, MemoryScope } from '../shared/memoryTypes'
import type { TerminalBufferResult, TerminalSessionInfo } from '../shared/terminalTypes'

export interface Result<T = any> {
  success: boolean
  data?: T
  error?: string
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
  truncated?: boolean
}

export interface RequestOptions {
  signal?: AbortSignal
  streamId?: number
  timeoutMs?: number
}

export interface CheckpointResult {
  id: string
  label: string
  timestamp: number
}

export interface ToolExecutor {
  // File operations
  readFile(path: string): Promise<Result<string>>
  writeFile(path: string, content: string, metadata?: Record<string, unknown>): Promise<Result<void>>
  deleteFile(path: string, options?: Record<string, any>): Promise<Result<void>>
  listTree(path: string): Promise<Result<TreeNode>>

  // Search operations
  searchFiles(pattern: string, basePath: string): Promise<Result<{ matches: string[]; truncated?: boolean }>>
  searchContent(pattern: string, basePath: string, filePattern?: string, caseInsensitive?: boolean): Promise<Result<SearchContentHit[]>>
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
  runCommand(command: string, cwd: string, env?: Record<string, string>, timeout?: number, approved?: boolean): Promise<Result<CommandOutput>>
  runProcess?(command: string, args: string[], cwd: string, env?: Record<string, string>, timeout?: number): Promise<Result<CommandOutput>>
  validateCommand?(command: string, cwd: string): Promise<Result<void>>
  ptyCreate?(options?: { shell?: string; cwd?: string; env?: Record<string, string> }): Promise<Result<{ sessionId: string; session?: TerminalSessionInfo }>>
  ptyWrite?(sessionId: string, data: string): Promise<Result<void>>
  ptyGetBuffer?(sessionId: string): Promise<Result<string> & TerminalBufferResult>
  ptyInterruptCommand?(sessionId: string): Promise<Result<void>>
  ptyKill?(sessionId: string): Promise<Result<void>>
  ptyList?(): Promise<Result<TerminalSessionInfo[]>>
  ptyKillAll?(): Promise<Result<void>>

  // Checkpoint operations
  checkpointCreate?(workspacePath: string, message: string, filePaths: string[], type: 'auto' | 'explicit', preimages?: any): Promise<Result<CheckpointResult>>

  // Stream operations (API calls)
  sendMessage(url: string, headers: Record<string, string>, body: string, options?: RequestOptions): Promise<Result<string>>
  streamMessage(url: string, headers: Record<string, string>, body: string, onLine: (line: string) => void, options?: RequestOptions): Promise<Result<string>>
  streamAbort?(streamId: number): Promise<void>
}
