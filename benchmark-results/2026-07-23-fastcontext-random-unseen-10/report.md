# FastContext Repository Retrieval Benchmark

- Experiment: `2026-07-23-gpt-5.5-no-reasoning-formal`
- Model: `gpt-5.5`; native reasoning disabled for every LLM system
- Completed runs: 10/10
- Dataset cases: 10; repositories: 9; languages: Java, JavaScript, Python, TypeScript
- Repository snapshots processed: 0.02M files, 0.15 GiB (counts include repeated base commits)
- Per-run timeout: 300s; repeats: 1; seed: 20260722
- Manifest SHA-256: `fd07bcd5d9e354fa8c0492ff1a26de2d95495e9c5f238cc9f700a64bc866e74c`

**Status:** complete formal matrix.

## Primary Results

| System | Tasks / runs | Success | R@10 (95% CI) | MRR (95% CI) | MAP | nDCG@10 | Full@10 | p50 / p95 | Tools | Tokens in/out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fastcontext | 10 / 10 | 100.0% | 0.873 [0.687, 1.000] | 0.950 [0.850, 1.000] | 0.790 | 0.848 | 80.0% | 81.5s / 146.7s | 70.0 | 25527 / 4550 |

Scores include failures and timeouts as zero. Repeats are averaged within each task before 10,000-sample bootstrap confidence intervals are computed across tasks; latency and token means use successful runs only.

## Dataset Slices

### swepolybench-verified

| System | Tasks / runs | Success | R@10 (95% CI) | MRR (95% CI) | MAP | nDCG@10 | Full@10 | p50 / p95 | Tools | Tokens in/out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fastcontext | 5 / 5 | 100.0% | 0.747 [0.480, 1.000] | 1.000 [1.000, 1.000] | 0.680 | 0.771 | 60.0% | 97.2s / 145.8s | 71.8 | 27360 / 4699 |

### swebench-verified

| System | Tasks / runs | Success | R@10 (95% CI) | MRR (95% CI) | MAP | nDCG@10 | Full@10 | p50 / p95 | Tools | Tokens in/out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fastcontext | 5 / 5 | 100.0% | 1.000 [1.000, 1.000] | 0.900 [0.700, 1.000] | 0.900 | 0.926 | 100.0% | 81.5s / 146.7s | 68.2 | 23694 / 4400 |

## Language Slices

| Language | System | N | Success | R@10 | MRR | p50 |
|---|---|---:|---:|---:|---:|---:|
| Java | fastcontext | 1 | 100.0% | 1.000 | 1.000 | 145.8s |
| JavaScript | fastcontext | 2 | 100.0% | 0.667 | 1.000 | 76.2s |
| Python | fastcontext | 6 | 100.0% | 1.000 | 0.917 | 69.1s |
| TypeScript | fastcontext | 1 | 100.0% | 0.400 | 1.000 | 126.8s |

## Paired Tests

| FastContext system | Comparator | Pairs | Mean R@10 difference | Paired permutation p |
|---|---|---:|---:|---:|

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
