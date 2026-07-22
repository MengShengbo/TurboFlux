import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { BenchmarkCase, BenchmarkManifest, DatasetId } from './types'

interface HuggingFaceRowsResponse {
  rows: Array<{ row: Record<string, unknown> }>
  num_rows_total: number
}

interface DatasetDefinition {
  id: DatasetId
  dataset: string
  url: string
  parse: (row: Record<string, unknown>) => BenchmarkCase | null
}

const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js', '.jsx',
  '.kt', '.kts', '.m', '.mm', '.php', '.py', '.rb', '.rs', '.scala', '.scss', '.swift',
  '.ts', '.tsx', '.vue', '.xml', '.yaml', '.yml', '.toml', '.json', '.gradle', '.sql',
])

const TEST_PATH = /(?:^|\/)(?:tests?|testing|__tests__|specs?|fixtures?|testdata)(?:\/|$)|(?:^|[._-])(?:test|spec)(?:[._-]|$)/i
const DOC_PATH = /(?:^|\/)(?:docs?|examples?|benchmarks?|changelog|news)(?:\/|$)|(?:readme|changelog|news)\b/i

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^a\//, '').trim()
}

function extension(path: string): string {
  const name = basename(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot) : ''
}

export function patchPaths(patch: string): string[] {
  const paths: string[] = []
  for (const match of patch.matchAll(/^diff --git a\/(.+?) b\/(.+?)$/gm)) {
    const path = normalizePath(match[2])
    if (path !== '/dev/null' && !paths.includes(path)) paths.push(path)
  }
  if (paths.length > 0) return paths
  for (const match of patch.matchAll(/^\+\+\+\s+(?:b\/)?(.+?)$/gm)) {
    const path = normalizePath(match[1])
    if (path !== '/dev/null' && !paths.includes(path)) paths.push(path)
  }
  return paths
}

function changedLines(patch: string): number {
  let count = 0
  for (const line of patch.split(/\r?\n/)) {
    if ((line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) count += 1
  }
  return count
}

function splitGold(paths: string[]): { source: string[]; tests: string[] } {
  const tests = paths.filter(path => TEST_PATH.test(path))
  const source = paths.filter(path => {
    if (tests.includes(path) || DOC_PATH.test(path)) return false
    return SOURCE_EXTENSIONS.has(extension(path)) || !extension(path)
  })
  return { source: source.length > 0 ? source : paths.filter(path => !tests.includes(path)), tests }
}

function hasPathLeakage(objective: string, paths: string[]): boolean {
  const lower = objective.toLowerCase()
  return paths.some(path => {
    const normalized = path.toLowerCase()
    const file = basename(normalized)
    return lower.includes(normalized) || (file.length >= 8 && lower.includes(file))
  })
}

function buildCase(
  dataset: DatasetId,
  row: Record<string, unknown>,
  options: { repository: string; id: string; language: string; category: string; patch: string },
): BenchmarkCase | null {
  const objective = stringValue(row.problem_statement).trim()
  const baseCommit = stringValue(row.base_commit).trim()
  const goldPaths = patchPaths(options.patch)
  if (!objective || !baseCommit || goldPaths.length === 0) return null
  const split = splitGold(goldPaths)
  if (split.source.length === 0) return null
  return {
    id: options.id,
    dataset,
    repository: options.repository,
    baseCommit,
    language: options.language || 'unknown',
    category: options.category || 'unknown',
    createdAt: stringValue(row.created_at) || undefined,
    objective,
    goldPaths,
    sourceGoldPaths: split.source,
    testGoldPaths: split.tests,
    changedLines: changedLines(options.patch),
    leakageRisk: hasPathLeakage(objective, split.source),
    metadata: {},
  }
}

const DATASETS: DatasetDefinition[] = [
  {
    id: 'swebench-verified',
    dataset: 'princeton-nlp/SWE-bench_Verified',
    url: 'https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified',
    parse: row => buildCase('swebench-verified', row, {
      repository: stringValue(row.repo),
      id: stringValue(row.instance_id),
      language: 'Python',
      category: 'issue-resolution',
      patch: stringValue(row.patch),
    }),
  },
  {
    id: 'swepolybench-verified',
    dataset: 'AmazonScience/SWE-PolyBench_Verified',
    url: 'https://huggingface.co/datasets/AmazonScience/SWE-PolyBench_Verified',
    parse: row => {
      const result = buildCase('swepolybench-verified', row, {
        repository: stringValue(row.repo),
        id: stringValue(row.instance_id),
        language: stringValue(row.language),
        category: stringValue(row.task_category),
        patch: stringValue(row.patch),
      })
      if (result) {
        result.metadata = {
          pullNumber: Number(row.pull_number) || 0,
          modifiedNodes: stringValue(row.modified_nodes),
          nodeCount: Number(row.num_nodes) || 0,
        }
      }
      return result
    },
  },
]

async function fetchDataset(definition: DatasetDefinition): Promise<BenchmarkCase[]> {
  const rows: Record<string, unknown>[] = []
  let offset = 0
  let total = Number.POSITIVE_INFINITY
  while (offset < total) {
    const endpoint = new URL('https://datasets-server.huggingface.co/rows')
    endpoint.searchParams.set('dataset', definition.dataset)
    endpoint.searchParams.set('config', 'default')
    endpoint.searchParams.set('split', 'test')
    endpoint.searchParams.set('offset', String(offset))
    endpoint.searchParams.set('length', '100')
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`${definition.id}: dataset server returned HTTP ${response.status}`)
    const payload = await response.json() as HuggingFaceRowsResponse
    total = payload.num_rows_total
    rows.push(...payload.rows.map(item => item.row))
    if (payload.rows.length === 0) break
    offset += payload.rows.length
  }
  return rows.map(definition.parse).filter((item): item is BenchmarkCase => Boolean(item))
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6D2B79F5
    let value = state
    value = Math.imul(value ^ value >>> 15, value | 1)
    value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

function shuffle<T>(items: T[], seed: number): T[] {
  const random = seededRandom(seed)
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1))
    ;[copy[index], copy[target]] = [copy[target], copy[index]]
  }
  return copy
}

