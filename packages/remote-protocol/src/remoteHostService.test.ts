import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNodeDeviceIdentity, createPairingResponse } from './nodeCrypto'
import { RemoteHostService } from './remoteHostService'
import { NodeRemoteStateStore, RemoteHostStateUnreadableError, type RemoteHostPersistentState, type RemoteStateStore } from './stateStore'
import { turboFluxWorkspaceId, type TurboFluxRemoteSnapshotLike } from './turbofluxAdapter'
import { REMOTE_PROTOCOL_VERSION, type RemoteCommand } from './types'

class MinimalRuntime {
  readonly prompts: string[] = []
  private readonly snapshot: TurboFluxRemoteSnapshotLike = {
    workspace: { path: '/workspace', name: 'Workspace' },
    runtime: { status: 'ready', pendingRequests: [] },
    conversation: { id: 'session-1', turns: [] },
    conversationCatalog: [{ id: 'session-1', title: 'Task', workspacePath: '/workspace', updatedAt: 1 }],
    conversationRuntimes: [{ conversationId: 'session-1', status: 'ready', updatedAt: 1 }],
    artifacts: { artifacts: [] },
  }
  getSnapshot() { return this.snapshot }
  subscribe() { return () => undefined }
  submitPromptToConversation(_sessionId: string, prompt: string) { this.prompts.push(prompt); return { status: 'started' } }
  controlConversation() { return true }
  newConversation() {}
  switchConversation() {}
  activateRemoteSession() {}
  resolveRequestForConversation() { return true }
  getArtifact() { return null }
}

const temporaryDirectories: string[] = []
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))))

