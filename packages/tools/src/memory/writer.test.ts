import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Memory, MemoryWriteResponse } from '@turboflux/contracts/memoryTypes'
import { MemoryService } from './service'
import { MemoryWriter } from './writer'

const roots: string[] = []
function workspace() { const root = mkdtempSync(join(tmpdir(), 'turboflux-memory-writers-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('memory writer shared state', () => {
  it('modifies memories discovered through another service and preserves the latest fields and status', async () => {
    const workspacePath = workspace()
    const a = new MemoryService(), b = new MemoryService()
    await b.forget({ workspacePath, id: 'missing' })
    const created = await a.remember({ workspacePath, text: 'Deployment target is the staging cluster', tags: ['original'] })
    const id = created.id!
    expect(await b.query({ workspacePath, query: 'staging' })).toEqual(expect.arrayContaining([expect.objectContaining({ id })]))
    expect(await b.update({ workspacePath, id, pinned: true })).toEqual({ success: true })
    expect(await a.update({ workspacePath, id, tags: ['latest'] })).toEqual({ success: true })
    expect(await b.forget({ workspacePath, id })).toEqual({ success: true })
    expect(await a.update({ workspacePath, id, confidence: 'asserted' })).toEqual({ success: true })
    const restarted = new MemoryService()
    expect(await restarted.query({ workspacePath, query: 'staging' })).toEqual([])
    expect(await restarted.query({ workspacePath, query: 'staging', includeStale: true })).toEqual([
      expect.objectContaining({ id, status: 'rejected', pinned: true, confidence: 'asserted', tags: ['latest', 'forget:manual'] }),
    ])
  })

  it('deduplicates against another writer and does not retain entries removed from disk', async () => {
    const workspacePath = workspace()
    const a = new MemoryWriter(), b = new MemoryWriter()
    await b.forget({ workspacePath, id: 'missing' })
    const first = await a.remember({ workspacePath, text: 'Runtime reads deployment configuration', tags: ['first'] })
    const repeated = await b.remember({ workspacePath, text: 'Runtime reads deployment configuration', tags: ['second'] })
    expect(repeated).toMatchObject({ id: first.id, deduplicated: true })
    rmSync(join(workspacePath, '.turboflux', 'memory', 'facts.jsonl'))
    expect(await a.update({ workspacePath, id: first.id!, pinned: true })).toMatchObject({ success: false })
    expect((await a.remember({ workspacePath, text: 'Runtime reads deployment configuration' })).id).not.toBe(first.id)
  })

  it('shares the private memory store across workspace aliases', async () => {
    const root = workspace(), privateRoot = join(root, 'private-memory')
    const a = new MemoryWriter(privateRoot), b = new MemoryWriter(privateRoot)
    await b.forget({ workspacePath: '/workspace-b', id: 'missing' })
    const created = await a.remember({ workspacePath: '/workspace-a', text: 'Shared profile preference' })
    expect(await b.forget({ workspacePath: '/workspace-b', id: created.id! })).toEqual({ success: true })
  })

  it('serializes deduplication and updates across processes', async () => {
    const workspacePath = workspace()
    const moduleUrl = pathToFileURL(resolve('packages/tools/src/memory/writer.ts')).href
    const processes = Array.from({ length: 2 }, (_, index) => {
      const source = `import { MemoryWriter } from ${JSON.stringify(moduleUrl)};
        const writer = new MemoryWriter();
        await writer.forget({ workspacePath: ${JSON.stringify(workspacePath)}, id: 'missing' });
        process.send('ready');
        process.once('message', async () => {
          process.send(await writer.remember({ workspacePath: ${JSON.stringify(workspacePath)}, text: 'Concurrent memory writers preserve all tags', tags: ['writer-${index}'] }));
          process.disconnect();
        });`
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      let stderr = '', result: MemoryWriteResponse
      child.stderr!.on('data', chunk => { stderr += chunk })
      const ready = new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject) })
      child.on('message', message => { if (typeof message === 'object') result = message as MemoryWriteResponse })
      const done = new Promise<MemoryWriteResponse>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', code => code === 0 ? resolve(result) : reject(new Error(stderr || `writer exit ${code}`)))
      })
      return { child, ready, done }
    })
    try {
      await Promise.all(processes.map(process => process.ready))
      for (const process of processes) process.child.send('start')
      const results = await Promise.all(processes.map(process => process.done))
      expect(results.every(result => result.success)).toBe(true)
      expect(results[0].id).toBe(results[1].id)
      const lines = readFileSync(join(workspacePath, '.turboflux', 'memory', 'facts.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Memory)
      expect(lines.at(-1)?.tags).toEqual(expect.arrayContaining(['writer-0', 'writer-1']))
    } finally {
      for (const process of processes) if (process.child.exitCode === null) process.child.kill()
      await Promise.allSettled(processes.map(process => process.done))
    }
  }, 15_000)
})
