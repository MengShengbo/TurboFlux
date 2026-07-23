# FastContext Affected-Case Retest

Model: `gpt-5.5`; native reasoning disabled. Only TurboFlux FastContext was rerun.

| Case | Before R@10 | After R@10 | Before MRR | After MRR | Before latency | After latency | ContextMaps |
|---|---:|---:|---:|---:|---:|---:|---:|
| `huggingface__transformers-29519` | 0.000 | 1.000 | 0.000 | 1.000 | 81.3s | 63.5s | off |
| `Significant-Gravitas__AutoGPT-4652` | 0.000 | 1.000 | 0.000 | 0.200 | 48.2s | 71.6s | on |
| `pytest-dev__pytest-7490` | 0.000 | 1.000 | 0.000 | 0.500 | 52.6s | 76.9s | on |

The original records are in `benchmark-results/2026-07-23-three-system-blind-10/fastcontext/runs.jsonl`. The final AutoGPT and pytest records are in `results-v2/runs.jsonl`; the Transformers record is in `../2026-07-23-fastcontext-extra-transformers/runs.jsonl`.

The retest fixes recall on all three affected cases. AutoGPT and pytest spend additional time reading cross-module evidence; Transformers improves both recall and latency.
