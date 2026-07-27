import { mkdtemp, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolExecutor } from '../tools/executor'

const DEFAULT_OUTPUT_LIMIT = 60_000
const MAX_PATHS_PER_OPERATION = 200

export type GitDiffScope = 'working' | 'staged' | 'all'

export interface GitFileState {
  path: string
  originalPath?: string
  indexStatus: string
  worktreeStatus: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
}

export interface GitCommitSummary {
  hash: string
  shortHash: string
  author: string
  authoredAt: string
  subject: string
}

export interface GitSnapshot {
  branch: string
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  detached: boolean
  clean: boolean
  files: GitFileState[]
  stagedCount: number
  unstagedCount: number
  untrackedCount: number
  conflictedCount: number
  recentCommits: GitCommitSummary[]
}

export interface GitOperationResult {
  ok: boolean
  output?: string
  hash?: string
  nothingToCommit?: boolean
  error?: string
}

interface GitCommandResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number
  error?: string
}

function truncateOutput(value: string, limit = DEFAULT_OUTPUT_LIMIT): string {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n[git output truncated at ${limit} characters]`
}

function commandError(result: GitCommandResult, fallback: string): string {
  return truncateOutput(result.stderr.trim() || result.error || fallback, 4_000)
}

async function runGit(
  workspacePath: string,
  args: string[],
  executor: ToolExecutor,
  options: { timeout?: number; env?: Record<string, string> } = {},
): Promise<GitCommandResult> {
  if (!executor.runProcess) {
    return { ok: false, stdout: '', stderr: '', exitCode: 1, error: 'Safe process execution is unavailable' }
  }
  try {
    const result = await executor.runProcess('git', args, workspacePath, options.env || {}, options.timeout || 10_000)
    return {
      ok: result.success && result.data?.exitCode === 0,
      stdout: result.data?.stdout || '',
      stderr: result.data?.stderr || '',
      exitCode: result.data?.exitCode ?? (result.success ? 0 : 1),
      error: result.error,
    }
  } catch (error) {
    return { ok: false, stdout: '', stderr: '', exitCode: 1, error: error instanceof Error ? error.message : String(error) }
  }
}

function normalizeStatus(value: string | undefined): string {
  return value && value !== '.' ? value : ''
}

function isConflictStatus(indexStatus: string, worktreeStatus: string): boolean {
  return ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(`${indexStatus || '.'}${worktreeStatus || '.'}`)
}

export function parseGitStatusPorcelainV2(output: string): Omit<GitSnapshot, 'recentCommits'> {
  let branch = 'unknown'
  let head: string | null = null
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  let detached = false
  const files: GitFileState[] = []
  const records = output.split('\0')

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    if (record.startsWith('# branch.oid ')) {
      const oid = record.slice('# branch.oid '.length).trim()
      head = oid === '(initial)' ? null : oid
      continue
    }
    if (record.startsWith('# branch.head ')) {
      const name = record.slice('# branch.head '.length).trim()
      detached = name === '(detached)'
      branch = detached ? 'detached' : name
      continue
    }
    if (record.startsWith('# branch.upstream ')) {
      upstream = record.slice('# branch.upstream '.length).trim() || null
      continue
    }
    if (record.startsWith('# branch.ab ')) {
      const match = record.match(/\+(\d+)\s+-(\d+)/)
      if (match) {
        ahead = Number(match[1])
        behind = Number(match[2])
      }
      continue
    }

    const kind = record[0]
    let indexStatus = ''
    let worktreeStatus = ''
    let path = ''
    let originalPath: string | undefined
    let conflicted = false

    if (kind === '1') {
      const fields = record.split(' ')
      indexStatus = normalizeStatus(fields[1]?.[0])
      worktreeStatus = normalizeStatus(fields[1]?.[1])
      path = fields.slice(8).join(' ')
    } else if (kind === '2') {
      const fields = record.split(' ')
      indexStatus = normalizeStatus(fields[1]?.[0])
      worktreeStatus = normalizeStatus(fields[1]?.[1])
      path = fields.slice(9).join(' ')
      originalPath = records[index + 1] || undefined
      index += 1
    } else if (kind === 'u') {
      const fields = record.split(' ')
      indexStatus = normalizeStatus(fields[1]?.[0])
      worktreeStatus = normalizeStatus(fields[1]?.[1])
      path = fields.slice(10).join(' ')
      conflicted = true
    } else if (kind === '?') {
      path = record.slice(2)
      worktreeStatus = '?'
    } else {
      continue
    }

    if (!path) continue
    conflicted ||= isConflictStatus(indexStatus, worktreeStatus)
    files.push({
      path,
      originalPath,
      indexStatus,
      worktreeStatus,
      staged: Boolean(indexStatus),
      unstaged: Boolean(worktreeStatus && worktreeStatus !== '?'),
      untracked: worktreeStatus === '?',
      conflicted,
    })
  }

  return {
    branch,
    head,
    upstream,
    ahead,
    behind,
    detached,
    clean: files.length === 0,
    files,
    stagedCount: files.filter(file => file.staged).length,
    unstagedCount: files.filter(file => file.unstaged).length,
    untrackedCount: files.filter(file => file.untracked).length,
    conflictedCount: files.filter(file => file.conflicted).length,
  }
}

export function parseGitLog(output: string): GitCommitSummary[] {
  return output
    .split('\0')
    .map(record => record.trim())
    .filter(Boolean)
    .map(record => {
      const [hash = '', shortHash = '', author = '', authoredAt = '', ...subject] = record.split('\x1f')
      return { hash, shortHash, author, authoredAt, subject: subject.join('\x1f') }
    })
    .filter(commit => Boolean(commit.hash))
}

function normalizeWorkspacePaths(workspacePath: string, filePaths: string[]): string[] {
  if (!Array.isArray(filePaths) || filePaths.length === 0) throw new Error('At least one path is required')
  if (filePaths.length > MAX_PATHS_PER_OPERATION) throw new Error(`At most ${MAX_PATHS_PER_OPERATION} paths may be changed at once`)
  const workspaceRoot = resolve(workspacePath)
  return [...new Set(filePaths.map(filePath => {
    if (typeof filePath !== 'string' || !filePath.trim() || /[\0\r\n]/.test(filePath)) throw new Error('Invalid Git path')
    const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(workspaceRoot, filePath)
    const relativePath = relative(workspaceRoot, absolutePath)
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..\\`) || relativePath.startsWith('../') || isAbsolute(relativePath)) {
      throw new Error(`Git path is outside the workspace: ${filePath}`)
    }
    const normalized = relativePath.replace(/\\/g, '/')
    if (normalized.startsWith('-')) throw new Error(`Git path cannot start with '-': ${filePath}`)
    return normalized
  }))]
}

