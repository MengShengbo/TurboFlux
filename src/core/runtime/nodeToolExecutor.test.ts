import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandOutput, Result } from '../../tools/executor.js'
import { NodeToolExecutor } from './nodeToolExecutor.js'
import { RuntimeTaskManager } from './runtimeTaskManager.js'
import { hashText } from '../fileIO.js'

function makeTempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
}

async function withWorkspace<T>(fn: (paths: { workspace: string; outside: string }) => Promise<T> | T): Promise<T> {
  const workspace = makeTempDir('turboflux-executor-workspace-')
  const outside = makeTempDir('turboflux-executor-outside-')
  try {
    return await fn({ workspace, outside })
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NodeToolExecutor file and process lifecycle', () => {
  it('blocks external paths by default and requires explicit full access', async () => withWorkspace(async ({ workspace, outside }) => {
    const outsideFile = join(outside, 'outside.txt')
    writeFileSync(join(workspace, 'inside.txt'), 'inside', 'utf-8')
    writeFileSync(outsideFile, 'outside', 'utf-8')

    const executor = new NodeToolExecutor(workspace)

    await expect(executor.readFile('inside.txt')).resolves.toMatchObject({
      success: true,
      data: 'inside',
    })

    const outsideRead = await executor.readFile(outsideFile)
    expect(outsideRead).toMatchObject({ success: false })

    const outsideWrite = await executor.writeFile(join(outside, 'new.txt'), 'written')
    expect(outsideWrite.success).toBe(false)

    const fullAccessExecutor = new NodeToolExecutor(workspace, { capabilityProfile: 'danger-full-access' })
    await expect(fullAccessExecutor.readFile(outsideFile)).resolves.toMatchObject({ success: true, data: 'outside' })
    await expect(fullAccessExecutor.writeFile(join(outside, 'new.txt'), 'written')).resolves.toMatchObject({ success: true })
    expect(readFileSync(join(outside, 'new.txt'), 'utf-8')).toBe('written')
  }))

  it('resolves relative paths against the workspace root', async () => withWorkspace(async ({ workspace }) => {
    const executor = new NodeToolExecutor(workspace)

    const write = await executor.writeFile('nested/file.txt', 'hello')
    const read = await executor.readFile('nested/file.txt')

    expect(write.success).toBe(true)
    expect(read).toMatchObject({ success: true, data: 'hello' })
    expect(readFileSync(join(workspace, 'nested', 'file.txt'), 'utf-8')).toBe('hello')
  }))

  it('reports directories as non-file read targets', async () => withWorkspace(async ({ workspace }) => {
    mkdirSync(join(workspace, 'nested'), { recursive: true })
    const executor = new NodeToolExecutor(workspace)

    const read = await executor.readFile('nested')

    expect(read).toEqual({ success: false, error: 'Path is not a file' })
  }))

  it('uses optimistic version checks and preserves concurrent edits', async () => withWorkspace(async ({ workspace }) => {
    const filePath = join(workspace, 'inside.txt')
    writeFileSync(filePath, 'first', 'utf-8')
    const executor = new NodeToolExecutor(workspace)
    const expectedHash = hashText('first')

    writeFileSync(filePath, 'editor change', 'utf-8')
    const conflict = await executor.writeFile(filePath, 'agent change', { expectedHash })
    const createConflict = await executor.writeFile(filePath, 'overwrite', { expectNotExists: true })

    expect(conflict.success).toBe(false)
    expect(conflict.error).toContain('changed since it was read')
    expect(createConflict.success).toBe(false)
    expect(readFileSync(filePath, 'utf-8')).toBe('editor change')
  }))

  it('blocks paths through a symlink or junction outside the workspace', async () => withWorkspace(async ({ workspace, outside }) => {
    writeFileSync(join(outside, 'secret.txt'), 'outside', 'utf-8')
    const linkPath = join(workspace, 'linked')
    try {
      symlinkSync(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return
    }
    const executor = new NodeToolExecutor(workspace)

    const result = await executor.readFile(join(linkPath, 'secret.txt'))

    expect(result).toMatchObject({ success: false })
  }))

  it('requires an explicit permission decision for shell commands', async () => withWorkspace(async ({ workspace }) => {
    const executor = new NodeToolExecutor(workspace, { capabilityProfile: 'danger-full-access' })

    const blocked = await executor.runCommand('echo hello', workspace)
    const approved = await executor.runCommand('echo hello', workspace, {}, 5000, true)

    expect(blocked.success).toBe(false)
    expect(blocked.error).toContain('explicit permission')
    expect(approved.success).toBe(true)
  }))

  it('does not let an approval decision expand the capability profile', async () => withWorkspace(async ({ workspace }) => {
    const executor = new NodeToolExecutor(workspace)

    const result = await executor.runCommand('echo hello', workspace, {}, 5000, true)

    expect(result.success).toBe(false)
    expect(result.error).toContain('workspace-write')
    expect(executor.getRuntimeTaskManager().listTasks()).toEqual([])
  }))

  it('blocks writes before touching disk in read-only mode', async () => withWorkspace(async ({ workspace }) => {
    const executor = new NodeToolExecutor(workspace, { capabilityProfile: 'read-only' })
    const target = join(workspace, 'blocked.txt')

    const result = await executor.writeFile(target, 'blocked')

    expect(result.success).toBe(false)
    expect(result.error).toContain('read-only')
    expect(existsSync(target)).toBe(false)
  }))

  it('returns non-zero process exits as results while preserving task outcome', async () => withWorkspace(async ({ workspace }) => {
    const executor = new NodeToolExecutor(workspace)
    const result = await executor.runProcess(process.execPath, ['-e', 'process.exit(7)'], workspace)
    const runtimeTask = executor.getRuntimeTaskManager().listTasks({ kind: 'shell' })[0]

    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.data?.exitCode).toBe(7)
    expect(runtimeTask).toMatchObject({ status: 'failed', exitCode: 7, interactive: false })
  }))

  it('preserves exact shell command exit codes', async () => withWorkspace(async ({ workspace }) => {
    const executor = new NodeToolExecutor(workspace, { capabilityProfile: 'danger-full-access' })
    const result = await executor.runCommand('node -e "process.exit(7)"', workspace, {}, 5000, true)

    expect(result).toMatchObject({ success: true, data: { exitCode: 7 } })
    expect(result.error).toBeUndefined()
  }), 15_000)

  it('decodes shell output as UTF-8', async () => withWorkspace(async ({ workspace }) => {
    const executor = new NodeToolExecutor(workspace, { capabilityProfile: 'danger-full-access' })
    const command = process.platform === 'win32' ? "Write-Output '你好，世界'" : "printf '你好，世界'"
    const result = await executor.runCommand(command, workspace, {}, 5000, true)

    expect(result).toMatchObject({ success: true, data: { exitCode: 0 } })
    expect(result.data?.stdout).toContain('你好，世界')
  }))

  it('tracks successful foreground processes through completion', async () => withWorkspace(async ({ workspace }) => {
    const executor = new NodeToolExecutor(workspace)

    const result = await executor.runProcess(process.execPath, ['-e', 'process.stdout.write("done"); process.stderr.write("warn")'], workspace)
    const runtimeTask = executor.getRuntimeTaskManager().listTasks({ kind: 'shell' })[0]
    const logRecords = readFileSync(runtimeTask!.logPath!, 'utf-8').trim().split('\n').map(line => JSON.parse(line))

    expect(result.success).toBe(true)
    expect(result.data?.logPath).toBe(runtimeTask?.logPath)
    expect(runtimeTask).toMatchObject({
      status: 'completed',
      cwd: workspace,
      exitCode: 0,
      outputBytes: 8,
      interactive: false,
    })
    expect(runtimeTask?.command).toContain(process.execPath)
    expect(logRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: 'stdout', data: 'done' }),
      expect.objectContaining({ channel: 'stderr', data: 'warn' }),
    ]))
  }))

  it('does not create empty runtime log files for silent commands', async () => withWorkspace(async ({ workspace }) => {
    const executor = new NodeToolExecutor(workspace)

    const result = await executor.runProcess(process.execPath, ['-e', 'process.exit(0)'], workspace)
    const runtimeTask = executor.getRuntimeTaskManager().listTasks({ kind: 'shell' })[0]

    expect(result.success).toBe(true)
    expect(runtimeTask?.outputBytes).toBe(0)
    expect(runtimeTask?.logPath).toBeTruthy()
    expect(existsSync(runtimeTask!.logPath!)).toBe(false)
  }))

  it('settles after the termination grace period when a timed-out process never closes', async () => withWorkspace(async ({ workspace }) => {
    vi.useFakeTimers()
    try {
      const executor = new NodeToolExecutor(workspace)
      const proc = Object.assign(new EventEmitter(), {
        pid: 12345,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      }) as unknown as ChildProcessWithoutNullStreams
      const runtime = executor as unknown as {
        collectProcess: (proc: ChildProcessWithoutNullStreams, timeout: number, runtimeTaskId?: string) => Promise<Result<CommandOutput>>
        terminateProcessTree: (proc: ChildProcessWithoutNullStreams) => void
      }
      const terminate = vi.spyOn(runtime, 'terminateProcessTree').mockImplementation(() => {})
      const runtimeTask = executor.getRuntimeTaskManager().createTask({ kind: 'shell', status: 'running' })
      let settled = false

      const pending = runtime.collectProcess(proc, 25, runtimeTask.id)
      void pending.finally(() => { settled = true })
      proc.stdout.emit('data', Buffer.from('partial stdout'))
      proc.stderr.emit('data', Buffer.from('partial stderr'))

      await vi.advanceTimersByTimeAsync(10_000)

      expect(terminate).toHaveBeenCalledWith(proc)
      expect(settled).toBe(true)
      await expect(pending).resolves.toMatchObject({
        success: false,
        data: {
          stdout: 'partial stdout',
          stderr: 'partial stderr',
          timedOut: true,
        },
      })
      expect(executor.getRuntimeTaskManager().getTask(runtimeTask.id)).toMatchObject({
        status: 'failed',
        metadata: { timedOut: true },
      })
    } finally {
      vi.useRealTimers()
    }
  }))

  it('passes the parent environment and explicit overrides to child commands', async () => withWorkspace(async ({ workspace }) => {
    process.env.TURBOFLUX_TEST_SECRET = 'inherited'
    try {
      const executor = new NodeToolExecutor(workspace)
      const inherited = await executor.runProcess(process.execPath, ['-e', 'process.stdout.write(process.env.TURBOFLUX_TEST_SECRET || "missing")'], workspace)
      const explicit = await executor.runProcess(process.execPath, ['-e', 'process.stdout.write(process.env.EXPLICIT_VALUE || "missing")'], workspace, { EXPLICIT_VALUE: 'allowed' })
      const sensitive = await executor.runProcess(process.execPath, ['-e', 'process.stdout.write(process.env.SERVICE_API_KEY || "missing")'], workspace, { SERVICE_API_KEY: 'allowed' })

      expect(inherited.data?.stdout).toBe('inherited')
      expect(explicit.data?.stdout).toBe('allowed')
      expect(sensitive.data?.stdout).toBe('allowed')
    } finally {
      delete process.env.TURBOFLUX_TEST_SECRET
    }
  }))

  it('builds code maps for target paths outside the initial workspace', async () => withWorkspace(async ({ workspace, outside }) => {
    writeFileSync(join(outside, 'External.ts'), 'export const external = true\n', 'utf-8')
    const executor = new NodeToolExecutor(workspace, { capabilityProfile: 'danger-full-access' })

    const result = await executor.getCodeMap({
      workspacePath: workspace,
      targetPaths: [outside],
    })

    expect(result.success).toBe(true)
    expect(JSON.stringify(result.data?.map)).toContain('External.ts')
  }))

  it('builds code maps from an explicit feature path outside src', async () => withWorkspace(async ({ workspace }) => {
    mkdirSync(join(workspace, 'frontend', 'components'), { recursive: true })
    writeFileSync(join(workspace, 'frontend', 'components', 'Card.tsx'), 'export function HolderCard() { return null }\n', 'utf-8')
    const executor = new NodeToolExecutor(workspace)

    const result = await executor.getCodeMap({
      workspacePath: workspace,
      path: 'frontend',
      query: '持卡人 名片',
    })

    expect(result.success).toBe(true)
    expect(result.data?.map?.[0]?.path).toBe('frontend')
    expect(JSON.stringify(result.data?.map)).toContain('Card.tsx')
  }))

  it('returns line-numbered content and symbol search results', async () => withWorkspace(async ({ workspace }) => {
    mkdirSync(join(workspace, 'src'), { recursive: true })
    mkdirSync(join(workspace, 'tmp'), { recursive: true })
    mkdirSync(join(workspace, '.claude'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'FluxRunner.ts'), 'export class FluxRunner {\n  run() { return true }\n}\n', 'utf-8')
    writeFileSync(join(workspace, 'src', 'ignored.txt'), 'export class FluxIgnored {}\n', 'utf-8')
    writeFileSync(join(workspace, 'tmp', 'FluxHidden.ts'), 'export class FluxHidden {}\n', 'utf-8')
    writeFileSync(join(workspace, '.claude', 'FluxShadow.ts'), 'export class FluxShadow {}\n', 'utf-8')
    const executor = new NodeToolExecutor(workspace)

    const content = await executor.searchContent('FluxRunner', workspace, '*.ts')
    const symbols = await executor.searchCodeSymbols({ query: 'flux', workspacePath: workspace })

    expect(content.success).toBe(true)
    expect(content.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ line: 1, text: expect.stringContaining('FluxRunner') }),
    ]))
    expect(content.data?.some(hit => hit.file.endsWith('ignored.txt'))).toBe(false)
    expect(symbols.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/FluxRunner.ts', title: 'FluxRunner', line: 1 }),
    ]))
    expect(symbols.data?.some(hit => /FluxHidden|FluxShadow/.test(hit.title))).toBe(false)
  }))

  it('reads bounded line ranges and reports continuation without loading the full file result', async () => withWorkspace(async ({ workspace }) => {
    const filePath = join(workspace, 'large.txt')
    writeFileSync(filePath, Array.from({ length: 500 }, (_, index) => `line-${index + 1}`).join('\n'), 'utf-8')
    const executor = new NodeToolExecutor(workspace)

    const result = await executor.readFileRange(filePath, 199, 5)

    expect(result).toMatchObject({
      success: true,
      data: {
        startLine: 200,
        endLine: 204,
        truncated: true,
      },
    })
    expect(result.data?.content).toBe('line-200\nline-201\nline-202\nline-203\nline-204')
  }))

  it('bounds a giant single-line file by bytes', async () => withWorkspace(async ({ workspace }) => {
    const filePath = join(workspace, 'single-line.jsonl')
    writeFileSync(filePath, 'x'.repeat(300_000), 'utf-8')
    const executor = new NodeToolExecutor(workspace)

    const result = await executor.readFileRange(filePath, 0, 50)

    expect(result).toMatchObject({ success: true, data: { truncated: true, partialLine: true } })
    expect(result.data?.bytesRead).toBeLessThanOrEqual(64 * 1024 + 1)
    expect(result.data?.content.length).toBeLessThanOrEqual(64 * 1024)
  }))

  it('enforces depth, per-directory, and global node budgets while building a tree', async () => withWorkspace(async ({ workspace }) => {
    for (let directory = 0; directory < 4; directory += 1) {
      const nested = join(workspace, `dir-${directory}`, 'nested')
      mkdirSync(nested, { recursive: true })
      for (let file = 0; file < 6; file += 1) {
        writeFileSync(join(nested, `file-${file}.txt`), 'content', 'utf-8')
      }
    }
    const executor = new NodeToolExecutor(workspace)

    const result = await executor.listTree(workspace, {
      maxDepth: 2,
      maxEntriesPerDirectory: 3,
      maxNodes: 7,
    })
    const serialized = JSON.stringify(result.data)

    expect(result.success).toBe(true)
    expect(serialized).toContain('dir-0')
    expect(serialized).not.toContain('file-0.txt')
    const countNodes = (node: any): number => 1 + (node?.children || []).reduce((sum: number, child: any) => sum + countNodes(child), 0)
    expect(countNodes(result.data)).toBeLessThanOrEqual(7)
  }))

  it('paginates content search and returns context windows', async () => withWorkspace(async ({ workspace }) => {
    const filePath = join(workspace, 'events.ts')
    writeFileSync(filePath, [
      'before zero',
      'needle zero',
      'after zero',
      'before one',
      'needle one',
      'after one',
      'before two',
      'needle two',
      'after two',
      'before three',
      'needle three',
      'after three',
    ].join('\n'), 'utf-8')
    const executor = new NodeToolExecutor(workspace)

    const result = await executor.searchContentPage('needle', workspace, '*.ts', false, {
      offset: 1,
      limit: 2,
      contextBefore: 1,
      contextAfter: 1,
    })

    expect(result).toMatchObject({
      success: true,
      data: { totalMatches: 4, offset: 1, limit: 2, truncated: true },
    })
    expect(result.data?.hits.map(hit => hit.text)).toEqual(['needle one', 'needle two'])
    expect(result.data?.hits[0]?.context).toContain('4: before one')
    expect(result.data?.hits[0]?.context).toContain('6: after one')
  }))

  it('separates compatible batched content searches', async () => withWorkspace(async ({ workspace }) => {
    writeFileSync(join(workspace, 'owners.ts'), [
      'export function createOwner() { return true }',
      'export function dropOwner() { return false }',
      'export function unrelated() { return null }',
    ].join('\n'), 'utf-8')
    const executor = new NodeToolExecutor(workspace)

    const results = await executor.searchContentBatch([
      { pattern: 'createOwner', basePath: workspace, filePattern: '*.ts', options: { limit: 20 } },
      { pattern: 'dropOwner', basePath: workspace, filePattern: '*.ts', options: { limit: 20 } },
    ])

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ success: true, data: { totalMatches: 1 } })
    expect(results[1]).toMatchObject({ success: true, data: { totalMatches: 1 } })
    expect(results[0].data?.hits[0]?.text).toContain('createOwner')
    expect(results[1].data?.hits[0]?.text).toContain('dropOwner')
  }))

  it('can cap census search to one anchor per file', async () => withWorkspace(async ({ workspace }) => {
    writeFileSync(join(workspace, 'first.ts'), 'needle one\nneedle two\nneedle three\n', 'utf-8')
    writeFileSync(join(workspace, 'second.ts'), 'needle four\nneedle five\n', 'utf-8')
    const executor = new NodeToolExecutor(workspace)

    const result = await executor.searchContentPage('needle', workspace, '*.ts', false, {
      limit: 500,
      maxMatchesPerFile: 1,
    })

    expect(result).toMatchObject({ success: true, data: { totalMatches: 2, truncated: false } })
    expect(result.data?.hits.map(hit => hit.file)).toHaveLength(2)
  }))

  it('propagates cancellation into ripgrep searches', async () => withWorkspace(async ({ workspace }) => {
    writeFileSync(join(workspace, 'source.ts'), 'needle\n', 'utf-8')
    const executor = new NodeToolExecutor(workspace)
    const controller = new AbortController()
    controller.abort()

    const [content, files] = await Promise.all([
      executor.searchContentPage('needle', workspace, '*.ts', false, { signal: controller.signal }),
      executor.searchFiles('**/*.ts', workspace, { signal: controller.signal }),
    ])

    expect(content.success).toBe(false)
    expect(files.success).toBe(false)
  }))

  it('finds symbols across Python, Rust, and Go declaration syntax', async () => withWorkspace(async ({ workspace }) => {
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'worker.py'), 'async def flux_worker():\n    return True\n', 'utf-8')
    writeFileSync(join(workspace, 'src', 'worker.rs'), 'pub async fn flux_runner() {}\n', 'utf-8')
    writeFileSync(join(workspace, 'src', 'worker.go'), 'func FluxGateway() {}\n', 'utf-8')
    const executor = new NodeToolExecutor(workspace)

    const result = await executor.searchCodeSymbols({ query: 'flux', workspacePath: workspace, limit: 10 })

    expect(result.success).toBe(true)
    expect(result.data?.map(hit => hit.title)).toEqual(expect.arrayContaining(['flux_worker', 'flux_runner', 'FluxGateway']))
  }))

  it('can require an exact symbol instead of a similarly named test declaration', async () => withWorkspace(async ({ workspace }) => {
    mkdirSync(join(workspace, 'lib', 'tests'), { recursive: true })
    writeFileSync(join(workspace, 'lib', 'cbook.py'), 'class Grouper:\n    pass\n', 'utf-8')
    writeFileSync(join(workspace, 'lib', 'tests', 'test_cbook.py'), 'def test_grouper_private():\n    pass\n', 'utf-8')
    const executor = new NodeToolExecutor(workspace)

    const result = await executor.searchCodeSymbols({ query: 'Grouper', workspacePath: workspace, limit: 10, exact: true })

    expect(result.success).toBe(true)
    expect(result.data?.map(hit => hit.title)).toEqual(['Grouper'])
    expect(result.data?.[0]?.path).toBe('lib/cbook.py')
  }))

  it('accepts a concrete file path when narrowing symbol search', async () => withWorkspace(async ({ workspace }) => {
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'Target.ts'), 'export function fluxTarget() {}\n', 'utf-8')
    writeFileSync(join(workspace, 'src', 'Sibling.ts'), 'export function fluxSibling() {}\n', 'utf-8')
    const executor = new NodeToolExecutor(workspace)

    const result = await executor.searchCodeSymbols({
      query: 'flux',
      workspacePath: workspace,
      path: 'src/Target.ts',
      limit: 10,
    })

    expect(result.success).toBe(true)
    expect(result.data?.map(hit => hit.path)).toEqual(['src/Target.ts'])
  }))

  it('discovers useful dot-directories but skips secret env files', async () => withWorkspace(async ({ workspace }) => {
    mkdirSync(join(workspace, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(workspace, '.github', 'workflows', 'ci.yml'), 'name: ci', 'utf-8')
    writeFileSync(join(workspace, '.env'), 'SECRET=value', 'utf-8')
    writeFileSync(join(workspace, '.env.example'), 'SECRET=', 'utf-8')
    const executor = new NodeToolExecutor(workspace)

    const yaml = await executor.searchFiles('**/*.yml', workspace)
    const envFiles = await executor.searchFiles('.env*', workspace)

    expect(yaml.data?.matches.some(path => path.endsWith('ci.yml'))).toBe(true)
    expect(envFiles.data?.matches.some(path => path.endsWith('.env.example'))).toBe(true)
    expect(envFiles.data?.matches.some(path => path.endsWith('.env'))).toBe(false)
  }))

  it('supports root files and brace globs used by code-search agents', async () => withWorkspace(async ({ workspace }) => {
    mkdirSync(join(workspace, 'src', 'cli'), { recursive: true })
    writeFileSync(join(workspace, 'package.json'), '{}', 'utf-8')
    writeFileSync(join(workspace, 'src', 'cli', 'index.ts'), 'export {}', 'utf-8')
    writeFileSync(join(workspace, 'src', 'cli', 'main.js'), 'export {}', 'utf-8')
    const executor = new NodeToolExecutor(workspace)

    const manifests = await executor.searchFiles('**/{package.json,pyproject.toml,Cargo.toml}', workspace)
    const entries = await executor.searchFiles('**/{index,main}.{ts,js}', workspace)

    expect(manifests.data?.matches).toEqual([join(workspace, 'package.json')])
    expect(entries.data?.matches).toEqual(expect.arrayContaining([
      join(workspace, 'src', 'cli', 'index.ts'),
      join(workspace, 'src', 'cli', 'main.js'),
    ]))
  }))

})

