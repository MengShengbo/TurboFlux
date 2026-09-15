import { describe, expect, it } from 'vitest'
import {
  NodePairingAuthority,
  createNodeDeviceIdentity,
  createPairingResponse,
  decodePairingInvite,
  encodePairingInvite,
  openRemoteMessage,
  sealRemoteMessage,
  verifyCapabilityGrant,
} from './nodeCrypto'
import { REMOTE_PROTOCOL_VERSION, type RemoteCommand } from './types'

describe('remote device security', () => {
  it('pairs two devices through a single-use signed QR invite', () => {
    let now = 1_780_000_000_000
    const host = createNodeDeviceIdentity('Home Mac', now)
    const client = createNodeDeviceIdentity('Phone', now)
    const authority = new NodePairingAuthority(host, () => now)
    const invite = authority.createInvite(
      ['session.read', 'session.submit', 'approval.resolve'],
      [{ kind: 'iroh', value: 'endpoint-home' }],
      60_000,
    )
    const decoded = decodePairingInvite(encodePairingInvite(invite), now)
    const response = createPairingResponse(client, decoded, ['session.read', 'approval.resolve'], now)
    const grant = authority.accept(response, { workspaceIds: ['workspace-main'] })

    expect(grant.payload.capabilities).toEqual(['approval.resolve', 'session.read'])
    expect(grant.payload.workspaceIds).toEqual(['workspace-main'])
    expect(verifyCapabilityGrant(grant, host.publicIdentity, client.publicIdentity, now)).toBe(true)
    expect(() => authority.accept(response)).toThrow(/already used|unavailable/)

    now += 60_001
    expect(() => decodePairingInvite(encodePairingInvite(invite), now)).toThrow(/expired/)
  })

  it('encrypts, authenticates, and rejects tampered messages', () => {
    const now = 1_780_000_100_000
    const host = createNodeDeviceIdentity('Home Mac', now)
    const client = createNodeDeviceIdentity('Phone', now)
    const command: RemoteCommand = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      commandId: 'command-1',
      clientInstanceId: 'client-1',
      createdAt: now,
      type: 'sync.snapshot',
    }
    const envelope = sealRemoteMessage(client, host.publicIdentity, { kind: 'command', grantId: 'grant-1', command }, { now })
    expect(openRemoteMessage(host, client.publicIdentity, envelope, { now })).toEqual({
      kind: 'command',
      grantId: 'grant-1',
      command,
    })

    const tampered = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}AA` }
    expect(() => openRemoteMessage(host, client.publicIdentity, tampered, { now })).toThrow(/signature/)
  })
})