describe('remote host service', () => {
  it('reports protected state that the platform key store cannot decrypt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'turboflux-remote-state-'))
    temporaryDirectories.push(root)
    const path = join(root, 'remote-host.json')
    await writeFile(path, JSON.stringify({ schemaVersion: 1, protected: true, payload: 'AQ' }))
    const store = new NodeRemoteStateStore(path, {
      protect: value => value,
      unprotect: () => { throw new Error('safeStorage decrypt failed') },
    })

    await expect(store.load()).rejects.toBeInstanceOf(RemoteHostStateUnreadableError)
  })

  it('persists protected host identity and paired device grants', async () => {
    const root = await mkdtemp(join(tmpdir(), 'turboflux-remote-state-'))
    temporaryDirectories.push(root)
    const path = join(root, 'remote-host.json')
    const protect = (value: Uint8Array) => Uint8Array.from(value, byte => byte ^ 0x5a)
    const store = new NodeRemoteStateStore(path, { protect, unprotect: protect })
    const now = 1_780_000_300_000
    const service = await RemoteHostService.create({ displayName: 'Home Mac', runtime: new MinimalRuntime(), stateStore: store, now: () => now })
    const phone = createNodeDeviceIdentity('Phone', now)
    const invite = service.createPairingInvite(['session.read', 'session.submit'], [{ kind: 'iroh', value: 'endpoint-1' }])
    const response = createPairingResponse(phone, invite, ['session.read'], now)
    const pending = service.requestPairing(response, { workspaceIds: [turboFluxWorkspaceId('/workspace')] })
    expect(service.listPairedDevices()).toHaveLength(0)
    expect(service.pairingStatus(pending.requestId, pending.pollToken)).toMatchObject({ status: 'pending' })
    await service.approvePairing(pending.requestId)
    expect(service.pairingStatus(pending.requestId, pending.pollToken)).toMatchObject({ status: 'approved' })

    expect(service.listPairedDevices()).toMatchObject([{ displayName: 'Phone', capabilities: ['session.read'] }])
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const persistedText = await import('node:fs/promises').then(module => module.readFile(path, 'utf8'))
    expect(persistedText).not.toContain(service.identity.signingPrivateKey)
    service.close()

    const restored = await RemoteHostService.create({ displayName: 'Ignored', runtime: new MinimalRuntime(), stateStore: store, now: () => now })
    expect(restored.identity.publicIdentity.deviceId).toBe(service.identity.publicIdentity.deviceId)
    expect(restored.listPairedDevices()).toHaveLength(1)
    restored.close()
  })

  it('keeps a device authorized when revoke persistence fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'turboflux-remote-state-'))
    temporaryDirectories.push(root)
    const baseStore = new NodeRemoteStateStore(join(root, 'remote-host.json'))
    let failSave = false
    const store: RemoteStateStore = {
      loadOrCreate: (displayName, now) => baseStore.loadOrCreate(displayName, now),
      save: (state: RemoteHostPersistentState) => failSave ? Promise.reject(new Error('disk full')) : baseStore.save(state),
    }
    const now = 1_780_000_310_000
    const service = await RemoteHostService.create({ displayName: 'Home Mac', runtime: new MinimalRuntime(), stateStore: store, now: () => now })
    const phone = createNodeDeviceIdentity('Phone', now)
    const invite = service.createPairingInvite(['session.read'], [{ kind: 'iroh', value: 'endpoint-1' }])
    const pending = service.requestPairing(createPairingResponse(phone, invite, ['session.read'], now))
    await service.approvePairing(pending.requestId)
    failSave = true

    await expect(service.revokeDevice(phone.publicIdentity.deviceId)).rejects.toThrow('disk full')
    expect(service.listPairedDevices()).toHaveLength(1)
    service.close()

    const restored = await RemoteHostService.create({ displayName: 'Ignored', runtime: new MinimalRuntime(), stateStore: baseStore, now: () => now })
    expect(restored.listPairedDevices()).toHaveLength(1)
    restored.close()
  })

  it('returns a persisted command result after host restart without executing again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'turboflux-remote-state-'))
    temporaryDirectories.push(root)
    const store = new NodeRemoteStateStore(join(root, 'remote-host.json'))
    const now = 1_780_000_320_000
    const firstRuntime = new MinimalRuntime()
    const service = await RemoteHostService.create({ displayName: 'Home Mac', runtime: firstRuntime, stateStore: store, now: () => now })
    const phone = createNodeDeviceIdentity('Phone', now)
    const invite = service.createPairingInvite(['session.control', 'session.read', 'session.submit'], [{ kind: 'iroh', value: 'endpoint-1' }])
    const pending = service.requestPairing(createPairingResponse(phone, invite, ['session.control', 'session.read', 'session.submit'], now))
    const grant = await service.approvePairing(pending.requestId)
    const submit: RemoteCommand = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      commandId: 'persistent-command',
      clientInstanceId: 'client-1',
      createdAt: now,
      type: 'session.submit',
      adapterId: 'turboflux-native',
      sessionId: 'session-1',
      prompt: 'Only once',
      mode: 'turn',
    }
    await service.controller.execute(phone.publicIdentity, grant.payload.grantId, {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      commandId: 'claim-first',
      clientInstanceId: 'client-1',
      createdAt: now,
      type: 'control.claim',
    })
    const first = await service.controller.execute(phone.publicIdentity, grant.payload.grantId, submit)
    service.close()

    const restoredRuntime = new MinimalRuntime()
    const restored = await RemoteHostService.create({ displayName: 'Ignored', runtime: restoredRuntime, stateStore: store, now: () => now })
    await restored.controller.execute(phone.publicIdentity, grant.payload.grantId, {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      commandId: 'claim-restored',
      clientInstanceId: 'client-1',
      createdAt: now,
      type: 'control.claim',
    })
    const duplicate = await restored.controller.execute(phone.publicIdentity, grant.payload.grantId, submit)

    expect(duplicate).toEqual(first)
    expect(firstRuntime.prompts).toEqual(['Only once'])
    expect(restoredRuntime.prompts).toEqual([])
    restored.close()
  })

  it('serializes competing approve and reject decisions for one pairing request', async () => {
    const now = 1_780_000_330_000
    const service = await RemoteHostService.create({ displayName: 'Home Mac', runtime: new MinimalRuntime(), now: () => now })
    const phone = createNodeDeviceIdentity('Phone', now)
    const invite = service.createPairingInvite(['session.read'], [{ kind: 'iroh', value: 'endpoint-1' }])
    const pending = service.requestPairing(createPairingResponse(phone, invite, ['session.read'], now))

    const [grant, rejected] = await Promise.all([
      service.approvePairing(pending.requestId),
      service.rejectPairing(pending.requestId),
    ])

    expect(grant.payload.subjectDeviceId).toBe(phone.publicIdentity.deviceId)
    expect(rejected).toBe(false)
    expect(service.listPairedDevices()).toHaveLength(1)
    service.close()
  })

  it('invalidates old links and pending confirmations when pairing is refreshed', async () => {
    const now = 1_780_000_340_000
    const service = await RemoteHostService.create({ displayName: 'Home Mac', runtime: new MinimalRuntime(), now: () => now })
    const phone = createNodeDeviceIdentity('Phone', now)
    const invite = service.createPairingInvite(['session.read'], [{ kind: 'iroh', value: 'endpoint-1' }])
    const response = createPairingResponse(phone, invite, ['session.read'], now)
    const pending = service.requestPairing(response)

    service.refreshPairingInvites()

    expect(service.pairingStatus(pending.requestId, pending.pollToken)).toMatchObject({ status: 'rejected' })
    expect(() => service.requestPairing(response)).toThrow(/unavailable|already used/u)
    expect(service.listPendingPairings()).toHaveLength(0)
    service.close()
  })

  it('atomically revokes every device when the remote control session stops', async () => {
    const root = await mkdtemp(join(tmpdir(), 'turboflux-remote-state-'))
    temporaryDirectories.push(root)
    const store = new NodeRemoteStateStore(join(root, 'remote-host.json'))
    const now = 1_780_000_350_000
    const service = await RemoteHostService.create({ displayName: 'Home Mac', runtime: new MinimalRuntime(), stateStore: store, now: () => now })
    const phone = createNodeDeviceIdentity('Phone', now)
    const invite = service.createPairingInvite(['session.control', 'session.read'], [{ kind: 'iroh', value: 'endpoint-1' }])
    const pending = service.requestPairing(createPairingResponse(phone, invite, ['session.control', 'session.read'], now))
    const grant = await service.approvePairing(pending.requestId)
    await service.controller.execute(phone.publicIdentity, grant.payload.grantId, {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      commandId: 'claim-before-stop',
      clientInstanceId: 'client-1',
      createdAt: now,
      type: 'control.claim',
    })

    await expect(service.stopRemoteControlSession()).resolves.toBe(1)
    expect(service.listPairedDevices()).toHaveLength(0)
    expect(service.controller.activeControlSession()).toBeUndefined()
    service.close()

    const restored = await RemoteHostService.create({ displayName: 'Ignored', runtime: new MinimalRuntime(), stateStore: store, now: () => now })
    expect(restored.listPairedDevices()).toHaveLength(0)
    restored.close()
  })
})