const windowsIt = process.platform === 'win32' ? it : it.skip

windowsIt('does not mistake Windows command switches for absolute paths', async () => withWorkspace(async ({ workspace }) => {
  const executor = new NodeToolExecutor(workspace, { capabilityProfile: 'danger-full-access' })

  const result = await executor.runCommand('cmd /c echo ok /s', workspace, {}, 5000, true)

  expect(result.success).toBe(true)
  expect(result.data?.stdout).toContain('ok')
}))

it('aborts only the requested streaming response', async () => withWorkspace(async ({ workspace }) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write('data: {"partial":true}\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server address')
    const executor = new NodeToolExecutor(workspace)
    const pending = executor.streamMessage(
      `http://127.0.0.1:${address.port}`,
      {},
      '{}',
      () => {},
      { streamId: 42, timeoutMs: 5000 },
    )
    await new Promise(resolve => setTimeout(resolve, 25))
    await executor.streamAbort(42)
    await expect(pending).resolves.toMatchObject({ success: false, error: 'Request aborted' })
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}))

it('distinguishes request deadlines from user cancellation', async () => withWorkspace(async ({ workspace }) => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  }))
  const executor = new NodeToolExecutor(workspace)

  try {
    await expect(executor.streamMessage(
      'https://example.test/v1/responses',
      {},
      '{}',
      () => {},
      { timeoutMs: 5 },
    )).resolves.toMatchObject({
      success: false,
      error: 'Request timed out after 5ms',
    })
  } finally {
    fetchMock.mockRestore()
  }
}))

