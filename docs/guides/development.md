# Local development

## Prerequisites

- Node.js 20 or newer
- npm and Git
- A terminal with ANSI and Unicode support

## Setup

```bash
git clone <repository-url>
cd TurboFlux
npm ci
npm run type-check
npm test
npm run build
```

Run the CLI once or in watch mode:

```bash
npm run build
npm run link:tf
tf .
npm run dev:cli -- .
```

Use `tf` for the local built `dist/` launcher. Use `turboflux` to test the
published npm package.

Run one task without opening the full prompt loop:

```bash
tf . --command "Inspect the current project and summarize risks"
```

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run type-check` | TypeScript validation without emitting files. |
| `npm test` | Full Vitest suite. |
| `npm run test:flow` | Flow, UI, conversation, approval, and capability tests. |
| `npm run perf:flow` | Flow reducer, scheduler, and windowing performance gate. |
| `npm run smoke:tui` | Headless terminal flow smoke test. |
| `npm run baseline:terminal` | Capture terminal rendering evidence. |
| `npm run ci:flow` | Run the local CI-quality sequence. |
| `npm run build` | Compile `src/` into `dist/`. |
| `npm run runtime:info` | Print Node runtime information. |
| `npm run runtime:smoke` | Run the Node runtime smoke test. |

## Change workflow

1. Locate the state owner and adjacent tests in the documentation index or source map.
2. Reproduce the behavior with a focused test or fixture.
3. Change the narrowest owning module and preserve public event contracts.
4. Run focused tests, type-check, and then the full quality gates.
5. Update user, provider, architecture, or operations documentation as needed.

## Adding commands and tools

- Register commands in `src/cli/commands/` with aliases, descriptions, parsing,
  execution, and tests.
- Add user-facing copy to every supported locale in `src/cli/i18n/messages.ts`.
- Define tool schemas and risk metadata in `src/core/toolRegistry.ts`.
- Execute through `NodeToolExecutor` or the owning runtime service.
- Route paths through the capability boundary and propagate cancellation signals.
- Bound result size so one tool cannot consume the entire model context.

## Provider changes

Model metadata belongs in `src/core/modelRegistry.ts`, discovery in
`modelDiscovery.ts`, and protocol compatibility in `modelProtocol.ts` and
`requestCompatibility.ts`. Protocol retries must happen before semantic stream
progress and must never duplicate a tool side effect.

## Isolated debugging

Use temporary project-local configuration during manual runs:

```powershell
$env:TURBOFLUX_CONFIG_DIR = Join-Path $PWD '.tmp/turboflux-config'
$env:TURBOFLUX_CONVERSATIONS_DIR = Join-Path $PWD '.tmp/turboflux-conversations'
tf .
```

Remove only the temporary directory after the process exits. Never use real
credentials or a personal conversation directory for fixtures.
