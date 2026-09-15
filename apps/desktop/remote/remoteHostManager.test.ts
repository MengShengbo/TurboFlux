import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopRemoteHostManager } from './remoteHostManager'
import { decodePairingInvite, turboFluxWorkspaceId, type TurboFluxRemoteSnapshotLike } from '@turboflux/remote-protocol'
import { HttpRemoteTransport, RemoteBrowserClient } from '@turboflux/remote-protocol/browser'

class Runtime {
  readonly snapshot: TurboFluxRemoteSnapshotLike = {
    workspace: { path: '/workspace', name: 'Workspace' },
    runtime: { status: 'ready', pendingRequests: [] },
    conversation: { id: 'session-1', turns: [] },
    conversationCatalog: [{ id: 'session-1', title: 'Task', workspacePath: '/workspace', updatedAt: 1 }],
    conversationRuntimes: [{ conversationId: 'session-1', status: 'ready', updatedAt: 1 }],
    artifacts: { artifacts: [] },
  }
  getSnapshot() { return this.snapshot }
  subscribe() { return () => undefined }
  submitPromptToConversation() { return { status: 'started' } }
  controlConversation() { return true }
  newConversation() {}
  switchConversation() {}
  activateRemoteSession() {}
  resolveRequestForConversation() { return true }
  getArtifact() { return null }
}

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))))

