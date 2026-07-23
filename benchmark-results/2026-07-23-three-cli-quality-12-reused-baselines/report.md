# FastContext Repository Retrieval Benchmark

- Experiment: `2026-07-23-gpt-5.5-no-reasoning-formal`
- Model: `gpt-5.5`; native reasoning disabled for every LLM system
- Completed runs: 36/36
- Dataset cases: 12; repositories: 12; languages: Java, JavaScript, Python, TypeScript
- Repository snapshots processed: 0.04M files, 0.49 GiB (counts include repeated base commits)
- Per-run timeout: 300s; repeats: 1; seed: 20260722
- Manifest SHA-256: `b719c4203526187f5a9ec08837ac00909b46db6faa7d4fb7eaf4f0a143884423`

**Status:** complete formal matrix.

## Primary Results

| System | Tasks / runs | Success | R@10 (95% CI) | MRR (95% CI) | MAP | nDCG@10 | Full@10 | p50 / p95 | Tools | Tokens in/out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fastcontext | 12 / 12 | 100.0% | 0.722 [0.472, 0.944] | 0.771 [0.521, 1.000] | 0.615 | 0.674 | 66.7% | 133.1s / 160.0s | 74.4 | 19408 / 1805 |
| claude-code-readonly | 12 / 12 | 100.0% | 0.833 [0.639, 1.000] | 0.833 [0.625, 1.000] | 0.744 | 0.789 | 75.0% | 59.7s / 131.4s | 8.2 | 33936 / 1565 |
| opencode-explore | 12 / 12 | 58.3% | 0.556 [0.278, 0.833] | 0.583 [0.333, 0.833] | 0.522 | 0.549 | 50.0% | 166.2s / 278.0s | 10.4 | 65218 / 2007 |

Scores include failures and timeouts as zero. Repeats are averaged within each task before 10,000-sample bootstrap confidence intervals are computed across tasks; latency and token means use successful runs only.

## Dataset Slices

### swebench-verified

| System | Tasks / runs | Success | R@10 (95% CI) | MRR (95% CI) | MAP | nDCG@10 | Full@10 | p50 / p95 | Tools | Tokens in/out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fastcontext | 6 / 6 | 100.0% | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 1.000 | 1.000 | 100.0% | 135.0s / 155.6s | 84.3 | 22210 / 1740 |
| claude-code-readonly | 6 / 6 | 100.0% | 1.000 [1.000, 1.000] | 0.833 [0.667, 1.000] | 0.833 | 0.877 | 100.0% | 53.0s / 131.4s | 6.3 | 32399 / 1249 |
| opencode-explore | 6 / 6 | 66.7% | 0.667 [0.333, 1.000] | 0.667 [0.333, 1.000] | 0.667 | 0.667 | 66.7% | 166.2s / 278.0s | 9.5 | 67856 / 1826 |

### swepolybench-verified

| System | Tasks / runs | Success | R@10 (95% CI) | MRR (95% CI) | MAP | nDCG@10 | Full@10 | p50 / p95 | Tools | Tokens in/out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fastcontext | 6 / 6 | 100.0% | 0.444 [0.111, 0.778] | 0.542 [0.167, 0.875] | 0.230 | 0.348 | 33.3% | 122.0s / 160.0s | 64.5 | 16607 / 1870 |
| claude-code-readonly | 6 / 6 | 100.0% | 0.667 [0.333, 0.944] | 0.833 [0.500, 1.000] | 0.654 | 0.702 | 50.0% | 59.7s / 121.9s | 10.0 | 35474 / 1880 |
| opencode-explore | 6 / 6 | 50.0% | 0.444 [0.111, 0.833] | 0.500 [0.167, 0.833] | 0.378 | 0.431 | 33.3% | 148.7s / 183.0s | 11.7 | 61700 / 2249 |

## Language Slices

| Language | System | N | Success | R@10 | MRR | p50 |
|---|---|---:|---:|---:|---:|---:|
| Java | fastcontext | 2 | 100.0% | 0.167 | 0.500 | 40.7s |
| Java | claude-code-readonly | 2 | 100.0% | 1.000 | 1.000 | 49.7s |
| Java | opencode-explore | 2 | 50.0% | 0.500 | 0.500 | 67.8s |
| JavaScript | fastcontext | 2 | 100.0% | 0.667 | 1.000 | 69.6s |
| JavaScript | claude-code-readonly | 2 | 100.0% | 0.500 | 1.000 | 40.1s |
| JavaScript | opencode-explore | 2 | 50.0% | 0.333 | 0.500 | 148.7s |
| Python | fastcontext | 7 | 100.0% | 0.857 | 0.857 | 135.0s |
| Python | claude-code-readonly | 7 | 100.0% | 1.000 | 0.857 | 59.7s |
| Python | opencode-explore | 7 | 71.4% | 0.714 | 0.714 | 180.6s |
| TypeScript | fastcontext | 1 | 100.0% | 1.000 | 0.250 | 122.0s |
| TypeScript | claude-code-readonly | 1 | 100.0% | 0.000 | 0.000 | 121.9s |
| TypeScript | opencode-explore | 1 | 0.0% | 0.000 | 0.000 | 0.0s |

## Paired Tests

| FastContext system | Comparator | Pairs | Mean R@10 difference | Paired permutation p |
|---|---|---:|---:|---:|
| fastcontext | claude-code-readonly | 12 | -0.111 | 0.6253 |
| fastcontext | opencode-explore | 12 | 0.167 | 0.5302 |

## Reliability Audit

| System / failure | Count | Example |
|---|---:|---|
| opencode-explore:timeout | 5 | django__django-12193: Timed out after 300000ms |

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
npm run benchmark:retrieval-paper -- run --manifest benchmark-data/retrieval-paper-v1/splits/holdout-test-manifest.json --limit 100 --repeats 3 --systems fastcontext,claude-code-readonly,opencode-explore,bm25
npm run benchmark:retrieval-paper -- report
```
