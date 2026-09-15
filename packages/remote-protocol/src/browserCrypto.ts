import { canonicalStringify, toJsonValue, type JsonValue } from './canonical'
import {
  REMOTE_PROTOCOL_VERSION,
  type CapabilityGrantPayload,
  type DevicePublicIdentity,
  type EncryptedRemoteEnvelope,
  type NodeDeviceIdentity,
  type PairingResponsePayload,
  type RemoteWireMessage,
  type SignedCapabilityGrant,
  type SignedPairingInvite,
  type SignedPairingResponse,
} from './types'

const PAIRING_PREFIX = 'tfrp1:'
const ENVELOPE_INFO = new TextEncoder().encode('turboflux-remote-envelope-v1')

function bytesToBase64Url(value: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    binary += String.fromCharCode(...value.subarray(offset, offset + chunkSize))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength)
  copy.set(value)
  return copy.buffer
}

function textValue(value: AllowSharedBufferSource): string {
  return new TextDecoder().decode(value)
}

function randomBase64Url(length: number): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(length)))
}

async function importSigningPublicKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', arrayBuffer(base64UrlToBytes(value)), 'Ed25519', true, ['verify'])
}

async function importSigningPrivateKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', arrayBuffer(base64UrlToBytes(value)), 'Ed25519', true, ['sign'])
}

async function importExchangePublicKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', arrayBuffer(base64UrlToBytes(value)), 'X25519', true, [])
}

async function importExchangePrivateKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', arrayBuffer(base64UrlToBytes(value)), 'X25519', true, ['deriveBits'])
}

async function signatureFor(value: JsonValue, privateKey: string): Promise<string> {
  const signature = await crypto.subtle.sign('Ed25519', await importSigningPrivateKey(privateKey), arrayBuffer(textBytes(canonicalStringify(value))))
  return bytesToBase64Url(new Uint8Array(signature))
}

async function verifySignature(value: JsonValue, signature: string, publicKey: string): Promise<boolean> {
  return crypto.subtle.verify('Ed25519', await importSigningPublicKey(publicKey), arrayBuffer(base64UrlToBytes(signature)), arrayBuffer(textBytes(canonicalStringify(value))))
}

async function identityId(signingPublicKey: string, exchangePublicKey: string): Promise<string> {
  const signing = base64UrlToBytes(signingPublicKey)
  const exchange = base64UrlToBytes(exchangePublicKey)
  const joined = new Uint8Array(signing.length + exchange.length)
  joined.set(signing)
  joined.set(exchange, signing.length)
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', arrayBuffer(joined))))
}

async function assertIdentity(identity: DevicePublicIdentity): Promise<void> {
  if (identity.protocolVersion !== REMOTE_PROTOCOL_VERSION) throw new Error('Unsupported device identity version')
  if (identity.deviceId !== await identityId(identity.signingPublicKey, identity.exchangePublicKey)) throw new Error('Device identity does not match its public keys')
  await Promise.all([importSigningPublicKey(identity.signingPublicKey), importExchangePublicKey(identity.exchangePublicKey)])
}

function envelopeAad(envelope: Pick<EncryptedRemoteEnvelope, 'protocolVersion' | 'messageId' | 'senderDeviceId' | 'recipientDeviceId' | 'createdAt' | 'ephemeralExchangePublicKey' | 'iv'>): Uint8Array {
  return textBytes(canonicalStringify(toJsonValue({
    protocolVersion: envelope.protocolVersion,
    messageId: envelope.messageId,
    senderDeviceId: envelope.senderDeviceId,
    recipientDeviceId: envelope.recipientDeviceId,
    createdAt: envelope.createdAt,
    ephemeralExchangePublicKey: envelope.ephemeralExchangePublicKey,
    iv: envelope.iv,
  })))
}

