import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  aggregateRuns,
  average,
  pairedPermutationPValue,
  percentile,
  scoreRanking,
} from './retrieval-paper/metrics'
import type {
  BenchmarkManifest,
  ExperimentMetadata,
  RetrievalMetrics,
  RetrievalSystemId,
  RunRecord,
} from './retrieval-paper/types'

const DEFAULT_ROOT = resolve('benchmark-results', '2026-07-25-fastcontext-formal-scale')
const SYSTEMS: RetrievalSystemId[] = ['fastcontext', 'claude-code-readonly', 'opencode-explore']
const SYSTEM_LABELS: Record<string, string> = {
  fastcontext: 'FastContext',
  'claude-code-readonly': 'Claude Code',
  'opencode-explore': 'OpenCode',
}
const SYSTEM_COLORS: Record<string, string> = {
  fastcontext: '#0F766E',
  'claude-code-readonly': '#B45309',
  'opencode-explore': '#334155',
}

interface MatrixInput {
  id: 'main-200' | 'confirm-100x3'
  directory: string
  metadata: ExperimentMetadata
  manifest: BenchmarkManifest
  runs: RunRecord[]
  expectedRuns: number
  parseErrors: number
  complete: boolean
}

interface AggregateRow {
  matrix: string
  complete: boolean
  system: RetrievalSystemId
  cases: number
  runs: number
  expectedRuns: number
  successes: number
  successRate: number
  timeoutRate: number
  recallAt10: number
  recallAt10Low: number
  recallAt10High: number
  mrr: number
  mrrLow: number
  mrrHigh: number
  map: number
  ndcgAt10: number
  fullCoverageAt10: number
  latencyP50Ms: number
  latencyP95Ms: number
  averageApiRequests: number
  averageToolCalls: number
  averageSearchCalls: number
  averageReadCalls: number
  averageInputTokens: number
  averageOutputTokens: number
  averageCacheReadTokens: number
  totalCostUsd: number
}

interface SliceRow {
  matrix: string
  complete: boolean
  dimension: string
  value: string
  system: RetrievalSystemId
  cases: number
  runs: number
  successRate: number
  recallAt10: number
  mrr: number
  ndcgAt10: number
  fullCoverageAt10: number
  latencyP50Ms: number
  averageToolCalls: number
  averageInputTokens: number
}

interface PairwiseRow {
  matrix: string
  complete: boolean
  metric: string
  left: RetrievalSystemId
  right: RetrievalSystemId
  pairs: number
  leftMean: number
  rightMean: number
  meanDifference: number
  wins: number
  losses: number
  ties: number
  pValue: number
  holmAdjustedPValue: number
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function readJournal(path: string): { runs: RunRecord[]; parseErrors: number } {
  if (!existsSync(path)) return { runs: [], parseErrors: 0 }
  const records = new Map<string, RunRecord>()
  let parseErrors = 0
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)) {
    try {
      const record = JSON.parse(line) as RunRecord
      if (!record.runId) {
        parseErrors += 1
        continue
      }
      records.set(record.runId, record)
    } catch {
      parseErrors += 1
    }
  }
  return { runs: [...records.values()], parseErrors }
}

function loadMatrix(root: string, id: MatrixInput['id']): MatrixInput | null {
  const directory = join(root, id)
  const metadataPath = join(directory, 'metadata.json')
  const manifestPath = join(directory, 'selected-manifest.json')
  if (!existsSync(metadataPath) || !existsSync(manifestPath)) return null
  const metadata = readJson<ExperimentMetadata>(metadataPath)
  const manifest = readJson<BenchmarkManifest>(manifestPath)
  const journal = readJournal(join(directory, 'runs.jsonl'))
  const expectedRuns = metadata.caseIds.length * metadata.systems.length * metadata.repeats
  return {
    id,
    directory,
    metadata,
    manifest,
    runs: journal.runs,
    expectedRuns,
    parseErrors: journal.parseErrors,
    complete: journal.runs.length === expectedRuns,
  }
}

