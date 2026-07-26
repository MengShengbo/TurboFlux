import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeToolExecutor } from '../src/core/runtime/nodeToolExecutor'

const workspace = mkdtempSync(join(tmpdir(), 'turboflux-runtime-smoke-'))
try {
  const executor = new NodeToolExecutor(workspace, { sandboxPolicy: 'full' })
  const write = await executor.writeFile('smoke.txt', 'runtime-ok')
  const read = await executor.readFile('smoke.txt')
  const command = process.platform === 'win32' ? 'Write-Output runtime-ok' : 'printf runtime-ok'
  const result = await executor.runCommand(command, workspace, 10_000)
  if (!write.success || !read.success || read.data !== 'runtime-ok' || !result.success) process.exitCode = 1
  console.log(JSON.stringify({ write: write.success, read: read.success, command: result.success }))
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
