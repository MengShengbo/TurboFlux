# ADR-0001: Agent Runtime as the composition root

- Status: accepted
- Date: 2026-07-30
- Decision makers: TurboFlux maintainers
- Related: `src/core/runtime/agentRuntime.ts`

## Context

`AgentEngine` depends on model configuration, tool execution, background tasks,
subagents, Skills, MCP, and session identity. If the CLI, single-shot entry
point, tests, and future entry points assemble those dependencies independently,
ownership, shutdown order, and configuration updates will diverge.

## Decision

`createAgentRuntime()` is the composition root. Entry points obtain the Engine,
state provider, tool executor, runtime-task and subagent-task managers, Skills,
MCP, and Session Registry from it. Configuration changes go through
`applyConfiguration()` and cleanup goes through `destroy()`.

Domain services do not import Ink components. Session identity changes are
broadcast by `SessionRegistry` to services that own an owner or conversation ID.
Background task completion returns to the Engine through runtime events instead
of being inferred by the UI.

## Alternatives

- Let `App.tsx` construct every service: the UI would own domain lifecycle and
  reuse/testing would become difficult.
- Construct all dependencies inside `AgentEngine`: dependencies would be hidden
  and the monolith's responsibilities would grow.
- Use a global singleton container: state would leak across tests and sessions,
  with no clear destruction order.

## Consequences

The CLI and future entry points share one assembly contract. Lifecycle cleanup,
listener removal, and resource closure are centralized and testable. New core
services must extend the runtime interface, and configuration updates must be
explicitly synchronized to affected services.

## Risk controls

- Add destroy/stop tests for every resource and invoke them from the runtime.
- Cover session switching and running-session guards in Session Registry tests.
- Keep the runtime surface narrow; domain operations belong in the Engine or a
  dedicated facade.

## Verification

- `src/core/runtime/agentRuntime.test.ts`
- `src/core/runtime/sessionRegistry.test.ts`
- `src/core/runtime/runtimeTaskManager.test.ts`
- `src/core/runtime/subAgentTaskManager.test.ts`
