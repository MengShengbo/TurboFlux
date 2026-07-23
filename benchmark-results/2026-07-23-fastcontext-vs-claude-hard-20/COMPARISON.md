# FastContext vs Claude Code: Hard-20 Comparison

## Verdict

This run does not support a comprehensive-superiority claim. FastContext was competitive and occasionally better on multi-file recall, but Claude Code had higher aggregate recall, substantially better ranking quality, and a lower median latency.

| Metric | FastContext | Claude Code readonly |
|---|---:|---:|
| Successful final runs | 20/20 | 20/20 |
| Recall@10 | 0.700 | 0.761 |
| MRR | 0.713 | 0.875 |
| MAP | 0.537 | 0.728 |
| nDCG@10 | 0.623 | 0.771 |
| Full coverage@10 | 55.0% | 65.0% |
| p50 latency | 101.5s | 71.4s |
| p95 latency | 178.5s | 245.2s |
| Mean input tokens | 23,680 | 56,191 |
| Mean tool calls | 67.7 | 11.3 |

The paired Recall@10 difference was -0.061 with p=0.5020. With 20 cases and one repeat, the observed aggregate gap is not statistically significant. FastContext won Recall@10 on 3 cases, Claude Code won on 2, and 15 were ties.

## Paired Results

| Case | TF R@10 | CC R@10 | TF MRR | CC MRR | TF seconds | CC seconds |
|---|---:|---:|---:|---:|---:|---:|
| mui__material-ui-17301 | 0.33 | 0.22 | 1.00 | 1.00 | 115.2 | 50.2 |
| mui__material-ui-12236 | 0.50 | 0.50 | 1.00 | 1.00 | 106.3 | 67.5 |
| mui__material-ui-26746 | 0.67 | 0.33 | 1.00 | 1.00 | 106.1 | 60.1 |
| sveltejs__svelte-1376 | 0.33 | 0.00 | 1.00 | 0.00 | 78.7 | 54.8 |
| yt-dlp__yt-dlp-5933 | 0.67 | 0.67 | 1.00 | 1.00 | 74.7 | 183.9 |
| astropy__astropy-8707 | 1.00 | 1.00 | 1.00 | 1.00 | 82.6 | 59.6 |
| prettier__prettier-11637 | 1.00 | 1.00 | 1.00 | 1.00 | 116.8 | 75.5 |
| pydata__xarray-3305 | 1.00 | 1.00 | 1.00 | 1.00 | 55.4 | 47.7 |
| trinodb__trino-3603 | 0.00 | 0.00 | 0.00 | 0.00 | 91.2 | 65.1 |
| mui__material-ui-12406 | 0.50 | 0.50 | 0.50 | 1.00 | 178.5 | 85.7 |
| apache__rocketmq-7655 | 1.00 | 1.00 | 0.25 | 1.00 | 102.7 | 296.0 |
| matplotlib__matplotlib-26466 | 1.00 | 1.00 | 1.00 | 1.00 | 101.5 | 71.4 |
| huggingface__transformers-13693 | 0.00 | 1.00 | 0.00 | 0.50 | 33.5 | 164.6 |
| astropy__astropy-13033 | 1.00 | 1.00 | 1.00 | 1.00 | 31.8 | 71.5 |
| serverless__serverless-6827 | 1.00 | 1.00 | 0.50 | 1.00 | 138.5 | 55.7 |
| astropy__astropy-7166 | 1.00 | 1.00 | 1.00 | 1.00 | 54.7 | 129.5 |
| matplotlib__matplotlib-20676 | 1.00 | 1.00 | 1.00 | 1.00 | 127.9 | 30.0 |
| astropy__astropy-13236 | 1.00 | 1.00 | 0.50 | 1.00 | 151.8 | 75.3 |
| microsoft__vscode-160342 | 0.00 | 1.00 | 0.00 | 1.00 | 192.6 | 245.2 |
| apache__rocketmq-7712 | 1.00 | 1.00 | 0.50 | 1.00 | 95.9 | 203.4 |

## Engineering Readout

- FastContext used 58% fewer input tokens, but roughly six times as many tool calls. Local execution is inexpensive in token terms but still produces too much low-information work.
- FastContext had the lower p95 because Claude Code produced several extreme long-tail runs. Claude Code still had the better p50 and won latency on 13 of 20 cases.
- Final success was 100% after retry for both systems. Raw attempts were less stable: FastContext had 9 failed attempts out of 29 (6 protocol, 3 timeout); Claude Code had 10 out of 30 (9 protocol).
- FastContext matched Claude Code at Recall@10 on the seven SWE-bench Python cases, but trailed on MRR. The larger deficit came from the cross-language SWE-PolyBench slice.
- The clearest FastContext misses were `huggingface__transformers-13693` and `microsoft__vscode-160342`. Both completed normally but returned zero recall while Claude Code found the gold owner.
- The clearest ranking failures were `apache__rocketmq-7655`, `serverless__serverless-6827`, `astropy__astropy-13236`, and `apache__rocketmq-7712`: the required file was retrieved, but wrappers or adjacent consumers ranked above it.
- `trinodb__trino-3603` defeated both systems and should remain a blind regression case rather than become a rule-specific tuning target.

## Changes Validated By This Run

- Structured owner/frontier planning preserved distinct causal boundaries instead of allowing one path to satisfy several frontier roles.
- The adaptive judge retained a three-turn evidence closure for broad multi-frontier cases and used a two-turn path for narrower uncertainty.
- Abort signals now stop local search and read queues from accepting new work after timeout.
- The benchmark runner now enforces a hard per-case deadline, journals each completed attempt, resumes safely, serializes same-repository worktrees, and releases snapshots after each case.
- Cache cleanup is manifest-aware and path-bounded, preventing large benchmark suites from silently exhausting the system drive.

## Next Technical Priorities

1. Replace path-adjacent ranking with an explicit owner-vs-consumer pairwise judge using the already-read evidence.
2. Feed low-confidence owner disagreements back to one targeted semantic query, not another broad search wave.
3. Reduce local tool volume by stopping lanes once their marginal evidence gain falls below the best owner candidate.
4. Preserve the three hard misses as holdout regressions and validate improvements on new cases before rerunning them.
5. Repeat the final protocol across at least 100 cases and multiple seeds before making comparative product claims.