it('does not replay a model request after receiving partial stream bytes', async () => withWorkspace(async ({ workspace }) => {
  const encoder = new TextEncoder()
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}'))
      setTimeout(() => controller.error(new Error('socket closed after response bytes')), 0)
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
  const onLine = vi.fn()
  const executor = new NodeToolExecutor(workspace)

  try {
    const result = await executor.streamMessage('https://example.test/v1/chat/completions', {}, '{}', onLine)

    expect(result.success).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onLine).toHaveBeenCalledWith('data: {"choices":[{"delta":{"content":"hi"}}]}')
  } finally {
    fetchMock.mockRestore()
  }
}))

it('preserves nested network causes in model request diagnostics', () => {
  const executor = new NodeToolExecutor(process.cwd())
  const cause = Object.assign(new Error('connection timed out'), {
    code: 'UND_ERR_CONNECT_TIMEOUT',
    address: '65.75.209.177',
    port: 443,
  })
  const error = new TypeError('fetch failed', { cause })
  const message = (executor as unknown as {
    formatNetworkError: (url: string, value: unknown) => string
  }).formatNetworkError('https://example.test/v1/messages', error)

  expect(message).toContain('https://example.test/v1/messages')
  expect(message).toContain('fetch failed')
  expect(message).toContain('UND_ERR_CONNECT_TIMEOUT')
  expect(message).toContain('address=65.75.209.177')
  expect(message).toContain('port=443')
})

