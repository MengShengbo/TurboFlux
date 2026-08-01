# Troubleshooting

## Five-minute health check

Run from the repository root:

```bash
node --version
npm run runtime:info
npm run type-check
npm run test:flow
npm run build
git status --short --branch
```

For interactive-only problems, also run `npm run smoke:tui` and
`npm run baseline:terminal`.

Record the command, platform, Node version, terminal, workspace, time, and
reproduction steps before changing runtime data.

## Startup or configuration failure

Check the installed version and active profile:

```bash
turboflux --version
turboflux config show
turboflux setup show
```

Check whether `TURBOFLUX_CONFIG_DIR`, `TURBOFLUX_API_KEY`, or CLI overrides are
shadowing file configuration. Settings live in `config.json`; credentials live
in `credentials.json`. Remove secrets from logs and screenshots.

To isolate a user-data issue, run with temporary configuration:

```powershell
$env:TURBOFLUX_CONFIG_DIR = Join-Path $PWD '.tmp/diagnostic-config'
$env:TURBOFLUX_CONVERSATIONS_DIR = Join-Path $PWD '.tmp/diagnostic-conversations'
npm run dev:once -- .
```

## Model request failure

Check the active provider, model, base URL, context/output limits, API-key
override, proxy settings, and the provider's exact error class. Distinguish
authentication, model availability, unsupported parameters, rate limits, and
network timeouts. Protocol fallback is appropriate only before semantic stream
or tool progress; see [model protocol compatibility](../model-protocol-compatibility.md).

## TUI flicker, lag, or layout issues

Reduce variables first:

```powershell
$env:TURBOFLUX_REDUCED_MOTION = '1'
$env:TURBOFLUX_DESKTOP_NOTIFICATIONS = '0'
$env:TURBOFLUX_FLOW_WINDOWING = '1'
npm run dev:once -- . --no-animation
```

Record terminal size, resize behavior, terminal application/version, shell,
transparency mode, message count, and whether streaming is active. Use
`npm run perf:flow` for data-structure regressions and `npm run smoke:tui` for
full event-chain regressions.

## Missing or unrecoverable conversation

Conversations normally live in `~/.turboflux/conversations/`. Before repair:

1. Stop every process using the conversation.
2. Copy the target `.json` or `.jsonl` file to a separate backup directory.
3. Check that the final JSONL lines are complete JSON objects.
4. Use `/list` and `/resume` to validate the index and replay result.
5. Keep the original and use recovery export for a readable artifact.

The reader preserves a valid prefix and marks unfinished stream or tool records
as interrupted. If append still fails, check permissions, disk space, directory
overrides, and other processes holding the file.

## Background task or terminal residue

Use `/ps` to inspect runtime tasks and `/stop` to end a running task. Check for
start records without terminal records, child processes that ignore abort/kill,
unfinished stdout/stderr readers, mismatched owner sessions, or missing runtime
cleanup. Reproduce in `runtimeTaskManager.test.ts`, `nodeToolExecutor.test.ts`,
or `subAgentTaskManager.test.ts`.

## MCP connection failure

1. Validate the project or user `settings.json`.
2. Confirm the server is enabled.
3. Start with `--mcp <name>` or `--mcp all`.
4. Verify the command and arguments in the same shell.
5. Check the working directory used for relative paths.
6. Use `/mcp` to inspect connected servers and tools.

Approval prompts for MCP tools under normal policies are expected behavior.

## Git integration failure

Use read-only checks first:

```bash
git status --short --branch
git diff
git diff --cached
git log -5 --oneline
```

Keep existing staged content separate from agent changes. Supply explicit paths
to structured commits and record the revision before restore or revert.

## Local proxy service

Start and check the optional proxy:

```bash
npx tsx src/server/index.ts
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/models
```

Use `Authorization: Bearer <token>` when proxy auth is enabled. Non-local
binding requires `TURBOFLUX_PROXY_AUTH_TOKEN`.

## Bug reports

Include minimal reproduction steps, expected and actual behavior, TurboFlux/Node/
OS/shell/terminal versions, redacted configuration, relevant logs or events, and
the results of type-check, focused tests, and TUI smoke. Never attach API keys,
authorization headers, complete conversations, or private source.
