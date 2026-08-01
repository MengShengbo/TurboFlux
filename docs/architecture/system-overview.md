# System overview

TurboFlux is a local Node.js application with an Ink terminal UI. The UI owns
presentation and input state; the runtime owns model requests, tools, approvals,
conversation persistence, and long-running tasks.

## Layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| CLI composition | `src/cli/` | Parse commands, configure the session, render Ink components, and translate runtime events into UI state. |
| Core runtime | `src/core/` | Run the agent loop, build provider requests, compact context, coordinate tools, and manage sessions. |
| Tool execution | `src/tools/` and `src/core/runtime/` | Execute file, shell, Git, MCP, search, memory, and runtime-task operations. |
| Shared contracts | `src/shared/` and `src/state/` | Define event, turn, tool, model, and persisted-state types without UI ownership. |
| Optional server | `src/server/` | Expose a local authenticated proxy and model-discovery endpoints when explicitly started. |

## Request flow

1. `src/cli/index.ts` resolves the workspace, profile, language, approval policy,
   and enabled extensions.
2. `App` submits a user turn to `AgentEngine` through the runtime boundary.
3. `AgentEngine` prepares context, selects the model protocol, and streams the
   response while emitting bounded events.
4. Tool calls pass through the registry, capability boundary, approval
   coordinator, and executor before results return to the model loop.
5. Critical and terminal events are persisted through the conversation journal;
   UI projections can be rebuilt from those events.
6. The turn completes when the model has no more tool calls, the user aborts, or
   a classified error is surfaced.

## State ownership

- `AgentEngine` owns one foreground run and its abort lifecycle.
- `FlowStore` and its reducer own derived per-thread UI state.
- `ConversationManager` and `JournalWriter` own durable conversation history.
- `SessionRegistry` owns conversation, runtime, and task identity.
- `RuntimeTaskManager` owns background task lifecycle and ownership metadata.
- Components read selectors and dispatch actions; they do not infer runtime state
  from arbitrary promises or duplicate domain state.

## Extension points

- Provider models and metadata: `src/core/modelRegistry.ts` and `modelDiscovery.ts`.
- Protocol planning and request compatibility: `src/core/modelProtocol.ts` and
  `requestCompatibility.ts`.
- Tools: `src/core/toolRegistry.ts`, `src/core/toolDispatcher.ts`, and MCP bridges.
- Workspace Skills and agents: `.turboflux/skills/` and `.turboflux/agents/`.
- UI commands and localized copy: `src/cli/commands/` and `src/cli/i18n/`.
