# FastContext Engineering Gate Summary

Date: 2026-07-23
Model: `gpt-5.5`, native reasoning disabled
Dataset: 12 balanced cases from SWE-bench Verified and SWE-PolyBench Verified

## Frozen architecture

- Two concurrent LLM branches: causal owner and change frontier.
- Four model turns per branch; independent tool calls run in parallel.
- Exact local primer for identifiers and compact filename variants.
- LLM-grounded candidate merge with relationship-evidence promotion.
- Deterministic ranking only for explicit causal clauses and exact title-to-filename matches.
- Older tool outputs are compacted while the latest wave remains complete; final submission receives a read-range ledger.
- Adaptive benchmark concurrency starts at four cases and may rise while error rate and request latency remain stable. Two FastContext branches cap case concurrency at 25 for a 50-request API ceiling.

## Measured results

| Gate | Success | R@10 | MRR | p50 | p95 |
|---|---:|---:|---:|---:|---:|
| Claude Code readonly, 12 cases | 100.0% | 0.833 | 0.833 | 59.7s | 131.4s |
| OpenCode explore, 12 cases | 58.3% | 0.556 | 0.583 | 166.2s | 278.0s |
| FastContext compacted, 12 cases | 100.0% | 0.861 | 0.861 | 68.3s | 76.3s |
| FastContext compacted, 4-case speed gate | 100.0% | 1.000 | 1.000 | 54.4s | 67.1s |

The 12-case FastContext gate used case concurrency six. The four-case speed gate used concurrency four and exposed substantial upstream latency inflation beyond that point. Absolute latency comparisons across separate runs remain indicative rather than statistically conclusive.

## Targeted regressions

- Django causal-owner ranking improved from MRR `0.25` to `1.00`.
- Gson implementation-family coverage improved from R@10 `0.67` to `1.00`.
- VS Code `multicursor.ts` improved from a complete miss to R@10 `1.00`; exact title-to-filename ranking is covered by a deterministic regression test.
- Serverless feature-frontier coverage improved from R@10 `0.50` to `0.83` with one additional coverage turn for explicit feature tasks.
- A persistent provider-side HTTP 502 affected the Prettier JSX task despite isolated runs and bounded retries. Cross-protocol 5xx replay was tested, cost 66 requests and 225 seconds, and was rejected from the final implementation.

## Verdict

The current evidence supports a quality advantage over the measured Claude Code and OpenCode baselines and a clear latency advantage over OpenCode. It does not yet support an unconditional claim that FastContext is faster than Claude Code across repositories: FastContext won the four-case speed gate but its 12-case p50 remained higher. A larger held-out, repeated, same-load experiment is still required before publishing a broad superiority claim.
