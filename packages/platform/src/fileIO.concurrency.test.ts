import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { hashText, withFileLockSync, writeFileAtomic } from './fileIO'
import { NodeToolExecutor } from '@turboflux/tools/nodeToolExecutor'

const roots: string[] = []
function root() { const value = realpathSync.native(mkdtempSync(join(tmpdir(), 'tf-write-race-'))); roots.push(value); return value }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
const fileIOUrl = pathToFileURL(resolve('packages/platform/src/fileIO.ts')).href
const executorUrl = pathToFileURL(resolve('packages/tools/src/nodeToolExecutor.ts')).href

function writer(directory: string, content: string, metadata: Record<string, unknown>) {
  const source = `import { NodeToolExecutor } from ${JSON.stringify(executorUrl)};
    const executor = new NodeToolExecutor(${JSON.stringify(directory)});
    process.send('ready'); process.once('message', async () => {
      process.send(await executor.writeFile('target.txt', ${JSON.stringify(content)}, ${JSON.stringify(metadata)})); process.disconnect();
    });`
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let error = ''
  child.stderr!.on('data', chunk => { error += chunk })
  const ready = new Promise<void>((resolveReady, reject) => { child.once('message', () => resolveReady()); child.once('error', reject) })
  let result: { success: boolean; error?: string }
  child.on('message', message => { if (typeof message === 'object') result = message as typeof result })
  const done = new Promise<typeof result>((resolveDone, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolveDone(result) : reject(new Error(error || `writer exit ${code}`)))
  })
  return { ready, start: () => child.send('start'), done }
}

describe('controlled filesystem mutation concurrency', () => {
  it.each([false, true])('admits one writer across processes (exclusive=%s)', async exclusive => {
    const directory = root()
    if (!exclusive) writeFileSync(join(directory, 'target.txt'), 'base')
    const metadata = exclusive ? { expectNotExists: true } : { expectedHash: hashText('base') }
    const a = writer(directory, 'writer-a', metadata)
    const b = writer(directory, 'writer-b', metadata)
    await Promise.all([a.ready, b.ready])
    a.start(); b.start()
    const results = await Promise.all([a.done, b.done])
    expect(results.filter(item => item.success)).toHaveLength(1)
    expect(results.find(item => !item.success)?.error).toContain('Write conflict')
    expect(readFileSync(join(directory, 'target.txt'), 'utf8')).toBe(results[0].success ? 'writer-a' : 'writer-b')
  }, 15_000)

  it('serializes separate executors and aliases of the same target', async () => {
    const directory = root()
    writeFileSync(join(directory, 'target.txt'), 'base')
    const a = new NodeToolExecutor(directory), b = new NodeToolExecutor(directory)
    const results = await Promise.all([
      a.writeFile('./target.txt', 'a', { expectedHash: hashText('base') }),
      b.writeFile(join(directory, 'target.txt'), 'b', { expectedHash: hashText('base') }),
    ])
    expect(results.filter(item => item.success)).toHaveLength(1)
  })

  it('publishes exclusive files without replacing an uncoordinated create', async () => {
    const directory = root(), target = join(directory, 'target.txt')
    await expect(writeFileAtomic(target, 'agent', {
      expectNotExists: true, lockPath: join(directory, '.write.lock'),
      beforeCommit: () => writeFileSync(target, 'external', { flag: 'wx' }),
    })).rejects.toMatchObject({ code: 'EEXIST' })
    expect(readFileSync(target, 'utf8')).toBe('external')
  })
})

describe('file lock ownership', () => {
  it('does not steal a live lock older than the stale threshold', () => {
    const lock = join(root(), '.lock')
    withFileLockSync(lock, () => {
      const aged = new Date(Date.now() - 31_000); utimesSync(lock, aged, aged)
      const source = `import { withFileLockSync } from ${JSON.stringify(fileIOUrl)};
        try { withFileLockSync(${JSON.stringify(lock)}, () => {}, 100); process.exit(2); }
        catch (error) { if (!error.message.includes('Timed out')) throw error; }`
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { encoding: 'utf8', timeout: 5_000 })
      expect(child.status, child.stderr).toBe(0)
    })
    expect(existsSync(lock)).toBe(false)
  })

  it('does not release a replacement owner lock', () => {
    const lock = join(root(), '.lock')
    withFileLockSync(lock, () => {
      rmSync(lock)
      writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'new-owner' }))
    })
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('new-owner')
  })

  it('recovers a lock left by a process that exited inside the critical section', () => {
    const lock = join(root(), '.lock')
    const source = `import { withFileLockSync } from ${JSON.stringify(fileIOUrl)};
      withFileLockSync(${JSON.stringify(lock)}, () => process.exit(0));`
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { encoding: 'utf8', timeout: 5_000 })
    expect(child.status, child.stderr).toBe(0)
    const aged = new Date(Date.now() - 2_000); utimesSync(lock, aged, aged)
    expect(withFileLockSync(lock, () => 'recovered', 200)).toBe('recovered')
  })
})
