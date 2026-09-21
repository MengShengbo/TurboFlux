import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationRepositoryV2 } from './conversationRepositoryV2'
import { ConversationEventStoreV2 } from './conversationEventStoreV2'
import { projectConversationEvents } from './conversationProjections'
import type { AnyAppendConversationEventV2Input } from './conversationV2Types'

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, readFileSync: vi.fn(original.readFileSync), writeFileSync: vi.fn(original.writeFileSync), renameSync: vi.fn(original.renameSync) }
})
const roots: string[] = []
const common = { conversationId: 'c', profileId: 'p', workspaceId: 'w', source: 'runtime' as const, provenance: 'live' as const }
function rename(id: string): AnyAppendConversationEventV2Input {
  return { ...common, eventId: id.replace(/ /g, '-'), type: 'conversation.renamed', at: 1000, payload: { title: id, titleSource: 'custom' } }
}
function fixture(extra: AnyAppendConversationEventV2Input[] = []) {
  const root = fs.mkdtempSync(join(tmpdir(), 'tf-incremental-projection-'))
  roots.push(root)
  const replays: Array<[number, string]> = []
  const repository = new ConversationRepositoryV2(root, () => 1, { onProjectionReplay: (count, mode) => replays.push([count, mode]) })
  repository.append([
    { ...common, eventId: 'created', type: 'conversation.created', payload: { record: {
      schemaVersion: 2, id: 'c', profileId: 'p', workspaceId: 'w', title: 'Before', titleSource: 'custom', mode: 'vibe', provider: 'fixture', model: 'fixture',
      status: 'needs_workspace', createdAt: 1, updatedAt: 1, lastEventSeq: 0, turnCount: 0, runCount: 0, tags: [],
    } } },
    ...Array.from({ length: 200 }, (_, i): AnyAppendConversationEventV2Input => ({
      ...common, eventId: `e-${i}`, itemId: `item-${i}`, type: 'item.created', payload: { item: {
        schemaVersion: 1, id: `item-${i}`, conversationId: 'c', kind: 'assistant_message', status: 'completed', createdAt: i + 2, updatedAt: i + 2, payload: { text: `Message ${i} ${'x'.repeat(512)}` },
      } },
    })),
    ...extra,
  ])
  return { root, repository, replays, snapshot: join(root, 'snapshots', 'c.json'), delta: join(root, 'snapshots', 'c.delta.json'), search: join(root, 'search-index.json') }
}
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value))
function canonical(root: string) { return projectConversationEvents(new ConversationEventStoreV2(join(root, 'events')).readAll('c')) }
afterEach(() => { vi.resetAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('incremental projection persistence', () => {
  it('commits only new events and small derived files on a warm append, with current reads after restart', () => {
    const { root, repository, replays, snapshot, search } = fixture()
    const beforeSnapshot = fs.readFileSync(snapshot)
    const beforeSearch = fs.readFileSync(search)
    replays.length = 0
    vi.mocked(fs.readFileSync).mockClear()
    vi.mocked(fs.writeFileSync).mockClear()
    repository.append([rename('After')])
    expect(replays).toEqual([[1, 'delta']])
    expect(vi.mocked(fs.readFileSync).mock.calls.some(([path]) => [snapshot, search, join(root, 'events', 'c.jsonl')].includes(String(path)))).toBe(false)
    const bytesWritten = vi.mocked(fs.writeFileSync).mock.calls.reduce((total, [, data]) => total + Buffer.byteLength(typeof data === 'string' ? data : data as Buffer), 0)
    expect(bytesWritten).toBeLessThan(16 * 1024)
    expect(fs.readFileSync(snapshot)).toEqual(beforeSnapshot)
    expect(fs.readFileSync(search)).toEqual(beforeSearch)
    const restarted = new ConversationRepositoryV2(root)
    expect(json(restarted.projection('c'))).toEqual(json(canonical(root)))
    expect(restarted.list().conversations[0]?.title).toBe('After')
    expect(restarted.search('After')).toHaveLength(1)
    expect(restarted.search('Message 199')[0]).toMatchObject({ title: 'After', itemId: 'item-199' })
    expect(restarted.search('Before')).toEqual([])
  })

  it('keeps item aliases and workspace requirements when continuing a persisted checkpoint', () => {
    const message = (id: string): AnyAppendConversationEventV2Input => ({
      ...common, eventId: `created-${id}`, type: 'item.created', itemId: id, turnId: 'turn', payload: { item: {
        schemaVersion: 1, id, conversationId: 'c', turnId: 'turn', kind: 'assistant_message', status: 'running', createdAt: 1, updatedAt: 1, payload: { text: 'alias message' },
      } },
    })
    const { root } = fixture([
      { ...common, eventId: 'run', runId: 'run', type: 'run.started', payload: { run: { id: 'run', conversationId: 'c', workspaceId: 'w', objective: 'work', status: 'running', startedAt: 1, updatedAt: 1 } } },
      message('original'), message('alias'),
    ])
    const restarted = new ConversationRepositoryV2(root)
    restarted.append([
      { ...common, eventId: 'updated', type: 'item.updated', itemId: 'alias', payload: { updatedAt: 10, payload: { text: 'Changed via alias' } } },
      { ...common, eventId: 'done', type: 'run.completed', runId: 'run', payload: { status: 'completed', completedAt: 10 } },
    ])
    expect(json(restarted.projection('c'))).toEqual(json(canonical(root)))
    expect(restarted.projection('c').conversation?.status).toBe('needs_workspace')
    expect(new ConversationRepositoryV2(root).search('Changed via alias')).toEqual([expect.objectContaining({ itemId: 'original' })])
  })

  it('bounds the pending event window and folds it into a checkpoint without replaying old events', () => {
    const { root, repository, replays, snapshot } = fixture()
    replays.length = 0
    for (let i = 0; i < 65; i += 1) repository.append([rename(`rename-${i}`)])
    expect(JSON.parse(fs.readFileSync(snapshot, 'utf8')).throughSeq).toBe(266)
    expect(replays.every(([count, mode]) => count === 1 && mode === 'delta')).toBe(true)
    expect(json(new ConversationRepositoryV2(root).projection('c'))).toEqual(json(canonical(root)))
    expect(repository.search('rename-64')).toHaveLength(1)
    repository.append([rename('after-checkpoint')])
    expect(new ConversationRepositoryV2(root).search('after-checkpoint')).toHaveLength(1)
  })

  it('checkpoints a large delta and immediately removes redacted content from search results', () => {
    const { root, repository, snapshot } = fixture()
    repository.append([{ ...common, eventId: 'large', type: 'recovery.applied', payload: { reason: 'x'.repeat(256 * 1024), throughSeq: 201 } }])
    expect(JSON.parse(fs.readFileSync(snapshot, 'utf8')).throughSeq).toBe(202)
    repository.append([{ ...common, eventId: 'redact', itemId: 'item-199', type: 'item.redacted', payload: { reason: 'private', redactedAt: 1000 } }])
    expect(JSON.parse(fs.readFileSync(snapshot, 'utf8')).throughSeq).toBe(203)
    expect(new ConversationRepositoryV2(root).search('Message 199')).toEqual([])
    expect(repository.search('Message 198')).toHaveLength(1)
  })

  it.each(['missing', 'corrupt', 'stale'] as const)('repairs a %s delta even when the journal checkpoint is current', kind => {
    const { root, repository, delta } = fixture()
    repository.append([rename('first-delta')])
    const first = fs.readFileSync(delta)
    repository.append([rename('latest')])
    if (kind === 'missing') fs.rmSync(delta)
    if (kind === 'corrupt') fs.writeFileSync(delta, '{broken')
    if (kind === 'stale') fs.writeFileSync(delta, first)
    const restarted = new ConversationRepositoryV2(root)
    expect(restarted.search('latest')).toHaveLength(1)
    expect(json(restarted.projection('c'))).toEqual(json(canonical(root)))
  })

  it('invalidates warm state after external journal changes and isolates returned projections', () => {
    const { root, repository } = fixture()
    repository.append([rename('first-delta')])
    repository.projection('c').items[0]!.payload = { text: 'Mutated return value' } as never
    new ConversationEventStoreV2(join(root, 'events')).append([rename('external')])
    repository.append([rename('last')])
    expect(json(repository.projection('c'))).toEqual(json(canonical(root)))
    expect(repository.search('Mutated return value')).toEqual([])
  })

  it('upgrades legacy full snapshots before continuing with incremental events', () => {
    const { root, snapshot, repository } = fixture()
    const previous = JSON.parse(fs.readFileSync(snapshot, 'utf8'))
    previous.schemaVersion = 1
    delete previous.reducer
    previous.checksum = createHash('sha256').update(JSON.stringify(previous.projection)).digest('hex')
    fs.writeFileSync(snapshot, JSON.stringify(previous))
    fs.writeFileSync(join(root, 'projection-watermarks.json'), JSON.stringify({
      schemaVersion: 1, conversations: { c: { throughSeq: previous.throughSeq, journalVersion: previous.journalVersion } },
    }))
    expect(json(repository.projection('c'))).toEqual(json(canonical(root)))
    expect(JSON.parse(fs.readFileSync(snapshot, 'utf8')).schemaVersion).toBe(2)
    repository.append([rename('after-migration')])
    expect(new ConversationRepositoryV2(root).search('after-migration')).toHaveLength(1)
  })

  it('keeps other pending conversations current when one conversation checkpoints or the index is rebuilt', () => {
    const { root, repository } = fixture()
    const otherEvents = repository.read('c', 0, 500).events.map(event => {
      const other = { ...event, conversationId: 'other', payload: structuredClone(event.payload) }
      if ('record' in other.payload) other.payload.record.id = 'other'
      if ('item' in other.payload) other.payload.item.conversationId = 'other'
      return other as AnyAppendConversationEventV2Input
    })
    repository.append(otherEvents)
    repository.append([rename('pending-first')])
    repository.append([{ ...rename('pending-other'), conversationId: 'other' }])
    const expected = [expect.objectContaining({ title: 'pending-first' }), expect.objectContaining({ title: 'pending-other' })]
    expect(repository.search('pending-')).toEqual(expect.arrayContaining(expected))
    repository.append([{ ...common, eventId: 'redact', itemId: 'item-199', type: 'item.redacted', payload: { reason: 'private', redactedAt: 1000 } }])
    for (const missingIndex of [false, true]) {
      if (missingIndex) fs.rmSync(join(root, 'search-index.json'))
      const restarted = new ConversationRepositoryV2(root)
      expect(restarted.search('pending-')).toHaveLength(2)
      expect(restarted.search('pending-')).toEqual(expect.arrayContaining(expected))
      expect(restarted.search('Message 199')).toEqual([expect.objectContaining({ conversationId: 'other', title: 'pending-other' })])
    }
  })

  it('recovers a failed full checkpoint after the delta window fills', async () => {
    const { root, repository } = fixture()
    repository.append(Array.from({ length: 64 }, (_, i) => rename(`rename-${i}`)))
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(fs.renameSync).mockImplementation((source, destination) => {
      if (basename(String(destination)) === 'search-index.json') throw new Error('Full checkpoint failed')
      actual.renameSync(source, destination)
    })
    expect(() => repository.append([rename('checkpoint')])).toThrow('Full checkpoint failed')
    vi.mocked(fs.renameSync).mockReset()
    const restarted = new ConversationRepositoryV2(root)
    expect(restarted.append([rename('checkpoint')]).appended).toBe(0)
    expect(json(restarted.projection('c'))).toEqual(json(canonical(root)))
    expect(restarted.search('checkpoint')).toHaveLength(1)
  })

  it('does not resurrect old search entries after a workspace move, archive or history rewrite', () => {
    const { root, repository } = fixture()
    repository.append([{ ...common, eventId: 'move', type: 'conversation.workspace_changed', payload: { workspaceId: 'new-workspace', status: 'idle' } }])
    expect(new ConversationRepositoryV2(root).search({ query: 'Message 199', workspaceId: 'w' })).toEqual([])
    expect(repository.search({ query: 'Message 199', workspaceId: 'new-workspace' })).toHaveLength(1)
    repository.append([{ ...common, eventId: 'archive', type: 'conversation.archived', payload: { archivedAt: 100 } }])
    expect(new ConversationRepositoryV2(root).search('Message 199')).toEqual([])
    repository.append([{ ...common, eventId: 'restore', type: 'conversation.restored', payload: {} }])
    expect(new ConversationRepositoryV2(root).search('Message 199')).toHaveLength(1)
    repository.append([{ ...common, eventId: 'rewrite', type: 'conversation.rewritten', payload: { retainedTurnIds: [], rewrittenAt: 100 } }])
    expect(json(new ConversationRepositoryV2(root).projection('c'))).toEqual(json(canonical(root)))
  })

  it('serializes two processes extending the same persisted delta', async () => {
    const { root, repository } = fixture()
    repository.append([rename('initial-delta')])
    const moduleUrl = pathToFileURL(resolve('packages/conversations/src/conversations/conversationRepositoryV2.ts')).href
    const processes = ['process-a', 'process-b'].map(id => {
      const source = `import { ConversationRepositoryV2 } from ${JSON.stringify(moduleUrl)};
        const repository = new ConversationRepositoryV2(${JSON.stringify(root)});
        repository.projection('c');
        process.send('ready');
        process.once('message', () => { repository.append([${JSON.stringify(rename(id))}]); process.disconnect(); });`
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      let stderr = ''
      child.stderr!.on('data', chunk => { stderr += chunk })
      const ready = new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject) })
      const done = new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `Unexpected exit ${code}`)))
      })
      return { child, ready, done }
    })
    try {
      await Promise.all(processes.map(value => value.ready))
      for (const value of processes) value.child.send('start')
      await Promise.all(processes.map(value => value.done))
      expect(repository.read('c', 202).events.map(event => event.eventId).sort()).toEqual(['process-a', 'process-b'])
      expect(json(repository.projection('c'))).toEqual(json(canonical(root)))
      expect(new ConversationRepositoryV2(root).search('process-')).toHaveLength(1)
    } finally {
      for (const value of processes) if (value.child.exitCode === null) value.child.kill()
      await Promise.allSettled(processes.map(value => value.done))
    }
  }, 15_000)

  it('recovers after a process dies before publishing the delta watermark', async () => {
    const { root, repository } = fixture()
    repository.append([rename('initial-delta')])
    const moduleUrl = pathToFileURL(resolve('packages/conversations/src/conversations/conversationRepositoryV2.ts')).href
    const watermarkPath = join(root, 'projection-watermarks.json')
    const source = `import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const rename = fs.renameSync;
      fs.renameSync = (source, target) => {
        if (String(target) === ${JSON.stringify(watermarkPath)}) process.kill(process.pid, 'SIGKILL');
        rename(source, target);
      };
      syncBuiltinESMExports();
      const { ConversationRepositoryV2 } = await import(${JSON.stringify(moduleUrl)});
      new ConversationRepositoryV2(${JSON.stringify(root)}).append([${JSON.stringify(rename('after-crash'))}]);`
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => signal === 'SIGKILL' ? resolve() : reject(new Error(stderr || `Unexpected exit ${code}`)))
      })
      const restarted = new ConversationRepositoryV2(root)
      expect(restarted.append([rename('after-crash')])).toMatchObject({ appended: 0, lastSeq: 203 })
      expect(restarted.search('after-crash')).toHaveLength(1)
      expect(json(restarted.projection('c'))).toEqual(json(canonical(root)))
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
  }, 15_000)

  for (const recovery of ['retry', 'projection', 'list', 'search'] as const) {
    it.each(['c.delta.json', 'catalog.json', 'projection-watermarks.json'])(`repairs failure publishing %s via ${recovery}`, async target => {
      const { root, repository } = fixture()
      repository.append([rename('existing-delta')])
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      vi.mocked(fs.renameSync).mockImplementation((source, destination) => {
        if (basename(String(destination)) === target) throw new Error('Injected delta publication failure')
        actual.renameSync(source, destination)
      })
      expect(() => repository.append([rename('After failure')])).toThrow('Injected delta publication failure')
      expect(repository.read('c', 202).events[0]?.eventId).toBe('After-failure')
      vi.mocked(fs.renameSync).mockReset()
      const recovered = recovery === 'retry' ? repository : new ConversationRepositoryV2(root)
      if (recovery === 'retry') expect(recovered.append([rename('After failure')]).appended).toBe(0)
      if (recovery === 'projection') expect(recovered.projection('c').throughSeq).toBe(203)
      if (recovery === 'list') expect(recovered.list().conversations[0]?.title).toBe('After failure')
      if (recovery === 'search') expect(recovered.search('After failure')).toHaveLength(1)
      expect(json(recovered.projection('c'))).toEqual(json(canonical(root)))
      expect(recovered.search('existing-delta')).toEqual([])
      expect(fs.readdirSync(root, { recursive: true }).some(path => String(path).endsWith('.tmp'))).toBe(false)
    })
  }
})
