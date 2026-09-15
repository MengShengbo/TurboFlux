import { createHash } from 'node:crypto'

export const CONVERSATION_V2_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
export const CONVERSATION_V2_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const TURBOFLUX_CONVERSATION_NAMESPACE = Buffer.from('70dd573745ba554fb46af040ecd60f0a', 'hex')

export function isConversationV2Id(value: string): boolean {
  return CONVERSATION_V2_ID_PATTERN.test(value)
}

export function isConversationV2Uuid(value: string): boolean {
  return CONVERSATION_V2_UUID_PATTERN.test(value)
}

function legacyStableConversationV2Id(kind: string, ...parts: Array<string | number>): string {
  const digest = createHash('sha256').update(parts.join('\0')).digest('base64url').slice(0, 24)
  return `${kind}-${digest}`
}

function legacyNormalizeConversationV2Id(kind: string, value: string): string {
  return isConversationV2Id(value) ? value : legacyStableConversationV2Id(kind, value)
}

function legacyScopedConversationV2Id(kind: string, value: string): string {
  const candidate = `${kind}-${value}`
  return isConversationV2Id(candidate) ? candidate : legacyStableConversationV2Id(kind, value)
}

export function stableConversationV2Id(kind: string, ...parts: Array<string | number>): string {
  const digest = createHash('sha1')
    .update(TURBOFLUX_CONVERSATION_NAMESPACE)
    .update(kind)
    .update('\0')
    .update(parts.map(String).join('\0'))
    .digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function normalizeConversationV2Id(kind: string, value: string): string {
  return isConversationV2Uuid(value) ? value.toLowerCase() : stableConversationV2Id(kind, value)
}

export function scopedConversationV2Id(kind: string, value: string): string {
  return stableConversationV2Id(kind, value)
}

export interface ConversationV2IdFactory {
  canonical: boolean
  stable(kind: string, ...parts: Array<string | number>): string
  normalize(kind: string, value: string): string
  scoped(kind: string, value: string): string
}

export function conversationV2IdFactory(conversationId: string): ConversationV2IdFactory {
  if (isConversationV2Uuid(conversationId)) {
    return {
      canonical: true,
      stable: stableConversationV2Id,
      normalize: normalizeConversationV2Id,
      scoped: scopedConversationV2Id,
    }
  }
  return {
    canonical: false,
    stable: legacyStableConversationV2Id,
    normalize: legacyNormalizeConversationV2Id,
    scoped: legacyScopedConversationV2Id,
  }
}
