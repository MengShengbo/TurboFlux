import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationEventStoreV2 } from './conversationEventStoreV2'
import { ConversationRepositoryV2 } from './conversationRepositoryV2'
import type { AnyAppendConversationEventV2Input, ConversationRecordV2 } from './conversationV2Types'

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, renameSync: vi.fn(original.renameSync) }
})

const roots: string[] = []
function root() { const path = mkdtempSync(join(tmpdir(), 'turboflux-projection-recovery-')); roots.push(path); return path }
afterEach(() => { vi.resetAllMocks(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

function created(id = 'conversation-1', title = 'Before crash'): AnyAppendConversationEventV2Input {
  const record: ConversationRecordV2 = {
    schemaVersion: 2, id, profileId: 'profile-1', workspaceId: 'workspace-1', title, titleSource: 'custom', mode: 'vibe', provider: 'openai', model: 'test', status: 'idle',
    createdAt: 1, updatedAt: 1, lastEventSeq: 0, turnCount: 0, runCount: 0, tags: [],
  }
  return { eventId: `created-${id}`, profileId: 'profile-1', conversationId: id, source: 'user', provenance: 'live', type: 'conversation.created', at: 1, payload: { record } }
}

function renamed(id = 'conversation-1', title = 'After crash'): AnyAppendConversationEventV2Input {
  return { eventId: `renamed-${id}`, profileId: 'profile-1', conversationId: id, source: 'user', provenance: 'live', type: 'conversation.renamed', at: 2, payload: { title, titleSource: 'custom' } }
}

describe('projection recovery after journal commit', () => {
  for (const recovery of ['retry', 'projection', 'list', 'search'] as const) {
    it.each(['conversation-1.json', 'catalog.json', 'search-index.json', 'projection-watermarks.json'])(`repairs failure publishing %s through ${recovery}`, async target => {
      const directory = root()
      const repository = new ConversationRepositoryV2(directory)
      repository.append([created()])
      repository.append([created('conversation-2', 'Unaffected record')])
      const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
      vi.mocked(renameSync).mockImplementation((source, destination) => {
        if (basename(String(destination)) === target) throw new Error('Injected projection write failure')
        fs.renameSync(source, destination)
      })
      expect(() => repository.append([renamed()])).toThrow('Injected projection write failure')
      expect(repository.read('conversation-1').events).toHaveLength(2)
      vi.mocked(renameSync).mockReset()

      const restarted = new ConversationRepositoryV2(directory)
      if (recovery === 'retry') expect(restarted.append([renamed()])).toMatchObject({ appended: 0, lastSeq: 2 })
      if (recovery === 'projection') expect(restarted.projection('conversation-1').throughSeq).toBe(2)
      if (recovery === 'list') expect(restarted.list({ query: 'After crash' }).total).toBe(1)
      if (recovery === 'search') expect(restarted.search('After crash')).toHaveLength(1)
      expect(restarted.projection('conversation-1')).toMatchObject({ throughSeq: 2, conversation: { title: 'After crash' } })
      expect(restarted.list({ query: 'After crash' }).total).toBe(1)
      expect(restarted.search('After crash')).toHaveLength(1)
      expect(restarted.search('Before crash')).toEqual([])
      expect(restarted.search('Unaffected record')).toHaveLength(1)
      expect(restarted.append([renamed()]).appended).toBe(0)
      expect(restarted.read('conversation-1').events).toHaveLength(2)
      expect(readdirSync(directory, { recursive: true }).some(path => String(path).endsWith('.tmp'))).toBe(false)
    })
  }

  it('repairs legacy checkpoints and journals appended by another event-store instance', () => {
    const directory = root()
    const repository = new ConversationRepositoryV2(directory)
    repository.append([created()])
    rmSync(join(directory, 'projection-watermarks.json'))
    const journal = new ConversationEventStoreV2(join(directory, 'events'))
    journal.append([renamed()])
    expect(new ConversationRepositoryV2(directory).list().conversations[0]).toMatchObject({ title: 'After crash', lastEventSeq: 2 })
    journal.append([created('conversation-2', 'New external journal')])
    expect(repository.search('New external journal')).toHaveLength(1)
  })

  it('rebuilds a missing or corrupt search index without losing other conversations', () => {
    const directory = root()
    const repository = new ConversationRepositoryV2(directory)
    repository.append([created()])
    repository.append([created('conversation-2', 'Unaffected record')])
    writeFileSync(join(directory, 'search-index.json'), '{broken')
    repository.append([renamed()])
    expect(repository.search('Unaffected record')).toHaveLength(1)
    expect(repository.search('After crash')).toHaveLength(1)
  })

  it('rejects a stale but internally valid snapshot even if the checkpoint is current', () => {
    const directory = root()
    const repository = new ConversationRepositoryV2(directory)
    repository.append([created()])
    const snapshotPath = join(directory, 'snapshots', 'conversation-1.json')
    const oldSnapshot = readFileSync(snapshotPath)
    repository.append([renamed()])
    writeFileSync(snapshotPath, oldSnapshot)
    expect(new ConversationRepositoryV2(directory).projection('conversation-1')).toMatchObject({ throughSeq: 2, conversation: { title: 'After crash' } })
  })

  it('preserves catalogs and search entries written by concurrent repository processes', async () => {
    const directory = root()
    const repository = new ConversationRepositoryV2(directory)
    repository.append([created('conversation-a', 'Before A')])
    repository.append([created('conversation-b', 'Before B')])
    const moduleUrl = pathToFileURL(resolve('packages/conversations/src/conversations/conversationRepositoryV2.ts')).href
    const processes = ['a', 'b'].map(id => {
      const source = `import { ConversationRepositoryV2 } from ${JSON.stringify(moduleUrl)};
        const repository = new ConversationRepositoryV2(${JSON.stringify(directory)});
        process.send('ready');
        process.once('message', () => {
          repository.append([${JSON.stringify(renamed(`conversation-${id}`, `Concurrent ${id}`))}]);
          process.disconnect();
        });`
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      let stderr = ''
      child.stderr!.on('data', chunk => { stderr += chunk })
      const ready = new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject) })
      const done = new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `repository exit ${code}`)))
      })
      return { child, ready, done }
    })
    try {
      await Promise.all(processes.map(process => process.ready))
      for (const process of processes) process.child.send('start')
      await Promise.all(processes.map(process => process.done))
      const catalog = JSON.parse(readFileSync(join(directory, 'catalog.json'), 'utf8'))
      expect(catalog.records.map((record: ConversationRecordV2) => record.title).sort()).toEqual(['Concurrent a', 'Concurrent b'])
      const restarted = new ConversationRepositoryV2(directory)
      expect(restarted.search('Concurrent')).toHaveLength(2)
      expect(restarted.projection('conversation-a').throughSeq).toBe(2)
      expect(restarted.projection('conversation-b').throughSeq).toBe(2)
    } finally {
      for (const process of processes) if (process.child.exitCode === null) process.child.kill()
      await Promise.allSettled(processes.map(process => process.done))
    }
  }, 15_000)
})