async function deriveEncryptionKey(privateKey: CryptoKey, publicKey: CryptoKey, messageId: string): Promise<CryptoKey> {
  const sharedSecret = await crypto.subtle.deriveBits({ name: 'X25519', public: publicKey } as EcdhKeyDeriveParams, privateKey, 256)
  const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: arrayBuffer(textBytes(messageId)), info: arrayBuffer(ENVELOPE_INFO) },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function createBrowserDeviceIdentity(displayName: string, now = Date.now()): Promise<NodeDeviceIdentity> {
  const signing = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair
  const exchange = await crypto.subtle.generateKey('X25519', true, ['deriveBits']) as CryptoKeyPair
  const signingPublicKey = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', signing.publicKey)))
  const exchangePublicKey = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', exchange.publicKey)))
  return {
    publicIdentity: {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      deviceId: await identityId(signingPublicKey, exchangePublicKey),
      displayName: displayName.trim().slice(0, 80) || 'TurboFlux mobile',
      signingPublicKey,
      exchangePublicKey,
      createdAt: now,
    },
    signingPrivateKey: bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', signing.privateKey))),
    exchangePrivateKey: bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', exchange.privateKey))),
  }
}

export async function verifyPairingInviteBrowser(invite: SignedPairingInvite, now = Date.now()): Promise<boolean> {
  try {
    await assertIdentity(invite.payload.host)
    if (invite.payload.protocolVersion !== REMOTE_PROTOCOL_VERSION) return false
    if (invite.payload.expiresAt < now || invite.payload.createdAt > now + 60_000) return false
    return verifySignature(toJsonValue(invite.payload), invite.signature, invite.payload.host.signingPublicKey)
  } catch {
    return false
  }
}

export async function decodePairingInviteBrowser(value: string, now = Date.now()): Promise<SignedPairingInvite> {
  if (!value.startsWith(PAIRING_PREFIX)) throw new Error('Invalid TurboFlux pairing code')
  const invite = JSON.parse(textValue(base64UrlToBytes(value.slice(PAIRING_PREFIX.length)))) as SignedPairingInvite
  if (!await verifyPairingInviteBrowser(invite, now)) throw new Error('Pairing invite is invalid or expired')
  return invite
}

export async function createPairingResponseBrowser(
  client: NodeDeviceIdentity,
  invite: SignedPairingInvite,
  requestedCapabilities: readonly CapabilityGrantPayload['capabilities'][number][],
  now = Date.now(),
): Promise<SignedPairingResponse> {
  if (!await verifyPairingInviteBrowser(invite, now)) throw new Error('Pairing invite is invalid or expired')
  await assertIdentity(client.publicIdentity)
  const offered = new Set(invite.payload.offeredCapabilities)
  const requested = [...new Set(requestedCapabilities)].sort()
  if (requested.some(capability => !offered.has(capability))) throw new Error('Pairing response requests unavailable capabilities')
  const payload: PairingResponsePayload = {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    inviteId: invite.payload.inviteId,
    inviteNonce: invite.payload.nonce,
    client: structuredClone(client.publicIdentity),
    requestedCapabilities: requested,
    createdAt: now,
  }
  return { payload, signature: await signatureFor(toJsonValue(payload), client.signingPrivateKey) }
}

export async function verifyCapabilityGrantBrowser(
  grant: SignedCapabilityGrant,
  issuer: DevicePublicIdentity,
  subject: DevicePublicIdentity,
  now = Date.now(),
): Promise<boolean> {
  try {
    await Promise.all([assertIdentity(issuer), assertIdentity(subject)])
    if (grant.payload.protocolVersion !== REMOTE_PROTOCOL_VERSION) return false
    if (grant.payload.issuerDeviceId !== issuer.deviceId || grant.payload.subjectDeviceId !== subject.deviceId) return false
    if (grant.payload.expiresAt < now || grant.payload.issuedAt > now + 60_000) return false
    return verifySignature(toJsonValue(grant.payload), grant.signature, issuer.signingPublicKey)
  } catch {
    return false
  }
}

