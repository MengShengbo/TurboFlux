import { describe, expect, it } from 'vitest'
import {
  isConversationV2Id,
  isConversationV2Uuid,
  conversationV2IdFactory,
  normalizeConversationV2Id,
  scopedConversationV2Id,
  stableConversationV2Id,
} from './conversationV2Ids'

describe('Conversation V2 identities', () => {
  it('generates deterministic RFC UUID identities for derived records', () => {
    const first = stableConversationV2Id('item', 'conversation-1', 'turn-1')
    expect(first).toBe(stableConversationV2Id('item', 'conversation-1', 'turn-1'))
    expect(first).not.toBe(stableConversationV2Id('turn', 'conversation-1', 'turn-1'))
    expect(isConversationV2Uuid(first)).toBe(true)
  })

  it('normalizes legacy coordinates while preserving canonical UUIDs', () => {
    const canonical = 'A47AC10B-58CC-4372-A567-0E02B2C3D479'
    expect(normalizeConversationV2Id('turn', canonical)).toBe(canonical.toLowerCase())
    expect(isConversationV2Uuid(normalizeConversationV2Id('turn', 'legacy:turn/1'))).toBe(true)
    expect(isConversationV2Uuid(scopedConversationV2Id('message', canonical))).toBe(true)
    expect(isConversationV2Id('legacy-compatible-id')).toBe(true)
  })

  it('keeps established non-UUID conversations on their legacy identity generation', () => {
    const legacy = conversationV2IdFactory('conversation-legacy')
    const canonical = conversationV2IdFactory('a47ac10b-58cc-4372-a567-0e02b2c3d479')
    expect(legacy.canonical).toBe(false)
    expect(legacy.normalize('turn', 'turn-1')).toBe('turn-1')
    expect(legacy.scoped('message', 'turn-1')).toBe('message-turn-1')
    expect(canonical.canonical).toBe(true)
    expect(isConversationV2Uuid(canonical.normalize('turn', 'turn-1'))).toBe(true)
  })
})
