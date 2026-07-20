import { performance } from 'perf_hooks'
import { resolve } from 'path'

interface BenchmarkCase {
  id: string
  objective: string
  relevantPaths: string[]
}

interface BenchmarkResult {
  id: string
  latencyMs: number
  recallAt5: number
  reciprocalRank: number
  empty: boolean
  readConfirmed: number
  topPaths: string[]
}

const ENCODED_CASES = 'W3siaWQiOiJjbGktZW50cnkiLCJvYmplY3RpdmUiOiJMb2NhdGUgdGhlIFR1cmJvRmx1eCBDTEkgc3RhcnR1cCBlbnRyeSwgY29tbWFuZCBwYXJzaW5nLCBhbmQgaGFuZG9mZiBpbnRvIHRoZSBpbnRlcmFjdGl2ZSBhcHAuIiwicmVsZXZhbnRQYXRocyI6WyJiaW4vdHVyYm9mbHV4Lm1qcyIsInNyYy9jbGkvaW5kZXgudHMiLCJzcmMvY2xpL3JlcGwudHMiXX0seyJpZCI6ImZhc3QtY29udGV4dC1zY2hlZHVsaW5nIiwib2JqZWN0aXZlIjoiTG9jYXRlIEZhc3RDb250ZXh0IGJhY2tncm91bmQgc2NoZWR1bGluZywgc3ViYWdlbnQgcmV0cmlldmFsLCBhbmQgZXZpZGVuY2UgaW5qZWN0aW9uIGludG8gdGhlIG1haW4gYWdlbnQuIiwicmVsZXZhbnRQYXRocyI6WyJzcmMvY29yZS9hZ2VudEVuZ2luZS50cyIsInNyYy9jb3JlL2Zhc3RDb250ZXh0U3ViYWdlbnQudHMiLCJzcmMvY29yZS9zdWJBZ2VudC50cyJdfSx7ImlkIjoidHJhbnNjcmlwdC1zY3JvbGwiLCJvYmplY3RpdmUiOiJMb2NhdGUgcm93LWxldmVsIHRyYW5zY3JpcHQgdmlld3BvcnQgc2Nyb2xsaW5nIGFuZCB0ZXJtaW5hbCBtb3VzZS13aGVlbCBoYW5kbGluZyBpbiB0aGUgQ0xJIFVJLiIsInJlbGV2YW50UGF0aHMiOlsic3JjL2NsaS9jb21wb25lbnRzL1RyYW5zY3JpcHRWaWV3cG9ydC50c3giLCJzcmMvY2xpL2NvbXBvbmVudHMvQXBwLnRzeCIsInNyYy9jbGkvdGVybWluYWxNb3VzZS50cyJdfSx7ImlkIjoiY2hpbmVzZS1zZXR1cC1jb3B5Iiwib2JqZWN0aXZlIjoiRmFzdENvbnRleHQg5a2Q5Luj55CG5qih5Z6L6YWN572u6L+Z5q615Lit5paH55WM6Z2i5paH5qGI5Zyo5ZOq6YeM5a6e546w77yfIiwicmVsZXZhbnRQYXRocyI6WyJzcmMvY2xpL3NldHVwLnRzIl19LHsiaWQiOiJjbGlwYm9hcmQtaW1hZ2VzIiwib2JqZWN0aXZlIjoiTG9jYXRlIGNsaXBib2FyZCBpbWFnZSBwYXN0ZSwgaW1hZ2UgYXR0YWNobWVudCBwYXJzaW5nLCBhbmQgbW9kZWwgbWVzc2FnZSBjb252ZXJzaW9uLiIsInJlbGV2YW50UGF0aHMiOlsic3JjL2NsaS9pbWFnZUF0dGFjaG1lbnRzLnRzIiwic3JjL2NsaS9jb21wb25lbnRzL0FwcC50c3giLCJzcmMvY29yZS9jb250ZXh0TWFuYWdlci50cyJdfV0='
const CASES = JSON.parse(Buffer.from(ENCODED_CASES, 'base64').toString('utf8')) as BenchmarkCase[]

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

