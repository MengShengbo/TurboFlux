import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'fs'
import { join, dirname, relative, resolve as resolveNativePath, isAbsolute } from 'path'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { homedir } from 'os'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
import type { ToolExecutor, Result, SearchContentHit, CommandOutput, CheckpointResult, WebSearchResult } from '../../tools/executor'
import type { TreeNode } from '../../shared/types'
import type { CodeMapNode, CodeSearchHit } from '../../shared/codeIndexTypes'
import type { MemoryKind, MemoryScope } from '../../shared/memoryTypes'
import type { SandboxPolicy } from '../../shared/agentTypes'
import type { TerminalOutputChunk, TerminalSessionInfo } from '../../shared/terminalTypes'
import { MemoryService } from '../../tools/memory/service'
import { LocalHistoryService } from '../../tools/localHistory/service'

const RETRYABLE_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const STREAM_RETRY_DELAYS_MS = [300, 900, 1800]

export interface NodeToolExecutorOptions {
  sandboxPolicy?: SandboxPolicy
}

interface BackgroundTerminalSession {
  info: TerminalSessionInfo
  proc: ChildProcessWithoutNullStreams
  chunks: TerminalOutputChunk[]
  nextSeq: number
}

const MAX_TERMINAL_CHUNKS = 500
const TERMINAL_KILL_TIMEOUT_MS = 5000
const WEB_SEARCH_TIMEOUT_MS = 8000
const WEB_SEARCH_USER_AGENT = 'TurboFlux/0.1 (+https://github.com/MengShengbo/TurboFluxCli)'
const DEFAULT_TERMINAL_SHELL = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'
const DEFAULT_TERMINAL_SHELL_ARGS = process.platform === 'win32'
  ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass']
  : []
const DEFAULT_TERMINAL_SHELL_ID = process.platform === 'win32' ? 'powershell' : 'bash'
const DEFAULT_TERMINAL_SHELL_LABEL = process.platform === 'win32' ? 'PowerShell' : 'Bash'

export class NodeToolExecutor implements ToolExecutor {
  private memoryService: MemoryService
  private localHistoryService: LocalHistoryService
  private workspaceRoot: string
  private sandboxPolicy: SandboxPolicy
  private backgroundTerminals: Map<string, BackgroundTerminalSession> = new Map()

  constructor(private workspacePath: string, options: NodeToolExecutorOptions = {}) {
    this.memoryService = new MemoryService()
    this.localHistoryService = new LocalHistoryService(join(homedir(), '.turboflux', 'checkpoints'))
    this.workspaceRoot = resolveNativePath(workspacePath)
    this.sandboxPolicy = options.sandboxPolicy || 'workspace'
  }

