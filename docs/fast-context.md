# Fast Context

Fast Context is TurboFlux's lightweight code-location subsystem. It runs an isolated read-only subagent that maps an issue, feature, UI string, symbol, or behavior request to a compact ranked set of source files and line ranges.

The goal is not to prove the final answer by itself. The output is an issue-localization map that helps the main agent decide which files to read next, while keeping noisy search history out of the main model context.

## Where It Lives

- `src/core/fastContextSubagent.ts` defines the Fast Context agent configuration, objective tokenization, evidence scoring, result synthesis, and `runFastContextSubagent` entry point.
- `src/core/fastContextTypes.ts` defines scan events, phases, hit metadata, evidence roles, confidence levels, and the final `FastContextScanResult` contract.
- `src/core/subAgent.ts` provides the generic subagent runner and read-only tool bridge used by Fast Context.
- `src/core/agentEngine.ts` imports `runFastContextSubagent`, forwards scan events, and builds a cached workspace skeleton primer for subagent calls.
- `src/cli/components/tools/FastContextBanner.tsx` renders the CLI progress banner for mapping, ranking, synthesis, worker activity, hit counts, and completion status.
- `src/core/fastContextSubagent.test.ts` covers objective tokenization and evidence-pack behavior.

## User-Facing Behavior

Fast Context is used when TurboFlux needs a fast code map before making high-confidence claims about an unfamiliar part of a repository. It is especially useful for broad location tasks, UI/component discovery, cross-file bug localization, and requests where multiple file names or terms may be relevant.

The runtime treats its result as retrieval context. The main agent should still read the returned high-signal files before editing code or making detailed claims.

## Subagent Definition

`FAST_CONTEXT_DEFINITION` configures the built-in subagent as:

- `id`: `fast_context`
- `label`: `Fast Context`
- `driver`: `main-model`
- `maxTurns`: `3`
- `maxParallel`: `6`
- `maxOutputTokens`: `6000`
- `temperature`: `0.1`

Fast Context now uses the active main model selected in the runtime. It no longer defaults to `deepseek-v4-flash`; if no active model is available, the subagent runner returns a clear configuration error instead of silently falling back to a DeepSeek flash model.

The system prompt frames the subagent as a fast issue-localization scout. It should search first, read only high-signal slices, prefer exact UI text or symbols when available, and return a final `RANKED_CODE_MAP` with paths, line ranges, roles, confidence, and short reasons.

## Execution Flow

1. `runFastContextSubagent` receives an objective, workspace path, tool executor, model configuration, optional codemap primer, and event callback.
2. The objective is tokenized by `__testObjectiveTokens`, including Chinese phrases, mixed identifiers, kebab-case, camelCase fragments, and meaningful substrings.
3. The wrapper emits a `mapping` phase event and starts the generic `runSubAgent` loop.
4. `runSubAgent` exposes a small read-only tool set: `search_content`, `read_file`, `search_files`, `search_symbols`, and `get_codemap`.
5. Each subagent evidence event is normalized into a `FastContextScanHit`, scored, tagged with an evidence role, assigned confidence, and deduplicated by path and line range.
6. After the subagent returns, Fast Context enters `synthesizing`, combines the LLM-ranked final report with local fallback candidates, and emits a completed result.
7. The final `FastContextScanResult` includes the original objective, compact evidence pack, scanned file count, all hits, elapsed time, and truncation status.

## Evidence Pack Contract

The generated evidence pack is wrapped as:

```xml
<fast_context_pack role="code_map_locator">
...
</fast_context_pack>
```

It records:

- the objective and retrieval timing
- authority policy: LLM-ranked report first, local ranking as fallback/checksum
- isolation policy: raw subagent tool history is not injected into main context
- use policy: treat the pack as a locator, then read relevant files directly
- optional truncation warning
- `llm_ranked_code_map`
- `fallback_candidates`

This keeps the main conversation compact while preserving enough file and line anchors to continue with targeted reads.

## Scoring And Roles

Fast Context scores evidence with simple local heuristics in `decorateHit` and `summarizeCandidates`:

- exact token matches and objective-token density improve score
- relevant path names improve score
- high-signal file roles improve ranking
- multiple evidence roles and repeated hits add diversity and density bonuses

Evidence roles are defined in `FastContextEvidenceKind`:

- `entry`
- `implementation`
- `caller`
- `config`
- `schema`
- `test`
- `root_cause`
- `supporting`

Confidence is derived from score as `high`, `medium`, or `low`.

## CLI Progress UI

`FastContextBanner` consumes `FastContextScanEvent[]` and renders a live Ink banner:

- phase label: `MAPPING`, `RANKING`, `SCANNING`, `SYNTHESIZING`, `DONE`, or `ERROR`
- wave counter based on subagent turns
- discovered file count and hit count
- up to six active worker rows
- current file or fallback insight spinner
- recent files when no worker is active
- completion summary showing evidence files and line ranges

The banner is display-only. It does not own scanning logic.

## Workspace Primer

`AgentEngine` builds a compact workspace skeleton and caps it around 3000 characters. The skeleton is passed as the subagent `codemap` primer when available. The intent is to give the subagent a stable high-level map of the repository and improve prompt-cache reuse without bloating the request.

If tree retrieval fails, the runner skips the primer instead of passing partial data.

## Current Tests

`src/core/fastContextSubagent.test.ts` verifies two important behaviors:

- objective tokenization keeps Chinese UI wording and mixed code identifiers searchable
- the evidence pack treats the LLM final report as the primary ranked code map while retaining fallback candidates

Useful verification commands:

```bash
npm test -- src/core/fastContextSubagent.test.ts
npm run type-check
```

## Extension Notes

When changing Fast Context, keep the following contracts stable unless the runtime and UI are updated together:

- `FastContextScanEvent` event shapes in `src/core/fastContextTypes.ts`
- the `FastContextScanResult` fields consumed by the runtime
- the `RANKED_CODE_MAP` expectation in the subagent prompt
- the evidence-pack policy text that tells the main agent to read source files before making final claims
- the read-only nature of the subagent tool bridge in `src/core/subAgent.ts`

For new retrieval behavior, prefer improving scoring, tokenization, or the subagent prompt before expanding tool surface area. Fast Context is intentionally narrow: fast map first, targeted source reads second.
