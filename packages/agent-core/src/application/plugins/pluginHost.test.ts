import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codePluginHostUnavailableReason, PluginHostProcess } from './pluginHost'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('plugin code host availability', () => {
  it('reports unsupported platforms and missing enforcement primitives', () => {
    const allFlags = { has: () => true }
    expect(codePluginHostUnavailableReason({ platform: 'linux', sandboxExecAvailable: true, allowedNodeEnvironmentFlags: allFlags })).toContain('unavailable on linux')
    expect(codePluginHostUnavailableReason({ platform: 'darwin', sandboxExecAvailable: false, allowedNodeEnvironmentFlags: allFlags })).toContain('sandbox-exec is unavailable')
    expect(codePluginHostUnavailableReason({
      platform: 'darwin',
      sandboxExecAvailable: true,
      allowedNodeEnvironmentFlags: { has: () => false },
    })).toContain('cannot enforce plugin filesystem permissions')
    expect(codePluginHostUnavailableReason({ platform: 'darwin', sandboxExecAvailable: true, allowedNodeEnvironmentFlags: allFlags })).toBeUndefined()
  })
})

describe.skipIf(process.platform !== 'darwin')('PluginHostProcess', () => {
  it('invokes a code plugin through the sandbox host', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-plugin-host-'))
    directories.push(root)
    const pluginDirectory = join(root, 'plugin')
    const workspacePath = join(root, 'workspace')
    const storagePath = join(root, 'storage')
    mkdirSync(pluginDirectory)
    mkdirSync(workspacePath)
    writeFileSync(join(pluginDirectory, 'main.mjs'), `export function activate(context) {
      return {
        echo: async args => ({
          echoed: args.value,
          conversationId: context.conversationId,
          manifestId: context.manifest.id,
          api: Object.keys(context.api).sort(),
          filesystem: Object.keys(context.api.filesystem).sort(),
        }),
      }
    }\n`)
    const host = new PluginHostProcess({
      manifest: { id: 'host.test', name: 'Host test', description: '', version: '1.0.0', author: { name: 'Test' }, main: 'main.mjs', permissions: [] },
      conversationId: 'conversation-host-test',
      pluginDirectory,
      workspacePath,
      storagePath,
      approvedPermissions: [],
    })
    await host.start()
    await expect(host.invoke('echo', { value: 'ok' })).resolves.toEqual({
      echoed: 'ok',
      conversationId: 'conversation-host-test',
      manifestId: 'host.test',
      api: ['commands', 'filesystem', 'storage', 'tools'],
      filesystem: ['delete', 'mkdir', 'readDirectory', 'readFile', 'writeFile'],
    })
    await host.stop()
  })

  it('contains a crashing plugin without terminating the parent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-plugin-host-'))
    directories.push(root)
    const pluginDirectory = join(root, 'plugin')
    const workspacePath = join(root, 'workspace')
    mkdirSync(pluginDirectory)
    mkdirSync(workspacePath)
    writeFileSync(join(pluginDirectory, 'main.mjs'), 'export function crash() { process.exit(17) }\n')
    const host = new PluginHostProcess({
      manifest: { id: 'host.crash', name: 'Crash test', description: '', version: '1.0.0', author: { name: 'Test' }, main: 'main.mjs', permissions: [] },
      conversationId: 'conversation-host-crash',
      pluginDirectory,
      workspacePath,
      storagePath: join(root, 'storage'),
      approvedPermissions: [],
    })
    await host.start()
    await expect(host.invoke('crash', {})).rejects.toThrow('Plugin host exited')
    await host.start()
    await expect(host.invoke('crash', {})).rejects.toThrow('Plugin host exited')
    expect(process.pid).toBeGreaterThan(0)
  })

  it('blocks filesystem access through workspace symlinks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-plugin-host-'))
    directories.push(root)
    const pluginDirectory = join(root, 'plugin')
    const workspacePath = join(root, 'workspace')
    const outsidePath = join(root, 'outside')
    mkdirSync(pluginDirectory)
    mkdirSync(workspacePath)
    mkdirSync(outsidePath)
    writeFileSync(join(outsidePath, 'secret.txt'), 'secret')
    symlinkSync(join(outsidePath, 'secret.txt'), join(workspacePath, 'secret-link'))
    symlinkSync(outsidePath, join(workspacePath, 'outside-link'))
    writeFileSync(join(pluginDirectory, 'main.mjs'), `export function activate(context) {
      return {
        readLink: () => context.api.filesystem.readFile('secret-link'),
        writeLink: () => context.api.filesystem.writeFile('outside-link/secret.txt', 'changed'),
        writeSafe: () => context.api.filesystem.writeFile('nested/result.txt', 'safe'),
      }
    }\n`)
    const host = new PluginHostProcess({
      manifest: {
        id: 'host.symlink',
        name: 'Symlink test',
        description: '',
        version: '1.0.0',
        author: { name: 'Test' },
        main: 'main.mjs',
        permissions: ['filesystem.read', 'filesystem.write'],
      },
      conversationId: 'conversation-host-symlink',
      pluginDirectory,
      workspacePath,
      storagePath: join(root, 'storage'),
      approvedPermissions: ['filesystem.read', 'filesystem.write'],
    })
    await host.start()
    await expect(host.invoke('readLink', {})).rejects.toThrow()
    await expect(host.invoke('writeLink', {})).rejects.toThrow()
    await expect(host.invoke('writeSafe', {})).resolves.toBeUndefined()
    expect(readFileSync(join(outsidePath, 'secret.txt'), 'utf8')).toBe('secret')
    expect(readFileSync(join(workspacePath, 'nested', 'result.txt'), 'utf8')).toBe('safe')
    await host.stop()
  })
})
