# State Types

`src/state/` contains application state contracts consumed by the Ink CLI.

## Entry point

| File | Responsibility |
| --- | --- |
| `src/state/types.ts` | API profiles, model state, workspace state, turns, and persisted context contracts. |

## Boundaries

- Keep state types independent of Ink rendering.
- Reuse contracts from `src/shared/` instead of duplicating them.
- Preserve compatibility for saved configuration and conversation data.
