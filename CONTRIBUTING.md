# Contributing

Thanks for contributing to TurboFlux. Start with the [documentation index](docs/README.md)
and the [system overview](docs/architecture/system-overview.md).

## Contribution workflow

1. Open an issue before substantial changes so scope and acceptance criteria are clear.
2. Create a focused branch from the latest main branch.
3. Add or update tests with behavior changes.
4. Update user, architecture, or operational documentation when the behavior changes.
5. Run the quality gates before opening a pull request.
6. Keep commits focused and easy to revert.

## Development environment

- Node.js 20 or newer
- npm with the checked-in `package-lock.json`
- Git
- A terminal that supports ANSI and Unicode output

```bash
npm ci
npm run type-check
npm test
npm run build
```

For changes that affect the full terminal flow, also run:

```bash
npm run ci:flow
```

## Design boundaries

- Keep CLI and Ink UI code in `src/cli/`.
- Keep shared contracts in `src/shared/` and `src/state/`.
- Keep provider, runtime, tool, and persistence behavior in their existing layers.
- Route file paths through the capability boundary and preserve approval checks.
- Keep credentials, user prompts, conversation data, and generated artifacts out of commits.

## Documentation and ADRs

Update the relevant document in the same change as a public behavior or configuration change.
For a cross-module or long-lived architectural decision, copy
`docs/adr/0000-template.md` and add a new ADR under `docs/adr/`.

## Pull requests

- Use a clear prefix such as `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, or `chore:`.
- Describe the problem, implementation, verification commands, and compatibility impact.
- Link the relevant issue with `Closes #<number>` when applicable.
- Do not include credentials, private source, conversation logs, benchmark output, or generated media.
