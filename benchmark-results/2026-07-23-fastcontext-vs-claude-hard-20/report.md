# FastContext Repository Retrieval Benchmark

- Experiment: `2026-07-23-gpt-5.5-no-reasoning-formal`
- Model: `gpt-5.5`; native reasoning disabled for every LLM system
- Completed runs: 40/40
- Dataset cases: 20; repositories: 12; languages: Java, JavaScript, Python, TypeScript
- Repository snapshots processed: 0.11M files, 0.62 GiB (counts include repeated base commits)
- Per-run timeout: 300s; repeats: 1; seed: 20260722
- Manifest SHA-256: `ca070e61702aad369017bfbebc156c94162142dd31e2a480e53e968c9723f6e3`

**Status:** complete formal matrix.

## Primary Results

| System | Tasks / runs | Success | R@10 (95% CI) | MRR (95% CI) | MAP | nDCG@10 | Full@10 | p50 / p95 | Tools | Tokens in/out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fastcontext | 20 / 20 | 100.0% | 0.700 [0.525, 0.858] | 0.713 [0.537, 0.875] | 0.537 | 0.623 | 55.0% | 101.5s / 178.5s | 67.7 | 23680 / 3903 |
| claude-code-readonly | 20 / 20 | 100.0% | 0.761 [0.597, 0.903] | 0.875 [0.725, 1.000] | 0.728 | 0.771 | 65.0% | 71.4s / 245.2s | 11.3 | 56191 / 1826 |

Scores include failures and timeouts as zero. Repeats are averaged within each task before 10,000-sample bootstrap confidence intervals are computed across tasks; latency and token means use successful runs only.

## Dataset Slices

### swepolybench-verified

| System | Tasks / runs | Success | R@10 (95% CI) | MRR (95% CI) | MAP | nDCG@10 | Full@10 | p50 / p95 | Tools | Tokens in/out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fastcontext | 13 / 13 | 100.0% | 0.538 [0.333, 0.744] | 0.596 [0.365, 0.808] | 0.346 | 0.458 | 30.8% | 106.1s / 192.6s | 65.9 | 23216 / 4058 |
| claude-code-readonly | 13 / 13 | 100.0% | 0.632 [0.427, 0.833] | 0.808 [0.577, 1.000] | 0.581 | 0.648 | 46.2% | 75.5s / 296.0s | 13.2 | 58615 / 2075 |

### swebench-verified

| System | Tasks / runs | Success | R@10 (95% CI) | MRR (95% CI) | MAP | nDCG@10 | Full@10 | p50 / p95 | Tools | Tokens in/out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fastcontext | 7 / 7 | 100.0% | 1.000 [1.000, 1.000] | 0.929 [0.786, 1.000] | 0.893 | 0.930 | 100.0% | 82.6s / 151.8s | 70.9 | 24542 / 3616 |
| claude-code-readonly | 7 / 7 | 100.0% | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 1.000 | 1.000 | 100.0% | 71.4s / 129.5s | 7.9 | 51691 / 1363 |

## Language Slices

| Language | System | N | Success | R@10 | MRR | p50 |
|---|---|---:|---:|---:|---:|---:|
| Java | fastcontext | 3 | 100.0% | 0.667 | 0.250 | 95.9s |
| Java | claude-code-readonly | 3 | 100.0% | 0.667 | 0.667 | 203.4s |
| JavaScript | fastcontext | 3 | 100.0% | 0.778 | 0.833 | 116.8s |
| JavaScript | claude-code-readonly | 3 | 100.0% | 0.667 | 0.667 | 55.7s |
| Python | fastcontext | 9 | 100.0% | 0.852 | 0.833 | 74.7s |
| Python | claude-code-readonly | 9 | 100.0% | 0.963 | 0.944 | 71.5s |
| TypeScript | fastcontext | 5 | 100.0% | 0.400 | 0.700 | 115.2s |
| TypeScript | claude-code-readonly | 5 | 100.0% | 0.511 | 1.000 | 67.5s |

## Paired Tests

| FastContext system | Comparator | Pairs | Mean R@10 difference | Paired permutation p |
|---|---|---:|---:|---:|
| fastcontext | claude-code-readonly | 20 | -0.061 | 0.5020 |

## Reliability Audit

| System / failure | Count | Example |
|---|---:|---|
| none | 0 | - |

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
