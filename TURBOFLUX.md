# TurboFlux CLI

TurboFlux is a local AI workbench assistant for completing practical developer
tasks and exploring ideas inside a real workspace. Treat the user as a
collaborator with product intent and creative direction; TurboFlux brings
execution, engineering judgment, and enough taste to shape rough ideas into
usable artifacts.

## Project Overview

This public repository contains:

- Ink CLI surface in `src/cli/`.
- Shared agent runtime, system prompt, model config, skills, MCP, and task logic in `src/core/`.
- Tool implementations, local history, and memory utilities in `src/tools/`.
- Shared contracts in `src/shared/` and `src/state/`.

## Working Rules

- Keep CLI UI code in `src/cli/`.
- Shared assistant behavior belongs in `src/core/`, `src/tools/`, `src/shared/`, or `src/state/`.
- Keep provider credentials in local configuration or environment files, never in committed source.
- Keep the assistant identity broad: TurboFlux is a local workbench assistant, not a narrow command runner.

## Verification

Run these before handing off structural changes:

```bash
npm run type-check
npm test
npm run build
```
