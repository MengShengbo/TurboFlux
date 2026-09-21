import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationEventStoreV2 } from './conversationEventStoreV2'
import type { AnyAppendConversationEventV2Input } from './conversationV2Types'

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, readFileSync: vi.fn(original.readFileSync), renameSync: vi.fn(original.renameSync), fsyncSync: vi.fn(original.fsyncSync) }
})

const roots: string[] = []
function setup() {
  const root = fs.mkdtempSync(join(tmpdir(), 'tf-journal-index-'))
  roots.push(root)
  return { root, path: join(root, 'c.jsonl'), indexPath: join(root, 'c.index.json'), store: new ConversationEventStoreV2(root, () => 1) }
}
const event = (id: string, title = 'x'.repeat(512)): AnyAppendConversationEventV2Input => ({
  eventId: id, profileId: 'p', conversationId: 'c', source: 'user', provenance: 'live', type: 'conversation.renamed', payload: { title, titleSource: 'custom' },
})
afterEach(() => {
  vi.resetAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Conversation V2 journal indexes', () => {
  it('keeps a cold first page bounded without loading the full metadata index', () => {
    const { root, store } = setup()
    store.append(Array.from({ length: 1000 }, (_, i) => event(`event-${i}`)))
    let journalBytes = 0
    let indexBytes = 0
    const reader = new ConversationEventStoreV2(root, Date.now, undefined, {
      onPageRead: bytes => { journalBytes += bytes }, onIndexRead: bytes => { indexBytes += bytes },
    })
    expect(reader.read('c', 0, 20).events).toHaveLength(20)
    expect(journalBytes).toBeLessThanOrEqual(64 * 1024)
    expect(indexBytes).toBe(0)
  })

  it('reads a late page through a persisted offset without scanning the prefix after restart', () => {
    const { root, store, path } = setup()
    store.append(Array.from({ length: 4000 }, (_, i) => event(`event-${i}`)))
    let bytes = 0
    const reader = new ConversationEventStoreV2(root, Date.now, undefined, { onPageRead: count => { bytes += count } })
    const page = reader.read('c', 3980, 20)
    expect(page.events.map(value => value.seq)).toEqual(Array.from({ length: 20 }, (_, i) => 3981 + i))
    expect(page.nextSeq).toBeNull()
    expect(bytes).toBeLessThan(128 * 1024)
    expect(bytes).toBeLessThan(fs.statSync(path).size / 4)
  })

  it('uses the tail and event-id index for warm and restarted appends', () => {
    const { root, store, path } = setup()
    store.append(Array.from({ length: 1000 }, (_, i) => event(`event-${i}`)))
    vi.mocked(fs.readFileSync).mockClear()
    expect(store.append([event('event-0'), event('new')])).toMatchObject({ appended: 1, lastSeq: 1001, duplicateEventIds: ['event-0'] })
    const restarted = new ConversationEventStoreV2(root)
    expect(restarted.append([event('new'), event('after-restart')])).toMatchObject({ appended: 1, lastSeq: 1002, duplicateEventIds: ['new'] })
    expect(vi.mocked(fs.readFileSync).mock.calls.filter(([value]) => String(value) === path)).toEqual([])
  })

  it.each(['missing', 'corrupt', 'stale'] as const)('rebuilds a %s index and never loses duplicate protection', kind => {
    const { root, store, indexPath } = setup()
    store.append([event('one')])
    const oldIndex = fs.existsSync(indexPath) ? fs.readFileSync(indexPath) : Buffer.from('{}')
    store.append([event('two')])
    if (kind === 'missing') fs.rmSync(indexPath, { force: true })
    if (kind === 'corrupt') fs.writeFileSync(indexPath, '{broken')
    if (kind === 'stale') fs.writeFileSync(indexPath, oldIndex)
    const restarted = new ConversationEventStoreV2(root)
    expect(restarted.append([event('two'), event('three')])).toMatchObject({ appended: 1, lastSeq: 3, duplicateEventIds: ['two'] })
    expect(restarted.readAll('c').map(value => value.eventId)).toEqual(['one', 'two', 'three'])
  })

  it('invalidates cached offsets and ids after an in-place edit even with the original mtime', () => {
    const { store, path } = setup()
    store.append([event('one'), event('two')])
    const info = fs.statSync(path)
    fs.writeFileSync(path, fs.readFileSync(path, 'utf8').replace('"eventId":"two"', '"eventId":"new"'))
    fs.utimesSync(path, info.atime, info.mtime)
    expect(store.append([event('two')])).toMatchObject({ appended: 1, lastSeq: 3 })
    expect(store.read('c', 1).events.map(value => value.eventId)).toEqual(['new', 'two'])
  })

  it.each(['data', 'checkpoint'] as const)('rejects a damaged %s checksum even when the JSON still parses', target => {
    const { root, store, indexPath } = setup()
    store.append([event('one'), event('two')])
    if (target === 'data') {
      const path = join(root, 'c.index')
      fs.writeFileSync(path, fs.readFileSync(path, 'utf8').replace('two', 'new'))
    } else {
      const checkpoint = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
      fs.writeFileSync(indexPath, JSON.stringify({ ...checkpoint, profileId: 'other' }))
    }
    const restarted = new ConversationEventStoreV2(root)
    expect(restarted.append([event('two'), event('new')])).toMatchObject({ appended: 1, lastSeq: 3, duplicateEventIds: ['two'] })
  })

  it('reloads metadata after another writer appends and after journal replacement or deletion', () => {
    const { root, store, path } = setup()
    store.append([event('one')])
    const first = fs.readFileSync(path)
    new ConversationEventStoreV2(root).append([event('two')])
    expect(store.append([event('two'), event('three')])).toMatchObject({ appended: 1, lastSeq: 3 })
    fs.writeFileSync(`${path}.replacement`, first)
    fs.renameSync(`${path}.replacement`, path)
    expect(store.append([event('two')])).toMatchObject({ appended: 1, lastSeq: 2 })
    fs.rmSync(path)
    expect(store.append([event('two')])).toMatchObject({ appended: 1, lastSeq: 1 })
    expect(store.read('c').events.map(value => value.eventId)).toEqual(['two'])
  })

  it('rejects prefix corruption even when a formerly indexed late page is requested', () => {
    const { root, store, path } = setup()
    store.append(Array.from({ length: 1000 }, (_, i) => event(`event-${i}`)))
    const bytes = fs.readFileSync(path)
    bytes[0] = 33
    fs.writeFileSync(path, bytes)
    expect(() => new ConversationEventStoreV2(root).read('c', 980, 20)).toThrow('requires recovery')
    expect(() => store.append([event('later')])).toThrow('requires recovery')
  })

  it('indexes raw byte offsets across whitespace, CRLF and decoded replacement characters', () => {
    const { root, store, path } = setup()
    store.append([event('one', 'raw'), event('two')])
    const lines = fs.readFileSync(path, 'utf8').trimEnd().split('\n')
    const content = Buffer.from(`\r\n  \n${lines.join('\r\n\t\n')}\r\n`)
    content[content.indexOf('raw')] = 255
    fs.writeFileSync(path, content)
    expect(store.append([event('three')])).toMatchObject({ appended: 1, lastSeq: 3 })
    const restarted = new ConversationEventStoreV2(root)
    expect(restarted.read('c', 1, 1).events.map(value => value.eventId)).toEqual(['two'])
    expect(restarted.read('c', 2, 1).events.map(value => value.eventId)).toEqual(['three'])
  })

  it('keeps acknowledged journal data when an index publication fails', async () => {
    const { root, store, path, indexPath } = setup()
    store.append([event('one')])
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      if (String(target) === indexPath) throw new Error('Index publication failed')
      actual.renameSync(source, target)
    })
    expect(store.append([event('two')])).toMatchObject({ appended: 1, lastSeq: 2 })
    vi.mocked(fs.renameSync).mockReset()
    const restarted = new ConversationEventStoreV2(root)
    expect(restarted.append([event('two'), event('three')])).toMatchObject({ appended: 1, lastSeq: 3 })
    expect(restarted.readAll('c')).toHaveLength(3)
    expect(fs.statSync(path).size).toBeGreaterThan(0)
    expect(fs.readdirSync(root).some(name => name.endsWith('.tmp'))).toBe(false)
  })

  it('does not acknowledge a failed journal fsync or publish an index ahead of it', () => {
    const { root, store, indexPath } = setup()
    store.append([event('one')])
    const before = fs.existsSync(indexPath) ? fs.readFileSync(indexPath) : undefined
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw new Error('Journal sync failed') })
    expect(() => store.append([event('two')])).toThrow('Journal sync failed')
    if (before) expect(fs.readFileSync(indexPath)).toEqual(before)
    vi.mocked(fs.fsyncSync).mockReset()
    const restarted = new ConversationEventStoreV2(root)
    expect(restarted.append([event('two')])).toMatchObject({ appended: 0, lastSeq: 2 })
    expect(fs.fsyncSync).toHaveBeenCalled()
    expect(restarted.readAll('c').map(value => value.eventId)).toEqual(['one', 'two'])
  })

  it('recovers after a process dies between journal fsync and index checkpoint publication', async () => {
    const { root, store, indexPath } = setup()
    store.append([event('one')])
    const moduleUrl = pathToFileURL(resolve('packages/conversations/src/conversations/conversationEventStoreV2.ts')).href
    const source = `import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const rename = fs.renameSync;
      fs.renameSync = (source, target) => {
        if (String(target) === ${JSON.stringify(indexPath)}) process.kill(process.pid, 'SIGKILL');
        rename(source, target);
      };
      syncBuiltinESMExports();
      const { ConversationEventStoreV2 } = await import(${JSON.stringify(moduleUrl)});
      new ConversationEventStoreV2(${JSON.stringify(root)}).append([${JSON.stringify(event('two'))}]);`
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    try {
      const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => signal === 'SIGKILL' ? resolve(signal) : reject(new Error(stderr || `Unexpected exit ${code}`)))
      })
      expect(signal).toBe('SIGKILL')
      const restarted = new ConversationEventStoreV2(root)
      expect(restarted.append([event('two'), event('three')])).toMatchObject({ appended: 1, lastSeq: 3, duplicateEventIds: ['two'] })
      expect(restarted.read('c').events.map(value => value.eventId)).toEqual(['one', 'two', 'three'])
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
  }, 15_000)
})
