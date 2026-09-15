# Application Layer

## Module Role

`packages/agent-core/src/application/` owns UI-independent orchestration and state projections consumed by product adapters.

## Boundaries

- Depend on contracts from `packages/agent-core/src/shared/`, `packages/agent-core/src/state/`, and runtime APIs from `packages/agent-core/src/core/`.
- Do not depend on terminal input, UI rendering, or desktop framework implementations.
- Expose stable entrypoints for UI adapters instead of making surfaces import internal modules directly.
- Keep persistence formats and event schemas versioned when application state crosses process boundaries.

## Modules

- `flow/` owns UI-independent event reduction, stores, and selectors.
- `conversations/` owns durable conversation persistence, journaling, recovery, and interaction-state restoration.
- `workbench/` composes the shared agent runtime, Flow, conversations, Skills, MCP, approvals, and queue lifecycle for UI adapters.
