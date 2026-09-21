# Tool call lifecycle

The Desktop execution kernel implements this lifecycle in `packages/agent-runtime/src/`.
Tool adapters and host drivers remain outside the lifecycle coordinator; the kernel
does not depend on Electron or renderer state.

## Ownership

| Module | Responsibility |
| --- | --- |
| `toolCallOrchestrator.ts` | Partition calls into ordered batches and fill cancellations for calls not dispatched. |
| `runtime/toolExecutionCoordinator.ts` | Publish start/result events, drain concurrent work, close outstanding calls on notification failure, and publish batch settlement. |
| `runtime/toolCallLifecycle.ts` | Resolve and validate each call, obtain its permission, respect pause/cancellation, and share eligible physical reads. |
| `toolExecutionLedger.ts` | Coalesce identical in-flight reads within one cancellation scope; isolate each caller's result details. |
| `runtime/toolExecutionResult.ts` | Bind outcomes to the requested call identity and normalize execution/interruption errors. |
| `agentEngine.ts` | Supply workflow/mode/permission policies, dispatch adapters, build result details, and update task/evidence projections. |

## Execution contract

1. Each call passes validation and authorization independently, even when another
   identical read is already running.
2. The operation signal is captured at admission and passed unchanged to the
   adapter. An interrupted operation cannot attach itself to a resumed run's
   replacement signal. A non-interrupting pause keeps approved work gated until resume.
3. Interruption is checked before admission, after authorization, before dispatch,
   and after dispatch settles. A late successful adapter return does not turn an
   interrupted call into successful evidence. Driver cancellation is cooperative:
   the lifecycle waits for dispatched work to settle before releasing its ownership.
4. Results are returned in request order; result notifications arrive in completion
   order. Executor exceptions become per-call results. Notification failures stop
   further dispatch, wait for all running calls, then attempt one terminal notification
   for each remaining call before rejecting. Unexecuted calls receive a batch-failure
   result, or an interruption result if the signal was cancelled.
5. `onSettled` runs once for every nonempty invocation, after all started work has
   drained. Cleanup failures are retained alongside earlier lifecycle failures.
   Engine file snapshots are released in `finally`, and task activity is settled
   even if a result subscriber throws.

## Read sharing and write barriers

Read sharing uses the existing built-in read allowlist, canonical arguments, and
signal identity. Sequential calls always execute again. Every consumer receives its
own result metadata, so a UI or event subscriber cannot modify another call's
retrieval data, attachments, or structured output.

A new run clears sharing. Mutating dispatches invalidate sharing before starting
and again when they settle, including failures that may have partially changed the
workspace. Completion of an older read cannot evict a newer pending read.

Batches execute in order. A sensitive read following a write starts in a new batch;
the preceding batch must finish first. Subsequent safe reads can share that new
batch. Thus `read, read, write, read, read` executes as `[read, read] -> [write] ->
[read, read]`, preserving the write barrier without serializing every later read.

## Verification

The focused suites are `toolCallOrchestrator.test.ts`, `toolExecutionLedger.test.ts`,
`runtime/toolCallLifecycle.test.ts`, `runtime/toolExecutionCoordinator.test.ts`, and
`agentEngine.tools.test.ts`. They cover cancellation scope, pause/resume races,
independent admission, partial writes, mutable result isolation, notification
failure, delayed concurrent completion, adapter signal propagation, and task/snapshot
cleanup. Existing engine, approval, retrieval and runtime tests cover integration
with the surrounding kernel.
