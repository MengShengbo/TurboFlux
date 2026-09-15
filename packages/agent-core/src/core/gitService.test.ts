import { describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolExecutor } from '../tools/executor'
import {
  fetchGitSnapshot,
  fetchGitShow,
  gitCommitPaths,
  gitRestorePaths,
  gitUnstagePaths,
  gitRevertCommit,
  parseGitLog,
  parseGitStatusPorcelainV2,
} from './gitService'
import { NodeToolExecutor } from './runtime/nodeToolExecutor'

function executorWithProcessMock(handler?: (args: string[], env: Record<string, string>) => { success: boolean; stdout?: string; stderr?: string; exitCode?: number }) {
  const runProcess = vi.fn(async (_command: string, args: string[], _cwd: string, env: Record<string, string>) => {
    const result = handler?.(args, env) || { success: true, stdout: '', stderr: '', exitCode: 0 }
    return {
      success: result.success,
      error: result.success ? undefined : result.stderr,
      data: {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.exitCode ?? (result.success ? 0 : 1),
      },
    }
  })
  return { executor: { runProcess } as unknown as ToolExecutor, runProcess }
}

const execFileAsync = promisify(execFile)

function realGitExecutor(): ToolExecutor {
  return {
    runProcess: async (command, args, cwd, env, timeout) => {
      try {
        const result = await execFileAsync(command, args, {
          cwd,
          env: { ...process.env, ...env },
          timeout,
          maxBuffer: 1024 * 1024,
        })
        return { success: true, data: { stdout: result.stdout, stderr: result.stderr, exitCode: 0 } }
      } catch (error: any) {
        return {
          success: false,
          error: error.message,
          data: { stdout: error.stdout || '', stderr: error.stderr || '', exitCode: error.code || 1 },
        }
      }
    },
  } as ToolExecutor
}

describe('Git status parsing', () => {
  it('parses branch tracking, spaces, renames, untracked files, and conflicts', () => {
    const input = [
      '# branch.oid abcdef123456',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 a b src/staged file.ts',
      '1 .M N... 100644 100644 100644 a b src/working.ts',
      '2 R. N... 100644 100644 100644 a b R100 src/new name.ts',
      'src/old name.ts',
      '? src/new file.ts',
      'u UU N... 100644 100644 100644 100644 a b c src/conflict.ts',
      '',
    ].join('\0')

    const snapshot = parseGitStatusPorcelainV2(input)

    expect(snapshot).toMatchObject({
      branch: 'main',
      head: 'abcdef123456',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      clean: false,
      stagedCount: 3,
      unstagedCount: 2,
      untrackedCount: 1,
      conflictedCount: 1,
    })
    expect(snapshot.files[2]).toMatchObject({ path: 'src/new name.ts', originalPath: 'src/old name.ts' })
  })

  it('parses bounded structured log records', () => {
    const commits = parseGitLog('abc\x1fa1b2c3\x1fAda\x1f2026-07-27T10:00:00Z\x1ffeat: one\0def\x1fd4e5f6\x1fLin\x1f2026-07-26T10:00:00Z\x1ffix: two\0')
    expect(commits).toHaveLength(2)
    expect(commits[0]).toMatchObject({ hash: 'abc', shortHash: 'a1b2c3', subject: 'feat: one' })
  })
})

describe('Git runtime access', () => {
  it('reads repository state through a read-only capability profile', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'turboflux-git-readonly-'))
    try {
      await execFileAsync('git', ['init'], { cwd: workspace })
      const executor = new NodeToolExecutor(workspace, { capabilityProfile: 'read-only' })
      const snapshot = await fetchGitSnapshot(workspace, executor)

      expect(snapshot).toMatchObject({ clean: true, stagedCount: 0, unstagedCount: 0 })
      expect(snapshot?.branches).toEqual(expect.any(Array))
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }, 15_000)
})

