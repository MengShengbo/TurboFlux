import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NodeToolExecutor } from './nodeToolExecutor.js'

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

  const result = await executor.runCommand('cmd /c echo ok /s', workspace)

  expect(result.success).toBe(true)
  expect(result.data?.stdout).toContain('ok')
}))

it('runs and inspects an agent background terminal session', async () => withWorkspace(async ({ workspace }) => {
  const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'workspace' })

  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
  const created = await executor.ptyCreate?.({ cwd: workspace, shell })
  expect(created?.success).toBe(true)
  const sessionId = created?.data?.sessionId
  expect(sessionId).toBeTruthy()

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
}))