function normalizeOptionalPath(workspacePath: string, filePath?: string): string | undefined {
  if (!filePath) return undefined
  return normalizeWorkspacePaths(workspacePath, [filePath])[0]
}

function validateRevision(revision: string): string {
  const value = revision.trim()
  if (!value || value.length > 200 || value.startsWith('-') || !/^[A-Za-z0-9@][A-Za-z0-9._/@{}~^+\-]*$/.test(value)) {
    throw new Error(`Invalid Git revision: ${revision}`)
  }
  return value
}

function validateRemote(remote: string): string {
  const value = remote.trim()
  if (!value || value.length > 200 || value.startsWith('-') || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) {
    throw new Error(`Invalid Git remote: ${remote}`)
  }
  return value
}

function validateCommitMessage(message: string): string {
  const value = message.trim()
  if (!value || value.length > 4_000 || /\0/.test(value)) throw new Error('Commit message must contain 1-4000 characters')
  return value
}

export async function detectGitRepo(workspacePath: string, executor: ToolExecutor): Promise<boolean> {
  const result = await runGit(workspacePath, ['rev-parse', '--is-inside-work-tree'], executor, { timeout: 3_000 })
  return result.ok && result.stdout.trim() === 'true'
}

export async function fetchGitSnapshot(workspacePath: string, executor: ToolExecutor): Promise<GitSnapshot | null> {
  const [status, log] = await Promise.all([
    runGit(workspacePath, ['status', '--porcelain=v2', '--branch', '-z'], executor, { timeout: 5_000 }),
    runGit(workspacePath, ['log', '-z', '-5', '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s'], executor, { timeout: 5_000 }),
  ])
  if (!status.ok) return null
  return { ...parseGitStatusPorcelainV2(status.stdout), recentCommits: log.ok ? parseGitLog(log.stdout) : [] }
}