describe('Git safety boundaries', () => {
  it('rejects option injection in revisions', async () => {
    const { executor, runProcess } = executorWithProcessMock()
    const result = await fetchGitShow(process.cwd(), executor, '--output=/tmp/leak')
    expect(result.ok).toBe(false)
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('unstages selected paths without changing their working tree content', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'turboflux-git-unstage-'))
    const executor = realGitExecutor()
    const git = async (...args: string[]) => execFileAsync('git', args, { cwd: workspace, env: process.env })
    try {
      await git('init')
      await git('config', 'user.name', 'TurboFlux Test')
      await git('config', 'user.email', 'test@turboflux.local')
      await writeFile(join(workspace, 'example.txt'), 'before\n')
      await git('add', '--', 'example.txt')
      await git('commit', '-m', 'initial')
      await writeFile(join(workspace, 'example.txt'), 'after\n')
      await git('add', '--', 'example.txt')

      const result = await gitUnstagePaths(workspace, ['example.txt'], executor)

      expect(result).toMatchObject({ ok: true })
      expect((await git('diff', '--cached', '--name-only')).stdout.trim()).toBe('')
      expect((await git('diff', '--name-only')).stdout.trim()).toBe('example.txt')
      expect(await readFile(join(workspace, 'example.txt'), 'utf8')).toBe('after\n')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('refuses an isolated commit when selected paths already have staged changes', async () => {
    const { executor, runProcess } = executorWithProcessMock(args => {
      if (args[0] === 'diff') return { success: false, exitCode: 1 }
      return { success: true }
    })
    const result = await gitCommitPaths(process.cwd(), 'test commit', ['src/core/gitService.ts'], executor)
    expect(result).toMatchObject({ ok: false })
    expect(result.error).toContain('user-staged')
    expect(runProcess).toHaveBeenCalledTimes(2)
    expect(runProcess.mock.calls.map(call => call[1][0])).toEqual(['rev-parse', 'diff'])
  })

  it('refuses to restore paths with staged changes', async () => {
    const { executor, runProcess } = executorWithProcessMock(args => {
      if (args[0] === 'diff') return { success: false, exitCode: 1 }
      return { success: true }
    })

    const result = await gitRestorePaths(process.cwd(), ['src/app.ts'], executor)

    expect(result).toMatchObject({ ok: false })
    expect(result.error).toContain('staged changes')
    expect(runProcess.mock.calls.map(call => call[1][0])).toEqual(['diff'])
  })

  it('restores validated paths from an explicit Git revision', async () => {
    const { executor, runProcess } = executorWithProcessMock()

    const result = await gitRestorePaths(process.cwd(), ['src/app.ts'], executor, 'HEAD~1')

    expect(result).toMatchObject({ ok: true })
    expect(runProcess.mock.calls[1][1]).toEqual(['restore', '--source=HEAD~1', '--worktree', '--', 'src/app.ts'])
  })

  it('requires a clean tracked tree before creating a revert commit', async () => {
    const { executor, runProcess } = executorWithProcessMock(args => {
      if (args[0] === 'diff' && !args.includes('--cached')) return { success: false, exitCode: 1 }
      return { success: true }
    })

    const result = await gitRevertCommit(process.cwd(), 'abc1234', executor)

    expect(result).toMatchObject({ ok: false })
    expect(result.error).toContain('working-tree or staged changes')
    expect(runProcess.mock.calls.some(call => call[1][0] === 'revert')).toBe(false)
  })

  it('creates an auditable revert commit with --no-edit', async () => {
    const { executor, runProcess } = executorWithProcessMock(args => {
      if (args[0] === 'rev-parse') return { success: true, stdout: 'def5678\n' }
      if (args[0] === 'revert') return { success: true, stdout: '[main def5678] Revert changes\n' }
      return { success: true }
    })

    const result = await gitRevertCommit(process.cwd(), 'abc1234', executor)

    expect(result).toMatchObject({ ok: true, hash: 'def5678' })
    expect(runProcess.mock.calls.some(call => call[1].join(' ') === 'revert --no-edit abc1234')).toBe(true)
  })

  it('uses an isolated index and refreshes only committed paths', async () => {
    const { executor, runProcess } = executorWithProcessMock((args, env) => {
      if (args[0] === 'rev-parse') return { success: true, stdout: args[1] === 'HEAD' ? 'abc1234\n' : 'parent\n' }
      if (args[0] === 'commit') {
        expect(env.GIT_INDEX_FILE).toContain('turboflux-git-index-')
        return { success: true, stdout: '[main abc1234] changes\n' }
      }
      return { success: true }
    })
    const workspace = process.cwd()
    const result = await gitCommitPaths(workspace, 'commit changes', [`${workspace}/src/core/gitService.ts`], executor)

    expect(result).toMatchObject({ ok: true, hash: 'abc1234' })
    expect(runProcess.mock.calls.some(call => call[1][0] === 'read-tree')).toBe(true)
    expect(runProcess.mock.calls.some(call => call[1][0] === 'add' && call[3].GIT_INDEX_FILE)).toBe(true)
    expect(runProcess.mock.calls.some(call => call[1].join(' ') === 'reset --mixed HEAD -- src/core/gitService.ts')).toBe(true)
  })

  it('preserves selected paths staged concurrently while the isolated commit runs', async () => {
    let indexReads = 0
    const { executor, runProcess } = executorWithProcessMock(args => {
      if (args[0] === 'ls-files') {
        indexReads += 1
        return { success: true, stdout: indexReads === 1 ? 'before-index\0' : 'user-staged-index\0' }
      }
      if (args[0] === 'rev-parse') return { success: true, stdout: args[1] === 'HEAD' ? 'abc1234\n' : 'parent\n' }
      if (args[0] === 'commit') return { success: true, stdout: '[main abc1234] changes\n' }
      return { success: true }
    })

    const result = await gitCommitPaths(process.cwd(), 'commit changes', ['src/core/gitService.ts'], executor)

    expect(result).toMatchObject({ ok: true, hash: 'abc1234' })
    expect(result.output).toContain('real index was left untouched')
    expect(result.output).toContain('staged concurrently')
    expect(runProcess.mock.calls.some(call => call[1][0] === 'reset')).toBe(false)
  })

  it('commits AI paths without consuming unrelated staged content in a real repository', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'turboflux-git-test-'))
    const executor = realGitExecutor()
    const git = async (...args: string[]) => execFileAsync('git', args, { cwd: workspace, env: process.env })
    try {
      await git('init')
      await git('config', 'user.name', 'TurboFlux Test')
      await git('config', 'user.email', 'test@turboflux.local')
      await writeFile(join(workspace, 'base.txt'), 'base\n')
      await writeFile(join(workspace, 'user.txt'), 'before\n')
      await git('add', '--', 'base.txt', 'user.txt')
      await git('commit', '-m', 'initial')

      await writeFile(join(workspace, 'user.txt'), 'user staged\n')
      await git('add', '--', 'user.txt')
      await writeFile(join(workspace, 'agent.txt'), 'agent change\n')

      const result = await gitCommitPaths(workspace, 'agent changes', ['agent.txt'], executor)

      expect(result.ok).toBe(true)
      expect((await git('show', '--pretty=', '--name-only', 'HEAD')).stdout.trim()).toBe('agent.txt')
      expect((await git('diff', '--cached', '--name-only')).stdout.trim()).toBe('user.txt')
      expect(await readFile(join(workspace, 'agent.txt'), 'utf8')).toBe('agent change\n')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }, 20_000)

  it('creates an isolated initial commit while preserving unrelated staged paths', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'turboflux-git-initial-test-'))
    const executor = realGitExecutor()
    const git = async (...args: string[]) => execFileAsync('git', args, { cwd: workspace, env: process.env })
    try {
      await git('init')
      await git('config', 'user.name', 'TurboFlux Test')
      await git('config', 'user.email', 'test@turboflux.local')
      await writeFile(join(workspace, 'agent.txt'), 'agent change\n')
      await writeFile(join(workspace, 'user.txt'), 'user staged\n')
      await git('add', '--', 'agent.txt', 'user.txt')

      const result = await gitCommitPaths(workspace, 'initial agent changes', ['agent.txt'], executor)

      expect(result.ok).toBe(true)
      expect((await git('show', '--pretty=', '--name-only', 'HEAD')).stdout.trim()).toBe('agent.txt')
      expect((await git('diff', '--cached', '--name-only')).stdout.trim()).toBe('user.txt')
      expect((await git('status', '--short')).stdout).toContain('A  user.txt')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

})
