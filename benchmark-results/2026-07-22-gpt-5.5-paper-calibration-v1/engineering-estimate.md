# Formal Experiment Engineering Estimate

## Recommended matrix

The calibration supports a two-part experiment rather than running every system on every task three times.

### Primary comparison

- 100 stratified tasks: 50 SWE-bench Verified and 50 SWE-PolyBench Verified.
- The PolyBench half is balanced across Java, JavaScript, TypeScript, and Python.
- Systems: FastContext medium, Claude Code read-only, OpenCode, and BM25.
- Repeats: three per LLM system; one deterministic BM25 run per task.
- Total: 1,000 run records and roughly 6,060 upstream model requests.

### Depth and prompt ablation

- 30 stratified tasks.
- Systems: FastContext low, medium, max, neutral tool agent, and BM25.
- Repeats: one calibration-quality run per system, with a second run only if variance analysis shows it is needed.
- Total: 150 run records.

## Calibration-derived load

The five-task calibration completed 35 unique system/task runs plus seven auditable retry attempts. Based on the deduplicated final records:

| System | Mean input tokens | Mean output tokens | Mean requests | Mean wall time |
|---|---:|---:|---:|---:|
| FastContext low | 63,540 | 2,208 | 5.8 | 55.5 s |
| FastContext medium | 127,939 | 3,072 | 8.0 | 84.1 s |
| FastContext max | 166,971 | 3,675 | 7.2 | 91.6 s |
| Claude Code read-only | 55,781 | 1,546 | 6.2 | 45.0 s |
| OpenCode | 126,257 | 2,487 | 6.0 | 93.6 s |
| Neutral tool agent | 108,420 | 3,170 | 7.0 | 76.5 s |
| BM25 | 0 | 0 | 0 | 1.0 s |

Projected total for the recommended primary plus ablation matrices:

- About 108 million input tokens.
- About 2.46 million output tokens.
- About 1,150 run records.
- About 21 sequential wall-clock hours before transient retries and repository downloads.
- Roughly 3-6 GiB of repository snapshots, depending on Git worktree sharing and selected commits.

These are engineering estimates, not billing estimates. The relay does not return a standardized authoritative cost field across all three protocols, so the benchmark does not invent a dollar total.

## Execution policy

- Run the primary matrix only after committing the benchmark and FastContext implementation so every result names an immutable commit.
- Use the JSONL journal for resume. Never delete failed attempts; append retries with the same run id and use the latest attempt for aggregate scoring.
- Retry only transport, authentication, rate-limit, model-availability, and timeout failures. Do not retry retrieval, tool, output-contract, or turn-budget failures merely to improve scores.
- Freeze the model id, endpoint host, CLI versions, prompt contract, timeout, dataset manifest hash, and Git commit before the formal run.
- Report calibration separately. It was used to repair protocol and measurement defects and therefore cannot be treated as a preregistered final result.
