import { openRemoteMessage, sealRemoteMessage } from './nodeCrypto'
import { RemoteHostController } from './host'
import {
  type DevicePublicIdentity,
  type EncryptedRemoteEnvelope,
  type NodeDeviceIdentity,
  type RemoteCommand,
  type RemoteCommandResult,
  type SignedCapabilityGrant,
} from './types'

export class RemoteSecureGateway {
  private readonly responsesByMessageId = new Map<string, EncryptedRemoteEnvelope>()
  private readonly observedMessageOrder: string[] = []

  constructor(
    private readonly host: NodeDeviceIdentity,
    private readonly controller: RemoteHostController,
    private readonly replayWindow = 4_096,
  ) {}

  async handle(envelope: EncryptedRemoteEnvelope, sender: DevicePublicIdentity): Promise<EncryptedRemoteEnvelope> {
    if (envelope.senderDeviceId !== sender.deviceId || envelope.recipientDeviceId !== this.host.publicIdentity.deviceId) {
      throw new Error('Remote envelope device identity mismatch')
    }
    const cacheKey = `${sender.deviceId}:${envelope.messageId}`
    const cached = this.responsesByMessageId.get(cacheKey)
    if (cached) return structuredClone(cached)
    const message = openRemoteMessage(this.host, sender, envelope)
    if (message.kind !== 'command') throw new Error('Remote gateway expected a command')
    const result = await this.controller.execute(sender, message.grantId, message.command)
    const response = sealRemoteMessage(this.host, sender, { kind: 'result', result })
    this.rememberResponse(cacheKey, response)
    return response
  }

  private rememberResponse(cacheKey: string, response: EncryptedRemoteEnvelope): void {
    this.responsesByMessageId.set(cacheKey, structuredClone(response))
    this.observedMessageOrder.push(cacheKey)
    while (this.observedMessageOrder.length > this.replayWindow) {
      const oldest = this.observedMessageOrder.shift()
      if (oldest) this.responsesByMessageId.delete(oldest)
    }
  }
}

export class RemoteSecureClient {
  constructor(
    readonly identity: NodeDeviceIdentity,
    readonly host: DevicePublicIdentity,
    readonly grant: SignedCapabilityGrant,
  ) {}

  async execute(gateway: RemoteSecureGateway, command: RemoteCommand): Promise<RemoteCommandResult> {
    const request = sealRemoteMessage(this.identity, this.host, {
      kind: 'command',
      grantId: this.grant.payload.grantId,
      command,
    })
    const responseEnvelope = await gateway.handle(request, this.identity.publicIdentity)
    const response = openRemoteMessage(this.identity, this.host, responseEnvelope)
    if (response.kind !== 'result') throw new Error('Remote client expected a command result')
    return response.result
  }
}
