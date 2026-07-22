import type { RetrievalMetrics, RunRecord } from './types'

export function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^`|`$/g, '').toLowerCase()
}

export function scoreRanking(rankedPaths: string[], goldPaths: string[]): RetrievalMetrics {
  const ranked = [...new Set(rankedPaths.map(normalizePath))]
  const gold = [...new Set(goldPaths.map(normalizePath))]
  const relevant = new Set(gold)
  const recallAt = (limit: number) => gold.length === 0 ? 0 : ranked.slice(0, limit).filter(path => relevant.has(path)).length / gold.length
  const precisionAt = (limit: number) => ranked.slice(0, limit).filter(path => relevant.has(path)).length / limit
  const first = ranked.findIndex(path => relevant.has(path))
  let hits = 0
  let precisionSum = 0
  ranked.forEach((path, index) => {
    if (!relevant.has(path)) return
    hits += 1
    precisionSum += hits / (index + 1)
  })
  const idealLength = Math.min(gold.length, 10)
  const idealDcg = Array.from({ length: idealLength }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0)
  const dcg = ranked.slice(0, 10).reduce((sum, path, index) => sum + (relevant.has(path) ? 1 / Math.log2(index + 2) : 0), 0)
  return {
    recallAt1: recallAt(1),
    recallAt3: recallAt(3),
    recallAt5: recallAt(5),
    recallAt10: recallAt(10),
    precisionAt5: precisionAt(5),
    reciprocalRank: first >= 0 ? 1 / (first + 1) : 0,
    averagePrecision: gold.length === 0 ? 0 : precisionSum / gold.length,
    ndcgAt10: idealDcg > 0 ? dcg / idealDcg : 0,
    fullCoverageAt10: gold.length > 0 && recallAt(10) === 1,
  }
}

export function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

export function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]
}

function randomFactory(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = Math.imul(1664525, state) + 1013904223 | 0
    return (state >>> 0) / 4294967296
  }
}

export function bootstrapMeanCI(values: number[], seed: number, iterations = 10_000): { mean: number; low: number; high: number } {
  if (values.length === 0) return { mean: 0, low: 0, high: 0 }
  const random = randomFactory(seed)
  const means: number[] = []
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0
    for (let index = 0; index < values.length; index += 1) sum += values[Math.floor(random() * values.length)]
    means.push(sum / values.length)
  }
  return { mean: average(values), low: percentile(means, 0.025), high: percentile(means, 0.975) }
}

export function pairedPermutationPValue(left: number[], right: number[], seed: number, iterations = 20_000): number {
  const count = Math.min(left.length, right.length)
  if (count === 0) return 1
  const differences = Array.from({ length: count }, (_, index) => left[index] - right[index])
  const observed = Math.abs(average(differences))
  const random = randomFactory(seed)
  let atLeastObserved = 0
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const permuted = differences.map(value => random() < 0.5 ? value : -value)
    if (Math.abs(average(permuted)) >= observed - 1e-12) atLeastObserved += 1
  }
  return (atLeastObserved + 1) / (iterations + 1)
}

export function aggregateRuns(runs: RunRecord[], seed: number) {
  const success = runs.filter(run => run.success)
  const byCase = new Map<string, RunRecord[]>()
  for (const run of runs) {
    const group = byCase.get(run.caseId) || []
    group.push(run)
    byCase.set(run.caseId, group)
  }
  const caseMetric = (pick: (run: RunRecord) => number) => [...byCase.values()].map(group => average(group.map(run => run.success ? pick(run) : 0)))
  const recall = bootstrapMeanCI(caseMetric(run => run.metrics.recallAt10), seed)
  const mrr = bootstrapMeanCI(caseMetric(run => run.metrics.reciprocalRank), seed ^ 0xABCDEF)
  const map = bootstrapMeanCI(caseMetric(run => run.metrics.averagePrecision), seed ^ 0x123456)
  const ndcg = bootstrapMeanCI(caseMetric(run => run.metrics.ndcgAt10), seed ^ 0x654321)
  return {
    cases: byCase.size,
    runs: runs.length,
    successes: success.length,
    successRate: runs.length ? success.length / runs.length : 0,
    timeoutRate: runs.length ? runs.filter(run => run.timedOut).length / runs.length : 0,
    recallAt10: recall,
    mrr,
    map,
    ndcgAt10: ndcg,
    fullCoverageAt10: average(caseMetric(run => run.metrics.fullCoverageAt10 ? 1 : 0)),
    latencyP50Ms: percentile(success.map(run => run.latencyMs), 0.5),
    latencyP95Ms: percentile(success.map(run => run.latencyMs), 0.95),
    averageToolCalls: average(success.map(run => run.toolCalls)),
    averageInputTokens: average(success.map(run => run.usage.inputTokens)),
    averageOutputTokens: average(success.map(run => run.usage.outputTokens)),
    totalCostUsd: runs.reduce((sum, run) => sum + (run.usage.costUsd || 0), 0),
  }
}
