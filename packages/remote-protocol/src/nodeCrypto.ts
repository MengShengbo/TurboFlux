import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'
import { canonicalStringify, toJsonValue, type JsonValue } from './canonical'
import {
  REMOTE_PROTOCOL_VERSION,
  type CapabilityGrantPayload,
  type DevicePublicIdentity,
  type EncryptedRemoteEnvelope,
  type NodeDeviceIdentity,
  type PairingEndpointHint,
  type PairingInvitePayload,
  type PairingResponsePayload,
  type RemoteCapability,
  type RemoteWireMessage,
  type SignedCapabilityGrant,
  type SignedPairingInvite,
  type SignedPairingResponse,
} from './types'

const PAIRING_PREFIX = 'tfrp1:'
const ENVELOPE_INFO = Buffer.from('turboflux-remote-envelope-v1', 'utf8')

function encodeKey(key: KeyObject, type: 'spki' | 'pkcs8'): string {
  return Buffer.from(key.export({ format: 'der', type })).toString('base64url')
}

function decodePublicKey(value: string): KeyObject {
  return createPublicKey({ key: Buffer.from(value, 'base64url'), format: 'der', type: 'spki' })
}

function decodePrivateKey(value: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(value, 'base64url'), format: 'der', type: 'pkcs8' })
}

function signatureFor(value: JsonValue, privateKey: string): string {
  return sign(null, Buffer.from(canonicalStringify(value), 'utf8'), decodePrivateKey(privateKey)).toString('base64url')
}

function verifySignature(value: JsonValue, signature: string, publicKey: string): boolean {
  return verify(
    null,
    Buffer.from(canonicalStringify(value), 'utf8'),
    decodePublicKey(publicKey),
    Buffer.from(signature, 'base64url'),
  )
}

function identityId(signingPublicKey: string, exchangePublicKey: string): string {
  return createHash('sha256')
    .update(Buffer.from(signingPublicKey, 'base64url'))
    .update(Buffer.from(exchangePublicKey, 'base64url'))
    .digest('base64url')
}

function assertIdentity(identity: DevicePublicIdentity): void {
  if (identity.protocolVersion !== REMOTE_PROTOCOL_VERSION) throw new Error('Unsupported device identity version')
  if (identity.deviceId !== identityId(identity.signingPublicKey, identity.exchangePublicKey)) throw new Error('Device identity does not match its public keys')
  decodePublicKey(identity.signingPublicKey)
  decodePublicKey(identity.exchangePublicKey)
}

function uniqueCapabilities(capabilities: readonly RemoteCapability[]): RemoteCapability[] {
  return [...new Set(capabilities)].sort()
}

export function createNodeDeviceIdentity(displayName: string, now = Date.now()): NodeDeviceIdentity {
  const signing = generateKeyPairSync('ed25519')
  const exchange = generateKeyPairSync('x25519')
  const signingPublicKey = encodeKey(signing.publicKey, 'spki')
  const exchangePublicKey = encodeKey(exchange.publicKey, 'spki')
  return {
    publicIdentity: {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      deviceId: identityId(signingPublicKey, exchangePublicKey),
      displayName: displayName.trim().slice(0, 80) || 'TurboFlux device',
      signingPublicKey,
      exchangePublicKey,
      createdAt: now,
    },
    signingPrivateKey: encodeKey(signing.privateKey, 'pkcs8'),
    exchangePrivateKey: encodeKey(exchange.privateKey, 'pkcs8'),
  }
}

export function createPairingInvite(
  host: NodeDeviceIdentity,
  offeredCapabilities: readonly RemoteCapability[],
  endpointHints: readonly PairingEndpointHint[],
  options: { now?: number; ttlMs?: number } = {},
): SignedPairingInvite {
  assertIdentity(host.publicIdentity)
  const createdAt = options.now ?? Date.now()
  const payload: PairingInvitePayload = {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    inviteId: randomUUID(),
    host: structuredClone(host.publicIdentity),
    nonce: randomBytes(24).toString('base64url'),
    offeredCapabilities: uniqueCapabilities(offeredCapabilities),
    endpointHints: endpointHints.map(hint => ({ ...hint })),
    createdAt,
    expiresAt: createdAt + Math.max(10_000, options.ttlMs ?? 5 * 60_000),
  }
  return { payload, signature: signatureFor(toJsonValue(payload), host.signingPrivateKey) }
}

