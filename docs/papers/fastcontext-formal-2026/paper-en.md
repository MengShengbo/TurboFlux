# FastContext: Model-Led Adaptive Retrieval for Repository-Level Code Localization

**Manuscript status:** Methods and protocol are frozen; quantitative results will be inserted only after the formal experiment completes.  
**FastContext implementation:** `bf5d517c4e8cd94438f304e0895c097ec3612585`  
**Experiment harness:** `3fc9699bd1ba79011841ee66a21c68121727a1b1`

## Abstract

Repository-level code localization maps a natural-language maintenance request to the implementation files most likely to require modification. Fast lexical or graph-based retrieval often fails on indirect ownership, cross-layer propagation, and semantically underspecified issues, while unconstrained language-model exploration incurs high tail latency, repeated tool calls, context growth, and weakly grounded outputs. We present FastContext, a model-led, deterministically executed, and evidence-constrained retrieval system. The language model is responsible for semantic query reformulation, next-hop selection, frontier-completeness judgments, stopping, and final ranking. A local execution layer performs parallel search and reading, symbol tracing, exact-call caching, wave-level progress accounting, and mechanical evidence validation. Candidates are submitted through a structured code-map contract in which every cited line range must be covered by a file read from the same run; raw tool history remains isolated from the parent agent context. We evaluate FastContext against Claude Code read-only exploration and OpenCode Explore under a controlled, same-model, reasoning-disabled setting. The study comprises a 200-task main matrix drawn from SWE-bench Verified and SWE-PolyBench Verified and a 100-task, three-repeat confirmatory matrix. The completed manuscript will report retrieval quality, latency, cost, reliability, repeat stability, and stratified analyses. This pre-results version makes no quantitative superiority claim.

**Keywords:** repository-level retrieval; code localization; software engineering agents; tool-augmented language models; adaptive stopping; evidence grounding

## 1. Introduction

Software maintenance requests rarely identify their implementation owner directly. A user-visible symptom may originate in configuration parsing, protocol adaptation, state propagation, framework extension points, or synchronized implementations across several packages. Consequently, repository-level localization is not ordinary document retrieval. It is a constrained causal search from an issue description to a ranked edit set.

An effective localization system must solve several coupled decisions: translate symptoms into executable queries, follow definitions and consumers after the first hit, determine whether the edit frontier is complete, stop without either premature closure or redundant exploration, and ensure that the final ranking is supported by inspected source. Static lexical, embedding, and graph retrieval can produce candidates quickly, but cannot reliably decide which semantic branch should be followed next. General tool-using agents can revise their search dynamically, but often pay for that flexibility through redundant calls, long tool transcripts, and variable stopping behavior.

FastContext starts from a separation-of-responsibility hypothesis: semantic decisions that determine the search direction should remain model-controlled, while deterministic work should be executed, parallelized, cached, and verified locally. The result is a bounded plan-execute-feedback-submit loop rather than either a wrapped static retriever or an open-ended Explore agent.

This paper makes five contributions:

1. A repository-localization architecture with an auditable boundary between model-owned semantic control and deterministic local execution.
2. An adaptive stopping contract based on concrete unresolved paths or symbols that may still change the ranked edit set.
3. Batched symbol tracing, exact successful-call caching, and wave-delta feedback that reduce redundant low-information actions without replacing semantic planning.
4. A read-evidence ledger and structured code-map submission protocol that reject uninspected candidates and relationships.
5. A frozen 1,500-run evaluation that controls the model, reasoning setting, permissions, timeout, and task corpus across FastContext, Claude Code, and OpenCode.

## 2. Problem Formulation

Given a repository snapshot \(R\), a natural-language maintenance objective \(q\), and its implementation-file universe \(F\), a localization system returns an ordered list \(L_k(q,R)\) of at most \(k\) files. The benchmark provides the historical patch file set \(G \subseteq F\). The objective is to maximize coverage and ranking quality under bounded latency and inference cost.

We evaluate Recall@\(k\), reciprocal rank, mean average precision, nDCG@10, and full coverage within the first ten results. Failures and timeouts contribute zero to quality aggregates. We separately report success, timeout, latency, request, tool-call, and token metrics so that a system cannot appear accurate by excluding unreliable runs.

