# FastContext Repository Retrieval Benchmark

- Experiment: `2026-07-22-gpt-5.5-no-reasoning-calibration`
- Model: `gpt-5.5`; native reasoning disabled for every LLM system
- Completed runs: 35/35
- Dataset cases: 5; repositories: 5; languages: Java, JavaScript, Python, TypeScript
- Repository snapshots processed: 0.02M files, 0.13 GiB (counts include repeated base commits)
- Per-run timeout: 240s; repeats: 1; seed: 20260722
- Manifest SHA-256: `af84b012c67b5936646f07ec6712323f40a4a61ce75a3783e7d20124121160c9`

**Status:** complete calibration matrix. These values size and debug the formal study; they are not final comparative claims.

## Primary Results

| System | Tasks / runs | Success | R@10 (95% CI) | MRR (95% CI) | MAP | nDCG@10 | Full@10 | p50 / p95 | Tools | Tokens in/out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fastcontext-low | 5 / 5 | 60.0% | 0.500 [0.100, 0.900] | 0.600 [0.200, 1.000] | 0.500 | 0.523 | 40.0% | 63.1s / 74.2s | 5.7 | 51773 / 2508 |
| fastcontext-medium | 5 / 5 | 100.0% | 0.800 [0.600, 1.000] | 0.900 [0.700, 1.000] | 0.750 | 0.800 | 60.0% | 82.2s / 115.1s | 9.8 | 127939 / 3072 |
| fastcontext-max | 5 / 5 | 40.0% | 0.300 [0.000, 0.700] | 0.300 [0.000, 0.700] | 0.250 | 0.277 | 20.0% | 56.4s / 71.6s | 12.5 | 103244 / 2402 |
| claude-code-readonly | 5 / 5 | 100.0% | 0.900 [0.700, 1.000] | 0.900 [0.700, 1.000] | 0.817 | 0.861 | 80.0% | 43.2s / 60.6s | 7.2 | 55781 / 1546 |
| opencode-explore | 5 / 5 | 100.0% | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 0.967 | 0.984 | 100.0% | 87.1s / 132.0s | 13.8 | 126257 / 2487 |
| neutral-tool-agent | 5 / 5 | 60.0% | 0.500 [0.100, 0.900] | 0.600 [0.200, 1.000] | 0.500 | 0.523 | 40.0% | 58.4s / 59.3s | 15.0 | 85719 / 2313 |
| bm25 | 5 / 5 | 100.0% | 0.700 [0.300, 1.000] | 0.400 [0.133, 0.733] | 0.383 | 0.470 | 60.0% | 0.6s / 2.1s | 1.0 | 0 / 0 |

Scores include failures and timeouts as zero. Repeats are averaged within each task before 10,000-sample bootstrap confidence intervals are computed across tasks; latency and token means use successful runs only.

## Dataset Slices

### swebench-verified

| System | Tasks / runs | Success | R@10 (95% CI) | MRR (95% CI) | MAP | nDCG@10 | Full@10 | p50 / p95 | Tools | Tokens in/out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fastcontext-low | 1 / 1 | 100.0% | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 1.000 | 1.000 | 100.0% | 74.2s / 74.2s | 6.0 | 43609 / 3098 |
| fastcontext-medium | 1 / 1 | 100.0% | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 1.000 | 1.000 | 100.0% | 75.5s / 75.5s | 5.0 | 96263 / 2647 |
| fastcontext-max | 1 / 1 | 0.0% | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 | 0.000 | 0.0% | 0.0s / 0.0s | 0.0 | 0 / 0 |
| claude-code-readonly | 1 / 1 | 100.0% | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 1.000 | 1.000 | 100.0% | 32.0s / 32.0s | 4.0 | 21449 / 1212 |
| opencode-explore | 1 / 1 | 100.0% | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 1.000 | 1.000 | 100.0% | 72.7s / 72.7s | 13.0 | 83452 / 2510 |
| neutral-tool-agent | 1 / 1 | 100.0% | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 1.000 | 1.000 | 100.0% | 58.4s / 58.4s | 12.0 | 58426 / 2169 |
| bm25 | 1 / 1 | 100.0% | 1.000 [1.000, 1.000] | 0.333 [0.333, 0.333] | 0.333 | 0.500 | 100.0% | 0.6s / 0.6s | 1.0 | 0 / 0 |

### swepolybench-verified

