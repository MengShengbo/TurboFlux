# Repository and release boundary

The repository contains the TurboFlux Agent Core and Desktop application. The root is a self-contained npm workspace; installation, builds, tests, and boundary checks run without sibling checkouts.

## Workspace packages

| Package | Role |
| --- | --- |
| `@turboflux/agent-core` | Versioned execution kernel and application services |
| `@turboflux/desktop` | Electron workbench and native adapters |
| `@turboflux/remote-protocol` | Desktop remote-control pairing, grants, encrypted commands, and events |
| `@turboflux/remote-mobile` | Desktop remote-control browser client |

The remote-control packages support Desktop and are required by its build. The root package is private; Agent Core owns its public package entrypoints.

## Dependency direction

Desktop consumes the kernel through public exports. Main-process adapters use `workbench` and `extensions`; the renderer uses `renderer` and type-only contracts. Native browser, computer, and terminal capabilities are supplied by the host. The kernel does not depend on Electron, the Desktop UI, or native host drivers.

Internal workspace dependencies use `"*"` so npm links the local packages. Install at the repository root and use its single lockfile. `npm run verify:boundary` rejects pinned internal dependencies and nested lockfiles. The root and Desktop product versions remain aligned; `turbofluxCoreVersion` tracks the kernel version separately.

`scripts/verify-architecture.mjs` enforces dependency direction within the kernel. Foundation layers (`core`, `tools`, `platform`, `shared`, `state`) sit below orchestration (`application`, `kernel`); `server` is a leaf. Applications consume `@turboflux/*` package exports rather than internal paths.

Plugins use the host-owned [Workflow Surface contract](workflow-surfaces.md) and [local plugin lifecycle](local-plugin-lifecycle.md). Plugin-specific behavior must not add branches to the Agent Core or Desktop renderer.

## Validation and distribution

1. Install locked dependencies with `npm ci` using Node.js 22.12 or newer.
2. Run `npm run ci` for lint, types, tests, production builds, and repository checks.
3. Build platform packages and run the packaging and profile acceptance checks in CI.
4. Configure signing and distribution credentials separately when producing a release.

`npm run verify:workspace` checks the repository's own workspace manifests, source roots, scripts, and documentation. Generated builds, local profiles, credentials, and test evidence are excluded from source control.

See the [architecture overview](project-overview.md) for the runtime call chain and source map.
