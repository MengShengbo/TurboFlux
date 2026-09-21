# @turboflux/renderer

Browser rendering engine for TurboFlux. Owns frame scheduling, keyed reconciliation, mount lifetimes, task timelines, Markdown, code and diffs, tool results and work plans. Depends on browser-safe presentation contracts and visual libraries; no Electron, IPC, filesystem or Agent execution.

State is reduced synchronously. `RenderScheduler` merges DOM work by surface; `KeyedList` preserves node identity; `RenderLifetime` releases listeners, observers, timers and subscriptions. Host callbacks inject actions. Product styles belong to the application. See [package architecture](../../docs/architecture/packages.md).