function parseFallbackPaths(evidencePack: string): string[] {
  const section = evidencePack.split('fallback_candidates:')[1]?.split('</fast_context_pack>')[0] || ''
  return section
    .split(/\r?\n/)
    .map(line => line.match(/^\d+\.\s+(.+?)\s+\[(?:high|medium|low)\]/i)?.[1])
    .filter((path): path is string => Boolean(path))
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

async function loadRuntime(): Promise<{ runner: (options: any) => Promise<any>; Executor: new (path: string, options: any) => any }> {
  const runnerModulePath = '../src/core/' + ['fast', 'Context', 'Subagent'].join('')
  const runnerExport = ['run', 'Fast', 'Context', 'Subagent'].join('')
  const [runnerModule, executorModule] = await Promise.all([
    import(runnerModulePath),
    import('../src/core/runtime/nodeToolExecutor'),
  ])
  return {
    runner: runnerModule[runnerExport],
    Executor: executorModule.NodeToolExecutor,
  }
}

async function runCase(
  workspacePath: string,
  benchmark: BenchmarkCase,
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
): Promise<BenchmarkResult> {
  const executor = new runtime.Executor(workspacePath, { sandboxPolicy: 'readonly' })
  const startedAt = performance.now()
  const result = await runtime.runner({
    workspacePath,
    objective: benchmark.objective,
    toolExecutor: executor,
    apiKey: '',
    baseUrl: 'http://benchmark.invalid',
  })
  const latencyMs = performance.now() - startedAt
  const rankedPaths = parseFallbackPaths(result.evidencePack)
  const topFive = rankedPaths.slice(0, 5).map(normalizePath)
  const relevant = benchmark.relevantPaths.map(normalizePath)
  const recalled = relevant.filter(path => topFive.includes(path)).length
  const firstRelevantIndex = rankedPaths.findIndex(path => relevant.includes(normalizePath(path)))

  return {
    id: benchmark.id,
    latencyMs,
    recallAt5: relevant.length > 0 ? recalled / relevant.length : 0,
    reciprocalRank: firstRelevantIndex >= 0 ? 1 / (firstRelevantIndex + 1) : 0,
    empty: rankedPaths.length === 0,
    readConfirmed: result.hits.filter((hit: any) => /(?:file read|read confirmation|prefetch read)/i.test(hit.reason || '')).length,
    topPaths: rankedPaths.slice(0, 5),
  }
}

async function main(): Promise<void> {
  const workspacePath = resolve(process.argv[2] || process.cwd())
  const runtime = await loadRuntime()
  const results: BenchmarkResult[] = []

  for (const benchmark of CASES) {
    results.push(await runCase(workspacePath, benchmark, runtime))
  }

  console.log('Deterministic retrieval benchmark')
  console.log(`Workspace: ${workspacePath}`)
  console.log('')
  console.log('Case'.padEnd(26) + 'Recall@5'.padStart(10) + 'MRR'.padStart(8) + 'Latency'.padStart(12) + 'Reads'.padStart(8))
  for (const result of results) {
    console.log(
      result.id.padEnd(26)
      + result.recallAt5.toFixed(2).padStart(10)
      + result.reciprocalRank.toFixed(2).padStart(8)
      + `${Math.round(result.latencyMs)}ms`.padStart(12)
      + String(result.readConfirmed).padStart(8),
    )
    console.log(`  top5: ${result.topPaths.join(', ') || '(empty)'}`)
  }

  const recallAt5 = average(results.map(result => result.recallAt5))
  const mrr = average(results.map(result => result.reciprocalRank))
  const latencies = results.map(result => result.latencyMs)
  const emptyRate = results.filter(result => result.empty).length / results.length
  console.log('')
  console.log(`Average Recall@5: ${recallAt5.toFixed(3)}`)
  console.log(`MRR:              ${mrr.toFixed(3)}`)
  console.log(`Latency p50/p95:  ${Math.round(percentile(latencies, 0.5))}ms / ${Math.round(percentile(latencies, 0.95))}ms`)
  console.log(`Empty result rate: ${(emptyRate * 100).toFixed(1)}%`)

  const hasZeroRecallCase = results.some(result => result.recallAt5 === 0)
  if (recallAt5 < 0.65 || mrr < 0.65 || emptyRate > 0 || hasZeroRecallCase) {
    process.exitCode = 1
  }
}

void main()
