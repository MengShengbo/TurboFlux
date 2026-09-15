# Tool Implementations

`packages/agent-core/src/tools/` contains concrete tool executors, code-index utilities, and memory
operations used by the core runtime.

## Key files

| File | Responsibility |
| --- | --- |
| `packages/agent-core/src/tools/executor.ts` | Typed executor contracts, result envelopes, process and terminal APIs. |
| `packages/agent-core/src/core/runtime/nodeToolExecutor.ts` | Node filesystem, process, memory, network, and terminal implementation. |
| `packages/agent-core/src/tools/memory/` | Workspace memory service, loaders, persistence, and retrieval. |

## Boundaries

- Reuse shared contracts from `packages/agent-core/src/shared/`.
- Keep orchestration in `packages/agent-core/src/core/` and route execution through the runtime boundary.
- Use capability and approval metadata for file, shell, network, Git, and MCP operations.
- Keep outputs bounded and avoid persisting credentials or private user content.
- Preserve the `Result<T>` data envelope; add fields to `data` instead of flat result properties.
- Pass an `AbortSignal` through long-running process and network operations where available.
- Use read-only process execution for repository inspection so read-only capability profiles remain usable.
- Use `apply_patch` for coordinated multi-file edits; preflight context and expected hashes before writing.
