import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationEventStoreV2 } from './conversationEventStoreV2'
import type { AnyAppendConversationEventV2Input } from './conversationV2Types'

const roots: string[] = []
function setup() {
  const root = fs.mkdtempSync(join(tmpdir(), 'tf-journal-boundary-')); roots.push(root)
  return { store: new ConversationEventStoreV2(root, () => 1), path: join(root, 'c.jsonl') }
}
function event(id: string, title = '中文 😀'): AnyAppendConversationEventV2Input {
  return { eventId: id, profileId: 'p', conversationId: 'c', source: 'user', provenance: 'live', type: 'conversation.renamed', payload: { title, titleSource: 'custom' } }
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('journal append boundaries', () => {
  it('preserves a complete UTF-8 tail without a newline across append and recovery', () => {
    const { store, path } = setup()
    store.append([event('one')])
    fs.writeFileSync(path, fs.readFileSync(path).subarray(0, -1))
    expect(store.readAll('c')).toHaveLength(1)
    store.append([event('two')])
    expect(store.readAll('c').map(item => item.eventId)).toEqual(['one', 'two'])
    expect(store.read('c').events).toHaveLength(2)
    expect(store.recover('c')).toMatchObject({ repaired: false, throughSeq: 2 })
  })

  it('refuses a truncated multibyte tail until recovery, then can append', () => {
    const { store, path } = setup()
    store.append([event('one')])
    const first = fs.readFileSync(path)
    const partial = Buffer.concat([Buffer.from('{"type":"'), Buffer.from('中').subarray(0, 2)])
    fs.appendFileSync(path, partial)
    expect(() => store.append([event('two')])).toThrow('requires recovery')
    expect(fs.readFileSync(path).equals(Buffer.concat([first, partial]))).toBe(true)
    expect(store.recover('c')).toMatchObject({ repaired: true, throughSeq: 1 })
    store.append([event('two')])
    expect(store.readAll('c').map(item => item.eventId)).toEqual(['one', 'two'])
  })

  it.each(['x', '中'])('rejects the whole oversized batch by UTF-8 bytes (%s)', character => {
    const { store, path } = setup()
    store.append([event('one')])
    const before = fs.readFileSync(path)
    const title = character.repeat(Math.ceil(8 * 1024 * 1024 / Buffer.byteLength(character)))
    expect(() => store.append([event('two'), event('large', title)])).toThrow('exceeds size budget')
    expect(fs.readFileSync(path).equals(before)).toBe(true)
    expect(store.readAll('c')).toHaveLength(1)
  })

  it('accepts a line exactly at the reader budget', () => {
    const { store } = setup()
    const empty = { ...event('one', ''), schemaVersion: 2, seq: 1, at: 1 }
    const title = 'x'.repeat(8 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(empty)))
    store.append([event('one', title)])
    expect(store.read('c').events).toHaveLength(1)
    expect(store.readAll('c')).toHaveLength(1)
  })

})
