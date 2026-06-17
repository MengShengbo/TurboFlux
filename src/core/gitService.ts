import type { ToolExecutor } from '../tools/executor'

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
  executor: ToolExecutor,
): Promise<{ ok: boolean; hash?: string; nothingToCommit?: boolean; error?: string }> {
  try {
    await executor.runCommand('git add -A', workspacePath, {}, 10000, true)
    const commitRes = await executor.runCommand(
      `git commit -m ${JSON.stringify(message)}`,
      workspacePath, {}, 15000, true,
    )
    const out = (commitRes.data?.stdout || '') + (commitRes.data?.stderr || '')
    if (commitRes.data?.exitCode !== 0) {
      if (out.toLowerCase().includes('nothing to commit')) return { ok: true, nothingToCommit: true }
      return { ok: false, error: commitRes.data?.stderr?.trim() || 'commit failed' }
    }
    const hashRes = await executor.runCommand('git rev-parse HEAD', workspacePath, {}, 3000, true)
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
    const res = await executor.runCommand(`git reset --hard ${hash}`, workspacePath, {}, 20000, true)
    if (res.data?.exitCode !== 0) {
      return { ok: false, error: res.data?.stderr?.trim() || 'git reset failed' }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}
