import { describe, expect, it } from 'vitest'
import {
  createBrowserDeviceIdentity,
  createPairingResponseBrowser,
  decodePairingInviteBrowser,
  openRemoteMessageBrowser,
  sealRemoteMessageBrowser,
  verifyCapabilityGrantBrowser,
} from './browserCrypto'
import {
  createCapabilityGrant,
  createNodeDeviceIdentity,
  createPairingInvite,
  encodePairingInvite,
  openRemoteMessage,
  sealRemoteMessage,
} from './nodeCrypto'
import { REMOTE_PROTOCOL_VERSION, type RemoteCommand } from './types'

describe('browser crypto interoperability', () => {
  it('pairs and exchanges encrypted messages with the Node host', async () => {
    const now = 1_780_000_400_000
    const host = createNodeDeviceIdentity('Home Mac', now)
    const phone = await createBrowserDeviceIdentity('Phone', now)
    const invite = createPairingInvite(host, ['session.read'], [{ kind: 'iroh', value: 'endpoint-1' }], { now })
    const decoded = await decodePairingInviteBrowser(encodePairingInvite(invite), now)
    const response = await createPairingResponseBrowser(phone, decoded, ['session.read'], now)
    expect(response.payload.client.deviceId).toBe(phone.publicIdentity.deviceId)

    const grant = createCapabilityGrant(host, phone.publicIdentity, ['session.read'], [], { now })
    expect(await verifyCapabilityGrantBrowser(grant, host.publicIdentity, phone.publicIdentity, now)).toBe(true)
    const command: RemoteCommand = { protocolVersion: REMOTE_PROTOCOL_VERSION, commandId: 'command-1', clientInstanceId: 'client-1', createdAt: now, type: 'sync.snapshot' }
    const browserEnvelope = await sealRemoteMessageBrowser(phone, host.publicIdentity, { kind: 'command', grantId: grant.payload.grantId, command }, { now })
    expect(openRemoteMessage(host, phone.publicIdentity, browserEnvelope, { now })).toMatchObject({ kind: 'command', command })

    const nodeEnvelope = sealRemoteMessage(host, phone.publicIdentity, { kind: 'result', result: { protocolVersion: REMOTE_PROTOCOL_VERSION, commandId: command.commandId, ok: true } }, { now })
    expect(await openRemoteMessageBrowser(phone, host.publicIdentity, nodeEnvelope, { now })).toMatchObject({ kind: 'result', result: { ok: true } })
  })
})