export function formatGitSnapshotForPrompt(snapshot: GitSnapshot): string {
  const tracking = snapshot.upstream
    ? `${snapshot.upstream} (+${snapshot.ahead}/-${snapshot.behind})`
    : 'none'
  const lines = [
    `Branch: ${snapshot.branch}${snapshot.detached && snapshot.head ? ` @ ${snapshot.head.slice(0, 12)}` : ''}`,
    `Upstream: ${tracking}`,
    snapshot.clean
      ? 'Working tree: clean'
      : `Working tree: ${snapshot.stagedCount} staged, ${snapshot.unstagedCount} unstaged, ${snapshot.untrackedCount} untracked, ${snapshot.conflictedCount} conflicted`,
  ]
  if (snapshot.files.length > 0) {
    const fileLines = snapshot.files.slice(0, 40).map(file => {
      const status = file.untracked ? '??' : `${file.indexStatus || '.'}${file.worktreeStatus || '.'}`
      return `${status} ${file.path}${file.originalPath ? ` <- ${file.originalPath}` : ''}`
    })
    lines.push(`Changes:\n${fileLines.join('\n')}${snapshot.files.length > 40 ? `\n... ${snapshot.files.length - 40} more` : ''}`)
  }
  if (snapshot.recentCommits.length > 0) {
    lines.push(`Recent commits:\n${snapshot.recentCommits.map(commit => `${commit.shortHash} ${commit.subject}`).join('\n')}`)
  }
  return lines.join('\n')
}

export function formatGitSnapshotForTool(snapshot: GitSnapshot): string {
  return truncateOutput(JSON.stringify(snapshot, null, 2))
}

