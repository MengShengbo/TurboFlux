# State Types

`packages/agent-core/src/state/` contains application state contracts consumed by product adapters.

## Entry point

| File | Responsibility |
| --- | --- |
| `packages/agent-core/src/state/types.ts` | API profiles, model state, workspace state, turns, and persisted context contracts. |

## Boundaries

- Keep state types independent of Ink rendering.
- Reuse contracts from `packages/agent-core/src/shared/` instead of duplicating them.
- Preserve compatibility for saved configuration and conversation data.