export function verifyPairingInvite(invite: SignedPairingInvite, now = Date.now()): boolean {
  try {
    assertIdentity(invite.payload.host)
    if (invite.payload.protocolVersion !== REMOTE_PROTOCOL_VERSION) return false
    if (invite.payload.expiresAt < now || invite.payload.createdAt > now + 60_000) return false
    return verifySignature(toJsonValue(invite.payload), invite.signature, invite.payload.host.signingPublicKey)
  } catch {
    return false
  }
}

export function encodePairingInvite(invite: SignedPairingInvite): string {
  return `${PAIRING_PREFIX}${Buffer.from(canonicalStringify(toJsonValue(invite)), 'utf8').toString('base64url')}`
}

export function decodePairingInvite(value: string, now = Date.now()): SignedPairingInvite {
  if (!value.startsWith(PAIRING_PREFIX)) throw new Error('Invalid TurboFlux pairing code')
  const invite = JSON.parse(Buffer.from(value.slice(PAIRING_PREFIX.length), 'base64url').toString('utf8')) as SignedPairingInvite
  if (!verifyPairingInvite(invite, now)) throw new Error('Pairing invite is invalid or expired')
  return invite
}

export function createPairingResponse(
  client: NodeDeviceIdentity,
  invite: SignedPairingInvite,
  requestedCapabilities: readonly RemoteCapability[],
  now = Date.now(),
): SignedPairingResponse {
  if (!verifyPairingInvite(invite, now)) throw new Error('Pairing invite is invalid or expired')
  assertIdentity(client.publicIdentity)
  const offered = new Set(invite.payload.offeredCapabilities)
  const requested = uniqueCapabilities(requestedCapabilities)
  if (requested.some(capability => !offered.has(capability))) throw new Error('Pairing response requests unavailable capabilities')
  const payload: PairingResponsePayload = {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    inviteId: invite.payload.inviteId,
    inviteNonce: invite.payload.nonce,
    client: structuredClone(client.publicIdentity),
    requestedCapabilities: requested,
    createdAt: now,
  }
  return { payload, signature: signatureFor(toJsonValue(payload), client.signingPrivateKey) }
}

export function verifyPairingResponse(response: SignedPairingResponse, invite: SignedPairingInvite, now = Date.now()): boolean {
  try {
    if (!verifyPairingInvite(invite, now)) return false
    assertIdentity(response.payload.client)
    if (response.payload.protocolVersion !== REMOTE_PROTOCOL_VERSION) return false
    if (response.payload.inviteId !== invite.payload.inviteId || response.payload.inviteNonce !== invite.payload.nonce) return false
    if (response.payload.createdAt < invite.payload.createdAt || response.payload.createdAt > now + 60_000) return false
    const offered = new Set(invite.payload.offeredCapabilities)
    if (response.payload.requestedCapabilities.some(capability => !offered.has(capability))) return false
    return verifySignature(toJsonValue(response.payload), response.signature, response.payload.client.signingPublicKey)
  } catch {
    return false
  }
}

export function createCapabilityGrant(
  host: NodeDeviceIdentity,
  subject: DevicePublicIdentity,
  capabilities: readonly RemoteCapability[],
  workspaceIds: readonly string[],
  options: { now?: number; ttlMs?: number } = {},
): SignedCapabilityGrant {
  assertIdentity(host.publicIdentity)
  assertIdentity(subject)
  const issuedAt = options.now ?? Date.now()
  const payload: CapabilityGrantPayload = {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    grantId: randomUUID(),
    issuerDeviceId: host.publicIdentity.deviceId,
    subjectDeviceId: subject.deviceId,
    capabilities: uniqueCapabilities(capabilities),
    workspaceIds: [...new Set(workspaceIds)].sort(),
    issuedAt,
    expiresAt: issuedAt + Math.max(60_000, options.ttlMs ?? 30 * 24 * 60 * 60_000),
  }
  return { payload, signature: signatureFor(toJsonValue(payload), host.signingPrivateKey) }
}

