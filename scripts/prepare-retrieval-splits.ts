import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { BenchmarkCase, BenchmarkManifest } from './retrieval-paper/types'

const ROOT_MANIFEST = resolve('benchmark-data', 'retrieval-paper-v1', 'manifest.json')
const RESULTS_ROOT = resolve('benchmark-results')
const OUTPUT_ROOT = resolve('benchmark-data', 'retrieval-paper-v1', 'splits')
const SEED = 20260722

function collectRunJournals(path: string): string[] {
  if (!existsSync(path)) return []
  const files: string[] = []
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) files.push(...collectRunJournals(child))
    else if (entry.name === 'runs.jsonl') files.push(child)
  }
  return files
}

function exposedCaseIds(): Set<string> {
  const ids = new Set<string>()
  const priorMetadata = join(OUTPUT_ROOT, 'split-metadata.json')
  if (existsSync(priorMetadata)) {
    try {
      const prior = JSON.parse(readFileSync(priorMetadata, 'utf8')) as { contaminatedCaseIds?: string[] }
      for (const caseId of prior.contaminatedCaseIds || []) ids.add(caseId)
    } catch {}
  }
  for (const journal of collectRunJournals(RESULTS_ROOT)) {
    for (const line of readFileSync(journal, 'utf8').split(/\r?\n/).filter(Boolean)) {
      try {
        const caseId = String((JSON.parse(line) as { caseId?: string }).caseId || '')
        if (caseId) ids.add(caseId)
      } catch {}
    }
  }
  return ids
}

function stableOrder(cases: BenchmarkCase[]): BenchmarkCase[] {
  return [...cases].sort((left, right) => {
    const leftHash = createHash('sha256').update(`${SEED}:${left.id}`).digest('hex')
    const rightHash = createHash('sha256').update(`${SEED}:${right.id}`).digest('hex')
    return leftHash.localeCompare(rightHash)
  })
}

function takeGroup(pool: BenchmarkCase[], dataset: string, language: string, count: number): BenchmarkCase[] {
  return stableOrder(pool.filter(item => item.dataset === dataset && item.language === language)).slice(0, count)
}

function without(pool: BenchmarkCase[], selected: BenchmarkCase[]): BenchmarkCase[] {
  const ids = new Set(selected.map(item => item.id))
  return pool.filter(item => !ids.has(item.id))
}

function manifest(source: BenchmarkManifest, cases: BenchmarkCase[]): BenchmarkManifest {
  return {
    ...source,
    generatedAt: new Date().toISOString(),
    seed: SEED,
    sources: source.sources.map(item => ({
      ...item,
      selected: cases.filter(candidate => candidate.dataset === item.id).length,
    })),
    cases,
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

const source = JSON.parse(readFileSync(ROOT_MANIFEST, 'utf8')) as BenchmarkManifest
const exposedIds = exposedCaseIds()
const contaminated = stableOrder(source.cases.filter(item => exposedIds.has(item.id)))
let unseen = source.cases.filter(item => !exposedIds.has(item.id))

const development = [
  ...takeGroup(unseen, 'swebench-verified', 'Python', 12),
  ...takeGroup(unseen, 'swepolybench-verified', 'Java', 3),
  ...takeGroup(unseen, 'swepolybench-verified', 'JavaScript', 3),
  ...takeGroup(unseen, 'swepolybench-verified', 'TypeScript', 3),
  ...takeGroup(unseen, 'swepolybench-verified', 'Python', 3),
]
unseen = without(unseen, development)

const holdout = [
  ...takeGroup(unseen, 'swebench-verified', 'Python', 50),
  ...takeGroup(unseen, 'swepolybench-verified', 'Java', 13),
  ...takeGroup(unseen, 'swepolybench-verified', 'JavaScript', 13),
  ...takeGroup(unseen, 'swepolybench-verified', 'TypeScript', 12),
  ...takeGroup(unseen, 'swepolybench-verified', 'Python', 12),
]
const reserve = stableOrder(without(unseen, holdout))

mkdirSync(OUTPUT_ROOT, { recursive: true })
writeJson(join(OUTPUT_ROOT, 'contaminated-manifest.json'), manifest(source, contaminated))
writeJson(join(OUTPUT_ROOT, 'generalization-dev-manifest.json'), manifest(source, development))
writeJson(join(OUTPUT_ROOT, 'holdout-test-manifest.json'), manifest(source, holdout))
writeJson(join(OUTPUT_ROOT, 'reserve-manifest.json'), manifest(source, reserve))
writeJson(join(OUTPUT_ROOT, 'split-metadata.json'), {
  schemaVersion: 1,
  seed: SEED,
  sourceManifest: 'benchmark-data/retrieval-paper-v1/manifest.json',
  contaminatedCaseIds: contaminated.map(item => item.id),
  counts: {
    contaminated: contaminated.length,
    generalizationDevelopment: development.length,
    holdoutTest: holdout.length,
    reserve: reserve.length,
  },
  policy: {
    contaminated: 'Never use for comparative claims; retained only for regression debugging.',
    generalizationDevelopment: 'May guide architecture work; becomes contaminated after first result inspection.',
    holdoutTest: 'Run only after implementation freeze; never tune against individual outcomes.',
    reserve: 'Unused replacement pool for future preregistered studies.',
  },
})

console.log(`contaminated=${contaminated.length} development=${development.length} holdout=${holdout.length} reserve=${reserve.length}`)
