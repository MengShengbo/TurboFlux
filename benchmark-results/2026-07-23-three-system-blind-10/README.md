# Three-System Blind Retrieval Run

This directory records a frozen ten-task comparison of TurboFlux FastContext, Claude Code, and OpenCode.

## Frozen Protocol

- The ten case IDs were absent from every historical `runs.jsonl` and every manifest under `benchmark-results` before selection.
- All cases have `leakageRisk=false`, cover ten repositories, and include Python (4), JavaScript (2), TypeScript (2), and Java (2).
- The manifest was frozen before any objective or gold path was inspected: SHA-256 `a78acc519758204671c95cf2a11950abdbb24fad86a9697b995be3614942f690`.
- All systems used `gpt-5.5` with native reasoning disabled, read-only repository access, one repeat, and a 240-second per-run timeout.
- Three independent runners launched concurrently at `2026-07-23T05:35:26.280Z`, each with case concurrency 4.
- FastContext used separate worktree snapshots so its `.codegraph` index was invisible to Claude Code and OpenCode.

## Primary Result

| System | Success | R@10 | MRR | Full@10 | p50 | p95 | Mean input tokens |
|---|---:|---:|---:|---:|---:|---:|---:|
| TurboFlux FastContext | 100% | 0.575 | 0.633 | 50% | 57.6s | 86.6s | 8,844 |
| Claude Code | 100% | **0.925** | **0.808** | **90%** | 82.8s | 149.8s | 42,732 |
| OpenCode | 80% | 0.775 | 0.675 | 70% | 198.3s | 238.8s | 92,363 |

Scores include failed runs as zero. Token and latency means in the generated report use successful runs.

## Operational Result

| System | Attempts | API requests | Total input tokens | Observed runner wall time |
|---|---:|---:|---:|---:|
| TurboFlux FastContext | 10 | 11 | 88,438 | 202.0s |
| Claude Code | 10 | 72 | 427,322 | 251.3s |
| OpenCode | 15 | 44 | 738,906 | 1,355.8s |

OpenCode failed AutoGPT and Flask before making an API request because its local SQLite/WAL initialization failed. The outer 30-minute harness later timed out on a residual process handle, after all three journals and per-system reports had already been written; the matrix contains all 30 unique runs.

## Language Result

| Language | FastContext R@10 | Claude Code R@10 | OpenCode R@10 |
|---|---:|---:|---:|
| Java | 1.000 | 1.000 | 1.000 |
| JavaScript | 0.625 | 0.625 | 0.875 |
| Python | **0.250** | **1.000** | 0.500 |
| TypeScript | 0.750 | 1.000 | 1.000 |

FastContext completely missed the Transformers, AutoGPT, and pytest gold implementation paths. Its quality deficit is therefore not a uniform ranking problem: it is concentrated in Python ownership localization. ContextMaps and the single-pass judge did not recover those indirect semantic owners.

## Interpretation

- **Quality:** Claude Code wins this matrix decisively in practical effect size. FastContext trails Claude Code by `-0.350` mean R@10; with only ten pairs, the permutation test remains non-significant (`p=0.1228`).
- **Efficiency:** FastContext is about 30% faster at p50 and 42% faster at p95 than Claude Code, while using about 79% fewer input tokens per successful run.
- **Reliability:** FastContext and Claude Code completed 10/10. OpenCode completed 8/10 and had severe retry/wall-time overhead.
- **Claim boundary:** This run does not support a claim that FastContext comprehensively exceeds Claude Code or OpenCode. It supports a narrower claim of substantially better efficiency with weaker blind retrieval recall.

The auditable aggregate is in `combined/runs.jsonl`; the generated statistical report is `combined/report.md`.
