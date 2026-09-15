# TurboFlux Desktop Remote Protocol

`@turboflux/remote-protocol` provides the pairing, authorization, encryption, and synchronization protocol for TurboFlux Desktop remote control.

The protocol uses device-held keys, QR pairing, signed capability grants, encrypted envelopes, idempotent commands, and resumable event cursors. Agent state and provider credentials remain on the execution host. Relays are optional and are never trusted with plaintext.

The package contains protocol contracts, host and browser adapters, an HTTP gateway, and transport interfaces. Agent execution and product UI remain in Agent Core and Desktop.

The `RemoteAgentAdapter` interface separates Desktop runtime integration from the wire protocol.

`TurboFluxRemoteAdapter` is the native projection for `DesktopRuntimeHost`. It exposes session summaries, the visible active transcript, approvals, and bounded artifact chunks without serializing workspace paths, artifact paths, hidden system turns, API configuration, or runtime internals.

Capability grants with an empty `workspaceIds` list are host-wide. A non-empty list is a strict allowlist applied to commands, snapshots, and resumable events.

`RemoteHostService` owns the native adapter, pairing authority, grant registry, encrypted gateway, device revocation, and restart-safe trust state. `NodeRemoteStateStore` writes atomically with owner-only permissions and accepts platform protection callbacks such as Electron `safeStorage`.

The browser client uses `RemoteClientTransport`. `HttpRemoteTransport` works against the self-hosted `RemoteHttpGateway`; `IrohRemoteTransport` and `IrohRemoteEndpoint` adapt the same messages to a host-injected byte channel. A native Iroh endpoint is not included. Remote browser access requires trusted HTTPS; plain HTTP is limited to loopback debugging.

Each browser page has a non-persisted `clientInstanceId`. Read-only snapshots and event synchronization do not require the exclusive control lease. Mutating runtime commands require a short lease that can only be claimed with `session.control`; only one page can hold it at a time, and another controller receives `control_session_in_use` until it explicitly claims with takeover enabled. Revoking the grant, stopping the remote session, closing the host, or allowing the lease to expire clears the active controller.
