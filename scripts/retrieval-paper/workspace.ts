import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

  async ensureMirror(repository: string): Promise<string> {
    const mirror = this.mirrorPath(repository)
    if (!existsSync(mirror)) {
      await run('git', ['clone', '--mirror', '--filter=blob:none', `https://github.com/${repository}.git`, mirror], { timeoutMs: 900_000 })
    }
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
    if (existsSync(snapshot) && !existsSync(readyMarker)) rmSync(snapshot, { recursive: true, force: true })
    if (!existsSync(snapshot)) {
      try {
        execFileSync('git', ['worktree', 'prune'], {
          cwd: mirror,
          timeout: 120_000,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        })
        execFileSync('git', ['worktree', 'add', '--detach', snapshot, item.baseCommit], {
          cwd: mirror,
          timeout: 900_000,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        })
      } catch (error) {
        if (existsSync(snapshot)) rmSync(snapshot, { recursive: true, force: true })
        throw new Error(`Failed to materialize ${item.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
      writeFileSync(readyMarker, `${item.repository}\n${item.baseCommit}\n`)
    }
    const listing = await run('git', ['ls-tree', '-r', '-l', item.baseCommit], { cwd: mirror, timeoutMs: 120_000 })
    let files = 0
    let bytes = 0
    for (const line of listing.split(/\r?\n/)) {
      const match = line.match(/^\d+\s+blob\s+[0-9a-f]+\s+(\d+)\t/)
      if (!match) continue
      files += 1
      bytes += Number(match[1]) || 0
    }
    return { path: snapshot, stats: { files, bytes } }
  }
}

export function defaultCacheRoot(): string {
  return join(process.env.LOCALAPPDATA || homedir(), 'TurboFlux', 'retrieval-benchmark-cache')
}
