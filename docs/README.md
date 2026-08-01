# TurboFlux documentation

This directory is the English documentation index for the TurboFlux terminal
coding agent. Current implementation documentation is kept close to the code;
historical research notes and generated artifacts are intentionally excluded.

## Start here

| Reader | Recommended page | Purpose |
| --- | --- | --- |
| New contributor | [Local development](guides/development.md) | Install, test, and make a first change. |
| Runtime maintainer | [Runtime lifecycle](architecture/runtime-lifecycle.md) | Follow the request, tool, approval, and persistence flow. |
| Tool maintainer | [Tool runtime contract](architecture/tool-runtime.md) | Maintain tool metadata, execution ordering, cancellation, and MCP discovery. |
| UI maintainer | [System overview](architecture/system-overview.md) | Understand the Ink UI and runtime boundaries. |
| Provider maintainer | [Provider/API compatibility](provider-api-compatibility.md) | Track models, endpoints, and request adaptations. |
| Release owner | [Release operations](operations/release.md) | Run release gates and package checks. |
| Support owner | [Troubleshooting](operations/troubleshooting.md) | Diagnose configuration, provider, session, and MCP issues. |

## Architecture

- [System overview](architecture/system-overview.md)
- [Runtime lifecycle](architecture/runtime-lifecycle.md)
- [Tool runtime contract](architecture/tool-runtime.md)
- [Security model](architecture/security-model.md)

## Development and quality

- [Local development](guides/development.md)
- [Testing strategy](guides/testing.md)
- [Contribution guide](../CONTRIBUTING.md)
- [Architecture decision records](adr/README.md)

## Providers and operations

- [Model protocol compatibility](model-protocol-compatibility.md)
- [Provider/API compatibility](provider-api-compatibility.md)
- [Release operations](operations/release.md)
- [Troubleshooting](operations/troubleshooting.md)

## Documentation rules

- Write committed documentation in English.
- Prefer links to source files, tests, commands, and stable public behavior.
- Update affected documentation in the same change as the implementation.
- Mark planned work as planned; do not describe a proposal as a shipped feature.
- Keep credentials, private prompts, user data, logs, and generated media out of the repository.
