# Tool runtime contract

TurboFlux tools are exposed through `src/core/toolRegistry.ts` and executed by
`AgentEngine` through the `ToolExecutor` contract in `src/tools/executor.ts`.
The registry is the model-facing contract; the executor is the capability-bound
implementation. A tool must not rely on the model to infer identifiers,
permissions, or side effects.

## Execution pipeline

1. Resolve the builtin or namespaced MCP tool.
2. Validate the input schema and mode availability.
3. Check the approval and capability pipelines.
4. Reuse only safe read results from the execution ledger.
5. Partition calls using `isConcurrencySafeFor` and the read-after-write barrier.
6. Execute through the runtime boundary and return a bounded `Result<T>`.
7. Persist a structured tool result and invalidate stale read entries after writes.

`apply_patch` follows the Codex patch grammar (`Add File`, `Update File`,
`Move to`, and `Delete File`). It parses and validates every operation before
writing, matches update hunks against unique context, and passes expected file
hashes to the executor so concurrent edits are reported as conflicts.

`ask_user`, memory writes, and background-agent creation are serialized side
effects. `ask_user` does not return until the coordinator has a response, so a
later write in the same model turn cannot run before the user decision.

## Cancellation

`AgentEngine.abort()` aborts the provider stream, foreground process signal,
background terminal sessions, interactive requests, and all child-agent runtime
tasks owned by the session. `NodeToolExecutor` reports `aborted` separately from
`timedOut` so the UI and retry policy can distinguish user interruption from a
runtime deadline.

Git inspection uses `readOnlyProcess`, which resolves the working directory
through read access and does not create a workspace log in a `read-only`
capability profile. Git mutation paths continue to use the write process path.

## MCP discovery

Connected MCP servers expose metadata to `tool_search`; matching schemas are
loaded into the next model turn. This keeps the initial tool surface small while
retaining full server-side resolution for already selected names. MCP connections
also enforce startup and per-call timeouts, optional tool allow/deny lists, HTTP
transport headers, and bounded server instructions.

## Codex alignment

The design follows the Codex source audit at commit
`8bbdf6c8f9ecf4833479c64a4794c9ed6c2dab9b`: explicit shell workdir/yield/output
budgets, structured user-input requests, deferred tool search, and typed tool
contracts. The next P2 extraction is a dedicated `ToolRuntime` dispatcher and a
structured patch primitive; both should preserve this pipeline and its tests.

## Verification

Run the focused runtime suite while iterating, then the complete checks:

```text
npm run type-check
npm test
```
