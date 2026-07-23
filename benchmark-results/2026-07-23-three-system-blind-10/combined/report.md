# FastContext Repository Retrieval Benchmark

- Experiment: `2026-07-23-gpt-5.5-no-reasoning-formal`
- Model: `gpt-5.5`; native reasoning disabled for every LLM system
- Completed runs: 30/30
- Dataset cases: 10; repositories: 10; languages: Java, JavaScript, Python, TypeScript
- Repository snapshots processed: 0.02M files, 0.51 GiB (counts include repeated base commits)
- Per-run timeout: 240s; repeats: 1; seed: 20260722
- Manifest SHA-256: `a78acc519758204671c95cf2a11950abdbb24fad86a9697b995be3614942f690`

**Status:** complete formal matrix.

## Primary Results

| System | Tasks / runs | Success | R@10 (95% CI) | MRR (95% CI) | MAP | nDCG@10 | Full@10 | p50 / p95 | Tools | Tokens in/out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fastcontext | 10 / 10 | 100.0% | 0.575 [0.300, 0.850] | 0.633 [0.333, 0.900] | 0.542 | 0.570 | 50.0% | 57.6s / 86.6s | 33.7 | 8844 / 1317 |
| claude-code-readonly | 10 / 10 | 100.0% | 0.925 [0.775, 1.000] | 0.808 [0.608, 1.000] | 0.741 | 0.803 | 90.0% | 82.8s / 149.8s | 12.0 | 42732 / 1881 |
| opencode-explore | 10 / 10 | 80.0% | 0.775 [0.500, 1.000] | 0.675 [0.400, 0.925] | 0.618 | 0.675 | 70.0% | 198.3s / 238.8s | 13.6 | 92363 / 2311 |

Scores include failures and timeouts as zero. Repeats are averaged within each task before 10,000-sample bootstrap confidence intervals are computed across tasks; latency and token means use successful runs only.

## Dataset Slices

### swepolybench-verified

| System | Tasks / runs | Success | R@10 (95% CI) | MRR (95% CI) | MAP | nDCG@10 | Full@10 | p50 / p95 | Tools | Tokens in/out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fastcontext | 8 / 8 | 100.0% | 0.594 [0.281, 0.875] | 0.667 [0.333, 0.917] | 0.552 | 0.587 | 50.0% | 68.1s / 86.6s | 34.0 | 8896 / 1400 |
| claude-code-readonly | 8 / 8 | 100.0% | 0.906 [0.719, 1.000] | 0.760 [0.542, 0.938] | 0.676 | 0.753 | 87.5% | 90.8s / 149.8s | 13.0 | 46902 / 1981 |
| opencode-explore | 8 / 8 | 87.5% | 0.844 [0.594, 1.000] | 0.719 [0.438, 0.938] | 0.648 | 0.719 | 75.0% | 212.3s / 238.8s | 13.7 | 92528 / 2385 |

### swebench-verified

| System | Tasks / runs | Success | R@10 (95% CI) | MRR (95% CI) | MAP | nDCG@10 | Full@10 | p50 / p95 | Tools | Tokens in/out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fastcontext | 2 / 2 | 100.0% | 0.500 [0.000, 1.000] | 0.500 [0.000, 1.000] | 0.500 | 0.500 | 50.0% | 45.9s / 52.6s | 32.5 | 8634 / 986 |
| claude-code-readonly | 2 / 2 | 100.0% | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 1.000 | 1.000 | 100.0% | 63.9s / 75.9s | 8.0 | 26055 / 1482 |
| opencode-explore | 2 / 2 | 50.0% | 0.500 [0.000, 1.000] | 0.500 [0.000, 1.000] | 0.500 | 0.500 | 50.0% | 144.2s / 144.2s | 13.0 | 91207 / 1795 |

## Language Slices

| Language | System | N | Success | R@10 | MRR | p50 |
|---|---|---:|---:|---:|---:|---:|
| Java | fastcontext | 2 | 100.0% | 1.000 | 1.000 | 46.3s |
| Java | claude-code-readonly | 2 | 100.0% | 1.000 | 1.000 | 45.9s |
| Java | opencode-explore | 2 | 100.0% | 1.000 | 1.000 | 154.1s |
| JavaScript | fastcontext | 2 | 100.0% | 0.625 | 1.000 | 83.7s |
| JavaScript | claude-code-readonly | 2 | 100.0% | 0.625 | 0.375 | 90.8s |
| JavaScript | opencode-explore | 2 | 100.0% | 0.875 | 0.375 | 212.3s |
| Python | fastcontext | 4 | 100.0% | 0.250 | 0.250 | 48.2s |
| Python | claude-code-readonly | 4 | 100.0% | 1.000 | 0.833 | 75.9s |
| Python | opencode-explore | 4 | 50.0% | 0.500 | 0.500 | 144.2s |
| TypeScript | fastcontext | 2 | 100.0% | 0.750 | 0.667 | 57.6s |
| TypeScript | claude-code-readonly | 2 | 100.0% | 1.000 | 1.000 | 93.3s |
| TypeScript | opencode-explore | 2 | 100.0% | 1.000 | 1.000 | 170.7s |

## Paired Tests

| FastContext system | Comparator | Pairs | Mean R@10 difference | Paired permutation p |
|---|---|---:|---:|---:|
| fastcontext | claude-code-readonly | 10 | -0.350 | 0.1228 |
| fastcontext | opencode-explore | 10 | -0.200 | 0.4433 |

## Reliability Audit

| System / failure | Count | Example |
|---|---:|---|
| opencode-explore:unknown | 2 | Significant-Gravitas__AutoGPT-4652: [91m[1mError: [0mUnexpected error

Failed to execute statement |

## Protocol

- Task: rank implementation files that require editing for a real issue at its pre-fix repository commit.
- Ground truth: non-test implementation paths changed by the human gold patch. Test paths are retained in the manifest but excluded from the primary score.
- Inputs: original issue text and repository snapshot only. Gold patches, hints, PR discussions, tests, git history, network, and editing are unavailable to agents.
- Output: at most ten ranked, read-grounded repository-relative paths. Primary metrics are Recall@10, MRR, MAP, nDCG@10, full-file coverage, success rate, and latency.
- Ordering: three isolated system runners launched concurrently against the same frozen manifest. JSONL journaling makes every completed run resumable and auditable.
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
npm run benchmark:retrieval-paper -- run --manifest benchmark-results/2026-07-23-three-system-blind-10/manifest.json --limit 10 --repeats 1 --systems <one-system> --concurrency 4 --timeout-seconds 240
npm run benchmark:retrieval-paper -- report --output benchmark-results/2026-07-23-three-system-blind-10/combined
```
