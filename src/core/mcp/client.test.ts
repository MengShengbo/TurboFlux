import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ProcessSandbox } from '../sandbox/processSandbox'
import type { SandboxSpawnPlan } from '../sandbox/types'
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

  it('cleans up a sandbox process when MCP startup fails', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'turboflux-mcp-cleanup-'))
    const plan = {
      command: join(workspace, 'missing-mcp-server'),
      args: [],
      cwd: workspace,
      env: {},
      status: {},
      cleanup: { kind: 'docker', cidFile: join(workspace, 'container.cid') },
    } as SandboxSpawnPlan
    const cleanupProcess = vi.fn()
    const sandbox = {
      prepare: vi.fn(() => plan),
      cleanupProcess,
    } as unknown as ProcessSandbox
    const client = new McpClient(sandbox, workspace)

    try {
      const connection = await client.connect('broken', {
        enabled: true,
        command: 'ignored-by-plan',
      })

      expect(connection.status).toBe('error')
      expect(cleanupProcess).toHaveBeenCalledWith(plan, true)
    } finally {
      await client.disconnectAll()
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
