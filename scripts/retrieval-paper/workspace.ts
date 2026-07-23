import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { BenchmarkCase, RepositoryStats } from './types'

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '__')
}

function run(command: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  try {
    return Promise.resolve(execFileSync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 300_000,
      windowsHide: true,
      maxBuffer: 128 * 1024 * 1024,
    }))
  } catch (error) {
    const detail = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr || '') : ''
    return Promise.reject(new Error(`${command} ${args[0] || ''} failed: ${detail || (error instanceof Error ? error.message : String(error))}`))
  }
}

export class BenchmarkWorkspaceCache {
  readonly root: string
  readonly mirrorsRoot: string
  readonly snapshotsRoot: string

  constructor(root = join(process.env.LOCALAPPDATA || tmpdir(), 'TurboFlux', 'retrieval-benchmark-cache')) {
    this.root = resolve(root)
    this.mirrorsRoot = join(this.root, 'mirrors')
    this.snapshotsRoot = join(this.root, 'snapshots')
    mkdirSync(this.mirrorsRoot, { recursive: true })
    mkdirSync(this.snapshotsRoot, { recursive: true })
  }

  private assertInsideRoot(path: string): void {
    const resolved = resolve(path)
    if (resolved !== this.root && !resolved.startsWith(`${this.root}\\`) && !resolved.startsWith(`${this.root}/`)) {
      throw new Error(`Refusing benchmark cache operation outside ${this.root}: ${resolved}`)
    }
  }

  private mirrorPath(repository: string): string {
    return join(this.mirrorsRoot, `${safeName(repository)}.git`)
  }

  private snapshotPath(item: BenchmarkCase): string {
    return join(this.snapshotsRoot, `${safeName(item.repository)}__${item.baseCommit.slice(0, 12)}`)
  }

  private removeSnapshotPath(snapshot: string): boolean {
    this.assertInsideRoot(snapshot)
    if (!existsSync(snapshot)) return true
    try {
      rmSync(snapshot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
      return !existsSync(snapshot)
    } catch {
      return false
    }
  }

  async ensureMirror(repository: string): Promise<string> {
    const mirror = this.mirrorPath(repository)
    this.assertInsideRoot(mirror)
    if (existsSync(mirror)) {
      try {
        const bare = (await run('git', ['rev-parse', '--is-bare-repository'], { cwd: mirror, timeoutMs: 30_000 })).trim()
        if (bare !== 'true') throw new Error('not a bare repository')
      } catch {
        rmSync(mirror, { recursive: true, force: true })
      }
    }
    if (!existsSync(mirror)) {
      await run('git', ['clone', '--mirror', '--filter=blob:none', `https://github.com/${repository}.git`, mirror], { timeoutMs: 900_000 })
    }
    await run('git', ['config', 'core.longpaths', 'true'], { cwd: mirror, timeoutMs: 30_000 })
    return mirror
  }

  async prepare(item: BenchmarkCase): Promise<{ path: string; stats: RepositoryStats }> {
    const mirror = await this.ensureMirror(item.repository)
    try {
      await run('git', ['cat-file', '-e', `${item.baseCommit}^{commit}`], { cwd: mirror, timeoutMs: 30_000 })
    } catch {
      await run('git', ['fetch', '--depth', '1', 'origin', item.baseCommit], { cwd: mirror, timeoutMs: 900_000 })
    }
    const snapshot = this.snapshotPath(item)
    const readyMarker = `${snapshot}.ready`
    this.assertInsideRoot(snapshot)
    this.assertInsideRoot(readyMarker)
    if (existsSync(snapshot) && existsSync(readyMarker)) {
      try {
        const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: snapshot, timeoutMs: 30_000 })).trim()
        if (head !== item.baseCommit) throw new Error(`snapshot is at ${head}`)
      } catch {
        if (!this.removeSnapshotPath(snapshot)) throw new Error(`Snapshot is still locked: ${snapshot}`)
        rmSync(readyMarker, { force: true })
      }
    }
    if (existsSync(snapshot) && !existsSync(readyMarker) && !this.removeSnapshotPath(snapshot)) {
      throw new Error(`Snapshot is still locked: ${snapshot}`)
    }
    if (!existsSync(snapshot)) {
      try {
        try {
          execFileSync('git', ['worktree', 'prune'], {
            cwd: mirror,
            timeout: 120_000,
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe'],
          })
        } catch {}
        execFileSync('git', ['worktree', 'add', '--detach', snapshot, item.baseCommit], {
          cwd: mirror,
          timeout: 900_000,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        })
      } catch (error) {
        this.removeSnapshotPath(snapshot)
        throw new Error(`Failed to materialize ${item.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
      writeFileSync(readyMarker, `${item.repository}\n${item.baseCommit}\n`)
    }
    const listing = await run('git', ['ls-files', '-z'], { cwd: snapshot, timeoutMs: 120_000 })
    let files = 0
    let bytes = 0
    for (const path of listing.split('\0').filter(Boolean)) {
      try {
        const stats = statSync(join(snapshot, path))
        if (!stats.isFile()) continue
        files += 1
        bytes += stats.size
      } catch {}
    }
    return { path: snapshot, stats: { files, bytes } }
  }

  release(item: BenchmarkCase): void {
    const mirror = this.mirrorPath(item.repository)
    const snapshot = this.snapshotPath(item)
    const readyMarker = `${snapshot}.ready`
    this.assertInsideRoot(snapshot)
    this.assertInsideRoot(readyMarker)
    if (existsSync(mirror) && existsSync(snapshot)) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', snapshot], {
          cwd: mirror,
          timeout: 120_000,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        })
      } catch {}
    }
    this.removeSnapshotPath(snapshot)
    if (existsSync(readyMarker)) {
      try {
        rmSync(readyMarker, { force: true })
      } catch {}
    }
  }
}

export function defaultCacheRoot(): string {
  return join(process.env.LOCALAPPDATA || homedir(), 'TurboFlux', 'retrieval-benchmark-cache')
}
