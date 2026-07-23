import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

interface RetrievalCase {
  id: string
  objective: string
  sourceGoldPaths: string[]
  changedLines?: number
  leakageRisk?: boolean
  category?: string
  [key: string]: unknown
}

interface RetrievalManifest {
  schemaVersion: number
  generatedAt?: string
  seed?: number
  sources?: unknown[]
  cases: RetrievalCase[]
  [key: string]: unknown
}

function option(name: string): string | undefined {
  const inline = process.argv.find(argument => argument.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function hashSeed(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ value >>> 15, value | 1)
    value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

function shuffled<T>(values: T[], seed: number): T[] {
  const result = [...values]
  const random = hashSeed(seed)
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1))
    ;[result[index], result[target]] = [result[target], result[index]]
  }
  return result
}

function collectUsedCaseIds(root: string): Set<string> {
  const used = new Set<string>()
  if (!existsSync(root)) return used
  const visit = (path: string): void => {
    for (const name of readdirSync(path)) {
      const child = join(path, name)
      if (statSync(child).isDirectory()) visit(child)
      else if (name === 'metadata.json') {
        try {
          const metadata = JSON.parse(readFileSync(child, 'utf8')) as { caseIds?: string[] }
          metadata.caseIds?.forEach(id => used.add(id))
        } catch {}
      } else if (name === 'runs.jsonl') {
        for (const line of readFileSync(child, 'utf8').split(/\r?\n/).filter(Boolean)) {
          try {
            const run = JSON.parse(line) as { caseId?: string }
            if (run.caseId) used.add(run.caseId)
          } catch {}
        }
      }
    }
  }
  visit(root)
  return used
}

function difficulty(item: RetrievalCase): number {
  const goldCount = item.sourceGoldPaths?.length || 0
  const changedLines = Number(item.changedLines) || 0
  const objective = item.objective || ''
  const explicitPath = /(?:^|[\s`'"])(?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]+/i.test(objective)
  const exactLocationHint = /(?:bug is in|change .* file|line \d+|traceback.*\.(?:py|java|ts|js))/i.test(objective)
  const categoryBonus = /feature|refactor/i.test(item.category || '') ? 2 : 0
  return Math.min(8, goldCount) * 3
    + Math.min(8, Math.log2(changedLines + 1))
    + (explicitPath ? 0 : 4)
    + (exactLocationHint ? 0 : 3)
    + categoryBonus
}

const manifestPath = resolve(option('--manifest') || 'benchmark-data/retrieval-paper-v1/splits/reserve-manifest.json')
const outputPath = resolve(option('--output') || 'benchmark-results/selected-manifest.json')
const count = Math.max(1, Number(option('--count')) || 10)
const seed = Number(option('--seed')) || 20260723
const mode = option('--mode') === 'hard' ? 'hard' : 'random'
const includedIds = new Set((option('--include') || '').split(',').map(value => value.trim()).filter(Boolean))
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RetrievalManifest
const used = process.argv.includes('--exclude-results') ? collectUsedCaseIds(resolve('benchmark-results')) : new Set<string>()
const eligible = manifest.cases.filter(item => !item.leakageRisk && (!used.has(item.id) || includedIds.has(item.id)))
const selected = includedIds.size > 0
  ? [...includedIds].flatMap(id => eligible.find(item => item.id === id) || [])
  : mode === 'random'
    ? shuffled(eligible, seed).slice(0, count)
    : shuffled(eligible, seed)
      .sort((left, right) => difficulty(right) - difficulty(left))
      .slice(0, count)

if (selected.length < Math.min(count, includedIds.size || count)) {
  throw new Error(`Requested ${includedIds.size || count} cases but only selected ${selected.length}`)
}

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, JSON.stringify({
  ...manifest,
  generatedAt: new Date().toISOString(),
  seed,
  selection: {
    mode,
    sourceManifest: manifestPath,
    excludedHistoricalCases: used.size,
    leakageRiskExcluded: true,
  },
  cases: selected,
}, null, 2))

console.log(selected.map((item, index) => `${index + 1}\t${item.id}\tdifficulty=${difficulty(item).toFixed(2)}\tgold=${item.sourceGoldPaths.length}`).join('\n'))
