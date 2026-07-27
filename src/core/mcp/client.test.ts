import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProcessSandbox } from '../sandbox/processSandbox'
import { McpClient } from './client'

describe('McpClient sandbox integration', () => {
  it('cannot launch stdio servers around an unavailable strict sandbox', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'turboflux-mcp-sandbox-'))
    const sandbox = new ProcessSandbox(workspace, {
      policy: 'workspace',
      enforcement: 'strict',
      backend: 'guarded',
    })
    const client = new McpClient(sandbox, workspace)

    try {
      const connection = await client.connect('blocked', {
        enabled: true,
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
      })
      expect(connection.status).toBe('error')
      expect(connection.error).toContain('Sandbox unavailable')
    } finally {
      await client.disconnectAll()
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
