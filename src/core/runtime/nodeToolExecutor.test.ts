import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandOutput, Result } from '../../tools/executor.js'
import { NodeToolExecutor } from './nodeToolExecutor.js'
import { hashText } from '../fileIO.js'

const previousCodeGraphDisabled = process.env.TURBOFLUX_DISABLE_CODEGRAPH
process.env.TURBOFLUX_DISABLE_CODEGRAPH = '1'

afterAll(() => {
  if (previousCodeGraphDisabled === undefined) delete process.env.TURBOFLUX_DISABLE_CODEGRAPH
  else process.env.TURBOFLUX_DISABLE_CODEGRAPH = previousCodeGraphDisabled
})

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
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

describe('NodeToolExecutor sandbox policies', () => {
  it('keeps workspace policy reads and writes inside the workspace', async () => withWorkspace(async ({ workspace, outside }) => {
    const outsideFile = join(outside, 'secret.txt')
    writeFileSync(join(workspace, 'inside.txt'), 'inside', 'utf-8')
    writeFileSync(outsideFile, 'outside', 'utf-8')

    const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'workspace' })

    await expect(executor.readFile('inside.txt')).resolves.toMatchObject({
      success: true,
      data: 'inside',
    })

    const outsideRead = await executor.readFile(outsideFile)
    expect(outsideRead.success).toBe(false)
    expect(outsideRead.error).toContain('Path outside workspace')

    const outsideWrite = await executor.writeFile(join(outside, 'new.txt'), 'nope')
    expect(outsideWrite.success).toBe(false)
    expect(outsideWrite.error).toContain('Path outside workspace')
    expect(existsSync(join(outside, 'new.txt'))).toBe(false)
  }))

  it('resolves relative paths against the workspace root', async () => withWorkspace(async ({ workspace }) => {
    const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'workspace' })

    const write = await executor.writeFile('nested/file.txt', 'hello')
    const read = await executor.readFile('nested/file.txt')

    expect(write.success).toBe(true)
    expect(read).toMatchObject({ success: true, data: 'hello' })
    expect(readFileSync(join(workspace, 'nested', 'file.txt'), 'utf-8')).toBe('hello')
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

  it('blocks workspace paths that escape through a symlink or junction', async () => withWorkspace(async ({ workspace, outside }) => {
    writeFileSync(join(outside, 'secret.txt'), 'outside', 'utf-8')
    const linkPath = join(workspace, 'linked')
    try {
      symlinkSync(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return
    }
    const executor = new NodeToolExecutor(workspace)

    const result = await executor.readFile(join(linkPath, 'secret.txt'))

    expect(result.success).toBe(false)
    expect(result.error).toContain('Path outside workspace')
  }))

  it('blocks writes and command execution in readonly policy', async () => withWorkspace(async ({ workspace }) => {
    writeFileSync(join(workspace, 'inside.txt'), 'inside', 'utf-8')
    const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'readonly' })

    await expect(executor.readFile('inside.txt')).resolves.toMatchObject({
      success: true,
      data: 'inside',
    })

    const write = await executor.writeFile('inside.txt', 'changed')
    expect(write.success).toBe(false)
    expect(write.error).toContain('read-only')

    const command = await executor.runCommand('node -e "console.log(1)"', workspace)
    expect(command.success).toBe(false)
    expect(command.error).toContain('command execution is disabled')
  }))

  it('allows explicit outside paths in full policy', async () => withWorkspace(async ({ workspace, outside }) => {
    const outsideFile = join(outside, 'allowed.txt')
    const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'full' })

    const write = await executor.writeFile(outsideFile, 'outside ok')
    const read = await executor.readFile(outsideFile)

    expect(write.success).toBe(true)
    expect(read).toMatchObject({ success: true, data: 'outside ok' })
  }))

  it('blocks relative traversal paths in workspace commands', async () => withWorkspace(async ({ workspace }) => {
    const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'workspace' })
    const command = process.platform === 'win32'
      ? 'cmd /c type ..\\outside.txt'
      : 'cat ../outside.txt'

    const result = await executor.runCommand(command, workspace)

    expect(result.success).toBe(false)
    expect(result.error).toContain('relative path outside the workspace')
  }))

  it('requires an explicit permission decision for workspace shell commands', async () => withWorkspace(async ({ workspace }) => {
    const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'workspace' })

    const blocked = await executor.runCommand('echo hello', workspace)
    const approved = await executor.runCommand('echo hello', workspace, {}, 5000, true)

    expect(blocked.success).toBe(false)
    expect(blocked.error).toContain('explicit permission')
    expect(approved.success).toBe(true)
  }))

  it('reports non-zero process exits as failures', async () => withWorkspace(async ({ workspace }) => {
    const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'workspace' })
    const result = await executor.runProcess(process.execPath, ['-e', 'process.exit(7)'], workspace)
    const runtimeTask = executor.getRuntimeTaskManager().listTasks({ kind: 'shell' })[0]

    expect(result.success).toBe(false)
    expect(result.data?.exitCode).toBe(7)
    expect(runtimeTask).toMatchObject({ status: 'failed', exitCode: 7, interactive: false })
  }))

  it('blocks internal process execution in a readonly sandbox', async () => withWorkspace(async ({ workspace }) => {
    const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'readonly' })

    const result = await executor.runProcess(process.execPath, ['-e', 'process.exit(0)'], workspace)

    expect(result.success).toBe(false)
    expect(result.error).toContain('read-only')
    expect(executor.getRuntimeTaskManager().listTasks()).toHaveLength(0)
  }))

  it('blocks internal process arguments that escape the workspace sandbox', async () => withWorkspace(async ({ workspace, outside }) => {
    const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'workspace' })

    const result = await executor.runProcess('git', ['add', '--', outside], workspace)

    expect(result.success).toBe(false)
    expect(result.error).toContain('outside the workspace')
    expect(executor.getRuntimeTaskManager().listTasks()).toHaveLength(0)
  }))

  it('tracks successful foreground processes through completion', async () => withWorkspace(async ({ workspace }) => {
    const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'workspace' })

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

  it('settles after the termination grace period when a timed-out process never closes', async () => withWorkspace(async ({ workspace }) => {
    vi.useFakeTimers()
    try {
      const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'workspace' })
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

  it('does not leak parent-process secrets into child commands', async () => withWorkspace(async ({ workspace }) => {
    process.env.TURBOFLUX_TEST_SECRET = 'do-not-inherit'
    try {
      const executor = new NodeToolExecutor(workspace)
      const hidden = await executor.runProcess(process.execPath, ['-e', 'process.stdout.write(process.env.TURBOFLUX_TEST_SECRET || "missing")'], workspace)
      const explicit = await executor.runProcess(process.execPath, ['-e', 'process.stdout.write(process.env.EXPLICIT_VALUE || "missing")'], workspace, { EXPLICIT_VALUE: 'allowed' })

      expect(hidden.data?.stdout).toBe('missing')
      expect(explicit.data?.stdout).toBe('allowed')
    } finally {
      delete process.env.TURBOFLUX_TEST_SECRET
    }
  }))

  it('blocks code map target paths that escape the workspace', async () => withWorkspace(async ({ workspace }) => {
    const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'workspace' })

    const result = await executor.getCodeMap({
      workspacePath: workspace,
      targetPaths: ['..'],
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Path outside workspace')
  }))

  it('builds code maps from an explicit feature path outside src', async () => withWorkspace(async ({ workspace }) => {
    mkdirSync(join(workspace, 'frontend', 'components'), { recursive: true })
    writeFileSync(join(workspace, 'frontend', 'components', 'Card.tsx'), 'export function HolderCard() { return null }\n', 'utf-8')
    const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'workspace' })

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

  it('creates local history checkpoints for workspace files', async () => withWorkspace(async ({ workspace }) => {
    const filePath = join(workspace, 'inside.txt')
    writeFileSync(filePath, 'after', 'utf-8')
    const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'workspace' })

    const result = await executor.checkpointCreate?.(workspace, 'test checkpoint', [filePath], 'explicit', {
      [filePath]: 'before',
    })

    expect(result?.success).toBe(true)
    expect(result?.checkpointId).toMatch(/^cp_/)
    expect(result?.label).toBe('test checkpoint')
  }))

  it('lists and restores local history checkpoints', async () => withWorkspace(async ({ workspace }) => {
    const filePath = join(workspace, 'inside.txt')
    writeFileSync(filePath, 'checkpoint version', 'utf-8')
    const executor = new NodeToolExecutor(workspace)
    const created = await executor.checkpointCreate(workspace, 'restorable', [filePath], 'explicit', { [filePath]: 'before' })
    writeFileSync(filePath, 'later edit', 'utf-8')

    const listed = await executor.checkpointList(workspace, 10)
    const restored = await executor.checkpointRestore(workspace, created.checkpointId)

    expect(listed.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.checkpointId })]))
    expect(restored.success).toBe(true)
    expect(restored.data?.safetyCheckpointId).toBeTruthy()
    expect(readFileSync(filePath, 'utf-8')).toBe('checkpoint version')
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

  it('blocks local history checkpoints in readonly policy', async () => withWorkspace(async ({ workspace }) => {
    const filePath = join(workspace, 'inside.txt')
    writeFileSync(filePath, 'after', 'utf-8')
    const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'readonly' })

    const result = await executor.checkpointCreate?.(workspace, 'blocked checkpoint', [filePath], 'explicit')

    expect(result?.success).toBe(false)
    expect(result?.error).toContain('read-only')
  }))
})

const windowsIt = process.platform === 'win32' ? it : it.skip

windowsIt('does not mistake Windows command switches for absolute paths', async () => withWorkspace(async ({ workspace }) => {
  const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'workspace' })

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
  const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'workspace' })

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

    const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'workspace' })
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

    const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'workspace' })
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

    const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'workspace' })
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
