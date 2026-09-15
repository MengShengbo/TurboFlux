import { toJsonValue, type JsonValue } from './canonical'
import {
  createBrowserDeviceIdentity,
  createPairingResponseBrowser,
  decodePairingInviteBrowser,
  openRemoteMessageBrowser,
  sealRemoteMessageBrowser,
  verifyCapabilityGrantBrowser,
} from './browserCrypto'
import { type RemoteClientTransport } from './browserTransport'
import {
  REMOTE_PROTOCOL_VERSION,
  type DevicePublicIdentity,
  type NodeDeviceIdentity,
  type RemoteCapability,
  type RemoteCommand,
  type RemoteCommandResult,
  type RemoteControlSessionSummary,
  type RemoteEventWindow,
  type SignedCapabilityGrant,
} from './types'

type RemoteCommandInput = RemoteCommand extends infer Command
  ? Command extends RemoteCommand
    ? Omit<Command, 'protocolVersion' | 'commandId' | 'clientInstanceId' | 'createdAt'>
    : never
  : never

export interface PairedRemoteClientState {
  schemaVersion: 1
  identity: NodeDeviceIdentity
  host: DevicePublicIdentity
  grant: SignedCapabilityGrant
}

export interface PairRemoteClientOptions {
  identity?: NodeDeviceIdentity
  displayName?: string
  capabilities?: readonly RemoteCapability[]
  now?: number | (() => number)
  clientInstanceId?: string
}

export class RemoteCommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RemoteCommandError'
  }
}

export class RemoteBrowserClient {
  private constructor(
    readonly state: PairedRemoteClientState,
    private readonly transport: RemoteClientTransport,
    readonly clientInstanceId: string,
  ) {}

  static async pair(code: string, transport: RemoteClientTransport, options: PairRemoteClientOptions = {}): Promise<RemoteBrowserClient> {
    const now = typeof options.now === 'function' ? options.now() : options.now ?? Date.now()
    const invite = await decodePairingInviteBrowser(code, now)
    const identity = options.identity ?? await createBrowserDeviceIdentity(options.displayName ?? 'TurboFlux mobile', now)
    const requested = options.capabilities ?? invite.payload.offeredCapabilities
    const response = await createPairingResponseBrowser(identity, invite, requested, now)
    const grant = await transport.pair(response)
    const verificationTime = typeof options.now === 'function' ? options.now() : options.now ?? Date.now()
    if (!await verifyCapabilityGrantBrowser(grant, invite.payload.host, identity.publicIdentity, verificationTime)) throw new Error('Remote host returned an invalid capability grant')
    return new RemoteBrowserClient({ schemaVersion: 1, identity, host: invite.payload.host, grant }, transport, options.clientInstanceId ?? crypto.randomUUID())
  }

  static async restore(state: PairedRemoteClientState, transport: RemoteClientTransport, now = Date.now(), clientInstanceId = crypto.randomUUID()): Promise<RemoteBrowserClient> {
    if (state.schemaVersion !== 1 || !await verifyCapabilityGrantBrowser(state.grant, state.host, state.identity.publicIdentity, now)) {
      throw new Error('Saved remote pairing is invalid or expired')
    }
    return new RemoteBrowserClient(structuredClone(state), transport, clientInstanceId)
  }

  async claimControl(takeover = false): Promise<RemoteControlSessionSummary> {
    return this.expectData(await this.execute(this.command({ type: 'control.claim', takeover }))) as unknown as RemoteControlSessionSummary
  }

  async releaseControl(): Promise<void> {
    this.expectData(await this.execute(this.command({ type: 'control.release' })))
  }

  async execute(command: RemoteCommand): Promise<RemoteCommandResult> {
    const request = await sealRemoteMessageBrowser(this.state.identity, this.state.host, {
      kind: 'command',
      grantId: this.state.grant.payload.grantId,
      command,
    })
    let responseEnvelope
    try {
      responseEnvelope = await this.transport.exchange(request)
    } catch {
      responseEnvelope = await this.transport.exchange(request)
    }
    const response = await openRemoteMessageBrowser(this.state.identity, this.state.host, responseEnvelope)
    if (response.kind !== 'result') throw new Error('Remote client expected a command result')
    if (response.result.commandId !== command.commandId) throw new Error('Remote result does not match its command')
    return response.result
  }

  async snapshot(): Promise<JsonValue> {
    return this.expectData(await this.execute(this.command({ type: 'sync.snapshot' })))
  }

  async events(afterSeq: number): Promise<RemoteEventWindow> {
    return this.expectData(await this.execute(this.command({ type: 'sync.events', afterSeq }))) as unknown as RemoteEventWindow
  }

  async submit(adapterId: string, sessionId: string, prompt: string, mode: 'turn' | 'queue' | 'steer' = 'turn'): Promise<JsonValue> {
    return this.submitPrepared(this.prepareSubmit(adapterId, sessionId, prompt, mode))
  }

  prepareSubmit(adapterId: string, sessionId: string, prompt: string, mode: 'turn' | 'queue' | 'steer' = 'turn'): Extract<RemoteCommand, { type: 'session.submit' }> {
    return this.command({ type: 'session.submit', adapterId, sessionId, prompt, mode }) as Extract<RemoteCommand, { type: 'session.submit' }>
  }

  async submitPrepared(command: Extract<RemoteCommand, { type: 'session.submit' }>): Promise<JsonValue> {
    return this.expectData(await this.execute(command))
  }

  async activateSession(adapterId: string, sessionId: string): Promise<JsonValue> {
    return this.expectData(await this.execute(this.command({ type: 'session.activate', adapterId, sessionId })))
  }

  async control(adapterId: string, sessionId: string, action: 'pause' | 'resume' | 'stop'): Promise<JsonValue> {
    return this.expectData(await this.execute(this.command({ type: 'session.control', adapterId, sessionId, action })))
  }

  async resolveApproval(adapterId: string, sessionId: string, requestId: string, response: string): Promise<JsonValue> {
    return this.expectData(await this.execute(this.command({ type: 'approval.resolve', adapterId, sessionId, requestId, response })))
  }

  async listArtifacts(adapterId: string, sessionId?: string): Promise<JsonValue> {
    return this.expectData(await this.execute(this.command({ type: 'artifact.list', adapterId, sessionId })))
  }

  async readArtifact(adapterId: string, artifactId: string, offset = 0, length?: number): Promise<JsonValue> {
    return this.expectData(await this.execute(this.command({ type: 'artifact.read', adapterId, artifactId, offset, length })))
  }

  close(): Promise<void> | void {
    return this.transport.close?.()
  }

  private command(value: RemoteCommandInput): RemoteCommand {
    return {
      ...value,
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      commandId: crypto.randomUUID(),
      clientInstanceId: this.clientInstanceId,
      createdAt: Date.now(),
    } as RemoteCommand
  }

  private expectData(result: RemoteCommandResult): JsonValue {
    if (!result.ok) throw new RemoteCommandError(result.error?.code || 'remote_command_failed', result.error?.message || 'Remote command failed')
    return result.data ?? toJsonValue(null)
  }
}