it('runs and inspects an agent background terminal session', async () => withWorkspace(async ({ workspace }) => {
  const executor = new NodeToolExecutor(workspace, { capabilityProfile: 'danger-full-access' })

  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
  const created = await executor.ptyCreate?.({ cwd: workspace, shell })
  expect(created?.success).toBe(true)
  const sessionId = created?.data?.sessionId
  expect(sessionId).toBeTruthy()
  const runtimeTask = executor.getRuntimeTaskManager().listTasks({ kind: 'terminal' })[0]
  expect(runtimeTask).toMatchObject({
    status: 'running',
    interactive: true,
    metadata: { sessionId },
  })
  expect(created?.data?.session.logPath).toBe(runtimeTask?.logPath)

  const command = process.platform === 'win32'
    ? 'echo turbo-terminal-ok && exit'
    : 'printf "turbo-terminal-ok\\n"; exit'
  const written = await executor.ptyWrite?.(sessionId!, `${command}\n`)
  expect(written?.success).toBe(true)

  let buffer = await executor.ptyGetBuffer?.(sessionId!)
  for (let i = 0; i < 20 && !String(buffer?.data || '').includes('turbo-terminal-ok'); i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
    buffer = await executor.ptyGetBuffer?.(sessionId!)
  }

  expect(buffer?.success).toBe(true)
  expect(String(buffer?.data || '')).toContain('turbo-terminal-ok')

  const listed = await executor.ptyList?.()
  expect(listed?.success).toBe(true)
  expect(listed?.sessions?.some((session: any) => session.id === sessionId)).toBe(true)

  for (let i = 0; i < 20; i++) {
    const sessions = await executor.ptyList?.()
    const session = sessions?.sessions?.find((item: any) => item.id === sessionId)
    if (session?.status === 'exited') break
    await new Promise(resolve => setTimeout(resolve, 50))
  }

  const killed = await executor.ptyKillAll?.()
  expect(killed?.success).toBe(true)

  const afterKill = await executor.ptyList?.()
  expect(afterKill?.sessions?.find((session: any) => session.id === sessionId)?.status).toBe('exited')
  expect(executor.getRuntimeTaskManager().getTask(runtimeTask!.id)).toMatchObject({
    status: 'completed',
    exitCode: 0,
  })
  expect(readFileSync(runtimeTask!.logPath!, 'utf-8')).toContain('turbo-terminal-ok')
}))

