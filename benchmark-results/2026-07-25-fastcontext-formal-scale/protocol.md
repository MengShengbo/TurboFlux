# FastContext Formal Retrieval Experiment

## Frozen implementation

- FastContext implementation commit: `bf5d517c4e8cd94438f304e0895c097ec3612585`
- Model for every LLM system: `gpt-5.5`
- Native reasoning: disabled
- Systems: FastContext, Claude Code read-only, OpenCode Explore
- Permissions: repository read/search tools only
- Per-run hard timeout: 600 seconds
- Transient retry allowance: three attempts
- Requested case concurrency: 25; the benchmark controller starts at four and adapts downward or upward under pressure

## Main matrix

- Manifest: `benchmark-data/retrieval-paper-v1/manifest.json`
- Cases: 200
- Repeats: one
- Expected system runs: 600
- Purpose: broad quality, latency, cost, reliability, language, repository, and task-complexity analysis

## Confirmatory matrix

- Manifest: `benchmark-data/retrieval-paper-v1/splits/holdout-test-manifest.json`
- Cases: 100
- Repeats: three
- Expected system runs: 900
- Purpose: confidence intervals, paired significance tests, variance, and ranking stability

The confirmatory cases are a frozen subset of the 200-case corpus. Historical exposure is allowed for this engineering-scale experiment, but no implementation changes are permitted after launch. Comparative claims should lead with the three-repeat confirmatory matrix and disclose the public-task contamination limitation.

## Persistence

Each completed system run is appended immediately to `runs.jsonl`. Re-running the same command resumes compatible completed runs and retries only transient failures. Repository snapshots are deleted after each case; shallow mirrors remain cached for later cases.

## Final deliverables

When both matrices complete, the experiment will produce two independent publication-ready manuscripts rather than a translated summary:

1. A formal Chinese FastContext paper with Chinese abstract, related work, architecture, adaptive stopping and long-chain tracing methods, experimental protocol, threats to validity, complete results, failure analysis, and reproducibility appendix.
2. A formal English FastContext paper with independently edited academic English, the same auditable evidence base, statistical claims, limitations, and reproducibility material.

Both editions will include:

- Markdown source and typeset PDF.
- Full aggregate and per-case data in CSV and JSON formats.
- Main-matrix and confirmatory-matrix results reported separately.
- Bootstrap confidence intervals, paired significance tests, effect sizes, repeat variance, and multiple-comparison disclosure.
- Slices by language, dataset, repository, task category, gold-file count, and observed retrieval-chain complexity.
- Success, timeout, protocol, tool, output-contract, and repository failure audits.
- Quality, latency, token, request, and tool-call Pareto analysis.
- Publication-grade vector charts for aggregate quality, latency CDF, cost-quality frontier, win/loss/tie counts, language slices, difficulty slices, reliability, repeat stability, and per-case recall heatmaps.
- A machine-readable figure-data directory so every plotted value can be independently checked.

No missing result will be imputed, and no failed run will be silently excluded. Marketing claims must be derived from the frozen confirmatory matrix, not selected individual cases.
