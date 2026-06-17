# Binary Entrypoint

## Module Role

`bin/` contains the published Node entrypoint for the TurboFlux CLI surface. The
CLI is one interface to the TurboFlux workbench assistant; it should stay thin
and delegate product behavior to shared runtime code.

## Entrypoint

| File | Responsibility |
|------|----------------|
| `bin/turboflux.mjs` | Starts `src/cli/index.ts` through `tsx` for local TypeScript execution. |

## Boundary

- Keep this folder focused on executable wrappers only.
- Do not add assistant logic, desktop logic, model config, or tool behavior here.
- Shared behavior belongs in `src/core/`, `src/tools/`, `src/shared/`, or `src/state/`.
