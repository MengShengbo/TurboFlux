# FastContext Formal Analysis Plan

## Evidence boundary

- Frozen FastContext commit: `bf5d517c4e8cd94438f304e0895c097ec3612585`.
- Frozen harness commit: `3fc9699bd1ba79011841ee66a21c68121727a1b1`.
- Primary quality endpoint: task-level Recall@10 with failed and timed-out runs scored as zero.
- Confirmatory claims lead with the 100-task, three-repeat matrix.
- Main and confirmatory matrices remain separate in every table and chart.
- Partial data may validate the pipeline but may not enter the abstract, conclusion, or comparative claims.

## Aggregation

1. Parse JSONL defensively and deduplicate by `runId`, retaining the latest valid record.
2. Join runs to the frozen selected manifest by `caseId`.
3. For repeated runs, average each metric within `(caseId, system)` before cross-task inference.
4. Score failures and timeouts as zero for quality; retain their recorded latency and failure class for reliability analysis.
5. Report successful-run resource means and planned-run reliability denominators explicitly.

## Primary comparisons

- FastContext vs. Claude Code read-only.
- FastContext vs. OpenCode Explore.
- Metric: Recall@10.
- Test: two-sided paired permutation test over task-level values.
- Interval: 10,000-sample task bootstrap, 95% percentile interval.
- Effect summaries: paired mean difference and win/loss/tie counts.

## Secondary analyses

- Recall@1/3/5, MRR, MAP, nDCG@10, Full@10.
- Success and timeout rates.
- p50/p95 end-to-end and API latency.
- Requests, retries, search calls, read calls, tools, and token usage.
- Dataset, language, category, repository, gold-file-count, repository-size, and changed-line slices.
- Repeat standard deviation and coefficient of variation for quality, latency, requests, and tools.
- Failure audit by system and `failureKind`.
- Quality-cost Pareto frontier without scalarizing quality and latency into one arbitrary score.

## Multiple comparisons

Recall@10 is the sole primary metric. Secondary p-values will be reported as descriptive and adjusted with Holm's method within each comparison family. Raw and adjusted values must both remain in machine-readable output.

## Missingness and retries

- No result is imputed.
- A missing planned `runId` remains visibly missing in `progress.json`.
- Transient retries belong to the same planned run; the journal's latest record is authoritative.
- Permanent failures remain in the denominator and receive zero quality.

## Figures

1. Overall quality with bootstrap intervals.
2. End-to-end latency empirical CDF.
3. Quality-cost scatter and Pareto frontier.
4. Pairwise Recall@10 win/loss/tie counts.
5. Dataset and language slices.
6. Reliability by failure class.
7. Repeat stability for the confirmatory matrix.
8. Case-by-system Recall@10 heatmap.

Every figure must be generated from a neighboring CSV file, use vector SVG output, and state whether the source matrix is complete.