function stratifiedSample(cases: BenchmarkCase[], limit: number, seed: number): BenchmarkCase[] {
  if (limit >= cases.length) return shuffle(cases, seed)
  const languageGroups = new Map<string, BenchmarkCase[]>()
  for (const item of cases) {
    const key = item.language.toLowerCase()
    const group = languageGroups.get(key) || []
    group.push(item)
    languageGroups.set(key, group)
  }
  const languageQueues = shuffle([...languageGroups.entries()], seed).map(([language, languageCases], languageIndex) => {
    const strata = new Map<string, BenchmarkCase[]>()
    for (const item of shuffle(languageCases, seed + languageIndex * 3571)) {
      const key = `${item.repository.toLowerCase()}::${item.category.toLowerCase()}`
      const stratum = strata.get(key) || []
      stratum.push(item)
      strata.set(key, stratum)
    }
    const queues = shuffle([...strata.values()], seed ^ language.length ^ 0x9E3779B9)
    const ordered: BenchmarkCase[] = []
    while (queues.some(queue => queue.length > 0)) {
      for (const queue of queues) {
        const next = queue.shift()
        if (next) ordered.push(next)
      }
    }
    return ordered
  })
  const selected: BenchmarkCase[] = []
  while (selected.length < limit && languageQueues.some(queue => queue.length > 0)) {
    for (const queue of languageQueues) {
      const next = queue.shift()
      if (next) selected.push(next)
      if (selected.length >= limit) break
    }
  }
  return selected
}

export async function prepareManifest(options: { perDataset: number; seed: number }): Promise<BenchmarkManifest> {
  const sources: BenchmarkManifest['sources'] = []
  const selected: BenchmarkCase[] = []
  for (let index = 0; index < DATASETS.length; index += 1) {
    const definition = DATASETS[index]
    const all = await fetchDataset(definition)
    const sample = stratifiedSample(all, options.perDataset, options.seed + index * 10_007)
    selected.push(...sample)
    sources.push({ id: definition.id, url: definition.url, requested: options.perDataset, selected: sample.length })
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    seed: options.seed,
    sources,
    cases: shuffle(selected, options.seed ^ 0xA5A5A5A5),
  }
}

export function writeManifest(path: string, manifest: BenchmarkManifest): void {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

export function readManifest(path: string): BenchmarkManifest {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as BenchmarkManifest
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.cases)) throw new Error(`Unsupported manifest: ${path}`)
  return manifest
}

export function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