| System | Tasks / runs | Success | R@10 (95% CI) | MRR (95% CI) | MAP | nDCG@10 | Full@10 | p50 / p95 | Tools | Tokens in/out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fastcontext-low | 4 / 4 | 50.0% | 0.375 [0.000, 0.750] | 0.500 [0.000, 1.000] | 0.375 | 0.403 | 25.0% | 47.2s / 63.1s | 5.5 | 55856 / 2213 |
| fastcontext-medium | 4 / 4 | 100.0% | 0.750 [0.500, 1.000] | 0.875 [0.625, 1.000] | 0.688 | 0.750 | 50.0% | 82.2s / 115.1s | 11.0 | 135858 / 3178 |
| fastcontext-max | 4 / 4 | 50.0% | 0.375 [0.000, 0.750] | 0.375 [0.000, 0.750] | 0.313 | 0.347 | 25.0% | 56.4s / 71.6s | 12.5 | 103244 / 2402 |
| claude-code-readonly | 4 / 4 | 100.0% | 0.875 [0.625, 1.000] | 0.875 [0.625, 1.000] | 0.771 | 0.827 | 75.0% | 43.2s / 60.6s | 8.0 | 64365 / 1630 |
| opencode-explore | 4 / 4 | 100.0% | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 0.958 | 0.980 | 100.0% | 87.1s / 132.0s | 14.0 | 136958 / 2481 |
| neutral-tool-agent | 4 / 4 | 50.0% | 0.375 [0.000, 0.750] | 0.500 [0.000, 1.000] | 0.375 | 0.403 | 25.0% | 58.2s / 59.3s | 16.5 | 99365 / 2385 |
| bm25 | 4 / 4 | 100.0% | 0.625 [0.250, 1.000] | 0.417 [0.083, 0.792] | 0.396 | 0.462 | 50.0% | 0.5s / 2.1s | 1.0 | 0 / 0 |

## Language Slices

| Language | System | N | Success | R@10 | MRR | p50 |
|---|---|---:|---:|---:|---:|---:|
| Java | fastcontext-low | 1 | 100.0% | 0.500 | 1.000 | 47.2s |
| Java | fastcontext-medium | 1 | 100.0% | 0.500 | 1.000 | 115.1s |
| Java | fastcontext-max | 1 | 0.0% | 0.000 | 0.000 | 0.0s |
| Java | claude-code-readonly | 1 | 100.0% | 0.500 | 1.000 | 43.2s |
| Java | opencode-explore | 1 | 100.0% | 1.000 | 1.000 | 69.4s |
| Java | neutral-tool-agent | 1 | 0.0% | 0.000 | 0.000 | 0.0s |
| Java | bm25 | 1 | 100.0% | 1.000 | 1.000 | 1.5s |
| JavaScript | fastcontext-low | 1 | 0.0% | 0.000 | 0.000 | 0.0s |
| JavaScript | fastcontext-medium | 1 | 100.0% | 0.500 | 0.500 | 92.5s |
| JavaScript | fastcontext-max | 1 | 100.0% | 0.500 | 0.500 | 56.4s |
| JavaScript | claude-code-readonly | 1 | 100.0% | 1.000 | 0.500 | 41.5s |
| JavaScript | opencode-explore | 1 | 100.0% | 1.000 | 1.000 | 132.0s |
| JavaScript | neutral-tool-agent | 1 | 100.0% | 0.500 | 1.000 | 58.2s |
| JavaScript | bm25 | 1 | 100.0% | 0.500 | 0.167 | 0.2s |
| Python | fastcontext-low | 2 | 50.0% | 0.500 | 0.500 | 74.2s |
| Python | fastcontext-medium | 2 | 100.0% | 1.000 | 1.000 | 54.9s |
| Python | fastcontext-max | 2 | 50.0% | 0.500 | 0.500 | 71.6s |
| Python | claude-code-readonly | 2 | 100.0% | 1.000 | 1.000 | 32.0s |
| Python | opencode-explore | 2 | 100.0% | 1.000 | 1.000 | 72.7s |
| Python | neutral-tool-agent | 2 | 100.0% | 1.000 | 1.000 | 58.4s |
| Python | bm25 | 2 | 100.0% | 1.000 | 0.417 | 0.5s |
| TypeScript | fastcontext-low | 1 | 100.0% | 1.000 | 1.000 | 63.1s |
| TypeScript | fastcontext-medium | 1 | 100.0% | 1.000 | 1.000 | 82.2s |
| TypeScript | fastcontext-max | 1 | 0.0% | 0.000 | 0.000 | 0.0s |
| TypeScript | claude-code-readonly | 1 | 100.0% | 1.000 | 1.000 | 47.7s |
| TypeScript | opencode-explore | 1 | 100.0% | 1.000 | 1.000 | 87.1s |
| TypeScript | neutral-tool-agent | 1 | 0.0% | 0.000 | 0.000 | 0.0s |
| TypeScript | bm25 | 1 | 100.0% | 0.000 | 0.000 | 2.1s |

## Paired Tests

