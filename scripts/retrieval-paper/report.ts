import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { aggregateRuns, average, pairedPermutationPValue } from './metrics'
import type { BenchmarkManifest, ExperimentMetadata, RetrievalSystemId, RunRecord } from './types'

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function ci(value: { mean: number; low: number; high: number }): string {
  return `${value.mean.toFixed(3)} [${value.low.toFixed(3)}, ${value.high.toFixed(3)}]`
}

function csvValue(value: unknown): string {
  const text = value == null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
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

function pairedValues(runs: RunRecord[], left: RetrievalSystemId, right: RetrievalSystemId): { left: number[]; right: number[]; pairs: number } {
  const groups = groupBy(runs, run => `${run.caseId}:${run.system}`)
  const leftValues: number[] = []
  const rightValues: number[] = []
  const cases = new Set(runs.map(run => run.caseId))
  for (const caseId of cases) {
    const leftRuns = groups.get(`${caseId}:${left}`) || []
    const rightRuns = groups.get(`${caseId}:${right}`) || []
    if (leftRuns.length === 0 || rightRuns.length === 0) continue
    leftValues.push(average(leftRuns.map(run => run.metrics.recallAt10)))
    rightValues.push(average(rightRuns.map(run => run.metrics.recallAt10)))
  }
  return { left: leftValues, right: rightValues, pairs: leftValues.length }
}

function aggregateTable(runs: RunRecord[], systems: RetrievalSystemId[], seed: number): string[] {
  const lines = [
    '| System | Tasks / runs | Success | R@10 (95% CI) | MRR (95% CI) | MAP | nDCG@10 | Full@10 | p50 / p95 | Tools | Tokens in/out |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ]
  for (let index = 0; index < systems.length; index += 1) {
    const system = systems[index]
    const aggregate = aggregateRuns(runs.filter(run => run.system === system), seed + index * 7919)
    lines.push(`| ${system} | ${aggregate.cases} / ${aggregate.runs} | ${percent(aggregate.successRate)} | ${ci(aggregate.recallAt10)} | ${ci(aggregate.mrr)} | ${aggregate.map.mean.toFixed(3)} | ${aggregate.ndcgAt10.mean.toFixed(3)} | ${percent(aggregate.fullCoverageAt10)} | ${(aggregate.latencyP50Ms / 1000).toFixed(1)}s / ${(aggregate.latencyP95Ms / 1000).toFixed(1)}s | ${aggregate.averageToolCalls.toFixed(1)} | ${aggregate.averageInputTokens.toFixed(0)} / ${aggregate.averageOutputTokens.toFixed(0)} |`)
  }
  return lines
}

export function generateReport(options: {
  outputDir: string
  metadata: ExperimentMetadata
  manifest: BenchmarkManifest
  runs: RunRecord[]
}): void {
  const { outputDir, metadata, manifest } = options
  const deduplicated = [...new Map(options.runs.map(run => [run.runId, run])).values()]
  const expected = manifest.cases.length * metadata.systems.reduce((sum, system) => sum + (system === 'bm25' ? 1 : metadata.repeats), 0)
  const datasets = [...new Set(manifest.cases.map(item => item.dataset))]
  const languages = [...new Set(manifest.cases.map(item => item.language))].sort()
  const repositoryCount = new Set(manifest.cases.map(item => item.repository)).size
  const totalRepositoryBytes = [...new Map(deduplicated.map(run => [`${run.repository}:${run.caseId}`, run.repositoryBytes])).values()].reduce((sum, value) => sum + value, 0)
  const totalRepositoryFiles = [...new Map(deduplicated.map(run => [`${run.repository}:${run.caseId}`, run.repositoryFiles])).values()].reduce((sum, value) => sum + value, 0)
  const lines = [
    '# FastContext Repository Retrieval Benchmark',
    '',
    `- Experiment: \`${metadata.experimentId}\``,
    `- Model: \`${metadata.model}\`; native reasoning disabled for every LLM system`,
    `- Completed runs: ${deduplicated.length}/${expected}`,
    `- Dataset cases: ${manifest.cases.length}; repositories: ${repositoryCount}; languages: ${languages.join(', ')}`,
    `- Repository snapshots processed: ${(totalRepositoryFiles / 1_000_000).toFixed(2)}M files, ${(totalRepositoryBytes / 1024 / 1024 / 1024).toFixed(2)} GiB (counts include repeated base commits)`,
    `- Per-run timeout: ${metadata.timeoutMs / 1000}s; repeats: ${metadata.repeats}; seed: ${metadata.seed}`,
    `- Manifest SHA-256: \`${metadata.manifestSha256}\``,
    '',
    deduplicated.length === expected && metadata.experimentId.includes('calibration')
      ? '**Status:** complete calibration matrix. These values size and debug the formal study; they are not final comparative claims.'
      : deduplicated.length === expected
        ? '**Status:** complete formal matrix.'
      : '**Status:** incomplete/calibration matrix. Do not cite aggregate values as final results until every planned run completes.',
    '',
    '## Primary Results',
    '',
    ...aggregateTable(deduplicated, metadata.systems, metadata.seed),
    '',
    'Scores include failures and timeouts as zero. Repeats are averaged within each task before 10,000-sample bootstrap confidence intervals are computed across tasks; latency and token means use successful runs only.',
    '',
    '## Dataset Slices',
    '',
  ]

  for (const dataset of datasets) {
    lines.push(`### ${dataset}`, '', ...aggregateTable(deduplicated.filter(run => run.dataset === dataset), metadata.systems, metadata.seed ^ dataset.length), '')
  }

  lines.push('## Language Slices', '')
  lines.push('| Language | System | N | Success | R@10 | MRR | p50 |')
  lines.push('|---|---|---:|---:|---:|---:|---:|')
  for (const language of languages) {
    for (let index = 0; index < metadata.systems.length; index += 1) {
      const system = metadata.systems[index]
      const aggregate = aggregateRuns(deduplicated.filter(run => run.language === language && run.system === system), metadata.seed + index)
      lines.push(`| ${language} | ${system} | ${aggregate.runs} | ${percent(aggregate.successRate)} | ${aggregate.recallAt10.mean.toFixed(3)} | ${aggregate.mrr.mean.toFixed(3)} | ${(aggregate.latencyP50Ms / 1000).toFixed(1)}s |`)
    }
  }

  lines.push('', '## Paired Tests', '')
  lines.push('| FastContext system | Comparator | Pairs | Mean R@10 difference | Paired permutation p |')
  lines.push('|---|---|---:|---:|---:|')
  const fastSystems = metadata.systems.filter(system => system.startsWith('fastcontext-'))
  const comparators = metadata.systems.filter(system => !system.startsWith('fastcontext-'))
  for (const fast of fastSystems) {
    for (const comparator of comparators) {
      const paired = pairedValues(deduplicated, fast, comparator)
      const difference = average(paired.left.map((value, index) => value - paired.right[index]))
      const pValue = pairedPermutationPValue(paired.left, paired.right, metadata.seed ^ fast.length ^ comparator.length)
      lines.push(`| ${fast} | ${comparator} | ${paired.pairs} | ${difference.toFixed(3)} | ${pValue.toFixed(4)} |`)
    }
  }

  const failures = groupBy(deduplicated.filter(run => !run.success), run => `${run.system}:${run.failureKind}`)
  lines.push('', '## Reliability Audit', '')
  lines.push('| System / failure | Count | Example |')
  lines.push('|---|---:|---|')
  if (failures.size === 0) lines.push('| none | 0 | - |')
  else {
    for (const [key, values] of failures) {
      lines.push(`| ${key} | ${values.length} | ${values[0].caseId}: ${(values[0].error || '').replace(/\|/g, '\\|').slice(0, 160)} |`)
    }
  }

  lines.push(
    '',
    '## Protocol',
    '',
    '- Task: rank implementation files that require editing for a real issue at its pre-fix repository commit.',
    '- Ground truth: non-test implementation paths changed by the human gold patch. Test paths are retained in the manifest but excluded from the primary score.',
    '- Inputs: original issue text and repository snapshot only. Gold patches, hints, PR discussions, tests, git history, network, and editing are unavailable to agents.',
    '- Output: at most ten ranked, read-grounded repository-relative paths. Primary metrics are Recall@10, MRR, MAP, nDCG@10, full-file coverage, success rate, and latency.',
    '- Ordering: deterministic rotated system order for each case/repeat. JSONL journaling makes every completed run resumable and auditable.',
    '- Statistical tests: paired random-sign permutation test on Recall@10; bootstrap confidence intervals. No uncorrected significance claim should be made across many slices.',
    '',
    '## Dataset Provenance',
    '',
    '- [SWE-bench Verified](https://openai.com/index/introducing-swe-bench-verified/) contains 500 human-validated tasks sampled from resolved GitHub issues and associated PRs in 12 Python repositories. OpenAI reports 93 professional Python developers, three annotations per sample, and 1,699 screened candidates.',
    '- [SWE-PolyBench](https://github.com/amazon-science/SWE-PolyBench) contains real issue-closing PRs with executable tests. Its verified split spans Java, JavaScript, TypeScript, and Python and publishes file/CST localization metadata.',
    '- [Agentless](https://arxiv.org/abs/2407.01489) established hierarchical file-to-symbol-to-location localization on SWE-bench. It is a method, not an independent dataset.',
    '- [CodeRAG-Bench](https://github.com/code-rag-bench/code-rag-bench) motivates BM25/dense retrieval metrics but mixes task families; it is therefore background rather than the primary issue-localization set here.',
    '- [RepoQA](https://github.com/evalplus/repoqa) evaluates retrieval of a described needle function from long repository context. It measures a narrower capability than issue-to-edit localization and is not pooled into the primary result.',
    '',
    '## Validity Limits',
    '',
    '- Gold patch files are a defensible but incomplete relevance judgment: an alternative valid fix may touch different files, and incidental human edits can create false-positive gold paths.',
    '- Public GitHub tasks can appear in model training data. This experiment measures scaffolded retrieval on public tasks, not contamination-free generalization.',
    '- Claude Code uses its default agent with only Glob/Grep/Read enabled and enters a disclosed local Anthropic Messages to OpenAI Responses bridge. FastContext uses OpenAI Responses and OpenCode uses OpenAI-compatible Chat.',
    '- CLI systems include different proprietary/default system prompts. Equal model, task, permissions, and output contract do not make token budgets or internal instructions identical.',
    '- SWE-bench Verified is Python-only; cross-language conclusions require the SWE-PolyBench slice and should be reported separately.',
    '',
    '## Reproduction',
    '',
    '```powershell',
    'npm run benchmark:retrieval-paper -- prepare --per-dataset 100 --seed 20260722',
    'npm run benchmark:retrieval-paper -- run --limit 100 --repeats 3 --systems fastcontext-medium,claude-code-readonly,opencode-explore,bm25',
    'npm run benchmark:retrieval-paper -- run --limit 30 --repeats 1 --systems fastcontext-low,fastcontext-medium,fastcontext-max,neutral-tool-agent,bm25 --output benchmark-results/2026-07-22-gpt-5.5-paper-ablation',
    'npm run benchmark:retrieval-paper -- report',
    '```',
    '',
  )

  writeFileSync(join(outputDir, 'report.md'), lines.join('\n'))

  const summary = Object.fromEntries(metadata.systems.map((system, index) => [
    system,
    aggregateRuns(deduplicated.filter(run => run.system === system), metadata.seed + index),
  ]))
  writeFileSync(join(outputDir, 'summary.json'), `${JSON.stringify({ metadata, completed: deduplicated.length, expected, summary }, null, 2)}\n`)

  const headers = [
    'run_id', 'case_id', 'dataset', 'repository', 'language', 'category', 'system', 'repeat', 'order',
    'success', 'failure_kind', 'latency_ms', 'api_requests', 'api_retries', 'tool_calls', 'search_calls', 'read_calls',
    'recall_at_1', 'recall_at_3', 'recall_at_5', 'recall_at_10', 'mrr', 'map', 'ndcg_at_10', 'full_coverage_at_10',
    'input_tokens', 'output_tokens', 'cache_read_tokens', 'reasoning_tokens', 'protocol', 'ranked_paths', 'gold_paths', 'error',
  ]
  const rows = deduplicated.map(run => [
    run.runId, run.caseId, run.dataset, run.repository, run.language, run.category, run.system, run.repeat, run.order,
    run.success, run.failureKind, Math.round(run.latencyMs), run.apiRequests, run.apiRetries, run.toolCalls, run.searchCalls, run.readCalls,
    run.metrics.recallAt1, run.metrics.recallAt3, run.metrics.recallAt5, run.metrics.recallAt10, run.metrics.reciprocalRank,
    run.metrics.averagePrecision, run.metrics.ndcgAt10, run.metrics.fullCoverageAt10,
    run.usage.inputTokens, run.usage.outputTokens, run.usage.cacheReadTokens, run.usage.reasoningTokens,
    run.protocol, run.rankedPaths.join(';'), run.goldPaths.join(';'), run.error || '',
  ].map(csvValue).join(','))
  writeFileSync(join(outputDir, 'runs.csv'), `${headers.join(',')}\n${rows.join('\n')}\n`)
}
