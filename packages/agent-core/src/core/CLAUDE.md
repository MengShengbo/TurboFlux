# Core Engine

TurboFlux core owns the shared assistant runtime for product adapters. This
layer contains the agent loop, system prompt, model config,
tool schema registry, permission checks, task management, context compression,
subagents, and provider streaming.

Important files:

- `agentEngine.ts`: main agent loop, tool execution, provider streaming.
- `modelMessages.ts`: provider-neutral runtime-context injection and Anthropic tool-message normalization.
- `modelStream.ts`: bounded stream accumulation and provider response helpers.
- `modelRequestOrchestrator.ts`: provider-neutral protocol attempt, retry, and
  fallback lifecycle. UI adapters provide events; this module owns no UI state.
- `toolCallOrchestrator.ts`: concurrency-safe tool partitioning, batch execution,
  and cancellation completion. Concrete tool behavior stays in the engine.
- `contextCompactionBoundary.ts`: pure selection of compactable turns and their
  durable segment boundaries. Summary generation and persistence stay in the engine.
- `taskToolDispatcher.ts`: task-tree tool semantics and lifecycle callbacks;
  presentation receives task events through injected callbacks.
- `providers/`: provider-specific streaming protocol parsers with callback-based runtime adapters.
- `config.ts`: shared model and app configuration for all product surfaces.
- `toolRegistry.ts`: mode-based tool schema surface. Do not add intent or route
  filtering here; permissions and explicit mode gates decide availability.
- `turnStrategy.ts`: runtime strategy hints from structured signals only. It
  must not classify natural-language user intent and must not hide tools.
- `permissions.ts`: execution-time safety gates.
- `systemPrompt.ts`: static mode/tool guidance and dynamic context assembly.
- `contextManager.ts`: history shaping and provider message formatting.
- `subAgent.ts`: isolated subagent runner.

Removed design:

- `adaptiveRouter.ts` and route-aware tool filtering were removed. They relied
  on hardcoded natural-language intent buckets and could turn agentic requests
  into no-tool chat turns. Do not reintroduce semantic route gates in code.

Design rule:

The model gets the full tool surface allowed by explicit mode and user policy.
Any strategy layer may add guidance, but it must never remove tools or decide
what the user's sentence "means" through keyword lists.
