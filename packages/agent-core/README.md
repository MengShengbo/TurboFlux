# @turboflux/agent-core

The versioned TurboFlux execution kernel used by the Desktop workbench.

The package owns Agent execution, conversations, task flow, tools, Skills, MCP contracts, Work Packs, and platform-neutral application services. Its source lives in this package's `src/` directory. It does not contain Electron, accounts, billing, cloud services, updates, product telemetry, or product UI.

Consumers must use the exported entrypoints instead of importing internal `dist/core`, `dist/application`, or `dist/shared` files.