FastContext produces an edit-oriented code map rather than an unconstrained relevance list. Each candidate describes its role, patch probability, causal distance, and expected change effect. Candidate and relationship line ranges must be covered by source read during the same run. A run may expose unresolved edit paths, but it may not represent unread guesses as verified evidence.

## 3. Related Work

### 3.1 Repository-Level Retrieval

RepoCoder demonstrated that iterative retrieval improves repository-level completion over a single retrieval pass [@zhang2023repocoder]. Repoformer studied selective retrieval and the value of avoiding unnecessary context [@wu2024repoformer]. CodeRAG-Bench showed that retrieval quality and query formulation materially affect code-generation outcomes [@wang2024coderagbench]. FastContext differs in its target: issue-driven edit localization with dynamic semantic control and a grounded final submission contract.

### 3.2 Tool-Using Software Agents

ReAct established an interleaved reasoning-and-action pattern for language-model agents [@yao2023react], while Toolformer investigated learned tool use [@schick2023toolformer]. AutoCodeRover and Agentless explored contrasting agentic and simplified workflows for software repair [@zhang2024autocoderover; @xia2024agentless]. Production coding assistants also expose read-only exploration and delegated subtask mechanisms [@anthropicclaudecode; @opencode]. FastContext isolates the pre-edit retrieval stage and optimizes it as a distinct systems problem.

### 3.3 Selective Retrieval and Graph Guidance

Self-RAG couples retrieval with model-driven critique and retrieval decisions [@asai2024selfrag]. Graph-guided localization methods use symbol, call, and structural relationships to shorten long dependency chains. FastContext can consume symbol or graph-backed execution tools, but the graph does not own the control policy: the model decides which symbol to trace, whether a result changes the frontier, and when the evidence is sufficient.

### 3.4 Evaluation Corpora

SWE-bench introduced repository snapshots paired with real GitHub issues and patches [@jimenez2024swebench]. SWE-bench Verified improves task validity through human review, and SWE-PolyBench Verified broadens the language and repository distribution [@swebenchverified; @swepolybenchverified]. We derive file-level localization labels from historical implementation changes and evaluate retrieval independently from patch synthesis.

## 4. System Design

### 4.1 Retrieval Loop

FastContext executes as an isolated subagent. Its input consists of the maintenance objective and a compact workspace description. Its output is a `fast_context_pack` containing the run status, a grounded ranked code map, evidence ranges, and unresolved items. Raw search and tool transcripts do not enter the parent agent context.

Each run follows a bounded loop:

1. The model forms a retrieval frontier from the objective, workspace structure, and accumulated evidence.
2. It selects one or more search, file-discovery, symbol-tracing, or read actions.
3. The local layer executes the wave concurrently and reuses exact successful calls.
4. The model receives tool outputs plus a mechanical delta describing newly read paths, newly discovered paths, new evidence ranges, repeats, empty results, and errors.
5. The model either names a concrete unresolved path or symbol through its next action, or submits the ranked code map.
6. A validator rejects submissions whose candidates or relationships are not covered by read evidence.

The implementation permits at most eight provider turns and eight parallel tool calls per wave. These are safety ceilings, not a prescribed search depth; easy tasks may terminate earlier.

### 4.2 Responsibility Boundary

The language model owns decisions whose errors change semantic search direction: query reformulation, ownership and consumer interpretation, next-hop selection, frontier completeness, ranking, stopping, and explicit failure. The deterministic layer owns content and path search, range reading, symbol tracing, parallel scheduling, exact-call caching, evidence-ledger maintenance, schema validation, and progress accounting.

This split addresses two symmetric failure modes. Local heuristics that decide relevance from lexical frequency or fixed rules create blind spots for indirect owners and short issue descriptions. Conversely, asking a language model to perform enumeration, deduplication, cache bookkeeping, and range coverage consumes requests and introduces avoidable mechanical errors.

### 4.3 Retrieval Tools

The available tools are `search_content`, `search_files`, `trace_symbol`, `trace_symbols`, `read_file`, and `submit_code_map`. `trace_symbols` resolves two to four concrete symbols concurrently within one frontier. It is not an unbounded graph traversal: the model must identify symbols from the objective or newly read source before the execution layer follows them.