  async readFile(path: string): Promise<Result<string>> {
    try {
      const safePath = this.ensureAllowedPath(path)
      if (!existsSync(safePath)) return { success: false, error: 'File not found' }
      const content = readFileSync(safePath, 'utf-8')
      return { success: true, data: content }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async writeFile(path: string, content: string, _metadata?: Record<string, unknown>): Promise<Result<void>> {
    try {
      this.ensureWritable()
      const safePath = this.ensureAllowedPath(path)
      const dir = dirname(safePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(safePath, content, 'utf-8')
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async deleteFile(path: string, options?: { recursive?: boolean }): Promise<Result<void>> {
    try {
      this.ensureWritable()
      const safePath = this.ensureAllowedPath(path)
      if (!existsSync(safePath)) return { success: false, error: 'File not found' }
      rmSync(safePath, { recursive: options?.recursive, force: true })
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async listTree(path: string): Promise<Result<TreeNode>> {
    try {
      const root = this.buildTree(this.ensureAllowedPath(path), 3)
      return { success: true, data: root }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async searchFiles(pattern: string, basePath: string): Promise<Result<{ matches: string[]; truncated?: boolean }>> {
    try {
      const matches = this.globSync(pattern, this.ensureAllowedPath(basePath))
      return { success: true, data: { matches: matches.slice(0, 100), truncated: matches.length > 100 } }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async searchContent(pattern: string, basePath: string, filePattern?: string, caseInsensitive?: boolean): Promise<Result<SearchContentHit[]>> {
    let safeBasePath: string
    try {
      safeBasePath = this.ensureAllowedPath(basePath)
    } catch (e) {
      return { success: false, error: String(e) }
    }

    try {
      const args = caseInsensitive ? ['-rni', '--no-heading', '--max-count=50'] : ['-rn', '--no-heading', '--max-count=50']
      if (filePattern) {
        args.push(`--include=${filePattern}`)
      }
      args.push(pattern, safeBasePath)
      const { stdout } = await execFileAsync('rg', args, { timeout: 10000, maxBuffer: 1024 * 1024 })
      const output = stdout.trim()
      if (!output) return { success: true, data: [] }
      const results: SearchContentHit[] = output.split('\n').slice(0, 50).map(line => {
        const match = line.match(/^(.+?):(\d+):(.*)$/)
        if (!match) return { file: '', line: 0, text: line }
        return { file: match[1], line: parseInt(match[2]), text: match[3] }
      }).filter(r => r.file)
      return { success: true, data: results }
    } catch (e: any) {
      if (e.code === 'ENOENT' || e.exitCode === 1) return { success: true, data: [] }
      // Fallback to findstr on Windows if rg not available
      try {
        const args = ['/s', '/n']
        if (caseInsensitive) args.push('/i')
        args.push(pattern, join(safeBasePath, filePattern || '*'))
        const { stdout } = await execFileAsync('findstr', args, { timeout: 10000, maxBuffer: 1024 * 1024 })
        const output = stdout.trim()
        if (!output) return { success: true, data: [] }
        const results: SearchContentHit[] = output.split('\n').slice(0, 50).map(line => {
          const match = line.match(/^(.+?):(\d+):(.*)$/)
          if (!match) return { file: '', line: 0, text: line }
          return { file: match[1], line: parseInt(match[2]), text: match[3] }
        }).filter(r => r.file)
        return { success: true, data: results }
      } catch {
        return { success: true, data: [] }
      }
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

  async searchCodeSymbols(query: { query: string; workspacePath: string; kind?: string; limit?: number }): Promise<Result<CodeSearchHit[]>> {
    try {
      const safeWorkspacePath = this.ensureAllowedPath(query.workspacePath)
      const patterns = [
        `(export\\s+)?(function|const|let|var|class|interface|type|enum)\\s+\\w*${this.escapeRegex(query.query)}\\w*`,
        `(export\\s+default\\s+)?(function|class)\\s+\\w*${this.escapeRegex(query.query)}\\w*`,
      ]
      const results: CodeSearchHit[] = []
      for (const pattern of patterns) {
        const args = ['-rn', '--no-heading', '--max-count=20', pattern, safeWorkspacePath, '--glob=*.{ts,tsx,js,jsx,py,rs,go,java}', '--glob=!node_modules', '--glob=!dist', '--glob=!.git']
        try {
          const { stdout } = await execFileAsync('rg', args, { timeout: 8000, maxBuffer: 512 * 1024 })
          const output = stdout.trim()
          if (!output) continue
          for (const line of output.split('\n').slice(0, query.limit || 10)) {
            const match = line.match(/^(.+?):(\d+):(.*)$/)
            if (!match) continue
            const filePath = match[1]
            const lineNum = parseInt(match[2])
            const text = match[3].trim()
            const symbolMatch = text.match(/(?:export\s+)?(?:default\s+)?(?:function|const|let|var|class|interface|type|enum)\s+(\w+)/)
            results.push({
              id: `sym_${lineNum}_${filePath.slice(-20)}`,
              path: relative(safeWorkspacePath, filePath).replace(/\\/g, '/'),
              title: symbolMatch?.[1] || text.slice(0, 60),
              subtitle: text.slice(0, 120),
              line: lineNum,
              startLine: lineNum,
              endLine: lineNum + 5,
              score: 1.0,
              source: 'symbol',
              symbolKind: this.inferSymbolKind(text) as CodeSearchHit['symbolKind'],
              preview: text,
            })
          }
        } catch (e: any) {
          if (e.exitCode === 1) continue
        }
        if (results.length >= (query.limit || 10)) break
      }
      return { success: true, data: results.slice(0, query.limit || 10) }
    } catch (e) {
      return { success: true, data: [] }
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

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  async getCodeMap(query: { workspacePath: string; targetPaths?: string[]; path?: string; query?: string; depth?: number; maxPaths?: number; maxChildrenPerPath?: number }): Promise<Result<{ map: CodeMapNode[]; relatedPaths?: string[] }>> {
    try {
      const basePath = this.ensureAllowedPath(query.workspacePath)
      const targetPaths = this.resolveCodeMapTargets(basePath, query)
      const map: CodeMapNode[] = []

      for (const target of targetPaths) {
        const fullPath = this.ensureAllowedPath(isAbsolute(target) ? target : join(basePath, target))
        if (!existsSync(fullPath)) continue
        const node = this.buildCodeMapNode(fullPath, basePath, query.depth || 2, 0, query.maxChildrenPerPath || 24)
        if (node) map.push(node)
      }

      return { success: true, data: { map } }
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
        .filter(e => !e.name.startsWith('.'))
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

  async memoryQuery(query: { query: string; workspacePath: string; kind?: MemoryKind; scope?: MemoryScope; limit?: number }): Promise<Result<{ items: Array<{ id: string; content: string; kind: string; score: number }> }>> {
    try {
      const safeWorkspacePath = this.ensureAllowedPath(query.workspacePath)
      const memories = await this.memoryService.query({
        workspacePath: safeWorkspacePath,
        query: query.query,
        kind: query.kind,
        scope: query.scope,
        limit: query.limit,
      })
      const items = memories.map(m => ({
        id: m.id,
        content: m.text,
        kind: m.kind,
        score: 1,
      }))
      return { success: true, data: { items } }
    } catch (e) {
      return { success: true, data: { items: [] } }
    }
  }

  async memoryRemember(data: { content?: string; text?: string; kind: MemoryKind; scope: MemoryScope; workspacePath: string; conversationId?: string }): Promise<Result<{ id: string; deduplicated?: boolean }>> {
    try {
      this.ensureWritable()
      const safeWorkspacePath = this.ensureAllowedPath(data.workspacePath)
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
      this.ensureWritable()
      const safeWorkspacePath = this.ensureAllowedPath(data.workspacePath)
      const result = await this.memoryService.forget({ workspacePath: safeWorkspacePath, id: data.id })
      if (!result.success) return { success: false, error: result.error }
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async memoryList(workspacePath: string): Promise<Result<{ items: Array<{ id: string; content: string; kind: string }> }>> {
    try {
      const safeWorkspacePath = this.ensureAllowedPath(workspacePath)
      const memories = await this.memoryService.query({ workspacePath: safeWorkspacePath, limit: 100 })
      const items = memories.map(m => ({ id: m.id, content: m.text, kind: m.kind }))
      return { success: true, data: { items } }
    } catch (e) {
      return { success: true, data: { items: [] } }
    }
  }

  async memoryGetRelevantInjection(params: { workspacePath: string; query: string }): Promise<Result<{ text: string; tokens: number }>> {
    try {
      const safeWorkspacePath = this.ensureAllowedPath(params.workspacePath)
      const result = await this.memoryService.getRelevantInjection(safeWorkspacePath, params.query)
      return { success: true, data: { text: result.text, tokens: result.tokens } }
    } catch {
      return { success: true, data: { text: '', tokens: 0 } }
    }
  }

  async runCommand(command: string, cwd: string, env?: Record<string, string>, timeout?: number, _approved?: boolean): Promise<Result<CommandOutput>> {
    return new Promise((resolve) => {
      let safeCwd: string
      try {
        const validation = this.validateCommandSync(command, cwd)
        if (!validation.success) {
          resolve({ success: false, error: validation.error, data: { stdout: '', stderr: validation.error || '', exitCode: 1 } })
          return
        }
        safeCwd = validation.cwd
      } catch (error) {
        resolve({ success: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
      const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'
      const shellArgs = process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-c', command]
      const proc = spawn(shell, shellArgs, {
        cwd: safeCwd,
        env: { ...process.env, ...env },
        timeout: timeout || 30000,
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data) => { stdout += data.toString() })
      proc.stderr.on('data', (data) => { stderr += data.toString() })

      proc.on('close', (code) => {
        resolve({
          success: true,
          data: { stdout, stderr, exitCode: code ?? 1 },
        })
      })

      proc.on('error', (err) => {
        resolve({ success: false, error: err.message })
      })
    })
  }

  async validateCommand(command: string, cwd: string): Promise<Result<void>> {
    const validation = this.validateCommandSync(command, cwd)
    if (!validation.success) return { success: false, error: validation.error }
    return { success: true }
  }

  private validateCommandSync(command: string, cwd: string): { success: true; cwd: string } | { success: false; error: string } {
    try {
      const safeCwd = this.ensureAllowedPath(cwd)
      const sandboxError = this.checkCommandSandbox(command, safeCwd)
      if (sandboxError) return { success: false, error: sandboxError }
      return { success: true, cwd: safeCwd }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async ptyCreate(options?: { shell?: string; cwd?: string; env?: Record<string, string> }): Promise<Result<{ sessionId: string; session: TerminalSessionInfo }>> {
    try {
      const safeCwd = this.ensureAllowedPath(options?.cwd || this.workspaceRoot)
      const shell = options?.shell || DEFAULT_TERMINAL_SHELL
      const shellArgs = options?.shell ? [] : DEFAULT_TERMINAL_SHELL_ARGS
      const shellId = options?.shell ? 'custom' : DEFAULT_TERMINAL_SHELL_ID
      const shellLabel = options?.shell ? shell : DEFAULT_TERMINAL_SHELL_LABEL
      const now = Date.now()
      const sessionId = `term_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      const proc = spawn(shell, shellArgs, {
        cwd: safeCwd,
        env: { ...process.env, ...options?.env },
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
      const info: TerminalSessionInfo = {
        id: sessionId,
        pid: proc.pid ?? 0,
        shell,
        shellId,
        shellLabel,
        cwd: safeCwd,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        isAgentSession: true,
        title: shell,
      }
      const session: BackgroundTerminalSession = {
        info,
        proc,
        chunks: [],
        nextSeq: 1,
      }
      this.backgroundTerminals.set(sessionId, session)

      const append = (data: Buffer | string) => {
        const text = data.toString()
        if (!text) return
        session.chunks.push({
          seq: session.nextSeq++,
          data: text,
          timestamp: Date.now(),
        })
        if (session.chunks.length > MAX_TERMINAL_CHUNKS) {
          session.chunks.splice(0, session.chunks.length - MAX_TERMINAL_CHUNKS)
        }
        session.info.updatedAt = Date.now()
      }

      proc.stdout.on('data', append)
      proc.stderr.on('data', append)
      proc.on('error', (err) => {
        session.info.status = 'error'
        session.info.error = err.message
        session.info.updatedAt = Date.now()
        append(`\n[terminal error] ${err.message}\n`)
      })
      proc.on('close', (code, signal) => {
        session.info.status = 'exited'
        session.info.exitCode = code
        session.info.exitSignal = signal ?? null
        session.info.updatedAt = Date.now()
      })

      return { success: true, data: { sessionId, session: info }, session, sessionId }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
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
      if (firstLine) session.info.title = firstLine.trim()
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async ptyGetBuffer(sessionId: string): Promise<Result<string>> {
    const session = this.backgroundTerminals.get(sessionId)
    if (!session) return { success: false, error: `Terminal not found: ${sessionId}` }
    return {
      success: true,
      data: session.chunks.map(chunk => chunk.data).join(''),
      chunks: [...session.chunks],
      session: { ...session.info },
    }
  }

  async ptyInterruptCommand(sessionId: string): Promise<Result<void>> {
    const session = this.backgroundTerminals.get(sessionId)
    if (!session) return { success: false, error: `Terminal not found: ${sessionId}` }
    if (session.info.status !== 'running') return { success: false, error: `Terminal ${sessionId} is ${session.info.status}` }

    try {
      if (process.platform === 'win32') {
        session.proc.kill('SIGINT')
      } else {
        session.proc.stdin.write('\x03')
      }
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
          return { success: false, error: `Terminal ${sessionId} did not exit within ${TERMINAL_KILL_TIMEOUT_MS}ms` }
        }
      }
      session.info.status = 'exited'
      session.info.updatedAt = Date.now()
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async ptyList(): Promise<Result<TerminalSessionInfo[]>> {
    const sessions = Array.from(this.backgroundTerminals.values())
      .map(session => ({ ...session.info }))
      .sort((a, b) => a.createdAt - b.createdAt)
    return { success: true, data: sessions, sessions }
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
      process.kill(-pid, 'SIGTERM')
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

  async checkpointCreate(
    workspacePath: string,
    message: string,
    filePaths: string[],
    type: 'auto' | 'explicit',
    preimages?: Record<string, string | null>,
  ): Promise<Result<CheckpointResult>> {
    try {
      this.ensureWritable()
      const safeWorkspacePath = this.ensureAllowedPath(workspacePath)
      const safeFilePaths = filePaths.map(filePath => this.ensureAllowedPath(filePath))
      const result = await this.localHistoryService.createCheckpoint(
        safeWorkspacePath,
        message,
        safeFilePaths,
        type,
        preimages,
      )
      if (!result.success || !result.checkpointId) {
        return { success: false, error: result.error || 'Checkpoint was not created' }
      }
      return {
        success: true,
        data: {
          id: result.checkpointId,
          label: result.label || message,
          timestamp: Date.now(),
        },
        checkpointId: result.checkpointId,
        shortId: result.shortId,
        label: result.label || message,
        fileCount: result.fileCount,
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async sendMessage(url: string, headers: Record<string, string>, body: string): Promise<Result<string>> {
    for (let attempt = 0; attempt <= STREAM_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body })
        const text = await response.text()
        if (!response.ok) {
          const error = this.formatHttpError(url, response.status, text)
          if (attempt < STREAM_RETRY_DELAYS_MS.length && RETRYABLE_HTTP_STATUS.has(response.status)) {
            await this.delay(STREAM_RETRY_DELAYS_MS[attempt])
            continue
          }
          return { success: false, error }
        }
        return { success: true, data: text }
      } catch (e) {
        if (attempt < STREAM_RETRY_DELAYS_MS.length) {
          await this.delay(STREAM_RETRY_DELAYS_MS[attempt])
          continue
        }
        return { success: false, error: this.formatNetworkError(url, e) }
      }
    }
    return { success: false, error: 'Request failed' }
  }

  async streamMessage(url: string, headers: Record<string, string>, body: string, onLine: (line: string) => void): Promise<Result<string>> {
    for (let attempt = 0; attempt <= STREAM_RETRY_DELAYS_MS.length; attempt += 1) {
      let emittedAnyLine = false
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body,
        })
        if (!response.ok) {
          const text = await response.text()
          const error = this.formatHttpError(url, response.status, text)
          if (attempt < STREAM_RETRY_DELAYS_MS.length && RETRYABLE_HTTP_STATUS.has(response.status)) {
            await this.delay(STREAM_RETRY_DELAYS_MS[attempt])
            continue
          }
          return { success: false, error, status: response.status }
        }
        const reader = response.body?.getReader()
        if (!reader) return { success: false, error: 'No response body' }

        const decoder = new TextDecoder()
        let buffer = ''
        let fullResponse = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
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
      } catch (e) {
        if (!emittedAnyLine && attempt < STREAM_RETRY_DELAYS_MS.length) {
          await this.delay(STREAM_RETRY_DELAYS_MS[attempt])
          continue
        }
        return { success: false, error: this.formatNetworkError(url, e) }
      }
    }
    return { success: false, error: 'Stream request failed' }
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
  private ensureWritable(): void {
    if (this.sandboxPolicy === 'readonly') {
      throw new Error('Sandbox is read-only: write and execution tools are disabled')
    }
  }

  private ensureAllowedPath(path: string): string {
    const resolvedPath = this.resolveAgainstWorkspace(path)
    if (this.sandboxPolicy === 'full') return resolvedPath
    return this.ensureWithinWorkspace(resolvedPath)
  }

  private ensureWithinWorkspace(path: string): string {
    const resolvedPath = this.resolveAgainstWorkspace(path)
    const relativePath = relative(this.workspaceRoot, resolvedPath)
    if (relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))) {
      return resolvedPath
    }
    throw new Error(`Path outside workspace: ${path}`)
  }

  private resolveAgainstWorkspace(path: string): string {
    return isAbsolute(path)
      ? resolveNativePath(path)
      : resolveNativePath(this.workspaceRoot, path || '.')
  }

  private checkCommandSandbox(command: string, cwd: string): string | null {
    if (this.sandboxPolicy === 'readonly') {
      return 'Sandbox is read-only: command execution is disabled'
    }
    if (this.sandboxPolicy === 'full') return null

    for (const candidate of this.extractAbsolutePathCandidates(command)) {
      try {
        this.ensureWithinWorkspace(candidate)
      } catch {
        return `Sandbox blocked command because it references a path outside the workspace: ${candidate}`
      }
    }

    for (const candidate of this.extractRelativeTraversalCandidates(command)) {
      const resolvedCandidate = resolveNativePath(cwd, candidate)
      try {
        this.ensureWithinWorkspace(resolvedCandidate)
      } catch {
        return `Sandbox blocked command because it references a relative path outside the workspace: ${candidate}`
      }
    }

    return null
  }

  private extractAbsolutePathCandidates(command: string): string[] {
    const candidates = new Set<string>()
    const windowsPath = /\b[A-Za-z]:[\\/][^\s"'`|;&<>)]*/g
    for (const match of command.matchAll(windowsPath)) {
      candidates.add(match[0])
    }

    if (process.platform === 'win32') return [...candidates]

    const posixPath = /(^|[\s"'`=])\/[^\s"'`|;&<>)]*/g
    for (const match of command.matchAll(posixPath)) {
      const value = match[0].trim().replace(/^["'`=]/, '')
      if (value.startsWith('//') || value.startsWith('/?')) continue
      candidates.add(value)
    }

    return [...candidates]
  }

  private extractRelativeTraversalCandidates(command: string): string[] {
    const candidates = new Set<string>()
    const tokenPattern = /[^\s"'`|;&<>]+/g

    for (const match of command.matchAll(tokenPattern)) {
      for (const rawPart of match[0].split('=')) {
        const value = rawPart.replace(/^[([{]+/, '').replace(/[)\]},]+$/, '')
        const normalized = value.replace(/\\/g, '/')
        if (
          normalized === '..'
          || normalized.startsWith('../')
          || normalized.includes('/../')
          || normalized.endsWith('/..')
        ) {
          candidates.add(value)
        }
      }
    }

    return [...candidates]
  }

  private buildTree(dirPath: string, maxDepth: number, depth = 0): TreeNode {
    const name = depth === 0 ? dirPath : dirPath.split(/[\\/]/).pop() || dirPath
    const node: TreeNode = { name, type: 'directory', children: [] }

    if (depth >= maxDepth) return node

    try {
      const entries = readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const fullPath = join(dirPath, entry.name)
        if (entry.isDirectory()) {
          node.children!.push(this.buildTree(fullPath, maxDepth, depth + 1))
        } else {
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

  private walkDir(dir: string, callback: (path: string) => void, depth = 0): void {
    if (depth > 10) return
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
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
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\{\{GLOBSTAR\}\}/g, '.*')
    return new RegExp(`^${escaped}$`, 'i')
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  private formatHttpError(url: string, status: number, text: string): string {
    const detail = text.trim() || 'empty response'
    return `HTTP ${status}: ${detail}`
  }

  private formatNetworkError(url: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    return message
  }
}
