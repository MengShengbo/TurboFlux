# TurboFlux CLI

TurboFlux is a local AI workbench for turning workspace tasks into executable
plans, edits, command runs, checkpoints, and conversation history. This
repository contains the terminal CLI, shared agent runtime, optional Electron
desktop shell, and a local OpenAI-compatible model proxy.

The project is experimental and intended for local use. Treat it as a developer
toolkit rather than a hosted service.

## Features

- Ink-based terminal assistant with streaming output, command palette, model
  selection, conversation history, rewind, and no-flicker terminal mode.
- Shared agent runtime with plan/vibe modes, task tracking, tool calls,
  workspace sandboxing, local checkpoints, memory loaders, MCP support, and
  skill/subagent hooks.
- Local OpenAI-compatible proxy for keeping upstream API keys on the backend
  instead of inside the CLI or desktop UI.
- Electron desktop workbench source under `src-desktop/`.

## Repository Layout

```text
bin/           CLI executable shim
src/cli/       Ink CLI UI, slash commands, conversation storage
src/core/      Agent runtime, model config, permissions, MCP, skills
src/server/    Local OpenAI-compatible proxy and admin console
src/state/     Shared provider/model state contracts
src/tools/     Tool execution, local history, memory utilities
src/shared/    Cross-layer types
src-desktop/   Electron main/preload/renderer source
```

## Requirements

- Node.js 20 or newer
- npm
- Optional: `rg` / ripgrep for faster search tools

## Quick Start

```bash
npm install
npm start
```

Run the CLI against a specific workspace:

```bash
npm start -- /path/to/project
```

Run a single prompt and exit:

```bash
npm start -- --command "summarize this repository"
```

Useful CLI commands:

```text
/help                 list commands
/config               show current config
/config apiKey VALUE  set local proxy token or provider key
/model                pick a model preset
/plan                 switch to read/plan mode
/vibe                 switch to autonomous execution mode
/init                 create TURBOFLUX.md project instructions
/resume               open saved conversations
```

TurboFlux no longer writes `TURBOFLUX.md` automatically when the CLI starts.
Use `/init` when you want to create project instructions in the current
workspace.

## Local Model Proxy

The default CLI config points at the local backend:

```text
baseUrl: http://127.0.0.1:8787
apiKey: turboflux-local
model: gpt-5.5
```

Start the proxy:

```bash
npm run server
```

Open the admin console:

```text
http://127.0.0.1:8787/admin
```

Create `.env` from `.env.example` and set your upstream provider:

```bash
TURBOFLUX_FREE_MODEL_API_KEY=<your-upstream-api-key>
TURBOFLUX_FREE_MODEL_BASE_URL=https://api.example.com/v1
TURBOFLUX_FREE_MODEL=gpt-5.5
```

If you bind the proxy outside localhost, set `TURBOFLUX_PROXY_AUTH_TOKEN`.
TurboFlux refuses non-localhost binds without that token.

## Development

```bash
npm run dev:cli        # watch CLI
npm run dev:server     # watch local proxy
npm run dev            # launch Electron development workbench
npm run type-check     # TypeScript check
npm test               # Vitest suite
npm run build          # compile src/
npm run build:desktop  # build Electron bundles
```

## Safety Notes

- Workspace tool execution defaults to a workspace sandbox. Absolute paths and
  `..` traversal outside the workspace are blocked unless the runtime is
  explicitly configured for full access.
- High-risk commands such as force pushes, hard resets, recursive deletes, and
  database drops require approval outside full-auto policy.
- The local proxy redacts upstream API keys from admin responses.
- Secrets, local state, build output, logs, temporary files, reference dumps,
  and dependencies are ignored by Git.

## Verification Status

This snapshot was checked with:

```bash
npm run type-check
npm test
npm audit --audit-level=high --registry=https://registry.npmjs.org
```

Current result: TypeScript passes, 259 tests pass, and npm audit reports 0
known vulnerabilities.

## License

MIT
