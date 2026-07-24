# FastContext Adaptive Stop and Long-Chain Trace Check

This targeted single-run check reuses three cases from the July 25 hard set with the same repository commits, `gpt-5.5`, disabled native reasoning, API profile, and 600-second timeout. It is a regression check, not a statistical superiority claim.

## Aggregate

| Version | R@10 | MRR | Full@10 | p50 | Requests | Tools | Input tokens |
|---|---:|---:|---:|---:|---:|---:|---:|
| Previous adaptive controller | 0.556 | 0.667 | 33.3% | 116.1s | 7.33 | 22.67 | 59,891 |
| Stop/trace optimized controller | 0.667 | 1.000 | 33.3% | 115.5s | 6.67 | 17.33 | 54,538 |

Across these three cases, Recall@10 rises by 0.111, tool calls fall by 23.5%, provider requests fall by 9.1%, and cumulative input falls by 8.9%. Median latency is effectively unchanged because the remaining Trino and MUI runs still use the full eight-turn safety allowance.

## Per Case

| Case | R@10 old -> new | Time old -> new | Requests old -> new | Tools old -> new | Input old -> new |
|---|---:|---:|---:|---:|---:|
| `huggingface__transformers-27717` | 0.667 -> 0.667 | 116.1s -> 79.7s | 8 -> 4 | 23 -> 10 | 75,776 -> 46,757 |
| `trinodb__trino-2768` | 0.000 -> 0.333 | 105.9s -> 115.5s | 6 -> 8 | 15 -> 20 | 28,342 -> 48,427 |
| `mui__material-ui-34138` | 1.000 -> 1.000 | 183.4s -> 124.1s | 8 -> 8 | 30 -> 22 | 75,554 -> 68,429 |

## Interpretation

- The adaptive stop signal works strongly on Transformers: identical recall with half the provider turns and 38% fewer input tokens.
- Compact batch tracing prevents long-chain source slices from dominating later prompts.
- Trino now reaches both `SetRoleTask` and `MetadataUtil`, but still misses four sibling role-task owners. Implementation-family expansion improved recall but remains the main quality frontier.
- MUI preserves full owner/mirror recall and uses fewer tools, but still spends the full turn budget on tests and neighboring type surfaces. Mechanical novelty alone cannot determine semantic closure, so stopping remains model-owned rather than locally forced.