| FastContext system | Comparator | Pairs | Mean R@10 difference | Paired permutation p |
|---|---|---:|---:|---:|
| fastcontext-low | claude-code-readonly | 5 | -0.400 | 0.5029 |
| fastcontext-low | opencode-explore | 5 | -0.500 | 0.2517 |
| fastcontext-low | neutral-tool-agent | 5 | 0.000 | 1.0000 |
| fastcontext-low | bm25 | 5 | -0.200 | 0.7513 |
| fastcontext-medium | claude-code-readonly | 5 | -0.100 | 1.0000 |
| fastcontext-medium | opencode-explore | 5 | -0.200 | 0.5051 |
| fastcontext-medium | neutral-tool-agent | 5 | 0.300 | 0.4971 |
| fastcontext-medium | bm25 | 5 | 0.100 | 1.0000 |
| fastcontext-max | claude-code-readonly | 5 | -0.600 | 0.1245 |
| fastcontext-max | opencode-explore | 5 | -0.700 | 0.1264 |
| fastcontext-max | neutral-tool-agent | 5 | -0.200 | 1.0000 |
| fastcontext-max | bm25 | 5 | -0.400 | 0.5085 |

## Reliability Audit

| System / failure | Count | Example |
|---|---:|---|
| fastcontext-max:tool | 3 | matplotlib__matplotlib-22865: FastContext submission rejected: candidate lib/matplotlib/tests/test_colorbar.py:38-149 is not covered by a read_file result |
| neutral-tool-agent:tool | 2 | google__guava-3971: FastContext submission rejected: candidate guava/src/com/google/common/util/concurrent/Uninterruptibles.java:1-519 is not covered by a read_file result; covered |
| fastcontext-low:unknown | 2 | serverless__serverless-5640: FastContext exhausted its turn budget without a valid evidence map |

## Protocol

- Task: rank implementation files that require editing for a real issue at its pre-fix repository commit.
- Ground truth: non-test implementation paths changed by the human gold patch. Test paths are retained in the manifest but excluded from the primary score.
- Inputs: original issue text and repository snapshot only. Gold patches, hints, PR discussions, tests, git history, network, and editing are unavailable to agents.
- Output: at most ten ranked, read-grounded repository-relative paths. Primary metrics are Recall@10, MRR, MAP, nDCG@10, full-file coverage, success rate, and latency.
- Ordering: deterministic rotated system order for each case/repeat. JSONL journaling makes every completed run resumable and auditable.
- Statistical tests: paired random-sign permutation test on Recall@10; bootstrap confidence intervals. No uncorrected significance claim should be made across many slices.

## Dataset Provenance

- [SWE-bench Verified](https://openai.com/index/introducing-swe-bench-verified/) contains 500 human-validated tasks sampled from resolved GitHub issues and associated PRs in 12 Python repositories. OpenAI reports 93 professional Python developers, three annotations per sample, and 1,699 screened candidates.
- [SWE-PolyBench](https://github.com/amazon-science/SWE-PolyBench) contains real issue-closing PRs with executable tests. Its verified split spans Java, JavaScript, TypeScript, and Python and publishes file/CST localization metadata.
- [Agentless](https://arxiv.org/abs/2407.01489) established hierarchical file-to-symbol-to-location localization on SWE-bench. It is a method, not an independent dataset.
- [CodeRAG-Bench](https://github.com/code-rag-bench/code-rag-bench) motivates BM25/dense retrieval metrics but mixes task families; it is therefore background rather than the primary issue-localization set here.
- [RepoQA](https://github.com/evalplus/repoqa) evaluates retrieval of a described needle function from long repository context. It measures a narrower capability than issue-to-edit localization and is not pooled into the primary result.

## Validity Limits

- Gold patch files are a defensible but incomplete relevance judgment: an alternative valid fix may touch different files, and incidental human edits can create false-positive gold paths.
- Public GitHub tasks can appear in model training data. This experiment measures scaffolded retrieval on public tasks, not contamination-free generalization.
- Claude Code uses its default agent with only Glob/Grep/Read enabled and enters a disclosed local Anthropic Messages to OpenAI Responses bridge. FastContext uses OpenAI Responses and OpenCode uses OpenAI-compatible Chat.
- CLI systems include different proprietary/default system prompts. Equal model, task, permissions, and output contract do not make token budgets or internal instructions identical.
- SWE-bench Verified is Python-only; cross-language conclusions require the SWE-PolyBench slice and should be reported separately.

## Reproduction

```powershell
npm run benchmark:retrieval-paper -- prepare --per-dataset 100 --seed 20260722
npm run benchmark:retrieval-paper -- run --limit 100 --repeats 3 --systems fastcontext-medium,claude-code-readonly,opencode-explore,bm25
npm run benchmark:retrieval-paper -- run --limit 30 --repeats 1 --systems fastcontext-low,fastcontext-medium,fastcontext-max,neutral-tool-agent,bm25 --output benchmark-results/2026-07-22-gpt-5.5-paper-ablation
npm run benchmark:retrieval-paper -- report
```
