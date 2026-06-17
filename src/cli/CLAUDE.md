# CLI Layer

## Module Role

`src/cli/` is the terminal surface for TurboFlux. TurboFlux itself is a
workbench assistant; the CLI should stay focused on terminal interaction,
commands, rendering, keyboard input, and conversation flow.

## Entrypoints

| File | Responsibility |
|------|----------------|
| `src/cli/index.ts` | Commander entrypoint for the `turboflux` command. |
| `src/cli/repl.ts` | Starts the Ink REPL experience. |
| `src/cli/components/App.tsx` | Main terminal UI component. |
| `src/cli/commands/` | Slash command registry and handlers. |

## Boundaries

- Do not put desktop-specific code here.
- Do not make shared model config live here; use `src/core/config.ts`.
- Use `src/core/` for assistant runtime behavior and `src/tools/` for tool execution.
- Keep CLI-only state, theme, rendering, and keyboard interaction in this folder.
