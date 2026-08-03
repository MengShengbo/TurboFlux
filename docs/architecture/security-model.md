# Security model

TurboFlux handles local source code, shell commands, Git data, provider
credentials, MCP tools, and optional local proxy services. The model combines
capability boundaries, approvals, path validation, credential separation, and
redacted telemetry.

## Credentials and data

- API keys live in `~/.turboflux/credentials.json` or the process environment;
  ordinary configuration files contain redacted values.
- Windows writes use the parent directory ACL and Node file mode by default to
  keep startup responsive; set `TURBOFLUX_STRICT_FILE_PERMISSIONS=1` to run
  synchronous `icacls` hardening for credentials.
- Logs, telemetry, errors, and tests must not include complete keys,
  authorization headers, private prompts, or source contents.
- Generated artifacts, benchmark output, conversation journals, and local server
  credentials stay outside committed source.

## Capabilities and approvals

- File operations resolve paths against the workspace capability boundary and
  reject escapes unless the active capability profile explicitly allows them.
- Shell, write, Git, network, MCP, and background-task actions carry tool metadata
  and pass through the approval policy.
- `ask`, `agent`, and `full` change confirmation behavior; they do not remove
  validation or error classification.
- Abort and cleanup paths revoke active grants and terminate child resources.

## MCP and proxy services

MCP is opt-in and uses configured stdio servers. The optional proxy binds to
`127.0.0.1:8787` by default. Non-local binding requires a proxy auth token, and
administrative, health, model-list, and `/v1/*` routes share the auth guard.

## Safe implementation rules

- Validate and normalize paths before opening files or spawning commands.
- Keep provider headers and request bodies out of diagnostic messages.
- Use bounded buffers for streamed text, reasoning, tool arguments, and tool output.
- Preserve journal integrity on crashes, cancellation, partial writes, and replay.
- Add tests for approval, capability, credential, path, and recovery boundaries with
  placeholder credentials and temporary workspaces.
