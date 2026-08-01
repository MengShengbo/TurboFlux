# Runtime lifecycle

The foreground lifecycle is a bounded sequence of input, model, tool, and
persistence phases. Only one foreground run is active for a session.

## Run sequence

1. Validate the workspace, active API profile, model, and approval policy.
2. Create or restore the conversation and register the session owner.
3. Prepare context, workspace memory, Git state, Skills, MCP tools, and task context.
4. Append the user turn and persist the critical journal entry.
5. Plan a provider protocol and stream the model response.
6. If the response contains tool calls, validate arguments, request approval when
   required, execute the calls, persist results, and continue the model loop.
7. Finalize the assistant turn, token usage, Flow projection, and journal entry.
8. Release run grants, timers, streams, and temporary resources in `finally` paths.

## Interruption and recovery

- A user abort propagates through `AbortSignal` to model streams, tool executors,
  child processes, MCP clients, and background readers.
- A stream may finish as `complete`, `interrupted`, `cancelled`, or `failed`;
  partial visible output remains recoverable.
- Journal replay tolerates a truncated final line and unfinished tool records.
- Session switching is guarded while a foreground run owns the conversation.
- Context compaction preserves a structured summary and the recent turns needed
  for the next request.

## Background tasks

Background terminals and subagents use `RuntimeTaskManager` with explicit owner
and task IDs. Their progress is projected into Flow state but their side effects
remain owned by the runtime executor. Completion, cancellation, and cleanup are
exactly-once transitions.

## Verification points

The lifecycle is covered by core runtime tests, conversation recovery tests,
approval tests, Flow reducer tests, and the headless terminal smoke command:

```bash
npm run test:flow
npm run smoke:tui
```