export async function sealRemoteMessageBrowser(
  sender: NodeDeviceIdentity,
  recipient: DevicePublicIdentity,
  message: RemoteWireMessage,
  options: { now?: number; messageId?: string } = {},
): Promise<EncryptedRemoteEnvelope> {
  await Promise.all([assertIdentity(sender.publicIdentity), assertIdentity(recipient)])
  const ephemeral = await crypto.subtle.generateKey('X25519', true, ['deriveBits']) as CryptoKeyPair
  const ephemeralExchangePublicKey = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', ephemeral.publicKey)))
  const unsigned = {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    messageId: options.messageId ?? crypto.randomUUID(),
    senderDeviceId: sender.publicIdentity.deviceId,
    recipientDeviceId: recipient.deviceId,
    createdAt: options.now ?? Date.now(),
    ephemeralExchangePublicKey,
    iv: randomBase64Url(12),
  }
  const encryptionKey = await deriveEncryptionKey(ephemeral.privateKey, await importExchangePublicKey(recipient.exchangePublicKey), unsigned.messageId)
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: arrayBuffer(base64UrlToBytes(unsigned.iv)), additionalData: arrayBuffer(envelopeAad(unsigned)), tagLength: 128 },
    encryptionKey,
    arrayBuffer(textBytes(canonicalStringify(toJsonValue(message)))),
  ))
  const ciphertext = encrypted.subarray(0, encrypted.length - 16)
  const authTag = encrypted.subarray(encrypted.length - 16)
  const envelopeWithoutSignature = {
    ...unsigned,
    ciphertext: bytesToBase64Url(ciphertext),
    authTag: bytesToBase64Url(authTag),
  }
  return {
    ...envelopeWithoutSignature,
    signature: await signatureFor(toJsonValue(envelopeWithoutSignature), sender.signingPrivateKey),
  }
}

export async function openRemoteMessageBrowser(
  recipient: NodeDeviceIdentity,
  sender: DevicePublicIdentity,
  envelope: EncryptedRemoteEnvelope,
  options: { now?: number; maxClockSkewMs?: number } = {},
): Promise<RemoteWireMessage> {
  await Promise.all([assertIdentity(recipient.publicIdentity), assertIdentity(sender)])
  if (envelope.protocolVersion !== REMOTE_PROTOCOL_VERSION) throw new Error('Unsupported remote envelope version')
  if (envelope.senderDeviceId !== sender.deviceId || envelope.recipientDeviceId !== recipient.publicIdentity.deviceId) throw new Error('Remote envelope device identity mismatch')
  const now = options.now ?? Date.now()
  if (Math.abs(now - envelope.createdAt) > (options.maxClockSkewMs ?? 10 * 60_000)) throw new Error('Remote envelope timestamp is outside the accepted window')
  const { signature, ...unsigned } = envelope
  if (!await verifySignature(toJsonValue(unsigned), signature, sender.signingPublicKey)) throw new Error('Remote envelope signature is invalid')
  const encryptionKey = await deriveEncryptionKey(
    await importExchangePrivateKey(recipient.exchangePrivateKey),
    await importExchangePublicKey(envelope.ephemeralExchangePublicKey),
    envelope.messageId,
  )
  const ciphertext = base64UrlToBytes(envelope.ciphertext)
  const authTag = base64UrlToBytes(envelope.authTag)
  const combined = new Uint8Array(ciphertext.length + authTag.length)
  combined.set(ciphertext)
  combined.set(authTag, ciphertext.length)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: arrayBuffer(base64UrlToBytes(envelope.iv)), additionalData: arrayBuffer(envelopeAad(envelope)), tagLength: 128 },
    encryptionKey,
    arrayBuffer(combined),
  )
  const parsed = JSON.parse(textValue(plaintext)) as RemoteWireMessage
  if (!parsed || typeof parsed !== 'object' || !['command', 'result'].includes(parsed.kind)) throw new Error('Remote envelope payload is invalid')
  return parsed
}
