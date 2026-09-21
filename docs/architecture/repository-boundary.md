# Repository and release boundary

This repository is a self-contained npm workspace. Install, build and verify from its root; sibling checkouts are not prerequisites. See [package architecture](packages.md) for complete ownership and dependencies.

Each package owns its `src`, manifest, exports and build output. `contracts` defines shared data; `platform` owns Node adapters; model, tool, extension, Agent, conversation, profile and automation implementations live in their respective domain packages. `workbench` composes the application. `presentation` is pure view projection; `renderer` is the browser rendering engine. `agent-core` contains compatibility exports only.

Desktop and remote-mobile are leaf applications. The existing model proxy is a separate leaf under `apps/model-proxy`. Native browser, computer and terminal drivers belong to Desktop and are injected into runtime interfaces. Browser packages do not import Node, Electron or application implementation.

Cross-package imports use declared exports and workspace dependencies (`"*"`). Source/dist deep imports, undeclared dependencies and cycles are rejected by `verify:architecture`. That check includes type-only imports and rejects runtime host imports in the Desktop renderer. `verify:boundary` checks publication, workspace links, nested lockfiles and removed commercial coupling. `verify:workspace` checks manifests and repository structure without depending on the surrounding machine layout.

Builds follow the dependency graph through `build:packages`; `build:core` is a compatibility alias. Each package emits JavaScript and declarations with resolvable ESM paths. Extensions copy their plugin child-process resource into their own distribution. Desktop packaging follows manifest dependencies and verifies that the domain packages are included in ASAR.

Run `npm ci`, then `npm run ci`. Platform distribution additionally requires packaging and acceptance checks for that operating system. Signing is separate from local validation. Generated profiles, credentials, evidence and build output remain outside source control.