it('runs one background command per session with exact exit state and incremental output', async () => withWorkspace(async ({ workspace }) => {
  const executor = new NodeToolExecutor(workspace, { capabilityProfile: 'danger-full-access' })
  const command = `node -e "console.log('first'); setTimeout(() => { console.log('second'); process.exit(7) }, 1000)"`
  const created = await executor.startBackgroundCommand(command, workspace, undefined, true)

  expect(created.success).toBe(true)
  const sessionId = created.data!.sessionId
  let first = await executor.ptyGetBuffer(sessionId)
  for (let attempt = 0; attempt < 40 && !String(first.data || '').includes('first'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
    first = await executor.ptyGetBuffer(sessionId)
  }
  expect(first.data).toContain('first')
  const cursor = first.lastSeq || 0

  let session = (await executor.ptyList()).sessions?.find(item => item.id === sessionId)
  for (let attempt = 0; attempt < 120 && session?.status === 'running'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
    session = (await executor.ptyList()).sessions?.find(item => item.id === sessionId)
  }

  const incremental = await executor.ptyGetBuffer(sessionId, cursor)
  expect(incremental.data).toContain('second')
  expect(incremental.data).not.toContain('first')
  expect(session).toMatchObject({ status: 'error', exitCode: 7, command, canWrite: false })
  const task = executor.getRuntimeTaskManager().listTasks({ kind: 'terminal' })[0]
  expect(task).toMatchObject({ status: 'failed', exitCode: 7, command })
  expect(readFileSync(task.logPath!, 'utf8')).toContain('second')
}), 15_000)

it('reports evicted output and keeps explicit stops out of the error state', async () => withWorkspace(async ({ workspace }) => {
  const executor = new NodeToolExecutor(workspace, { capabilityProfile: 'danger-full-access' })
  const created = await executor.startBackgroundCommand('node -e "setInterval(() => {}, 1000)"', workspace, undefined, true)
  const sessionId = created.data!.sessionId
  const internal = executor as unknown as {
    backgroundTerminals: Map<string, { proc: { stdout: EventEmitter } }>
  }
  const session = internal.backgroundTerminals.get(sessionId)!

  for (let index = 0; index < 510; index += 1) {
    session.proc.stdout.emit('data', Buffer.from(`chunk-${index}\n`))
  }
  const buffer = await executor.ptyGetBuffer(sessionId)
  expect(buffer.firstSeq).toBeGreaterThan(1)
  expect(buffer.omittedBytes).toBeGreaterThan(0)
  expect(buffer.data).not.toContain('chunk-0\n')

  expect(await executor.ptyKill(sessionId)).toMatchObject({ success: true })
  await new Promise(resolve => setTimeout(resolve, 50))
  const stopped = (await executor.ptyList()).sessions?.find(item => item.id === sessionId)
  const task = executor.getRuntimeTaskManager().listTasks({ kind: 'terminal' })[0]
  expect(stopped).toMatchObject({ status: 'exited', canWrite: false, error: undefined })
  expect(task).toMatchObject({ status: 'stopped', error: undefined })
}), 15_000)

it('preserves persisted sequence cursors when reading a recovered session', async () => withWorkspace(async ({ workspace }) => {
  const logPath = join(workspace, 'recovered.jsonl')
  writeFileSync(logPath, [
    JSON.stringify({ timestamp: 100, channel: 'stdout', data: 'old\n', seq: 41 }),
    JSON.stringify({ timestamp: 200, channel: 'stdout', data: 'new\n', seq: 42 }),
    '',
  ].join('\n'), 'utf8')
  const manager = new RuntimeTaskManager({ recover: false })
  const task = manager.createTask({
    kind: 'terminal',
    status: 'running',
    command: 'npm run watch',
    logPath,
    outputBytes: 8,
    metadata: { sessionId: 'term-recovered', firstSeq: 41, lastSeq: 42, omittedBytes: 128 },
  })
  manager.completeTask(task.id, { exitCode: 0 })
  const executor = new NodeToolExecutor(workspace, { runtimeTaskManager: manager })

  const incremental = await executor.ptyGetBuffer('term-recovered', 41)
  expect(incremental).toMatchObject({ firstSeq: 41, lastSeq: 42, omittedBytes: 0, data: 'new\n' })
  const fullTail = await executor.ptyGetBuffer('term-recovered')
  expect(fullTail).toMatchObject({ firstSeq: 41, lastSeq: 42, omittedBytes: 128, data: 'old\nnew\n' })
}))

describe('NodeToolExecutor webSearch', () => {
  it('returns DuckDuckGo instant answer results', async () => withWorkspace(async ({ workspace }) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        Heading: 'TurboFlux',
        AbstractURL: 'https://example.com/turboflux',
        AbstractText: 'TurboFlux is a local AI workbench.',
        AbstractSource: 'Example',
        RelatedTopics: [
          {
            FirstURL: 'https://example.com/docs',
            Text: 'TurboFlux docs - Reference manual',
          },
        ],
      }),
    } as Response)

    const executor = new NodeToolExecutor(workspace)
    const result = await executor.webSearch({ query: 'TurboFlux docs', limit: 3 })

    expect(result.success).toBe(true)
    expect(result.data?.provider).toBe('duckduckgo_instant')
    expect(result.data?.results[0]).toMatchObject({
      title: 'TurboFlux',
      url: 'https://example.com/turboflux',
      snippet: 'TurboFlux is a local AI workbench.',
      source: 'Example',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  }))

  it('falls back to DuckDuckGo HTML results and normalizes redirect URLs', async () => withWorkspace(async ({ workspace }) => {
    const html = `
      <div class="result results_links">
        <div class="links_main">
          <a class="result__a" href="/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Flearn">Node.js Learn</a>
          <a class="result__snippet">Official Node.js learning documentation.</a>
        </div>
      </div>
    `
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => html,
    } as Response)

    const executor = new NodeToolExecutor(workspace)
    const result = await executor.webSearch({
      query: 'Node.js fetch AbortController',
      limit: 2,
      freshness: 'month',
      domains: ['https://nodejs.org/docs'],
    })

    expect(result.success).toBe(true)
    expect(result.data?.provider).toBe('duckduckgo_html')
    expect(result.data?.query).toContain('site:nodejs.org')
    expect(result.data?.results).toEqual([
      {
        title: 'Node.js Learn',
        url: 'https://nodejs.org/en/learn',
        snippet: 'Official Node.js learning documentation.',
        source: 'DuckDuckGo',
      },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const calledUrl = String(fetchMock.mock.calls[0][0])
    expect(calledUrl).toContain('df=m')
    expect(calledUrl).toContain('site%3Anodejs.org')
  }))

  it('falls back to Bing HTML when DuckDuckGo providers are unavailable', async () => withWorkspace(async ({ workspace }) => {
    const html = `
      <ol id="b_results">
        <li class="b_algo">
          <h2><a href="https://nodejs.org/en/learn">Node.js Learn</a></h2>
          <p>Node.js&#174; official learning documentation.</p>
        </li>
      </ol>
    `
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('duck instant blocked'))
      .mockRejectedValueOnce(new Error('duck html blocked'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => html,
      } as Response)

    const executor = new NodeToolExecutor(workspace)
    const result = await executor.webSearch({ query: 'Node.js learn', limit: 2 })

    expect(result.success).toBe(true)
    expect(result.data?.provider).toBe('bing_html')
    expect(result.data?.results).toEqual([
      {
        title: 'Node.js Learn',
        url: 'https://nodejs.org/en/learn',
        snippet: 'Node.js® official learning documentation.',
        source: 'Bing',
      },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  }))
})