### 4.4 Adaptive Stopping

A fixed retrieval depth wastes work on simple tasks and truncates difficult ones. FastContext instead asks whether a concrete unread path or unresolved symbol still has meaningful probability of changing the ranked edit set. Continuing only to increase confidence, collect generic examples, or inspect neighboring tests is discouraged unless the latest source exposes a specific next hop.

After every wave, the controller reports mechanical novelty and failures. A no-novelty or exact-repeat wave is evidence in favor of stopping, but it is not itself a semantic decision. The model remains responsible for relating that signal to the task and the current edit frontier.

### 4.5 Exact-Call Caching and Transcript Compaction

Cache keys combine the tool name with normalized arguments. Only successful results are cached; errors, timeouts, and incomplete outputs are never reused. Cache hits remain explicit in the transcript and do not count as new evidence.

Older tool output is compacted as the run grows, while the two most recent waves remain intact. Before finalization, FastContext materializes a read-evidence ledger containing paths and covered ranges. Submission validation depends on this ledger rather than on lossy natural-language summaries.

### 4.6 Grounded Code-Map Submission

`submit_code_map` must be issued alone. Candidate records encode path, range, role, and ranking evidence; relationship records identify their evidence location. Every submitted range must be covered by `read_file` in the current run. If a known high-probability edit path remains unread, the model must retrieve it or expose the frontier as unresolved rather than claiming completeness.

This contract cannot prove that a candidate is semantically correct. It does eliminate a mechanically detectable class of unsupported citations and gives the parent agent a compact, inspectable starting point for editing.

## 5. Experimental Method

### 5.1 Research Questions

- **RQ1, retrieval quality:** Does FastContext improve coverage and ranking of historical implementation files under a controlled model setting?
- **RQ2, efficiency:** How do end-to-end latency, model requests, tool calls, and token use compare with general exploration agents?
- **RQ3, reliability:** How frequently do the systems time out or fail through protocol, tool, model, or output-contract errors?
- **RQ4, generalization:** Are results stable across datasets, languages, repositories, task categories, gold-set sizes, and observed retrieval-chain complexity?
- **RQ5, repeatability:** How much do quality, ranking, and cost vary across three repetitions of the same task?

### 5.2 Corpus

The main matrix contains 200 tasks: 100 from SWE-bench Verified and 100 from SWE-PolyBench Verified. It covers Python, Java, JavaScript, and TypeScript repositories and preserves each task's repository, base commit, issue text, and historical modified files. A frozen 100-task subset forms the confirmatory matrix, in which each system is run three times.

Gold paths are derived from historical patch files. Dataset preparation fixes the treatment of tests, generated artifacts, and non-source changes. Because public tasks may be present in model training data and some cases were inspected during earlier engineering work, the confirmatory matrix is disclosed as a frozen public-task evaluation rather than a strictly unseen benchmark.

### 5.3 Systems and Controls

We compare FastContext, Claude Code in a read-only localization protocol, and OpenCode Explore. All systems use the same API profile and `gpt-5.5` model with native reasoning disabled. They may read and search repository contents but may not edit files, execute tests, or obtain answers from the network. Each run has a 600-second hard timeout and up to three retries for transient failures. System order rotates by case.

The main matrix contains 600 runs; the confirmatory matrix contains 900 runs, for 1,500 planned executions. Case-level concurrency is capped at 25 and begins at four. A pressure controller reduces concurrency on rate limits, timeouts, or latency inflation and increases it after stable windows. Concurrency changes throughput but not the per-run task or permissions.

### 5.4 Metrics

Quality metrics are Recall@1/3/5/10, Precision@5, MRR, MAP, nDCG@10, and Full@10. Reliability metrics include success and timeout rates and failures classified as protocol, authentication, rate limit, model, tool, output contract, repository, or unknown. Efficiency metrics include end-to-end p50/p95 latency, API duration, requests, retries, search calls, read calls, total tool calls, input/output/cache/reasoning tokens, and cost where available.

Failures and timeouts receive zero quality. Efficiency is reported both for all planned runs and for successful runs where appropriate. Repeated observations are first averaged within task; they are not treated as independent tasks.

