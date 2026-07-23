import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { defaultCacheRoot } from './retrieval-paper/workspace'

interface ManifestCase {
  repository: string
  baseCommit: string
}

interface Manifest {
  cases: ManifestCase[]
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '__')
}

function assertInside(root: string, target: string): void {
  const path = relative(root, target)
  if (!path || path.startsWith('..') || isAbsolute(path)) {
    throw new Error(`Refusing cache cleanup outside ${root}: ${target}`)
  }
}

function main(): void {
  const dropAll = process.argv.includes('--drop-all')
  const dropMirrors = process.argv.includes('--drop-mirrors')
  const manifestPath = option('--keep-manifest')
  if (!manifestPath && !dropAll) throw new Error('Usage: cleanup-retrieval-cache --keep-manifest <manifest.json> [--drop-all]')
  const manifest = manifestPath
    ? JSON.parse(readFileSync(resolve(manifestPath), 'utf8')) as Manifest
    : { cases: [] }
  const snapshotsRoot = resolve(defaultCacheRoot(), 'snapshots')
  if (!existsSync(snapshotsRoot)) return
  const keep = new Set(dropAll ? [] : manifest.cases.map(item => `${safeName(item.repository)}__${item.baseCommit.slice(0, 12)}`))
  let removed = 0
  for (const entry of readdirSync(snapshotsRoot, { withFileTypes: true })) {
    const baseName = entry.name.replace(/\.ready$/, '')
    if (keep.has(baseName)) continue
    const target = resolve(join(snapshotsRoot, entry.name))
    assertInside(snapshotsRoot, target)
    rmSync(target, { recursive: entry.isDirectory(), force: true })
    removed += 1
  }
  console.log(`Removed ${removed} stale retrieval snapshot entries; kept ${keep.size}.`)
  if (dropMirrors) {
    const mirrorsRoot = resolve(defaultCacheRoot(), 'mirrors')
    let removedMirrors = 0
    if (existsSync(mirrorsRoot)) {
      for (const entry of readdirSync(mirrorsRoot, { withFileTypes: true })) {
        const target = resolve(join(mirrorsRoot, entry.name))
        assertInside(mirrorsRoot, target)
        rmSync(target, { recursive: entry.isDirectory(), force: true, maxRetries: 8, retryDelay: 250 })
        removedMirrors += 1
      }
    }
    console.log(`Removed ${removedMirrors} retrieval mirror entries.`)
  }
}

main()
