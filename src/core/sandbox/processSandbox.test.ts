import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ProcessSandbox } from './processSandbox'

const workspaces: string[] = []

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), 'turboflux-process-sandbox-'))
  workspaces.push(path)
  return path
}

afterEach(() => {
  for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('ProcessSandbox', () => {
  it('rejects model-controlled secret and process-injection environment variables', () => {
    const root = workspace()
    const sandbox = new ProcessSandbox(root)

    expect(() => sandbox.prepare({ command: 'node', args: [], cwd: root, env: { SERVICE_API_KEY: 'secret' } }))
      .toThrow('sensitive environment override')
    expect(() => sandbox.prepare({ command: 'node', args: [], cwd: root, env: { NODE_OPTIONS: '--require ./inject.js' } }))
      .toThrow('process-injection environment override')
  })

  it('rejects model-controlled execution roots and paths outside the workspace', () => {
    const root = workspace()
    const outside = join(root, '..', 'outside')
    const sandbox = new ProcessSandbox(root)

    expect(() => sandbox.prepare({ command: 'node', args: [], cwd: root, env: { PATH: outside } }))
      .toThrow('controlled environment override')
    expect(() => sandbox.prepare({ command: 'node', args: [], cwd: root, env: { OUTPUT_PATH: outside } }))
      .toThrow('references a path outside the workspace')
  })

  it('allows explicitly trusted MCP-style environment configuration', () => {
    const root = workspace()
    const sandbox = new ProcessSandbox(root)
    const plan = sandbox.prepare({
      command: 'node',
      args: [],
      cwd: root,
      env: { PATH: process.env.PATH || '', SERVICE_API_KEY: 'configured-secret' },
      trustedEnvironment: true,
    })

    expect(plan.env.SERVICE_API_KEY).toBe('configured-secret')
    expect(plan.env.PATH).toBe(process.env.PATH || '')
  })

  it('blocks all process execution when strict mode cannot resolve a backend', () => {
    const root = workspace()
    const sandbox = new ProcessSandbox(root, {
      policy: 'workspace',
      enforcement: 'strict',
      backend: 'guarded',
    })

    expect(() => sandbox.prepare({
      command: 'node',
      args: ['-e', 'require("fs").readFileSync(require("os").homedir() + "/secret")'],
      cwd: root,
    })).toThrow('Sandbox unavailable')
  })

  it('builds a hardened Docker invocation for strict execution', () => {
    const root = workspace()
    const sandbox = new ProcessSandbox(root, {
      policy: 'workspace',
      enforcement: 'strict',
      network: 'deny',
      backend: 'docker',
      dockerImage: 'turboflux/sandbox:test',
    }, {
      platform: 'win32',
      executableAvailable: name => name === 'docker',
    })

    const hostScript = join(root, 'scripts', 'check.js')
    const plan = sandbox.prepare({ command: 'node', args: [hostScript], cwd: root })

    expect(plan.command).toBe('docker')
    expect(plan.cleanup?.kind).toBe('docker')
    expect(plan.args).toEqual(expect.arrayContaining(['--cidfile', plan.cleanup?.cidFile]))
    expect(plan.args).toEqual(expect.arrayContaining([
      '--read-only', '--cap-drop', 'ALL', '--network', 'none', 'turboflux/sandbox:test', 'node', '/workspace/scripts/check.js',
    ]))
  })

  it('does not project host path variables into Docker containers', () => {
    const root = workspace()
    const sandbox = new ProcessSandbox(root, {
      policy: 'workspace',
      enforcement: 'strict',
      backend: 'docker',
      dockerImage: 'turboflux/sandbox:test',
    }, {
      platform: 'win32',
      executableAvailable: name => name === 'docker',
    })

    const plan = sandbox.prepare({
      command: 'node',
      args: [],
      cwd: root,
      env: { PATH: 'C:\\host-tools', SERVICE_API_KEY: 'configured-secret' },
      trustedEnvironment: true,
    })

    expect(plan.args).not.toEqual(expect.arrayContaining(['--env', 'PATH']))
    expect(plan.args).toEqual(expect.arrayContaining(['--env', 'SERVICE_API_KEY']))
    expect(plan.env.SERVICE_API_KEY).toBe('configured-secret')
  })

  it('writes audit records with a digest instead of raw command text', () => {
    const root = workspace()
    const sandbox = new ProcessSandbox(root)
    sandbox.prepare({ command: 'node', args: ['--version'], cwd: root })

    const workspaceId = createHash('sha256').update(root).digest('hex').slice(0, 24)
    const audit = readFileSync(join(root, '.turboflux', 'sandbox', `${workspaceId}.jsonl`), 'utf-8')
    expect(audit).toContain('commandDigest')
    expect(audit).not.toContain('node --version')
  })
})
