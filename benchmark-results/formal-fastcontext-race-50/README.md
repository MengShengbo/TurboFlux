# FastContext Race 50-Case Benchmark

This directory is the consolidated Race-only retrieval matrix used for the current TurboFlux record.

## Matrix

- 50 unique issue-localization cases.
- 150 run records: FastContext Race, Claude Code read-only, and OpenCode Explore, 50 runs each.
- Model: `gpt-5.5`, native reasoning disabled.
- Primary metric: Recall@10.
- Failures count as zero for quality metrics; latency percentiles use successful runs only.
- `runs.jsonl` is the lossless record set; `runs.csv` is the compact analysis view; `manifest.json` contains the case definitions.

## Source Scope

The matrix combines three disjoint case slices. The first 40 cases were collected against `e56d054`; the final 10-case slice was collected against `82576eb`. The source slice is retained in each record through `sourceFile` and in `manifest.json`.

This is an auditable consolidated engineering benchmark, not a claim that all 150 runs were produced in one uninterrupted experiment. Endpoint, model, protocol, timing, tool calls, raw output, and failure fields remain in the source records where available.

## Consolidated Results

| System | Cases | Success | R@10 | MRR | MAP | nDCG@10 | Full@10 | p50 latency | p95 latency |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| FastContext Race | 50 | 98% | 0.7726 | 0.8317 | 0.7280 | 0.7733 | 68% | 46.3s | 98.2s |
| Claude Code | 50 | 100% | 0.7783 | 0.8350 | 0.7483 | 0.7858 | 70% | 54.6s | 117.2s |
| OpenCode Explore | 50 | 84% | 0.7816 | 0.7915 | 0.7145 | 0.7626 | 70% | 231.0s | 444.7s |

These aggregate values are descriptive. They should not be used as a claim of statistical superiority without repeated runs on a fixed preregistered split.