export function verifyCapabilityGrant(
  grant: SignedCapabilityGrant,
  issuer: DevicePublicIdentity,
  subject: DevicePublicIdentity,
  now = Date.now(),
): boolean {
  try {
    assertIdentity(issuer)
    assertIdentity(subject)
    if (grant.payload.protocolVersion !== REMOTE_PROTOCOL_VERSION) return false
    if (grant.payload.issuerDeviceId !== issuer.deviceId || grant.payload.subjectDeviceId !== subject.deviceId) return false
    if (grant.payload.expiresAt < now || grant.payload.issuedAt > now + 60_000) return false
    return verifySignature(toJsonValue(grant.payload), grant.signature, issuer.signingPublicKey)
  } catch {
    return false
  }
}

function envelopeSigningValue(envelope: Omit<EncryptedRemoteEnvelope, 'signature'>): JsonValue {
  return toJsonValue(envelope)
}

function envelopeAad(envelope: Pick<EncryptedRemoteEnvelope, 'protocolVersion' | 'messageId' | 'senderDeviceId' | 'recipientDeviceId' | 'createdAt' | 'ephemeralExchangePublicKey' | 'iv'>): Buffer {
  const aad = {
    protocolVersion: envelope.protocolVersion,
    messageId: envelope.messageId,
    senderDeviceId: envelope.senderDeviceId,
    recipientDeviceId: envelope.recipientDeviceId,
    createdAt: envelope.createdAt,
    ephemeralExchangePublicKey: envelope.ephemeralExchangePublicKey,
    iv: envelope.iv,
  }
  return Buffer.from(canonicalStringify(toJsonValue(aad)), 'utf8')
}

export function sealRemoteMessage(
  sender: NodeDeviceIdentity,
  recipient: DevicePublicIdentity,
  message: RemoteWireMessage,
  options: { now?: number; messageId?: string } = {},
): EncryptedRemoteEnvelope {
  assertIdentity(sender.publicIdentity)
  assertIdentity(recipient)
  const ephemeral = generateKeyPairSync('x25519')
  const ephemeralExchangePublicKey = encodeKey(ephemeral.publicKey, 'spki')
  const messageId = options.messageId ?? randomUUID()
  const createdAt = options.now ?? Date.now()
  const iv = randomBytes(12)
  const sharedSecret = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: decodePublicKey(recipient.exchangePublicKey) })
  const encryptionKey = Buffer.from(hkdfSync('sha256', sharedSecret, Buffer.from(messageId, 'utf8'), ENVELOPE_INFO, 32))
  const unsigned: Omit<EncryptedRemoteEnvelope, 'signature' | 'ciphertext' | 'authTag'> = {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    messageId,
    senderDeviceId: sender.publicIdentity.deviceId,
    recipientDeviceId: recipient.deviceId,
    createdAt,
    ephemeralExchangePublicKey,
    iv: iv.toString('base64url'),
  }
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
  cipher.setAAD(envelopeAad(unsigned))
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(canonicalStringify(toJsonValue(message)), 'utf8')),
    cipher.final(),
  ])
  const envelopeWithoutSignature: Omit<EncryptedRemoteEnvelope, 'signature'> = {
    ...unsigned,
    ciphertext: ciphertext.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
  }
  return {
    ...envelopeWithoutSignature,
    signature: signatureFor(envelopeSigningValue(envelopeWithoutSignature), sender.signingPrivateKey),
  }
}

