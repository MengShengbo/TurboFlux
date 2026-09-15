import { type RemoteByteChannel } from './browserTransport'
import { type RemoteHostService } from './remoteHostService'
import { type EncryptedRemoteEnvelope, type SignedPairingResponse } from './types'

interface IrohRequest {
  kind: 'pair' | 'pair.status' | 'exchange'
  response?: SignedPairingResponse
  requestId?: string
  pollToken?: string
  envelope?: EncryptedRemoteEnvelope
}

export class IrohRemoteEndpoint<TEvent = unknown> {
  constructor(private readonly service: RemoteHostService<TEvent>) {}

  async handle(payload: Uint8Array): Promise<Uint8Array> {
    try {
      const request = JSON.parse(new TextDecoder().decode(payload)) as IrohRequest
      const data = request.kind === 'pair'
        ? this.service.requestPairing(request.response!)
        : request.kind === 'pair.status'
          ? this.service.pairingStatus(request.requestId!, request.pollToken!)
          : await this.service.handle(request.envelope!)
      return new TextEncoder().encode(JSON.stringify({ ok: true, data }))
    } catch (error) {
      return new TextEncoder().encode(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    }
  }

  loopbackChannel(): RemoteByteChannel {
    return { request: payload => this.handle(payload) }
  }
}
