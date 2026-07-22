import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { buildFastContextRetrievalPrimer } from '../src/core/fastContextRetrieval'
import { NodeToolExecutor } from '../src/core/runtime/nodeToolExecutor'
import { BenchmarkWorkspaceCache } from './retrieval-paper/workspace'

interface AuditCase {
  id: string
  repository: string
  baseCommit: string
  objective: string
  goldPaths: string[]
}

interface AuditManifest {
  cases: AuditCase[]
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

async function auditCase(item: AuditCase, cache: BenchmarkWorkspaceCache): Promise<void> {
  const workspacePath = (await cache.prepare(item)).path
  const startedAt = performance.now()
  const primer = await buildFastContextRetrievalPrimer({
    workspacePath,
    objective: item.objective,
    toolExecutor: new NodeToolExecutor(workspacePath, { sandboxPolicy: 'readonly' }),
  })
  const candidates = new Set(primer.candidatePaths.map(normalizePath))
  const seeds = new Set(primer.seedEvidence.map(item => normalizePath(item.path)))
  const gold = item.goldPaths.map(normalizePath)
  const candidateHits = gold.filter(path => candidates.has(path))
  const seedHits = gold.filter(path => seeds.has(path))
  const latencyMs = performance.now() - startedAt
  console.log(JSON.stringify({
    id: item.id,
    gold: gold.length,
    candidateHits: candidateHits.length,
    seedHits: seedHits.length,
    candidates: candidates.size,
    seeds: seeds.size,
    calls: primer.calls,
    latencyMs: Math.round(latencyMs),
    missed: gold.filter(path => !candidates.has(path)),
  }))
}

async function main(): Promise<void> {
  const manifestPath = process.argv[2] || 'benchmark-results/2026-07-23-fastcontext-quality-final-12/selected-manifest.json'
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as AuditManifest
  const offset = Math.max(0, Number(process.argv[4]) || 0)
  const count = Math.max(1, Number(process.argv[5]) || manifest.cases.length)
  const cases = manifest.cases.slice(offset, offset + count)
  const concurrency = Math.max(1, Math.min(Number(process.argv[3]) || 4, cases.length))
  const cache = new BenchmarkWorkspaceCache()
  let next = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < cases.length) {
      const index = next
      next += 1
      await auditCase(cases[index], cache)
    }
  }))
}

await main()
