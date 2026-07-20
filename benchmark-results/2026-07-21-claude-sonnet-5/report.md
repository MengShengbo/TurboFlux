# TurboFlux FastContext vs Claude Code Explore

- Date: 2026-07-20T18:06:14.078Z
- Workspace commit: 629e4c25bc646c98113cddca4c86622a286cffdc
- Model/API: claude-sonnet-5 through the same configured Anthropic endpoint
- Retrieval mode: TurboFlux `medium`; Claude Code built-in `Explore` agent
- Reasoning: disabled for both because this relay rejects adaptive-thinking request fields
- Per-case timeout: 240s; one measured run per case
- Ordering: interleaved AB/BA by case to reduce time-window bias

## Aggregate

| Metric | TurboFlux | Claude Code |
|---|---:|---:|
| Success rate | 100.0% | 75.0% |
| Timeout rate | 0.0% | 25.0% |
| Recall@5 | 0.927 | 0.677 |
| Recall@10 | 0.927 | 0.677 |
| MRR | 1.000 | 0.750 |
| Top-1 hit rate | 100.0% | 75.0% |
| Line citation rate | 92.2% | 67.5% |
| Execution-flow section | 100.0% | 75.0% |
| Retrieval Quality Index | 94.8 | 69.9 |
| Successful-only Recall@10 | 0.927 | 0.903 |
| Successful-only MRR | 1.000 | 1.000 |
| Successful-only citation rate | 92.2% | 90.0% |
| Successful-only Quality Index | 94.8 | 93.2 |
| Successful latency p50 | 66.8s | 107.0s |
| Successful latency p95 | 107.0s | 208.7s |
| Average API retries | 0.0 | 0.0 |
| Average successful input/output tokens | 1310 / 1645 | 949 / 2429 |
| Average successful cache create/read | 866 / 12330 | 482 / 14122 |

The Retrieval Quality Index is transparent rather than model-judged: 60% Recall@10, 25% reciprocal rank, 10% line-citation completeness, and 5% execution-flow contract completion. Failed or timed-out cases receive zero.
Claude Code timed-out runs do not emit final usage totals, so token comparisons use successful cases only and should not be interpreted as total spend.

## Observed Result

- TurboFlux completed 8/8 tasks; Claude Code completed 6/8.
- TurboFlux successful latency was 37.6% lower at p50 and 48.7% lower at p95.
- End-to-end quality favored TurboFlux (94.8 vs 69.9) because Claude Code timed out twice.
- On successful runs only, quality was close (94.8 vs 93.2); the main measured advantage was convergence reliability and latency, not universal answer superiority.
- TurboFlux missed one reference file in its own FastContext scheduling trace and one in the interrupted-stream trace. Claude Code produced the more complete interrupted-stream map, while TurboFlux was stronger on background-terminal lifecycle and completed the Chinese exact-copy task that Claude Code timed out on.

## Per Case

| Case | System | OK | Recall@10 | MRR | Quality | Latency | Retries | Tokens in/out |
|---|---|:---:|---:|---:|---:|---:|---:|---:|
| cli-entry | turboflux | yes | 1.00 | 1.00 | 100.0 | 63.2s | 0 | 1259/1170 |
| cli-entry | claude-code | yes | 1.00 | 1.00 | 100.0 | 49.1s | 0 | 570/1400 |
| fast-context-scheduling | turboflux | yes | 0.67 | 1.00 | 73.8 | 80.5s | 0 | 1309/1604 |
| fast-context-scheduling | claude-code | no | 0.00 | 0.00 | 0.0 | 240.1s | 0 | 0/0 |
| transcript-scroll | turboflux | yes | 1.00 | 1.00 | 100.0 | 73.5s | 0 | 1283/1842 |
| transcript-scroll | claude-code | yes | 1.00 | 1.00 | 96.0 | 113.4s | 0 | 515/1975 |
| chinese-setup-copy | turboflux | yes | 1.00 | 1.00 | 100.0 | 65.1s | 0 | 1399/1270 |
| chinese-setup-copy | claude-code | no | 0.00 | 0.00 | 0.0 | 240.0s | 0 | 0/0 |
| clipboard-images | turboflux | yes | 1.00 | 1.00 | 100.0 | 60.9s | 0 | 1332/1530 |
| clipboard-images | claude-code | yes | 1.00 | 1.00 | 100.0 | 107.0s | 0 | 857/2286 |
| background-terminal-lifecycle | turboflux | yes | 1.00 | 1.00 | 100.0 | 95.8s | 0 | 1305/1756 |
| background-terminal-lifecycle | claude-code | yes | 0.67 | 1.00 | 78.0 | 208.7s | 0 | 1580/3406 |
| model-request-compatibility | turboflux | yes | 1.00 | 1.00 | 100.0 | 66.8s | 0 | 1292/1691 |
| model-request-compatibility | claude-code | yes | 0.75 | 1.00 | 85.0 | 91.3s | 0 | 957/2381 |
| interrupted-stream-persistence | turboflux | yes | 0.75 | 1.00 | 85.0 | 107.0s | 0 | 1301/2294 |
| interrupted-stream-persistence | claude-code | yes | 1.00 | 1.00 | 100.0 | 122.9s | 0 | 1212/3127 |

## Failure Notes

- claude-code / fast-context-scheduling: Timed out after 240000ms
- claude-code / chinese-setup-copy: Timed out after 240000ms

## Interpretation Limits

- This is one measured round, so latency variance and stochastic output variance are not confidence-bounded yet.
- Ground truth measures coverage of known authoritative files; additional valid supporting files are not penalized.
- The custom relay required reasoning to be disabled. This isolates retrieval orchestration but does not compare maximum native reasoning quality.
- Claude Code runs in bare/safe, read-only Explore mode; user plugins, MCP servers, memory, and project instructions are excluded.
