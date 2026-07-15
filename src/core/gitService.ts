import type { ToolExecutor } from '../tools/executor'
import { isAbsolute, relative } from 'node:path'

export interface GitInfo {
  branch: string
  statusLines: string
  recentLog: string
}

export async function detectGitRepo(workspacePath: string, executor: ToolExecutor): Promise<boolean> {
  try {
    const res = await executor.runCommand(
      'git rev-parse --is-inside-work-tree',
      workspacePath, {}, 3000, true,
    )
    return res.success && (res.data?.exitCode === 0 || res.data?.stdout?.trim() === 'true')
  } catch {
    return false
  }
}

export async function fetchGitInfo(workspacePath: string, executor: ToolExecutor): Promise<GitInfo | null> {
  try {
    const [statusRes, logRes] = await Promise.all([
      executor.runCommand('git status --short --branch', workspacePath, {}, 5000, true),
      executor.runCommand('git log --oneline -5', workspacePath, {}, 5000, true),
    ])
    if (!statusRes.success) return null

    const statusLines = (statusRes.data?.stdout || '').trim()
    const recentLog = (logRes.data?.stdout || '').trim()
    const branchLine = statusLines.split('\n')[0] || ''
    const branch = branchLine.startsWith('## ') ? branchLine.slice(3).split('...')[0].trim() : 'unknown'

    return { branch, statusLines, recentLog }
  } catch {
    return null
  }
}

export function formatGitStatusForPrompt(info: GitInfo): string {
  const lines: string[] = [`Branch: ${info.branch}`]
  const statusBody = info.statusLines.split('\n').slice(1).join('\n').trim()
  if (statusBody) {
    lines.push(`Working tree:\n${statusBody}`)
  } else {
    lines.push('Working tree: clean')
  }
  if (info.recentLog) {
    lines.push(`Recent commits:\n${info.recentLog}`)
  }
  return lines.join('\n')
}

export async function gitCommitCheckpoint(
  workspacePath: string,
  message: string,
  filePaths: string[],
  executor: ToolExecutor,
): Promise<{ ok: boolean; hash?: string; nothingToCommit?: boolean; error?: string }> {
  try {
    if (!executor.runProcess) return { ok: false, error: 'Safe process execution is unavailable' }
    const relativePaths = filePaths.map(filePath => {
      const path = isAbsolute(filePath) ? relative(workspacePath, filePath) : filePath
      if (!path || path === '..' || path.startsWith(`..\\`) || path.startsWith('../') || isAbsolute(path)) {
        throw new Error(`Checkpoint path is outside the workspace: ${filePath}`)
      }
      return path.replace(/\\/g, '/')
    })
    if (relativePaths.length === 0) return { ok: true, nothingToCommit: true }

    const addRes = await executor.runProcess('git', ['add', '--', ...relativePaths], workspacePath, {}, 10000)
    if (!addRes.success) return { ok: false, error: addRes.error || addRes.data?.stderr || 'git add failed' }
    const commitRes = await executor.runProcess('git', ['commit', '-m', message], workspacePath, {}, 15000)
    const out = (commitRes.data?.stdout || '') + (commitRes.data?.stderr || '')
    if (!commitRes.success || commitRes.data?.exitCode !== 0) {
      if (out.toLowerCase().includes('nothing to commit')) return { ok: true, nothingToCommit: true }
      return { ok: false, error: commitRes.error || commitRes.data?.stderr?.trim() || 'commit failed' }
    }
    const hashRes = await executor.runProcess('git', ['rev-parse', 'HEAD'], workspacePath, {}, 3000)
    return { ok: true, hash: hashRes.data?.stdout?.trim() }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

export async function gitResetToCommit(
  workspacePath: string,
  hash: string,
  executor: ToolExecutor,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!/^[0-9a-f]{7,64}$/i.test(hash)) return { ok: false, error: 'Invalid commit hash' }
    if (!executor.runProcess) return { ok: false, error: 'Safe process execution is unavailable' }
    const res = await executor.runProcess('git', ['reset', '--hard', hash], workspacePath, {}, 20000)
    if (!res.success || res.data?.exitCode !== 0) {
      return { ok: false, error: res.data?.stderr?.trim() || 'git reset failed' }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}
