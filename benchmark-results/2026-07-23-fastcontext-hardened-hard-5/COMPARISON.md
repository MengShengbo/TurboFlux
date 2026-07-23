# FastContext hardened hard-5 comparison

All figures use the same five repository snapshots, issue text, `gpt-5.5`, disabled native reasoning, one run per case, and the same top-10 output contract.

## Aggregate

| System | R@10 | MRR | MAP | nDCG@10 | Full@10 | p50 | Tools | Avg input |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| FastContext hardened | 0.561 | 0.629 | 0.518 | 0.566 | 40% | 73.3s | 38.2 | 7,216 |
| FastContext first semantic planner | 0.504 | 0.640 | 0.482 | 0.530 | 40% | 76.2s | 28.8 | 9,785 |
| Claude Code read-only | 0.569 | 0.667 | 0.417 | 0.519 | 40% | 69.3s | 12.2 | 64,023 |

The hardened FastContext run is 0.008 below Claude Code on R@10 and 0.038 below it on MRR. It is 4.0 seconds slower at p50, while using about 89% fewer input tokens. With five single-run cases, these differences are descriptive rather than statistically conclusive.

## Per case

| Case | FastContext R@10 / MRR | Claude Code R@10 / MRR | Observation |
|---|---:|---:|---|
| `psf__requests-6028` | 1.000 / 1.000 | 1.000 / 0.333 | FastContext finds and ranks `requests/utils.py` first. |
| `sphinx-doc__sphinx-9658` | 1.000 / 1.000 | 1.000 / 1.000 | Tie. |
| `trinodb__trino-2081` | 0.000 / 0.000 | 0.000 / 0.000 | Both miss the indirect bytecode-generation owner. |
| `prettier__prettier-3515` | 0.714 / 1.000 | 0.571 / 1.000 | FastContext covers one additional implementation/configuration file. |
| `coder__code-server-3277` | 0.091 / 0.143 | 0.273 / 1.000 | FastContext over-focuses on vendored workbench files and misses most server/route/IPC propagation files. |

## Diagnosis

The remaining gap is concentrated in high-cardinality cross-boundary change frontiers rather than direct-owner localization. The code-server run read only one of eleven gold files. Its planners identified authentication, logout, menu registration, and IPC concepts, but the candidate field clustered around generic vendored workbench surfaces. Evidence volume was high enough to suppress semantic feedback even though evidence diversity across architectural boundaries was low.

The next improvement should score boundary coverage explicitly: server route, capability/config source, transport or IPC propagation, and UI consumer each need an independent evidence quota. Raw file count and multi-query agreement within one subsystem are not sufficient confidence signals.
