# Release operations

TurboFlux is currently distributed through the GitHub repository. The root
package exposes the `turboflux` binary and TypeScript output is built into
`dist/`. GitHub Actions provides cross-platform quality gates; there is no
automatic release workflow in this repository.

## Pre-release checks

```bash
git status --short --branch
git pull --ff-only
npm ci
npm run ci:flow
npm pack --dry-run
```

The working tree should contain only the intended release changes. The package
preview must include `bin/`, `dist/`, `package.json`, the license, and required
documentation, but no credentials, conversations, telemetry, temporary files, or
generated media.

## Version sources

Check all user-visible version sources when releasing:

| File | Source |
| --- | --- |
| `package.json` | Package version |
| `package-lock.json` | Root package version |
| `src/cli/index.ts` | Commander version |
| `src/cli/brand.ts` | Display version |
| `src/cli/setup.ts` | Setup banner |
| `src/core/mcp/client.ts` | MCP client identity |
| `src/core/clientIdentity.ts` | Package lookup and fallback |

Use npm to update the package and lock file, then synchronize source constants:

```bash
npm version <patch|minor|major> --no-git-tag-version
rg -n "version\\(" package.json package-lock.json src
npm run type-check
npm test
```

## Release steps

1. Define the semantic version and user-visible changes.
2. Update every version source and the English documentation.
3. Run `npm ci` and `npm run ci:flow`.
4. Run `npm pack --dry-run` and review the file list.
5. Install the tarball locally and verify `turboflux --version`, `turboflux setup show`, and one single-shot task.
6. Push the focused branch and wait for all platform gates.
7. Merge to `main`, create the annotated `v<version>` tag, and push the tag.
8. Verify the GitHub installation scripts and global installation path.
9. Publish to npm only when that release channel is explicitly enabled.

Local tarball verification:

```bash
npm pack
npm install -g ./turboflux-<version>.tgz
turboflux --version
```

## Release validation

Verify the version, redacted setup output, model/tool execution, `/help`,
`/model`, `/approval`, `/capability`, `/resume`, session recovery, and background
task convergence on Windows, macOS, and Linux.

## Rollback

Keep the failed tag and build logs, install the last known-good tag, and verify
the core path. Fix the issue in a new commit and publish a patch version. Prefer
compatible reads or migrations for data formats; do not ask users to delete
conversations, memory, or configuration as a first step.