export function openRemoteMessage(
  recipient: NodeDeviceIdentity,
  sender: DevicePublicIdentity,
  envelope: EncryptedRemoteEnvelope,
  options: { now?: number; maxClockSkewMs?: number } = {},
): RemoteWireMessage {
  assertIdentity(recipient.publicIdentity)
  assertIdentity(sender)
  if (envelope.protocolVersion !== REMOTE_PROTOCOL_VERSION) throw new Error('Unsupported remote envelope version')
  if (envelope.senderDeviceId !== sender.deviceId || envelope.recipientDeviceId !== recipient.publicIdentity.deviceId) throw new Error('Remote envelope device identity mismatch')
  const now = options.now ?? Date.now()
  if (Math.abs(now - envelope.createdAt) > (options.maxClockSkewMs ?? 10 * 60_000)) throw new Error('Remote envelope timestamp is outside the accepted window')
  const { signature, ...unsigned } = envelope
  if (!verifySignature(envelopeSigningValue(unsigned), signature, sender.signingPublicKey)) throw new Error('Remote envelope signature is invalid')
  const ephemeralPublicKey = decodePublicKey(envelope.ephemeralExchangePublicKey)
  const sharedSecret = diffieHellman({ privateKey: decodePrivateKey(recipient.exchangePrivateKey), publicKey: ephemeralPublicKey })
  const encryptionKey = Buffer.from(hkdfSync('sha256', sharedSecret, Buffer.from(envelope.messageId, 'utf8'), ENVELOPE_INFO, 32))
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(envelope.iv, 'base64url'))
  decipher.setAAD(envelopeAad(envelope))
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64url'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
    decipher.final(),
  ])
  const parsed = JSON.parse(plaintext.toString('utf8')) as RemoteWireMessage
  if (!parsed || typeof parsed !== 'object' || !['command', 'result'].includes(parsed.kind)) throw new Error('Remote envelope payload is invalid')
  return parsed
}

export class NodePairingAuthority {
  private readonly pendingInvites = new Map<string, SignedPairingInvite>()
  private readonly consumedInviteIds = new Set<string>()

  constructor(private readonly host: NodeDeviceIdentity, private readonly now: () => number = Date.now) {}

  createInvite(
    offeredCapabilities: readonly RemoteCapability[],
    endpointHints: readonly PairingEndpointHint[],
    ttlMs?: number,
  ): SignedPairingInvite {
    const invite = createPairingInvite(this.host, offeredCapabilities, endpointHints, { now: this.now(), ttlMs })
    this.pendingInvites.set(invite.payload.inviteId, invite)
    return invite
  }

  accept(
    response: SignedPairingResponse,
    options: { capabilities?: readonly RemoteCapability[]; workspaceIds?: readonly string[]; ttlMs?: number } = {},
  ): SignedCapabilityGrant {
    const invite = this.inspectResponse(response)
    const requested = new Set(response.payload.requestedCapabilities)
    const capabilities = uniqueCapabilities(options.capabilities ?? response.payload.requestedCapabilities)
    if (capabilities.some(capability => !requested.has(capability))) throw new Error('Capability grant exceeds the pairing request')
    this.pendingInvites.delete(response.payload.inviteId)
    this.consumedInviteIds.add(response.payload.inviteId)
    return createCapabilityGrant(this.host, response.payload.client, capabilities, options.workspaceIds ?? [], {
      now: this.now(),
      ttlMs: options.ttlMs,
    })
  }

  inspectResponse(response: SignedPairingResponse): SignedPairingInvite {
    const invite = this.pendingInvites.get(response.payload.inviteId)
    if (!invite || this.consumedInviteIds.has(response.payload.inviteId)) throw new Error('Pairing invite is unavailable or already used')
    if (!verifyPairingResponse(response, invite, this.now())) throw new Error('Pairing response is invalid')
    return structuredClone(invite)
  }

  reject(inviteId: string): void {
    if (!this.pendingInvites.has(inviteId)) return
    this.pendingInvites.delete(inviteId)
    this.consumedInviteIds.add(inviteId)
  }

  invalidateAll(): void {
    for (const inviteId of this.pendingInvites.keys()) this.consumedInviteIds.add(inviteId)
    this.pendingInvites.clear()
  }
}