### 5.5 Statistical Analysis

The task is the unit of analysis. We compute 95% confidence intervals with 10,000 bootstrap resamples. Pairwise system comparisons use paired permutation tests and report mean differences, win/loss/tie counts, and effect sizes. Recall@10 is the prespecified primary quality metric. The final manuscript will state the multiple-comparison correction used for secondary metrics and comparisons. Repeat stability is measured with within-task dispersion and ranking consistency.

### 5.6 Reproducibility

The study freezes the FastContext commit, harness commit, manifest SHA-256, model, reasoning setting, CLI versions, random seed, timeout, and concurrency policy. Each completed run is appended immediately to a JSONL journal. Resumption deduplicates by `runId`; missing and failed runs are not silently removed. The artifact package will include per-case and aggregate CSV/JSON files, figure data, failure audits, experiment metadata, and the scripts used to reconstruct all tables and figures.

## 6. Results

> **Pending formal data.** This section accepts values only from `build-formal-retrieval-paper-data.ts` after both formal matrices are complete. No aggregate superiority statement is generated from partial data.

### 6.1 Overall Retrieval Quality

Pending Recall@10, MRR, MAP, nDCG@10, Full@10, confidence intervals, and paired tests for the main and confirmatory matrices.

### 6.2 Latency and Cost

Pending end-to-end latency distributions, API time, request and tool counts, token use, and quality-cost Pareto analysis.

### 6.3 Dataset, Language, and Difficulty Slices

Pending stratified results by dataset, language, task category, number of gold files, repository size, and retrieval-chain complexity.

### 6.4 Reliability and Repeat Stability

Pending failure audit, timeout rate, within-task variance, ranking stability, and case-level anomaly analysis.

## 7. Discussion

FastContext tests the hypothesis that repository retrieval is limited less by the absence of additional local heuristics than by the absence of fast, constrained semantic control. If the formal study improves quality without reducing latency, the model-led path is useful but stopping or request reuse remains insufficient. If latency improves while multi-file recall declines, the corrective target is frontier-completeness estimation rather than a globally larger fixed budget. Language- or repository-specific regressions would point to path normalization and symbol execution coverage before they justify changes to the global control policy.

Historical patch files are auditable labels but not necessarily the only valid edit set. A patch may also include synchronized or test files that need not be retrieved in the first editing pass. We therefore report ranked coverage, full coverage, and case audits instead of treating one aggregate metric as a complete measure of engineering utility.

## 8. Threats to Validity

**Construct validity.** Historical patch paths may not uniquely identify all valid repair locations, and file-level metrics do not evaluate line-level explanations. We mitigate this limitation with multiple ranking metrics, evidence audits, and case studies.

**Internal validity.** Although all systems use the same model, their prompts, protocol adapters, tool schemas, and CLI implementations differ. These differences are part of the systems under test but prevent attribution to a single component. Shared gateway load and caching may affect latency; order rotation, adaptive pressure control, and repeated trials reduce but do not eliminate this risk.

**External validity.** The corpus consists of public issue-resolution tasks and does not directly represent private monorepositories, generated code, non-defect exploration, or all programming languages.

**Conclusion validity.** Public tasks may have appeared in model training, and historical development exposed a subset of cases. Claims must therefore rely on the frozen confirmatory protocol, uncertainty estimates, and effect sizes rather than selected examples.

## 9. Conclusion

FastContext structures repository-level localization as a model-led semantic control loop backed by deterministic parallel tools, exact caching, mechanical progress feedback, and read-evidence constraints. The design seeks a principled boundary between the flexibility of general exploration agents and the speed and repeatability of conventional retrieval systems. Final comparative conclusions will be generated only after all 1,500 frozen runs complete.

## Data and Artifact Availability

The protocol is stored at `benchmark-results/2026-07-25-fastcontext-formal-scale/protocol.md`. The final machine-readable package will be generated under `benchmark-results/2026-07-25-fastcontext-formal-scale/paper-data/`. Manuscript sources and bibliography are stored in `docs/papers/fastcontext-formal-2026/`.

## References

References are maintained in `references.bib` and will be rendered according to the selected venue template.
