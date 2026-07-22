# FastContext Retrieval Benchmark Protocol

## Research question

Does FastContext locate the implementation files required by real repository issues more accurately, reliably, or efficiently than representative coding-agent retrieval loops when the endpoint, model, reasoning setting, repository snapshot, task text, permissions, timeout, and output contract are controlled?

## Datasets

The primary Python set is [SWE-bench Verified](https://openai.com/index/introducing-swe-bench-verified/). Its 500 tasks originate from resolved GitHub issues and associated pull requests in 12 open-source Python repositories. OpenAI and the SWE-bench authors screened 1,699 candidates with 93 Python developers, three independent annotations per task, and retained 500 well-specified, testable cases.

The cross-language set is [SWE-PolyBench Verified](https://github.com/amazon-science/SWE-PolyBench). It contains executable issue-closing pull requests from Java, JavaScript, TypeScript, and Python projects and publishes file-level and concrete-syntax-tree change metadata.

The benchmark manifest stores only the issue, repository, base commit, metadata, and paths derived from the gold patch. Agents never receive the patch, test patch, hints, pull-request discussion, or gold paths.

## Systems

- FastContext `low`, `medium`, and `max` measure its coverage-depth tradeoff.
- Claude Code read-only measures its default production agent loop with only Glob, Grep, and Read enabled. Its `--agent Explore` route cannot use the configured `gpt-5.5` channel, so it is not mislabeled as an Explore result.
- OpenCode measures a production open-source agent loop under a custom read-only policy.
- Neutral Tool Agent uses TurboFlux's tool transport with a minimal localization prompt, isolating FastContext's retrieval policy from the shared runtime.
- BM25 is a deterministic non-LLM lexical baseline over repository file paths and source text.

All LLM systems use the active TurboFlux API endpoint, `gpt-5.5`, and disabled native reasoning. Claude Code uses Anthropic Messages, FastContext negotiates the configured TurboFlux protocol, and OpenCode uses OpenAI-compatible Chat. The protocol is recorded rather than hidden because relay conversion can affect latency and compatibility.

## Task and truth

Each system receives the original issue text and a read-only checkout of the repository's pre-fix base commit. It returns up to ten ranked implementation files that it read and considers necessary to edit.

Primary relevance judgments are non-test implementation files modified by the human gold patch. Test paths remain in the manifest for secondary analysis. Documentation-only and test-only tasks are excluded during manifest construction.

Gold patches are not perfect relevance judgments: alternate valid fixes may touch different files, and a human patch may include incidental edits. Results therefore support comparative localization claims, not proof that every non-gold path is irrelevant.

## Metrics

Primary metrics are Recall@10 and MRR. Secondary metrics are Recall@1/3/5, Precision@5, MAP, nDCG@10, complete gold-file coverage, protocol success, timeout rate, p50/p95 latency, tool calls, API calls, retries, and token usage.

Failures and timeouts score zero in end-to-end quality metrics. Latency and token summaries are additionally reported on successful runs. Reports use 10,000-sample nonparametric bootstrap 95% confidence intervals and paired random-sign permutation tests. Dataset and language slices remain separate.

## Experimental controls

- Three repeated runs per LLM system are the default formal protocol. Metrics are averaged within task before task-level bootstrap or paired tests, avoiding pseudo-replication.
- BM25 is deterministic and runs once per task.
- System ordering rotates deterministically across case and repeat.
- Every completed run is appended to a resumable JSONL journal.
- Repository snapshots are materialized from immutable base commits in a dedicated cache.
- Network, git history, tests, edits, and external agents are denied during retrieval.
- API keys are provided only through process environment or in-memory configuration and are redacted before persistence.

## Validity threats

- Public GitHub issues may be present in model training data.
- CLI system prompts and internal token budgets are not identical even when the user task is controlled.
- SWE-bench Verified is Python-only and overrepresents several repositories.
- Protocol conversion at a relay can change caching, latency, and unsupported-parameter behavior.
- Repeated stochastic runs on a single endpoint do not measure provider-to-provider variance.

## Commands

Generate fixed data splits before further tuning. Any case found in an existing `runs.jsonl` is assigned to the contaminated split and excluded from development and holdout data. The 24-case generalization split may guide architecture work; the 100-case holdout must remain uninspected until implementation freeze and must never be used for per-case tuning.

```powershell
npm run benchmark:retrieval-splits
```

```powershell
npm run benchmark:retrieval-paper -- prepare --per-dataset 100 --seed 20260722
npm run benchmark:retrieval-paper -- calibrate --limit 6 --repeats 1
npm run benchmark:retrieval-paper -- run --manifest benchmark-data/retrieval-paper-v1/splits/holdout-test-manifest.json --limit 100 --repeats 3 --systems fastcontext,claude-code-readonly,opencode-explore,bm25
npm run benchmark:retrieval-paper -- report
```