describe('DesktopRemoteHostManager', () => {
  it('keeps remote access disabled until explicitly enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'turboflux-desktop-remote-'))
    directories.push(root)
    const manager = new DesktopRemoteHostManager({ userDataPath: root, displayName: 'Home Mac', stateProtection: { protect: value => value, unprotect: value => value }, port: 0 })
    expect((await manager.initialize()).enabled).toBe(false)
    await manager.attachRuntime(new Runtime())
    expect(manager.status().active).toBe(false)
    await manager.setEnabled(true)
    const active = manager.status()
    expect(active).toMatchObject({ enabled: true, active: true, available: true })
    const pairing = await manager.createPairingCode()
    expect(pairing.code.startsWith('tfrp1:')).toBe(true)
    expect(pairing.workspaceId).toBe(turboFluxWorkspaceId('/workspace'))
    expect(pairing.qrDataUrl).toMatch(/^data:image\/svg\+xml;base64,/u)
    expect(Buffer.from(pairing.qrDataUrl.split(',')[1]!, 'base64').toString('utf8')).toContain('<svg')
    expect(decodePairingInvite(pairing.code).payload.endpointHints).toEqual([{ kind: 'custom', value: `http://127.0.0.1:${active.port}` }])
    await manager.setEnabled(false)
    expect(manager.status().active).toBe(false)
    await manager.close()
  })

  it('publishes only the loopback endpoint when no HTTPS proxy is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'turboflux-desktop-remote-'))
    directories.push(root)
    const manager = new DesktopRemoteHostManager({
      userDataPath: root,
      displayName: 'Home Mac',
      stateProtection: { protect: value => value, unprotect: value => value },
      port: 0,
    })
    await manager.attachRuntime(new Runtime())
    await manager.setEnabled(true)

    const status = manager.status()
    expect(status.localEndpointUrl).toBe(`http://127.0.0.1:${status.port}`)
    expect(status.endpointUrls).toEqual([status.localEndpointUrl])
    expect(decodePairingInvite((await manager.createPairingCode()).code).payload.endpointHints).toEqual([
      { kind: 'custom', value: `http://127.0.0.1:${status.port}` },
    ])
    await manager.close()
  })

  it('does not expose legacy plaintext LAN routes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'turboflux-desktop-remote-'))
    directories.push(root)
    const manager = new DesktopRemoteHostManager({
      userDataPath: root,
      displayName: 'Home Mac',
      stateProtection: { protect: value => value, unprotect: value => value },
      port: 0,
    })
    await manager.attachRuntime(new Runtime())
    await manager.setEnabled(true)
    const status = manager.status()
    expect(status).toMatchObject({ available: true, enabled: true, active: true })

    for (const path of ['/v1/lan/pair', '/v1/lan/pair/status', '/v1/lan/command']) {
      const response = await fetch(`${status.localEndpointUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      expect(response.status).toBe(404)
    }
    await manager.close()
  })

  it('refuses to enable remote access without protected persistent state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'turboflux-desktop-remote-'))
    directories.push(root)
    const manager = new DesktopRemoteHostManager({ userDataPath: root, displayName: 'Home Mac', port: 0 })
    await manager.attachRuntime(new Runtime())

    await expect(manager.setEnabled(true)).rejects.toThrow(/安全存储不可用/u)
    expect(manager.status()).toMatchObject({ available: false, enabled: false, active: false })
    await manager.close()
  })

  it('recovers from an unreadable protected identity without deleting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'turboflux-desktop-remote-'))
    directories.push(root)
    const originalManager = new DesktopRemoteHostManager({
      userDataPath: root,
      displayName: 'Home Mac',
      stateProtection: { protect: value => value, unprotect: value => value },
      port: 0,
    })
    await originalManager.attachRuntime(new Runtime())
    await originalManager.setEnabled(true)
    await originalManager.close()

    const now = 1_780_000_400_000
    const manager = new DesktopRemoteHostManager({
      userDataPath: root,
      displayName: 'Home Mac',
      stateProtection: {
        protect: value => value,
        unprotect: () => { throw new Error('safeStorage decrypt failed') },
      },
      port: 0,
      now: () => now,
    })
    await manager.initialize()
    await expect(manager.attachRuntime(new Runtime())).resolves.toMatchObject({
      enabled: false,
      active: false,
      recoveryRequired: true,
      error: '远程身份无法解密，可能来自其他系统钥匙串。请重置远程身份后重新配对。',
    })
    expect(await readdir(join(root, 'remote'))).toContain('host-state.json')

    await expect(manager.resetRemoteIdentity()).resolves.toMatchObject({ enabled: false, active: false, recoveryRequired: false })
    expect(await readdir(join(root, 'remote'))).toContain(`host-state.unreadable-${now}.json`)
    await expect(manager.setEnabled(true)).resolves.toMatchObject({ enabled: true, active: true, recoveryRequired: false })
    await manager.close()
  })

  it('closes the gateway even when persisted device revocation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'turboflux-desktop-remote-'))
    directories.push(root)
    const manager = new DesktopRemoteHostManager({
      userDataPath: root,
      displayName: 'Home Mac',
      stateProtection: { protect: value => value, unprotect: value => value },
      port: 0,
    })
    await manager.attachRuntime(new Runtime())
    await manager.setEnabled(true)
    const endpoint = manager.status().localEndpointUrl!
    const internals = manager as unknown as { service: { stopRemoteControlSession(reason?: string): Promise<number> } }
    vi.spyOn(internals.service, 'stopRemoteControlSession').mockRejectedValueOnce(new Error('disk full'))

    await expect(manager.setEnabled(false)).rejects.toThrow('disk full')
    expect(manager.status()).toMatchObject({ enabled: false, active: false })
    await expect(fetch(`${endpoint}/health`)).rejects.toThrow()
    await manager.close()
  })

  it('rolls back a partially started gateway when preference persistence fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'turboflux-desktop-remote-'))
    directories.push(root)
    const manager = new DesktopRemoteHostManager({
      userDataPath: root,
      displayName: 'Home Mac',
      stateProtection: { protect: value => value, unprotect: value => value },
      port: 0,
    })
    await manager.attachRuntime(new Runtime())
    const internals = manager as unknown as { savePreferences(): Promise<void> }
    const savePreferences = internals.savePreferences.bind(manager)
    let saveCount = 0
    vi.spyOn(internals, 'savePreferences').mockImplementation(async () => {
      saveCount += 1
      if (saveCount === 2) throw new Error('preference write failed')
      await savePreferences()
    })

    await expect(manager.setEnabled(true)).rejects.toThrow('preference write failed')
    expect(manager.status()).toMatchObject({ enabled: false, active: false })
    await manager.close()
  })

  it('publishes only an explicitly configured HTTPS endpoint to mobile browsers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'turboflux-desktop-remote-'))
    directories.push(root)
    const manager = new DesktopRemoteHostManager({
      userDataPath: root,
      displayName: 'Home Mac',
      stateProtection: { protect: value => value, unprotect: value => value },
      publicEndpoint: 'https://remote.example.test/',
      clientUrl: 'https://remote-ui.example.test/control',
      port: 0,
    })
    await manager.attachRuntime(new Runtime())
    await manager.setEnabled(true)

    const pairing = await manager.createPairingCode()
    expect(pairing.endpointUrls).toEqual(['https://remote.example.test'])
    expect(decodePairingInvite(pairing.code).payload.endpointHints).toEqual([{ kind: 'custom', value: 'https://remote.example.test' }])
    expect(new URL(pairing.url!).origin).toBe('https://remote-ui.example.test')
    expect(new URLSearchParams(new URL(pairing.url!).hash.slice(1)).get('pair')).toBe(pairing.code)
    expect(pairing.qrDataUrl).toMatch(/^data:image\/svg\+xml;base64,/u)
    expect(Buffer.from(pairing.qrDataUrl.split(',')[1]!, 'base64').toString('utf8')).toContain('<svg')
    await manager.close()
  })

  it('rejects insecure public LAN endpoints', () => {
    expect(() => new DesktopRemoteHostManager({
      userDataPath: '/tmp/turboflux-desktop-remote',
      displayName: 'Home Mac',
      publicEndpoint: 'http://192.168.2.19:48173',
    })).toThrow(/必须使用 HTTPS/u)
    expect(() => new DesktopRemoteHostManager({
      userDataPath: '/tmp/turboflux-desktop-remote',
      displayName: 'Home Mac',
      clientUrl: 'http://192.168.2.19:4180',
    })).toThrow(/必须使用 HTTPS/u)
  })

  it('does not grant a mobile device until the desktop approves the pending request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'turboflux-desktop-remote-'))
    directories.push(root)
    const manager = new DesktopRemoteHostManager({
      userDataPath: root,
      displayName: 'Home Mac',
      stateProtection: { protect: value => value, unprotect: value => value },
      port: 0,
    })
    await manager.attachRuntime(new Runtime())
    await manager.setEnabled(true)
    const pairing = await manager.createPairingCode()
    const clientPromise = RemoteBrowserClient.pair(
      pairing.code,
      new HttpRemoteTransport(pairing.endpointUrls[0]!, undefined, { pollIntervalMs: 10 }),
      { displayName: 'Phone' },
    )

    await vi.waitFor(() => expect(manager.status().pendingPairings).toHaveLength(1))
    expect(manager.status().pairedDevices).toHaveLength(0)
    const request = manager.status().pendingPairings[0]!
    expect(request).toMatchObject({ displayName: 'Phone', workspaceIds: [turboFluxWorkspaceId('/workspace')] })
    await manager.approvePairing(request.requestId)
    const client = await clientPromise

    await client.claimControl()

    expect(manager.status().pendingPairings).toHaveLength(0)
    expect(manager.status().pairedDevices).toHaveLength(1)
    expect(manager.status().pairedDevices[0]!.expiresAt - manager.status().pairedDevices[0]!.pairedAt).toBeGreaterThan(12 * 60 * 60_000 - 1_000)
    expect(manager.status().controlSession).toMatchObject({ displayName: 'Phone' })
    await manager.stopRemoteControlSession()
    expect(manager.status().pairedDevices).toHaveLength(0)
    expect(manager.status().controlSession).toBeUndefined()
    await expect(client.snapshot()).rejects.toThrow(/not paired/u)
    await client.close()
    await manager.close()
  })

  it('keeps remote identity and grants isolated between local profiles', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'turboflux-desktop-remote-profile-a-'))
    const secondRoot = await mkdtemp(join(tmpdir(), 'turboflux-desktop-remote-profile-b-'))
    directories.push(firstRoot, secondRoot)
    const protection = { protect: (value: Uint8Array) => value, unprotect: (value: Uint8Array) => value }
    const first = new DesktopRemoteHostManager({ userDataPath: firstRoot, displayName: 'Profile A', stateProtection: protection, port: 0 })
    await first.attachRuntime(new Runtime())
    await first.setEnabled(true)
    const pairing = await first.createPairingCode()
    const clientPromise = RemoteBrowserClient.pair(pairing.code, new HttpRemoteTransport(pairing.endpointUrls[0]!, undefined, { pollIntervalMs: 10 }), { displayName: 'Profile A phone' })
    await vi.waitFor(() => expect(first.status().pendingPairings).toHaveLength(1))
    await first.approvePairing(first.status().pendingPairings[0]!.requestId)
    const client = await clientPromise
    expect(first.status().pairedDevices).toHaveLength(1)

    const second = new DesktopRemoteHostManager({ userDataPath: secondRoot, displayName: 'Profile B', stateProtection: protection, port: 0 })
    await second.attachRuntime(new Runtime())
    await second.setEnabled(true)

    expect(second.status().pairedDevices).toEqual([])
    expect(second.status().deviceId).not.toBe(first.status().deviceId)
    expect(second.status().controlSession).toBeUndefined()

    await client.close()
    await first.close()
    await second.close()
  })
})
