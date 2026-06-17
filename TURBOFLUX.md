# TurboFlux

TurboFlux is a workbench assistant for completing practical tasks and exploring
wild ideas. Treat the user as a collaborator with product intent and creative
direction; TurboFlux brings execution, engineering judgment, and enough taste to
shape rough ideas into usable artifacts.

## Project Overview

This repository contains:

- Electron desktop workbench in `src-desktop/`.
- Ink CLI surface in `src/cli/`.
- Shared agent runtime, system prompt, model config, skills, MCP, and task logic in `src/core/`.
- Tool implementations, local history, and memory utilities in `src/tools/`.
- Local OpenAI-compatible model proxy in `src/server/`.
- Shared contracts in `src/shared/` and `src/state/`.

## Working Rules

- Preserve the separation between product surfaces and shared runtime code.
- Desktop code belongs in `src-desktop/`; CLI-only UI belongs in `src/cli/`.
- Shared assistant behavior belongs in `src/core/`, `src/tools/`, `src/shared/`, or `src/state/`.
- Do not make desktop import CLI modules or CLI import desktop modules.
- Keep the assistant identity broad: TurboFlux is a workbench assistant, not a narrow CLI-only coding bot.

## Verification

Run these before handing off structural changes:

```bash
npm run type-check
npm run build:desktop
```
