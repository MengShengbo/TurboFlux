# Testing strategy

The test suite protects behavior, recovery, terminal interaction, cross-platform
execution, and release reproducibility. Start with the smallest relevant test,
then run broader gates.

## Test layers

| Layer | Typical location | Primary risk |
| --- | --- | --- |
| Unit | `src/**/**/*.test.ts` | Boundary values, parsers, reducers, selectors, and pure transforms. |
| Runtime | `src/core/**/*.test.ts` | Model lifecycle, tools, approvals, cancellation, recovery, and concurrency. |
| Component | `src/cli/components/**/*.test.tsx` | Visible state, input, overlays, and terminal sizing. |
| Flow | `src/cli/state/` and `src/shared/` | Event ordering, ownership, replay, and reducer invariants. |
| Smoke | `scripts/tui-flow-smoke.ts` | Startup, input, rendering, completion, and cleanup in a headless terminal. |
| Performance | `scripts/flow-performance.ts` | Long transcripts, burst deltas, scheduling, and windowing. |
| Platform | GitHub Actions | Windows, macOS, Linux, shells, paths, and process behavior. |

## Focused verification

```bash
npx vitest run src/core/modelProtocol.test.ts
npx vitest run src/cli/state
npm run type-check
npm run test:flow
```

## Full quality gate

```bash
npm run ci:flow
```

The command runs type-checking, the full test suite, flow performance, headless
TUI smoke, and the production build.

## Runtime scenarios

Tests involving runs, tools, approvals, background tasks, subagents, or
conversations should cover:

- successful completion and exactly-once cleanup;
- provider errors, malformed responses, rate limits, and protocol fallback;
- user cancellation, stream interruption, timeout, and child-process termination;
- duplicate events, incomplete journal tails, and replay after restart;
- session switching, queued prompts, steering, and approval resolution;
- path validation, capability boundaries, and placeholder credentials.

## Test data rules

- Use explicit placeholder API keys and temporary directories.
- Do not read a user's home configuration, conversations, or credentials.
- Do not write prompts, source files, keys, or private output into snapshots.
- Inject clocks and IDs where timing or determinism matters.
- Include a seed or event sequence for randomized or concurrent tests.