function zeroFailedMetrics(run: RunRecord): RunRecord {
  return run.success ? run : { ...run, metrics: scoreRanking([], run.goldPaths) }
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function writeCsv(path: string, rows: Array<Record<string, unknown>>, columns?: string[]): void {
  const header = columns || [...new Set(rows.flatMap(row => Object.keys(row)))]
  const lines = [
    header.map(csvCell).join(','),
    ...rows.map(row => header.map(column => csvCell(row[column])).join(',')),
  ]
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function successful(runs: RunRecord[]): RunRecord[] {
  return runs.filter(run => run.success)
}

function aggregateRow(matrix: MatrixInput, system: RetrievalSystemId, seedOffset: number): AggregateRow {
  const runs = matrix.runs.filter(run => run.system === system).map(zeroFailedMetrics)
  const successfulRuns = successful(runs)
  const aggregate = aggregateRuns(runs, matrix.metadata.seed + seedOffset)
  return {
    matrix: matrix.id,
    complete: matrix.complete,
    system,
    cases: aggregate.cases,
    runs: aggregate.runs,
    expectedRuns: matrix.metadata.caseIds.length * matrix.metadata.repeats,
    successes: aggregate.successes,
    successRate: aggregate.successRate,
    timeoutRate: aggregate.timeoutRate,
    recallAt10: aggregate.recallAt10.mean,
    recallAt10Low: aggregate.recallAt10.low,
    recallAt10High: aggregate.recallAt10.high,
    mrr: aggregate.mrr.mean,
    mrrLow: aggregate.mrr.low,
    mrrHigh: aggregate.mrr.high,
    map: aggregate.map.mean,
    ndcgAt10: aggregate.ndcgAt10.mean,
    fullCoverageAt10: aggregate.fullCoverageAt10,
    latencyP50Ms: aggregate.latencyP50Ms,
    latencyP95Ms: aggregate.latencyP95Ms,
    averageApiRequests: average(successfulRuns.map(run => run.apiRequests)),
    averageToolCalls: aggregate.averageToolCalls,
    averageSearchCalls: average(successfulRuns.map(run => run.searchCalls)),
    averageReadCalls: average(successfulRuns.map(run => run.readCalls)),
    averageInputTokens: aggregate.averageInputTokens,
    averageOutputTokens: aggregate.averageOutputTokens,
    averageCacheReadTokens: average(successfulRuns.map(run => run.usage.cacheReadTokens)),
    totalCostUsd: aggregate.totalCostUsd,
  }
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const value = key(item)
    const group = groups.get(value) || []
    group.push(item)
    groups.set(value, group)
  }
  return groups
}

function sliceRows(matrix: MatrixInput, dimension: string, pick: (run: RunRecord) => string): SliceRow[] {
  const rows: SliceRow[] = []
  const groups = groupBy(matrix.runs.map(zeroFailedMetrics), pick)
  for (const [value, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    for (let systemIndex = 0; systemIndex < SYSTEMS.length; systemIndex += 1) {
      const system = SYSTEMS[systemIndex]
      const runs = group.filter(run => run.system === system)
      if (runs.length === 0) continue
      const aggregate = aggregateRuns(runs, matrix.metadata.seed ^ value.length ^ systemIndex)
      rows.push({
        matrix: matrix.id,
        complete: matrix.complete,
        dimension,
        value,
        system,
        cases: aggregate.cases,
        runs: aggregate.runs,
        successRate: aggregate.successRate,
        recallAt10: aggregate.recallAt10.mean,
        mrr: aggregate.mrr.mean,
        ndcgAt10: aggregate.ndcgAt10.mean,
        fullCoverageAt10: aggregate.fullCoverageAt10,
        latencyP50Ms: aggregate.latencyP50Ms,
        averageToolCalls: aggregate.averageToolCalls,
        averageInputTokens: aggregate.averageInputTokens,
      })
    }
  }
  return rows
}

function caseMetricValues(
  runs: RunRecord[],
  system: RetrievalSystemId,
  metric: (metrics: RetrievalMetrics) => number,
): Map<string, number> {
  const groups = groupBy(runs.filter(run => run.system === system).map(zeroFailedMetrics), run => run.caseId)
  return new Map([...groups.entries()].map(([caseId, group]) => [caseId, average(group.map(run => metric(run.metrics)))]))
}

function holmAdjust(rows: PairwiseRow[]): void {
  const ordered = [...rows].sort((left, right) => left.pValue - right.pValue)
  let runningMaximum = 0
  for (let index = 0; index < ordered.length; index += 1) {
    const adjusted = Math.min(1, ordered[index].pValue * (ordered.length - index))
    runningMaximum = Math.max(runningMaximum, adjusted)
    ordered[index].holmAdjustedPValue = runningMaximum
  }
}

function pairwiseRows(matrix: MatrixInput): PairwiseRow[] {
  const metrics: Array<[string, (metrics: RetrievalMetrics) => number]> = [
    ['recallAt10', metrics => metrics.recallAt10],
    ['mrr', metrics => metrics.reciprocalRank],
    ['map', metrics => metrics.averagePrecision],
    ['ndcgAt10', metrics => metrics.ndcgAt10],
  ]
  const rows: PairwiseRow[] = []
  for (const [metricName, metric] of metrics) {
    const fastContext = caseMetricValues(matrix.runs, 'fastcontext', metric)
    for (const comparator of ['claude-code-readonly', 'opencode-explore'] as RetrievalSystemId[]) {
      const other = caseMetricValues(matrix.runs, comparator, metric)
      const shared = [...fastContext.keys()].filter(caseId => other.has(caseId)).sort()
      const leftValues = shared.map(caseId => fastContext.get(caseId) || 0)
      const rightValues = shared.map(caseId => other.get(caseId) || 0)
      const differences = leftValues.map((value, index) => value - rightValues[index])
      rows.push({
        matrix: matrix.id,
        complete: matrix.complete,
        metric: metricName,
        left: 'fastcontext',
        right: comparator,
        pairs: shared.length,
        leftMean: average(leftValues),
        rightMean: average(rightValues),
        meanDifference: average(differences),
        wins: differences.filter(value => value > 1e-12).length,
        losses: differences.filter(value => value < -1e-12).length,
        ties: differences.filter(value => Math.abs(value) <= 1e-12).length,
        pValue: pairedPermutationPValue(leftValues, rightValues, matrix.metadata.seed ^ metricName.length ^ comparator.length),
        holmAdjustedPValue: 1,
      })
    }
  }
  for (const metricName of metrics.map(([name]) => name)) {
    holmAdjust(rows.filter(row => row.metric === metricName))
  }
  return rows
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0
  const mean = average(values)
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

function repeatStabilityRows(matrix: MatrixInput): Array<Record<string, unknown>> {
  const groups = groupBy(matrix.runs.map(zeroFailedMetrics), run => `${run.caseId}:${run.system}`)
  return [...groups.values()].map(group => {
    const first = group[0]
    const recall = group.map(run => run.metrics.recallAt10)
    const latency = group.map(run => run.latencyMs)
    const requests = group.map(run => run.apiRequests)
    const tools = group.map(run => run.toolCalls)
    const recallMean = average(recall)
    const latencyMean = average(latency)
    return {
      matrix: matrix.id,
      complete: matrix.complete,
      caseId: first.caseId,
      system: first.system,
      repeatsObserved: group.length,
      repeatsExpected: matrix.metadata.repeats,
      recallAt10Mean: recallMean,
      recallAt10Sd: standardDeviation(recall),
      recallAt10Cv: recallMean === 0 ? '' : standardDeviation(recall) / recallMean,
      latencyMeanMs: latencyMean,
      latencySdMs: standardDeviation(latency),
      latencyCv: latencyMean === 0 ? '' : standardDeviation(latency) / latencyMean,
      requestsMean: average(requests),
      requestsSd: standardDeviation(requests),
      toolsMean: average(tools),
      toolsSd: standardDeviation(tools),
    }
  }).sort((left, right) => String(left.caseId).localeCompare(String(right.caseId)) || String(left.system).localeCompare(String(right.system)))
}

function caseRows(matrix: MatrixInput): Array<Record<string, unknown>> {
  const manifestCases = new Map(matrix.manifest.cases.map(item => [item.id, item]))
  return matrix.runs.map(zeroFailedMetrics).sort((left, right) => left.caseId.localeCompare(right.caseId) || left.system.localeCompare(right.system) || left.repeat - right.repeat).map(run => {
    const benchmarkCase = manifestCases.get(run.caseId)
    return {
      matrix: matrix.id,
      complete: matrix.complete,
      runId: run.runId,
      caseId: run.caseId,
      dataset: run.dataset,
      repository: run.repository,
      language: run.language,
      category: run.category,
      changedLines: benchmarkCase?.changedLines ?? '',
      goldFileCount: run.goldPaths.length,
      system: run.system,
      repeat: run.repeat,
      success: run.success,
      failureKind: run.failureKind,
      timedOut: run.timedOut,
      recallAt1: run.metrics.recallAt1,
      recallAt3: run.metrics.recallAt3,
      recallAt5: run.metrics.recallAt5,
      recallAt10: run.metrics.recallAt10,
      precisionAt5: run.metrics.precisionAt5,
      mrr: run.metrics.reciprocalRank,
      map: run.metrics.averagePrecision,
      ndcgAt10: run.metrics.ndcgAt10,
      fullCoverageAt10: run.metrics.fullCoverageAt10,
      latencyMs: run.latencyMs,
      apiDurationMs: run.apiDurationMs ?? '',
      apiRequests: run.apiRequests,
      apiRetries: run.apiRetries,
      toolCalls: run.toolCalls,
      searchCalls: run.searchCalls,
      readCalls: run.readCalls,
      inputTokens: run.usage.inputTokens,
      outputTokens: run.usage.outputTokens,
      cacheReadTokens: run.usage.cacheReadTokens,
      cacheWriteTokens: run.usage.cacheWriteTokens,
      reasoningTokens: run.usage.reasoningTokens,
      costUsd: run.usage.costUsd ?? '',
      repositoryFiles: run.repositoryFiles,
      repositoryBytes: run.repositoryBytes,
      rankedPaths: run.rankedPaths.join('|'),
      goldPaths: run.goldPaths.join('|'),
      error: run.error || '',
    }
  })
}

function failureRows(matrix: MatrixInput): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  for (const system of SYSTEMS) {
    const runs = matrix.runs.filter(run => run.system === system)
    const kinds = new Set(runs.map(run => run.failureKind))
    kinds.add('none')
    for (const failureKind of [...kinds].sort()) {
      const count = runs.filter(run => run.failureKind === failureKind).length
      rows.push({
        matrix: matrix.id,
        complete: matrix.complete,
        system,
        failureKind,
        count,
        rate: runs.length === 0 ? 0 : count / runs.length,
        runsObserved: runs.length,
        runsExpected: matrix.metadata.caseIds.length * matrix.metadata.repeats,
      })
    }
  }
  return rows
}

function latencyCdfRows(matrix: MatrixInput): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  for (const system of SYSTEMS) {
    const values = matrix.runs.filter(run => run.system === system && run.success).map(run => run.latencyMs)
    for (let percentileIndex = 0; percentileIndex <= 100; percentileIndex += 1) {
      const ratio = percentileIndex / 100
      rows.push({
        matrix: matrix.id,
        complete: matrix.complete,
        system,
        percentile: ratio,
        latencyMs: percentile(values, ratio),
        successfulRuns: values.length,
      })
    }
  }
  return rows
}

function qualityCostRows(aggregateRows: AggregateRow[]): Array<Record<string, unknown>> {
  return aggregateRows.map(row => ({
    matrix: row.matrix,
    complete: row.complete,
    system: row.system,
    recallAt10: row.recallAt10,
    mrr: row.mrr,
    latencyP50Ms: row.latencyP50Ms,
    latencyP95Ms: row.latencyP95Ms,
    averageApiRequests: row.averageApiRequests,
    averageToolCalls: row.averageToolCalls,
    averageInputTokens: row.averageInputTokens,
    averageOutputTokens: row.averageOutputTokens,
    totalCostUsd: row.totalCostUsd,
  }))
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function svgFrame(title: string, subtitle: string, body: string, complete: boolean, width = 1120, height = 680): string {
  const watermark = complete ? '' : `<text x="${width - 44}" y="${height - 28}" text-anchor="end" fill="#B91C1C" font-size="18" font-weight="700">INCOMPLETE DATA</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="#FFFFFF"/>
<text x="56" y="54" fill="#111827" font-family="Arial, sans-serif" font-size="28" font-weight="700">${xml(title)}</text>
<text x="56" y="82" fill="#4B5563" font-family="Arial, sans-serif" font-size="14">${xml(subtitle)}</text>
${body}
${watermark}
</svg>\n`
}

function qualitySvg(rows: AggregateRow[], matrix: MatrixInput): string {
  const matrixRows = rows.filter(row => row.matrix === matrix.id)
  const chartLeft = 210
  const chartRight = 1030
  const chartTop = 135
  const rowGap = 145
  const axis = `<line x1="${chartLeft}" y1="${chartTop - 18}" x2="${chartLeft}" y2="${chartTop + rowGap * 2 + 52}" stroke="#9CA3AF"/>
<line x1="${chartRight}" y1="${chartTop - 18}" x2="${chartRight}" y2="${chartTop + rowGap * 2 + 52}" stroke="#E5E7EB"/>
${[0, 0.25, 0.5, 0.75, 1].map(value => {
    const position = chartLeft + value * (chartRight - chartLeft)
    return `<line x1="${position}" y1="${chartTop - 18}" x2="${position}" y2="${chartTop + rowGap * 2 + 52}" stroke="#E5E7EB"/><text x="${position}" y="${chartTop + rowGap * 2 + 80}" text-anchor="middle" fill="#4B5563" font-family="Arial, sans-serif" font-size="13">${value.toFixed(2)}</text>`
  }).join('\n')}`
  const marks = matrixRows.map((row, index) => {
    const centerY = chartTop + index * rowGap + 28
    const valueX = chartLeft + row.recallAt10 * (chartRight - chartLeft)
    const lowX = chartLeft + row.recallAt10Low * (chartRight - chartLeft)
    const highX = chartLeft + row.recallAt10High * (chartRight - chartLeft)
    return `<text x="56" y="${centerY + 5}" fill="#111827" font-family="Arial, sans-serif" font-size="17" font-weight="600">${xml(SYSTEM_LABELS[row.system])}</text>
<line x1="${lowX}" y1="${centerY}" x2="${highX}" y2="${centerY}" stroke="${SYSTEM_COLORS[row.system]}" stroke-width="4"/>
<line x1="${lowX}" y1="${centerY - 10}" x2="${lowX}" y2="${centerY + 10}" stroke="${SYSTEM_COLORS[row.system]}" stroke-width="2"/>
<line x1="${highX}" y1="${centerY - 10}" x2="${highX}" y2="${centerY + 10}" stroke="${SYSTEM_COLORS[row.system]}" stroke-width="2"/>
<circle cx="${valueX}" cy="${centerY}" r="9" fill="${SYSTEM_COLORS[row.system]}"/>
<text x="${Math.min(chartRight - 8, valueX + 16)}" y="${centerY - 14}" fill="#111827" font-family="Arial, sans-serif" font-size="14">${row.recallAt10.toFixed(3)}</text>`
  }).join('\n')
  return svgFrame(
    `Recall@10 with 95% bootstrap intervals — ${matrix.id}`,
    `${matrix.runs.length}/${matrix.expectedRuns} runs journaled; failures score zero`,
    `${axis}\n${marks}`,
    matrix.complete,
  )
}

function latencySvg(matrix: MatrixInput): string {
  const chartLeft = 100
  const chartRight = 1030
  const chartTop = 125
  const chartBottom = 580
  const successfulRuns = matrix.runs.filter(run => run.success)
  const maxLatency = Math.max(1, percentile(successfulRuns.map(run => run.latencyMs), 0.99))
  const axes = `<line x1="${chartLeft}" y1="${chartBottom}" x2="${chartRight}" y2="${chartBottom}" stroke="#6B7280"/>
<line x1="${chartLeft}" y1="${chartTop}" x2="${chartLeft}" y2="${chartBottom}" stroke="#6B7280"/>
${[0, 0.25, 0.5, 0.75, 1].map(value => {
    const x = chartLeft + value * (chartRight - chartLeft)
    const y = chartBottom - value * (chartBottom - chartTop)
    return `<line x1="${x}" y1="${chartTop}" x2="${x}" y2="${chartBottom}" stroke="#E5E7EB"/><text x="${x}" y="${chartBottom + 26}" text-anchor="middle" fill="#4B5563" font-family="Arial, sans-serif" font-size="12">${(value * maxLatency / 1000).toFixed(0)}s</text><line x1="${chartLeft}" y1="${y}" x2="${chartRight}" y2="${y}" stroke="#F3F4F6"/><text x="${chartLeft - 12}" y="${y + 4}" text-anchor="end" fill="#4B5563" font-family="Arial, sans-serif" font-size="12">${value.toFixed(2)}</text>`
  }).join('\n')}`
  const lines = SYSTEMS.map((system, systemIndex) => {
    const values = matrix.runs.filter(run => run.system === system && run.success).map(run => run.latencyMs).sort((left, right) => left - right)
    const points = values.map((value, index) => {
      const x = chartLeft + Math.min(1, value / maxLatency) * (chartRight - chartLeft)
      const y = chartBottom - ((index + 1) / Math.max(1, values.length)) * (chartBottom - chartTop)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
    const legendY = 106 + systemIndex * 24
    return `<polyline points="${points}" fill="none" stroke="${SYSTEM_COLORS[system]}" stroke-width="3"/>
<line x1="${chartRight - 170}" y1="${legendY}" x2="${chartRight - 142}" y2="${legendY}" stroke="${SYSTEM_COLORS[system]}" stroke-width="3"/><text x="${chartRight - 134}" y="${legendY + 5}" fill="#111827" font-family="Arial, sans-serif" font-size="13">${xml(SYSTEM_LABELS[system])}</text>`
  }).join('\n')
  return svgFrame(
    `Successful-run latency CDF — ${matrix.id}`,
    `${matrix.runs.length}/${matrix.expectedRuns} runs journaled; x-axis clipped at observed p99`,
    `${axes}\n${lines}`,
    matrix.complete,
  )
}

function reliabilitySvg(matrix: MatrixInput): string {
  const chartLeft = 260
  const chartRight = 1030
  const chartTop = 145
  const rowGap = 145
  const marks = SYSTEMS.map((system, index) => {
    const runs = matrix.runs.filter(run => run.system === system)
    const successRate = runs.length === 0 ? 0 : runs.filter(run => run.success).length / runs.length
    const y = chartTop + index * rowGap
    const width = successRate * (chartRight - chartLeft)
    return `<text x="56" y="${y + 25}" fill="#111827" font-family="Arial, sans-serif" font-size="17" font-weight="600">${xml(SYSTEM_LABELS[system])}</text>
<rect x="${chartLeft}" y="${y}" width="${chartRight - chartLeft}" height="38" fill="#E5E7EB"/>
<rect x="${chartLeft}" y="${y}" width="${width}" height="38" fill="${SYSTEM_COLORS[system]}"/>
<text x="${Math.min(chartRight - 8, chartLeft + width + 12)}" y="${y + 25}" fill="#111827" font-family="Arial, sans-serif" font-size="14">${(successRate * 100).toFixed(1)}% (${runs.filter(run => run.success).length}/${runs.length})</text>`
  }).join('\n')
  return svgFrame(
    `Observed run success — ${matrix.id}`,
    `${matrix.runs.length}/${matrix.expectedRuns} runs journaled; denominator excludes not-yet-run jobs`,
    marks,
    matrix.complete,
  )
}

function writeReadme(outputDirectory: string, matrices: MatrixInput[]): void {
  const lines = [
    '# FastContext formal paper data',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    ...matrices.map(matrix => `- ${matrix.id}: ${matrix.runs.length}/${matrix.expectedRuns} runs; ${matrix.complete ? 'complete' : 'INCOMPLETE'}; JSONL parse errors: ${matrix.parseErrors}`),
    '',
    'Partial outputs validate schemas and plotting only. They must not be cited as final comparative results.',
    '',
    '## Files',
    '',
    '- `progress.json`: completion and frozen experiment metadata.',
    '- `aggregate.csv` / `aggregate.json`: system-level quality, reliability, latency, and resource metrics.',
    '- `case-results.csv`: one row per journaled run.',
    '- `dataset-slices.csv`, `language-slices.csv`, `category-slices.csv`: stratified aggregates.',
    '- `failure-audit.csv`: failure-class counts and rates.',
    '- `latency-cdf.csv`: empirical latency quantiles.',
    '- `quality-cost.csv`: inputs for Pareto analysis.',
    '- `repeat-stability.csv`: within-task repeat dispersion.',
    '- `pairwise-tests.csv` / `pairwise-tests.json`: paired task-level comparisons and Holm-adjusted p-values.',
    '- `figures/*.svg`: deterministic vector previews generated from the same records.',
  ]
  writeFileSync(join(outputDirectory, 'README.md'), `${lines.join('\n')}\n`, 'utf8')
}

function main(): void {
  const root = resolve(option('--root') || DEFAULT_ROOT)
  const outputDirectory = resolve(option('--output') || join(root, 'paper-data'))
  const matrices = (['main-200', 'confirm-100x3'] as MatrixInput['id'][])
    .map(id => loadMatrix(root, id))
    .filter((matrix): matrix is MatrixInput => matrix !== null)
  if (matrices.length === 0) throw new Error(`No formal benchmark matrices found under ${root}`)

  mkdirSync(outputDirectory, { recursive: true })
  mkdirSync(join(outputDirectory, 'figures'), { recursive: true })

  const aggregateRows = matrices.flatMap((matrix, matrixIndex) => SYSTEMS.map((system, systemIndex) => aggregateRow(matrix, system, matrixIndex * 10_000 + systemIndex * 7919)))
  const caseResultRows = matrices.flatMap(caseRows)
  const datasetRows = matrices.flatMap(matrix => sliceRows(matrix, 'dataset', run => run.dataset))
  const languageRows = matrices.flatMap(matrix => sliceRows(matrix, 'language', run => run.language))
  const categoryRows = matrices.flatMap(matrix => sliceRows(matrix, 'category', run => run.category))
  const failureAuditRows = matrices.flatMap(failureRows)
  const latencyRows = matrices.flatMap(latencyCdfRows)
  const repeatRows = matrices.flatMap(repeatStabilityRows)
  const pairwise = matrices.flatMap(pairwiseRows)
  const progress = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceRoot: root,
    allComplete: matrices.length === 2 && matrices.every(matrix => matrix.complete),
    matrices: matrices.map(matrix => ({
      id: matrix.id,
      complete: matrix.complete,
      runsObserved: matrix.runs.length,
      runsExpected: matrix.expectedRuns,
      parseErrors: matrix.parseErrors,
      experimentId: matrix.metadata.experimentId,
      gitCommit: matrix.metadata.gitCommit,
      manifestSha256: matrix.metadata.manifestSha256,
      model: matrix.metadata.model,
      reasoning: matrix.metadata.reasoning,
      systems: matrix.metadata.systems,
      cases: matrix.metadata.caseIds.length,
      repeats: matrix.metadata.repeats,
    })),
  }

  writeJson(join(outputDirectory, 'progress.json'), progress)
  writeJson(join(outputDirectory, 'aggregate.json'), aggregateRows)
  writeCsv(join(outputDirectory, 'aggregate.csv'), aggregateRows as unknown as Array<Record<string, unknown>>)
  writeCsv(join(outputDirectory, 'case-results.csv'), caseResultRows)
  writeCsv(join(outputDirectory, 'dataset-slices.csv'), datasetRows as unknown as Array<Record<string, unknown>>)
  writeCsv(join(outputDirectory, 'language-slices.csv'), languageRows as unknown as Array<Record<string, unknown>>)
  writeCsv(join(outputDirectory, 'category-slices.csv'), categoryRows as unknown as Array<Record<string, unknown>>)
  writeCsv(join(outputDirectory, 'failure-audit.csv'), failureAuditRows)
  writeCsv(join(outputDirectory, 'latency-cdf.csv'), latencyRows)
  writeCsv(join(outputDirectory, 'quality-cost.csv'), qualityCostRows(aggregateRows))
  writeCsv(join(outputDirectory, 'repeat-stability.csv'), repeatRows)
  writeJson(join(outputDirectory, 'pairwise-tests.json'), pairwise)
  writeCsv(join(outputDirectory, 'pairwise-tests.csv'), pairwise as unknown as Array<Record<string, unknown>>)
  writeReadme(outputDirectory, matrices)

  for (const matrix of matrices) {
    writeFileSync(join(outputDirectory, 'figures', `${matrix.id}-quality.svg`), qualitySvg(aggregateRows, matrix), 'utf8')
    writeFileSync(join(outputDirectory, 'figures', `${matrix.id}-latency-cdf.svg`), latencySvg(matrix), 'utf8')
    writeFileSync(join(outputDirectory, 'figures', `${matrix.id}-reliability.svg`), reliabilitySvg(matrix), 'utf8')
  }

  console.log(`Generated paper data in ${outputDirectory}`)
  for (const matrix of matrices) console.log(`${matrix.id}: ${matrix.runs.length}/${matrix.expectedRuns} ${matrix.complete ? 'complete' : 'INCOMPLETE'}`)
  console.log(`Source: ${basename(root)}`)
}

main()