export async function fetchGitDiff(
  workspacePath: string,
  executor: ToolExecutor,
  scope: GitDiffScope = 'working',
  filePath?: string,
  contextLines = 3,
): Promise<GitOperationResult> {
  try {
    const path = normalizeOptionalPath(workspacePath, filePath)
    const context = Math.max(0, Math.min(50, Math.floor(contextLines)))
    const makeArgs = (staged: boolean) => [
      'diff', '--no-ext-diff', '--no-color', `--unified=${context}`,
      ...(staged ? ['--cached'] : []),
      ...(path ? ['--', path] : []),
    ]
    if (scope === 'all') {
      const [staged, working] = await Promise.all([
        runGit(workspacePath, makeArgs(true), executor),
        runGit(workspacePath, makeArgs(false), executor),
      ])
      if (!staged.ok) return { ok: false, error: commandError(staged, 'Unable to read staged diff') }
      if (!working.ok) return { ok: false, error: commandError(working, 'Unable to read working diff') }
      const sections = [
        staged.stdout ? `## Staged\n${staged.stdout.trimEnd()}` : '',
        working.stdout ? `## Working tree\n${working.stdout.trimEnd()}` : '',
      ].filter(Boolean)
      return { ok: true, output: truncateOutput(sections.join('\n\n') || 'No tracked changes.') }
    }
    const result = await runGit(workspacePath, makeArgs(scope === 'staged'), executor)
    return result.ok
      ? { ok: true, output: truncateOutput(result.stdout.trimEnd() || 'No tracked changes.') }
      : { ok: false, error: commandError(result, 'Unable to read Git diff') }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function fetchGitLog(
  workspacePath: string,
  executor: ToolExecutor,
  limit = 10,
  filePath?: string,
): Promise<GitOperationResult> {
  try {
    const path = normalizeOptionalPath(workspacePath, filePath)
    const count = Math.max(1, Math.min(100, Math.floor(limit)))
    const result = await runGit(workspacePath, [
      'log', `-${count}`, '--date=iso-strict', '--format=%h%x09%aI%x09%an%x09%s',
      ...(path ? ['--', path] : []),
    ], executor)
    return result.ok
      ? { ok: true, output: truncateOutput(result.stdout.trimEnd() || 'No commits found.') }
      : { ok: false, error: commandError(result, 'Unable to read Git log') }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function fetchGitShow(
  workspacePath: string,
  executor: ToolExecutor,
  revision: string,
  filePath?: string,
): Promise<GitOperationResult> {
  try {
    const safeRevision = validateRevision(revision)
    const path = normalizeOptionalPath(workspacePath, filePath)
    const result = await runGit(workspacePath, [
      'show', '--no-ext-diff', '--no-color', '--format=fuller', safeRevision,
      ...(path ? ['--', path] : []),
    ], executor)
    return result.ok
      ? { ok: true, output: truncateOutput(result.stdout.trimEnd() || 'No output.') }
      : { ok: false, error: commandError(result, 'Unable to show Git revision') }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function gitStagePaths(
  workspacePath: string,
  filePaths: string[],
  executor: ToolExecutor,
): Promise<GitOperationResult> {
  try {
    const paths = normalizeWorkspacePaths(workspacePath, filePaths)
    const result = await runGit(workspacePath, ['add', '--', ...paths], executor)
    return result.ok
      ? { ok: true, output: `Staged ${paths.length} path(s):\n${paths.join('\n')}` }
      : { ok: false, error: commandError(result, 'Unable to stage paths') }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function commitCurrentIndex(
  workspacePath: string,
  message: string,
  executor: ToolExecutor,
): Promise<GitOperationResult> {
  const commit = await runGit(workspacePath, ['commit', '-m', message], executor, { timeout: 30_000 })
  const combined = `${commit.stdout}\n${commit.stderr}`
  if (!commit.ok) {
    if (/nothing to commit|no changes added to commit/i.test(combined)) return { ok: true, nothingToCommit: true, output: 'Nothing to commit.' }
    return { ok: false, error: commandError(commit, 'Git commit failed') }
  }
  const hash = await runGit(workspacePath, ['rev-parse', 'HEAD'], executor, { timeout: 3_000 })
  return { ok: true, hash: hash.ok ? hash.stdout.trim() : undefined, output: truncateOutput(commit.stdout.trimEnd()) }
}

export async function gitCommitPaths(
  workspacePath: string,
  message: string,
  filePaths: string[],
  executor: ToolExecutor,
): Promise<GitOperationResult> {
  let temporaryDirectory: string | null = null
  try {
    const paths = normalizeWorkspacePaths(workspacePath, filePaths)
    const safeMessage = validateCommitMessage(message)
    const stagedCheck = await runGit(workspacePath, ['diff', '--cached', '--quiet', '--', ...paths], executor)
    if (stagedCheck.exitCode === 1) {
      return { ok: false, error: 'Refusing to commit: one or more selected paths already contain user-staged changes.' }
    }
    if (!stagedCheck.ok) return { ok: false, error: commandError(stagedCheck, 'Unable to inspect staged paths') }
    const indexBefore = await runGit(workspacePath, ['ls-files', '-s', '-z', '--', ...paths], executor)
    if (!indexBefore.ok) return { ok: false, error: commandError(indexBefore, 'Unable to snapshot the real Git index') }

    temporaryDirectory = await mkdtemp(join(tmpdir(), 'turboflux-git-index-'))
    const indexPath = join(temporaryDirectory, 'index')
    const env = { GIT_INDEX_FILE: indexPath }
    const head = await runGit(workspacePath, ['rev-parse', '--verify', 'HEAD'], executor, { timeout: 3_000 })
    const readTree = await runGit(workspacePath, head.ok ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], executor, { env })
    if (!readTree.ok) return { ok: false, error: commandError(readTree, 'Unable to initialize isolated Git index') }
    const add = await runGit(workspacePath, ['add', '--', ...paths], executor, { env })
    if (!add.ok) return { ok: false, error: commandError(add, 'Unable to stage paths in isolated Git index') }
    const commit = await commitCurrentIndex(workspacePath, safeMessage, {
      ...executor,
      runProcess: (command, args, cwd, _ignoredEnv, timeout) => executor.runProcess!(command, args, cwd, env, timeout),
    })
    if (!commit.ok || commit.nothingToCommit) return commit

    const indexAfter = await runGit(workspacePath, ['ls-files', '-s', '-z', '--', ...paths], executor)
    if (!indexAfter.ok || indexAfter.stdout !== indexBefore.stdout) {
      const detail = !indexAfter.ok
        ? commandError(indexAfter, 'index snapshot failed')
        : 'selected paths were staged concurrently'
      return {
        ...commit,
        output: `${commit.output || 'Commit created.'}\nWarning: commit succeeded, but the real index was left untouched because ${detail}.`,
      }
    }

    const syncIndex = await runGit(workspacePath, ['reset', '--mixed', 'HEAD', '--', ...paths], executor)
    if (!syncIndex.ok) {
      return {
        ...commit,
        output: `${commit.output || 'Commit created.'}\nWarning: commit succeeded, but the real index could not be refreshed for committed paths: ${commandError(syncIndex, 'index refresh failed')}`,
      }
    }
    return commit
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {})
  }
}

export async function gitCommit(
  workspacePath: string,
  message: string,
  executor: ToolExecutor,
  filePaths?: string[],
): Promise<GitOperationResult> {
  try {
    const safeMessage = validateCommitMessage(message)
    return filePaths && filePaths.length > 0
      ? gitCommitPaths(workspacePath, safeMessage, filePaths, executor)
      : commitCurrentIndex(workspacePath, safeMessage, executor)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function validateBranchName(workspacePath: string, name: string, executor: ToolExecutor): Promise<GitOperationResult> {
  const value = name.trim()
  if (!value || value.startsWith('-') || /[\0\r\n]/.test(value)) return { ok: false, error: `Invalid Git branch: ${name}` }
  const result = await runGit(workspacePath, ['check-ref-format', '--branch', value], executor, { timeout: 3_000 })
  return result.ok ? { ok: true, output: value } : { ok: false, error: commandError(result, `Invalid Git branch: ${name}`) }
}

export async function gitCreateBranch(
  workspacePath: string,
  name: string,
  executor: ToolExecutor,
  startPoint?: string,
): Promise<GitOperationResult> {
  try {
    const branch = await validateBranchName(workspacePath, name, executor)
    if (!branch.ok) return branch
    const start = startPoint ? validateRevision(startPoint) : undefined
    const result = await runGit(workspacePath, ['switch', '-c', branch.output!, ...(start ? [start] : [])], executor)
    return result.ok
      ? { ok: true, output: result.stdout.trim() || `Created and switched to ${branch.output}.` }
      : { ok: false, error: commandError(result, 'Unable to create branch') }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function gitSwitchBranch(
  workspacePath: string,
  name: string,
  executor: ToolExecutor,
): Promise<GitOperationResult> {
  const branch = await validateBranchName(workspacePath, name, executor)
  if (!branch.ok) return branch
  const result = await runGit(workspacePath, ['switch', branch.output!], executor)
  return result.ok
    ? { ok: true, output: result.stdout.trim() || `Switched to ${branch.output}.` }
    : { ok: false, error: commandError(result, 'Unable to switch branch') }
}

export async function gitStash(
  workspacePath: string,
  action: 'list' | 'push' | 'apply' | 'pop',
  executor: ToolExecutor,
  options: { message?: string; includeUntracked?: boolean; stash?: string } = {},
): Promise<GitOperationResult> {
  try {
    let args: string[]
    if (action === 'list') {
      args = ['stash', 'list', '--format=%gd%x09%h%x09%cr%x09%s']
    } else if (action === 'push') {
      const message = options.message?.trim()
      if (message && (message.length > 1_000 || /\0/.test(message))) throw new Error('Stash message is invalid')
      args = ['stash', 'push', ...(options.includeUntracked ? ['--include-untracked'] : []), ...(message ? ['-m', message] : [])]
    } else {
      const stash = options.stash?.trim() || 'stash@{0}'
      if (!/^stash@\{\d+\}$/.test(stash)) throw new Error(`Invalid stash reference: ${stash}`)
      args = ['stash', action, stash]
    }
    const result = await runGit(workspacePath, args, executor, { timeout: 20_000 })
    return result.ok
      ? { ok: true, output: truncateOutput(result.stdout.trimEnd() || 'Git stash operation completed.') }
      : { ok: false, error: commandError(result, 'Git stash operation failed') }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function gitPush(
  workspacePath: string,
  executor: ToolExecutor,
  options: { remote?: string; branch?: string; setUpstream?: boolean } = {},
): Promise<GitOperationResult> {
  try {
    const remote = validateRemote(options.remote || 'origin')
    const args = ['push', ...(options.setUpstream ? ['--set-upstream'] : []), remote]
    if (options.branch) {
      const branch = await validateBranchName(workspacePath, options.branch, executor)
      if (!branch.ok) return branch
      args.push(branch.output!)
    }
    const result = await runGit(workspacePath, args, executor, { timeout: 60_000 })
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
    return result.ok
      ? { ok: true, output: truncateOutput(output || 'Push completed.') }
      : { ok: false, error: commandError(result, 'Git push failed') }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
