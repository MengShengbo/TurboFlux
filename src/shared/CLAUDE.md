# Shared Types

`src/shared/` defines runtime contracts shared by the CLI, core, tools, and
state layers. It contains agent, tool, memory, subagent, code-index, and common
types without runtime UI logic.

## Key files

| File | Responsibility |
| --- | --- |
| `src/shared/types.ts` | Common model, provider, and system types. |
| `src/shared/agentTypes.ts` | Turns, strategies, context, edits, and agent configuration. |
| `src/shared/toolTypes.ts` | Tool definitions, calls, results, and metadata. |
| `src/shared/memoryTypes.ts` | Memory entries, queries, and persistence contracts. |
| `src/shared/subAgentTypes.ts` | Subagent definitions, events, and results. |
| `src/shared/codeIndexTypes.ts` | Code index, symbol, and search contracts. |

## Boundaries

- Export contracts as TypeScript `interface` or `type` definitions.
- Do not import Ink, CLI modules, or Node-specific implementation details.
- Preserve backward-compatible shapes for persisted and cross-process events.
- Add explicit versioning when a serialized contract changes.
