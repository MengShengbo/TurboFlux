import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { RetrievalSystemId } from './retrieval-paper/types'

const DEFAULT_ROOT = resolve('benchmark-results', '2026-07-25-fastcontext-formal-scale')
const DEFAULT_PAPER_DIRECTORY = resolve('docs', 'papers', 'fastcontext-formal-2026')
const LABELS: Record<RetrievalSystemId, string> = {
  fastcontext: 'FastContext',
  'claude-code-readonly': 'Claude Code',
  'opencode-explore': 'OpenCode',
  'neutral-tool-agent': 'Neutral Agent',
  bm25: 'BM25',
}

interface Progress {
  allComplete: boolean
  generatedAt: string
}

interface AggregateRow {
  matrix: 'main-200' | 'confirm-100x3'
  complete: boolean
  system: RetrievalSystemId
  cases: number
  runs: number
  successRate: number
  timeoutRate: number
  recallAt10: number
  recallAt10Low: number
  recallAt10High: number
  mrr: number
  map: number
  ndcgAt10: number
  fullCoverageAt10: number
  latencyP50Ms: number
  latencyP95Ms: number
  averageApiRequests: number
  averageToolCalls: number
  averageInputTokens: number
}

interface PairwiseRow {
  matrix: 'main-200' | 'confirm-100x3'
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

interface SliceRow {
  matrix: 'main-200' | 'confirm-100x3'
  dimension: string
  value: string
  system: RetrievalSystemId
  cases: number
  runs: number
  successRate: number
  recallAt10: number
  mrr: number
  latencyP50Ms: number
}

interface StabilityRow {
  matrix: 'main-200' | 'confirm-100x3'
  system: RetrievalSystemId
  repeatsObserved: number
  recallAt10Sd: number
  latencyCv: number | ''
  requestsSd: number
  toolsSd: number
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function seconds(value: number): string {
  return `${(value / 1000).toFixed(1)} s`
}

function metric(value: number): string {
  return value.toFixed(3)
}

function aggregateTable(rows: AggregateRow[], language: 'zh' | 'en'): string {
  const header = language === 'zh'
    ? '| 系统 | 成功率 | R@10 [95% CI] | MRR | MAP | nDCG@10 | Full@10 | p50 / p95 |\n|---|---:|---:|---:|---:|---:|---:|---:|'
    : '| System | Success | R@10 [95% CI] | MRR | MAP | nDCG@10 | Full@10 | p50 / p95 |\n|---|---:|---:|---:|---:|---:|---:|---:|'
  return [header, ...rows.map(row => `| ${LABELS[row.system]} | ${percent(row.successRate)} | ${metric(row.recallAt10)} [${metric(row.recallAt10Low)}, ${metric(row.recallAt10High)}] | ${metric(row.mrr)} | ${metric(row.map)} | ${metric(row.ndcgAt10)} | ${percent(row.fullCoverageAt10)} | ${seconds(row.latencyP50Ms)} / ${seconds(row.latencyP95Ms)} |`)].join('\n')
}

function pairedTable(rows: PairwiseRow[], language: 'zh' | 'en'): string {
  const header = language === 'zh'
    ? '| 比较 | 配对题数 | R@10 差值 | 胜 / 负 / 平 | 原始 p | Holm p |\n|---|---:|---:|---:|---:|---:|'
    : '| Comparison | Pairs | R@10 difference | Win / loss / tie | Raw p | Holm p |\n|---|---:|---:|---:|---:|---:|'
  return [header, ...rows.map(row => `| FastContext vs. ${LABELS[row.right]} | ${row.pairs} | ${row.meanDifference.toFixed(3)} | ${row.wins} / ${row.losses} / ${row.ties} | ${row.pValue.toFixed(4)} | ${row.holmAdjustedPValue.toFixed(4)} |`)].join('\n')
}

function sliceTable(rows: SliceRow[], language: 'zh' | 'en'): string {
  const values = [...new Set(rows.map(row => row.value))].sort()
  const header = language === 'zh'
    ? '| 切片 | FastContext R@10 | Claude Code R@10 | OpenCode R@10 |\n|---|---:|---:|---:|'
    : '| Slice | FastContext R@10 | Claude Code R@10 | OpenCode R@10 |\n|---|---:|---:|---:|'
  return [header, ...values.map(value => {
    const pick = (system: RetrievalSystemId) => rows.find(row => row.value === value && row.system === system)?.recallAt10
    const display = (system: RetrievalSystemId) => pick(system) == null ? '—' : metric(pick(system) as number)
    return `| ${value} | ${display('fastcontext')} | ${display('claude-code-readonly')} | ${display('opencode-explore')} |`
  })].join('\n')
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function stabilitySummary(rows: StabilityRow[], language: 'zh' | 'en'): string {
  const lines = rows.length === 0 ? [] : (['fastcontext', 'claude-code-readonly', 'opencode-explore'] as RetrievalSystemId[]).map(system => {
    const systemRows = rows.filter(row => row.system === system && row.repeatsObserved > 1)
    const recallSd = mean(systemRows.map(row => row.recallAt10Sd))
    const latencyCv = mean(systemRows.map(row => typeof row.latencyCv === 'number' ? row.latencyCv : 0))
    const requestSd = mean(systemRows.map(row => row.requestsSd))
    const toolSd = mean(systemRows.map(row => row.toolsSd))
    return language === 'zh'
      ? `- ${LABELS[system]}：题内 R@10 标准差均值 ${recallSd.toFixed(3)}，延迟变异系数均值 ${latencyCv.toFixed(3)}，请求数标准差 ${requestSd.toFixed(2)}，工具数标准差 ${toolSd.toFixed(2)}。`
      : `- ${LABELS[system]}: mean within-task R@10 SD ${recallSd.toFixed(3)}, mean latency CV ${latencyCv.toFixed(3)}, request-count SD ${requestSd.toFixed(2)}, and tool-count SD ${toolSd.toFixed(2)}.`
  })
  return lines.join('\n')
}

function significanceSentence(row: PairwiseRow, language: 'zh' | 'en'): string {
  const direction = row.meanDifference > 0 ? 'higher' : row.meanDifference < 0 ? 'lower' : 'equal'
  const significant = row.holmAdjustedPValue < 0.05
  if (language === 'zh') {
    const directionText = direction === 'higher' ? '更高' : direction === 'lower' ? '更低' : '相同'
    return `相较 ${LABELS[row.right]}，FastContext 的任务级 R@10 均值${directionText} ${Math.abs(row.meanDifference).toFixed(3)}；Holm 校正 p=${row.holmAdjustedPValue.toFixed(4)}，${significant ? '达到预设显著性阈值' : '未达到预设显著性阈值'}。`
  }
  return `Relative to ${LABELS[row.right]}, FastContext's task-level mean R@10 was ${direction} by ${Math.abs(row.meanDifference).toFixed(3)} (Holm-adjusted p=${row.holmAdjustedPValue.toFixed(4)}), ${significant ? 'meeting' : 'not meeting'} the prespecified significance threshold.`
}

function resultSection(
  aggregates: AggregateRow[],
  pairwise: PairwiseRow[],
  languageSlices: SliceRow[],
  datasetSlices: SliceRow[],
  stability: StabilityRow[],
  language: 'zh' | 'en',
): string {
  const main = aggregates.filter(row => row.matrix === 'main-200')
  const confirm = aggregates.filter(row => row.matrix === 'confirm-100x3')
  const confirmPairs = pairwise.filter(row => row.matrix === 'confirm-100x3' && row.metric === 'recallAt10')
  const confirmLanguages = languageSlices.filter(row => row.matrix === 'confirm-100x3')
  const confirmDatasets = datasetSlices.filter(row => row.matrix === 'confirm-100x3')
  const confirmStability = stability.filter(row => row.matrix === 'confirm-100x3')
  const fastConfirm = confirm.find(row => row.system === 'fastcontext')
  if (!fastConfirm || main.length !== 3 || confirm.length !== 3 || confirmPairs.length !== 2) {
    throw new Error('Formal result package is complete but required aggregate rows are missing')
  }

  if (language === 'zh') {
    return `## 6 结果

本节全部数值由冻结 JSONL 运行日志生成。主实验用于观察广度，确认实验用于主要比较与不确定性估计；失败和超时按零质量计入。

### 6.1 总体检索质量

**200 题主实验。**

${aggregateTable(main, language)}

**100 题三重复确认实验。**

${aggregateTable(confirm, language)}

确认实验中，FastContext 的 Recall@10 为 ${metric(fastConfirm.recallAt10)}，95% bootstrap 区间为 [${metric(fastConfirm.recallAt10Low)}, ${metric(fastConfirm.recallAt10High)}]。${confirmPairs.map(row => significanceSentence(row, language)).join('')}

${pairedTable(confirmPairs, language)}

### 6.2 延迟与调用成本

确认实验中，FastContext 端到端延迟 p50/p95 为 ${seconds(fastConfirm.latencyP50Ms)} / ${seconds(fastConfirm.latencyP95Ms)}，成功运行平均使用 ${fastConfirm.averageApiRequests.toFixed(1)} 次模型请求、${fastConfirm.averageToolCalls.toFixed(1)} 次工具调用和 ${fastConfirm.averageInputTokens.toFixed(0)} 个输入 token。三套系统的质量与成本应结合表 6.1 和 paper-data/quality-cost.csv 解读，本文不使用任意线性加权分数掩盖质量—延迟权衡。

### 6.3 数据集与语言切片

**确认实验数据集切片。**

${sliceTable(confirmDatasets, language)}

**确认实验语言切片。**

${sliceTable(confirmLanguages, language)}

切片样本量小于总体样本量，结果用于定位系统性差异，不单独支持总体优越性声明。完整类别、仓库规模和 gold 文件数切片见机器可读数据包。

### 6.4 可靠性与重复稳定性

FastContext 在确认实验中的成功率为 ${percent(fastConfirm.successRate)}，超时率为 ${percent(fastConfirm.timeoutRate)}。逐失败类别审计见 failure-audit.csv，所有失败均保留在主质量分母中。

${stabilitySummary(confirmStability, language)}

逐题三重复结果、题内离散度和异常案例索引见 repeat-stability.csv 与 case-results.csv。

`
  }

  return `## 6. Results

All values in this section are generated from the frozen JSONL journals. The main matrix measures breadth; the confirmatory matrix supports primary comparisons and uncertainty estimates. Failures and timeouts contribute zero quality.

### 6.1 Overall Retrieval Quality

**200-task main matrix.**

${aggregateTable(main, language)}

**100-task, three-repeat confirmatory matrix.**

${aggregateTable(confirm, language)}

FastContext achieved confirmatory Recall@10 of ${metric(fastConfirm.recallAt10)} with a 95% bootstrap interval of [${metric(fastConfirm.recallAt10Low)}, ${metric(fastConfirm.recallAt10High)}]. ${confirmPairs.map(row => significanceSentence(row, language)).join(' ')}

${pairedTable(confirmPairs, language)}

### 6.2 Latency and Invocation Cost

In the confirmatory matrix, FastContext's end-to-end p50/p95 latency was ${seconds(fastConfirm.latencyP50Ms)} / ${seconds(fastConfirm.latencyP95Ms)}. Successful runs used ${fastConfirm.averageApiRequests.toFixed(1)} model requests, ${fastConfirm.averageToolCalls.toFixed(1)} tool calls, and ${fastConfirm.averageInputTokens.toFixed(0)} input tokens on average. Quality and cost should be interpreted jointly through Section 6.1 and paper-data/quality-cost.csv; we do not hide the quality-latency trade-off behind an arbitrary scalar score.

### 6.3 Dataset and Language Slices

**Confirmatory dataset slices.**

${sliceTable(confirmDatasets, language)}

**Confirmatory language slices.**

${sliceTable(confirmLanguages, language)}

Slice sample sizes are smaller than the overall matrix. They identify systematic differences but do not independently support broad superiority claims. Complete category, repository-size, and gold-set-size data are included in the machine-readable artifact.

### 6.4 Reliability and Repeat Stability

FastContext's confirmatory success rate was ${percent(fastConfirm.successRate)}, with a timeout rate of ${percent(fastConfirm.timeoutRate)}. failure-audit.csv retains every failure class, and all failures remain in the primary quality denominator.

${stabilitySummary(confirmStability, language)}

Per-run observations, within-task dispersion, and anomaly identifiers are provided in repeat-stability.csv and case-results.csv.

`
}

function replaceResults(source: string, generatedResults: string): string {
  const resultPattern = /## 6(?:\.| )[^\n]*\n[\s\S]*?(?=## 7(?:\.| ))/
  if (!resultPattern.test(source)) throw new Error('Could not locate Results section in paper template')
  return source.replace(resultPattern, generatedResults)
}

function finalizePaper(
  source: string,
  language: 'zh' | 'en',
  results: string,
  fastConfirm: AggregateRow,
  pairwise: PairwiseRow[],
): string {
  let output = replaceResults(source, results)
  if (language === 'zh') {
    output = output.replace('**稿件状态：** 方法与实验设计已冻结；定量结果待正式实验完成后由数据生成器写入。', '**稿件状态：** 冻结实验已完成；结果由正式运行日志自动生成。')
    output = output.replace(/最终稿将报告检索质量、延迟、调用成本、可靠性、重复稳定性与多维切片结果；本文当前版本不对尚未完成的正式实验作定量结论。/, `确认实验中 FastContext 的 Recall@10 为 ${metric(fastConfirm.recallAt10)}，端到端延迟 p50 为 ${seconds(fastConfirm.latencyP50Ms)}；与两个对照系统的完整配对结果和不确定性估计在正文中报告。`)
    output = output.replace(/关于其相对质量、速度和稳定性的最终结论将在 1,500 次冻结实验全部完成后由同一数据流水线生成。/, `冻结实验表明，FastContext 在质量、延迟与可靠性之间形成了可量化的工程权衡；其相对差异与统计显著性以确认矩阵的配对结果为准。`)
  } else {
    output = output.replace('**Manuscript status:** Methods and protocol are frozen; quantitative results will be inserted only after the formal experiment completes.', '**Manuscript status:** The frozen experiment is complete; results are generated directly from the formal run journals.')
    output = output.replace(/The completed manuscript will report retrieval quality, latency, cost, reliability, repeat stability, and stratified analyses\. This pre-results version makes no quantitative superiority claim\./, `In the confirmatory matrix, FastContext achieved Recall@10 of ${metric(fastConfirm.recallAt10)} with median end-to-end latency of ${seconds(fastConfirm.latencyP50Ms)}; complete paired comparisons and uncertainty estimates are reported in the paper.`)
    output = output.replace(/Final comparative conclusions will be generated only after all 1,500 frozen runs complete\./, `The completed frozen study quantifies FastContext's trade-offs in retrieval quality, latency, and reliability; relative claims are based on paired confirmatory results.`)
  }
  const evidenceFooter = language === 'zh'
    ? `\n<!-- Generated from complete formal benchmark data. Recall@10 comparisons: ${pairwise.map(row => `${LABELS[row.right]} diff=${row.meanDifference.toFixed(3)}, Holm p=${row.holmAdjustedPValue.toFixed(4)}`).join('; ')}. -->\n`
    : `\n<!-- Generated from complete formal benchmark data. Recall@10 comparisons: ${pairwise.map(row => `${LABELS[row.right]} diff=${row.meanDifference.toFixed(3)}, Holm p=${row.holmAdjustedPValue.toFixed(4)}`).join('; ')}. -->\n`
  return `${output.trim()}${evidenceFooter}`
}

function main(): void {
  const root = resolve(option('--root') || DEFAULT_ROOT)
  const paperDirectory = resolve(option('--paper-dir') || DEFAULT_PAPER_DIRECTORY)
  const dataDirectory = join(root, 'paper-data')
  const progressPath = join(dataDirectory, 'progress.json')
  if (!existsSync(progressPath)) throw new Error('Paper data is missing; run npm run paper:fastcontext:data first')
  const progress = readJson<Progress>(progressPath)
  if (!progress.allComplete) throw new Error('Formal matrices are incomplete; refusing to generate final papers')

  const aggregates = readJson<AggregateRow[]>(join(dataDirectory, 'aggregate.json'))
  const pairwise = readJson<PairwiseRow[]>(join(dataDirectory, 'pairwise-tests.json'))
  const languageSlices = readJson<SliceRow[]>(join(dataDirectory, 'language-slices.json'))
  const datasetSlices = readJson<SliceRow[]>(join(dataDirectory, 'dataset-slices.json'))
  const stability = readJson<StabilityRow[]>(join(dataDirectory, 'repeat-stability.json'))
  const fastConfirm = aggregates.find(row => row.matrix === 'confirm-100x3' && row.system === 'fastcontext')
  const confirmPairs = pairwise.filter(row => row.matrix === 'confirm-100x3' && row.metric === 'recallAt10')
  if (!fastConfirm || confirmPairs.length !== 2) throw new Error('Confirmatory FastContext aggregates are missing')

  const zhResults = resultSection(aggregates, pairwise, languageSlices, datasetSlices, stability, 'zh')
  const enResults = resultSection(aggregates, pairwise, languageSlices, datasetSlices, stability, 'en')
  const zhSource = readFileSync(join(paperDirectory, 'paper-zh.md'), 'utf8')
  const enSource = readFileSync(join(paperDirectory, 'paper-en.md'), 'utf8')
  writeFileSync(join(paperDirectory, 'paper-zh-final.md'), finalizePaper(zhSource, 'zh', zhResults, fastConfirm, confirmPairs), 'utf8')
  writeFileSync(join(paperDirectory, 'paper-en-final.md'), finalizePaper(enSource, 'en', enResults, fastConfirm, confirmPairs), 'utf8')
  console.log(`Finalized bilingual manuscripts from complete data generated at ${progress.generatedAt}`)
}

main()
