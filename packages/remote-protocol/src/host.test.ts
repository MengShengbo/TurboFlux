import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { RemoteHostController } from './host'
import { createCapabilityGrant, createNodeDeviceIdentity, sealRemoteMessage } from './nodeCrypto'
import { RemoteSecureClient, RemoteSecureGateway } from './secureGateway'
import {
  REMOTE_PROTOCOL_VERSION,
  type RemoteAdapterExecutionContext,
  type RemoteAdapterEventListener,
  type RemoteAgentAdapter,
  type RemoteAgentEvent,
  type RemoteAgentSnapshot,
  type RemoteCommand,
  type RemoteCapability,
} from './types'

class FakeAdapter implements RemoteAgentAdapter {
  readonly descriptor = {
    id: 'fake-agent',
    name: 'Fake Agent',
    kind: 'custom' as const,
    version: '1.0.0',
    capabilities: [
      'session.read',
      'session.create',
      'session.submit',
      'session.steer',
      'session.control',
      'approval.resolve',
      'artifact.list',
      'artifact.read',
    ] satisfies RemoteCapability[],
  }
  readonly executions: RemoteCommand[] = []
  readonly executionContexts: RemoteAdapterExecutionContext[] = []
  private readonly listeners = new Set<RemoteAdapterEventListener>()

  getSnapshot(): RemoteAgentSnapshot {
    return {
      schemaVersion: 1,
      adapterId: this.descriptor.id,
      capturedAt: 1_780_000_200_000,
      activeSessionId: 'session-1',
      sessions: [{ id: 'session-1', title: 'Remote task', status: 'ready', updatedAt: 1_780_000_200_000, workspaceId: 'workspace-main', workspaceName: 'Main' }],
      messages: [],
      pendingApprovals: [],
      artifacts: [{ id: 'artifact-1', name: 'report.pdf', kind: 'pdf', mime: 'application/pdf', size: 42, updatedAt: 1_780_000_200_000, available: true }],
    }
  }

  resolveWorkspaceId(): string {
    return 'workspace-main'
  }

  resolveEventWorkspaceId(): string {
    return 'workspace-main'
  }

  execute(command: Exclude<RemoteCommand, { type: 'sync.snapshot' | 'sync.events' }>, context?: RemoteAdapterExecutionContext) {
    this.executions.push(command)
    if (context) this.executionContexts.push(context)
    return { accepted: true, type: command.type }
  }

  subscribe(listener: RemoteAdapterEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: RemoteAgentEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function command<T extends Omit<RemoteCommand, 'protocolVersion' | 'commandId' | 'clientInstanceId' | 'createdAt'>>(value: T, now: number, clientInstanceId = 'client-1'): RemoteCommand {
  return {
    ...value,
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    commandId: randomUUID(),
    clientInstanceId,
    createdAt: now,
  } as RemoteCommand
}

async function claimControl(
  controller: RemoteHostController,
  subject: ReturnType<typeof createNodeDeviceIdentity>['publicIdentity'],
  grantId: string,
  now: number,
  takeover = false,
  clientInstanceId = 'client-1',
): Promise<void> {
  const result = await controller.execute(subject, grantId, command({ type: 'control.claim', takeover }, now, clientInstanceId))
  expect(result.ok).toBe(true)
}

describe('remote host controller', () => {
  it('enforces grants, deduplicates commands, and resumes ordered events', async () => {
    const now = 1_780_000_200_000
    const host = createNodeDeviceIdentity('Home Mac', now)
    const clientIdentity = createNodeDeviceIdentity('Phone', now)
    const controller = new RemoteHostController(host.publicIdentity, { now: () => now, eventLimit: 64 })
    const adapter = new FakeAdapter()
    controller.registerAdapter(adapter)
    const grant = createCapabilityGrant(
      host,
      clientIdentity.publicIdentity,
      ['session.control', 'session.read', 'session.submit', 'approval.resolve'],
      ['workspace-main'],
      { now },
    )
    controller.authorizeGrant(grant, clientIdentity.publicIdentity)
    await claimControl(controller, clientIdentity.publicIdentity, grant.payload.grantId, now)

    const submit = command({ type: 'session.submit', adapterId: 'fake-agent', sessionId: 'session-1', prompt: 'Continue' }, now)
    const first = await controller.execute(clientIdentity.publicIdentity, grant.payload.grantId, submit)
    const duplicate = await controller.execute(clientIdentity.publicIdentity, grant.payload.grantId, submit)
    expect(first).toEqual(duplicate)
    expect(adapter.executions).toHaveLength(1)
    expect(adapter.executionContexts).toEqual([{
      deviceId: clientIdentity.publicIdentity.deviceId,
      clientInstanceId: 'client-1',
    }])
    const conflicting = await controller.execute(clientIdentity.publicIdentity, grant.payload.grantId, { ...submit, prompt: 'Different command' })
    expect(conflicting).toMatchObject({ ok: false, error: { code: 'command_id_conflict' } })
    expect(adapter.executions).toHaveLength(1)

    const denied = await controller.execute(
      clientIdentity.publicIdentity,
      grant.payload.grantId,
      command({ type: 'session.submit', adapterId: 'fake-agent', sessionId: 'session-1', prompt: 'Denied steer', mode: 'steer' }, now),
    )
    expect(denied).toMatchObject({ ok: false, error: { code: 'capability_denied' } })

    adapter.emit({ type: 'run.state', sessionId: 'session-1', status: 'running' })
    adapter.emit({ type: 'notification', sessionId: 'session-1', level: 'success', message: 'Done' })
    const window = controller.getEvents(0)
    expect(window.events.map(event => event.seq)).toEqual([1, 2])
    expect(controller.getEvents(1).events).toHaveLength(1)

    const otherWorkspaceGrant = createCapabilityGrant(
      host,
      clientIdentity.publicIdentity,
      ['session.control', 'session.read', 'session.submit'],
      ['workspace-other'],
      { now },
    )
    controller.authorizeGrant(otherWorkspaceGrant, clientIdentity.publicIdentity)
    await claimControl(controller, clientIdentity.publicIdentity, otherWorkspaceGrant.payload.grantId, now, true)
    const scopedSnapshot = await controller.execute(
      clientIdentity.publicIdentity,
      otherWorkspaceGrant.payload.grantId,
      command({ type: 'sync.snapshot' }, now),
    )
    expect(scopedSnapshot.data).toMatchObject({ snapshots: [{ sessions: [], messages: [] }] })
    const workspaceDenied = await controller.execute(
      clientIdentity.publicIdentity,
      otherWorkspaceGrant.payload.grantId,
      command({ type: 'session.submit', adapterId: 'fake-agent', sessionId: 'session-1', prompt: 'No access' }, now),
    )
    expect(workspaceDenied).toMatchObject({ ok: false, error: { code: 'workspace_denied' } })
  })

  it('runs commands through encrypted request and response envelopes', async () => {
    const now = Date.now()
    const host = createNodeDeviceIdentity('Home Mac', now)
    const clientIdentity = createNodeDeviceIdentity('Phone', now)
    const controller = new RemoteHostController(host.publicIdentity, { now: () => now })
    controller.registerAdapter(new FakeAdapter())
    const grant = createCapabilityGrant(host, clientIdentity.publicIdentity, ['session.read'], [], { now })
    controller.authorizeGrant(grant, clientIdentity.publicIdentity)
    const gateway = new RemoteSecureGateway(host, controller)
    const client = new RemoteSecureClient(clientIdentity, host.publicIdentity, grant)
    const result = await client.execute(gateway, command({ type: 'sync.snapshot' }, now))

    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ hostDeviceId: host.publicIdentity.deviceId })

    const request = sealRemoteMessage(clientIdentity, host.publicIdentity, {
      kind: 'command',
      grantId: grant.payload.grantId,
      command: command({ type: 'sync.snapshot' }, now),
    }, { now, messageId: 'retryable-message' })
    const firstResponse = await gateway.handle(request, clientIdentity.publicIdentity)
    const retryResponse = await gateway.handle(request, clientIdentity.publicIdentity)
    expect(retryResponse).toEqual(firstResponse)
  })

  it('coalesces concurrent duplicate commands before the adapter executes', async () => {
    const now = 1_780_000_250_000
    const host = createNodeDeviceIdentity('Home Mac', now)
    const clientIdentity = createNodeDeviceIdentity('Phone', now)
    const controller = new RemoteHostController(host.publicIdentity, { now: () => now })
    const adapter = new FakeAdapter()
    let release = () => undefined
    adapter.execute = async command => {
      adapter.executions.push(command)
      await new Promise<void>(resolve => { release = resolve })
      return { accepted: true }
    }
    controller.registerAdapter(adapter)
    const grant = createCapabilityGrant(host, clientIdentity.publicIdentity, ['session.control', 'session.read', 'session.submit'], [], { now })
    controller.authorizeGrant(grant, clientIdentity.publicIdentity)
    await claimControl(controller, clientIdentity.publicIdentity, grant.payload.grantId, now)
    const submit = command({ type: 'session.submit', adapterId: 'fake-agent', sessionId: 'session-1', prompt: 'Once' }, now)

    const first = controller.execute(clientIdentity.publicIdentity, grant.payload.grantId, submit)
    const duplicate = controller.execute(clientIdentity.publicIdentity, grant.payload.grantId, submit)
    await Promise.resolve()
    expect(adapter.executions).toHaveLength(1)
    release()
    await expect(duplicate).resolves.toEqual(await first)
  })

  it('uses a durable command ledger after controller restart', async () => {
    const now = 1_780_000_260_000
    const host = createNodeDeviceIdentity('Home Mac', now)
    const clientIdentity = createNodeDeviceIdentity('Phone', now)
    const records = new Map<string, import('./stateStore').PersistedRemoteCommand>()
    const ledger = {
      find: (key: string) => records.get(key),
      begin: async (record: import('./stateStore').PersistedRemoteCommand) => { records.set(record.dedupeKey, structuredClone(record)) },
      complete: async (record: import('./stateStore').PersistedRemoteCommand) => { records.set(record.dedupeKey, structuredClone(record)) },
    }
    const grant = createCapabilityGrant(host, clientIdentity.publicIdentity, ['session.control', 'session.read', 'session.submit'], [], { now })
    const submit = command({ type: 'session.submit', adapterId: 'fake-agent', sessionId: 'session-1', prompt: 'Persist once' }, now)
    const firstAdapter = new FakeAdapter()
    const firstController = new RemoteHostController(host.publicIdentity, { now: () => now, commandLedger: ledger })
    firstController.registerAdapter(firstAdapter)
    firstController.authorizeGrant(grant, clientIdentity.publicIdentity)
    await claimControl(firstController, clientIdentity.publicIdentity, grant.payload.grantId, now)
    const first = await firstController.execute(clientIdentity.publicIdentity, grant.payload.grantId, submit)

    const restoredAdapter = new FakeAdapter()
    const restoredController = new RemoteHostController(host.publicIdentity, { now: () => now, commandLedger: ledger })
    restoredController.registerAdapter(restoredAdapter)
    restoredController.authorizeGrant(grant, clientIdentity.publicIdentity)
    await claimControl(restoredController, clientIdentity.publicIdentity, grant.payload.grantId, now)
    const restored = await restoredController.execute(clientIdentity.publicIdentity, grant.payload.grantId, submit)

    expect(restored).toEqual(first)
    expect(firstAdapter.executions).toHaveLength(1)
    expect(restoredAdapter.executions).toHaveLength(0)
  })

  it('reports an unknown durable outcome when result persistence fails after execution', async () => {
    const now = 1_780_000_270_000
    const host = createNodeDeviceIdentity('Home Mac', now)
    const clientIdentity = createNodeDeviceIdentity('Phone', now)
    const records = new Map<string, import('./stateStore').PersistedRemoteCommand>()
    const controller = new RemoteHostController(host.publicIdentity, {
      now: () => now,
      commandLedger: {
        find: key => records.get(key),
        begin: async record => { records.set(record.dedupeKey, structuredClone(record)) },
        complete: async () => { throw new Error('disk full') },
      },
    })
    const adapter = new FakeAdapter()
    controller.registerAdapter(adapter)
    const grant = createCapabilityGrant(host, clientIdentity.publicIdentity, ['session.control', 'session.read', 'session.submit'], [], { now })
    controller.authorizeGrant(grant, clientIdentity.publicIdentity)
    await claimControl(controller, clientIdentity.publicIdentity, grant.payload.grantId, now)
    const submit = command({ type: 'session.submit', adapterId: 'fake-agent', sessionId: 'session-1', prompt: 'Persist result' }, now)

    const result = await controller.execute(clientIdentity.publicIdentity, grant.payload.grantId, submit)
    const retry = await controller.execute(clientIdentity.publicIdentity, grant.payload.grantId, submit)

    expect(result).toMatchObject({ ok: false, error: { code: 'command_result_persist_failed' } })
    expect(retry).toEqual(result)
    expect(adapter.executions).toHaveLength(1)
    expect([...records.values()]).toMatchObject([{ status: 'in_progress' }])
  })

  it('requires one active mobile page and supports explicit takeover', async () => {
    let now = 1_780_000_280_000
    const host = createNodeDeviceIdentity('Home Mac', now)
    const firstPhone = createNodeDeviceIdentity('First phone', now)
    const secondPhone = createNodeDeviceIdentity('Second phone', now)
    const controller = new RemoteHostController(host.publicIdentity, { now: () => now, controlSessionTtlMs: 10_000 })
    controller.registerAdapter(new FakeAdapter())
    const firstGrant = createCapabilityGrant(host, firstPhone.publicIdentity, ['session.control', 'session.read'], [], { now })
    const secondGrant = createCapabilityGrant(host, secondPhone.publicIdentity, ['session.control', 'session.read'], [], { now })
    controller.authorizeGrant(firstGrant, firstPhone.publicIdentity)
    controller.authorizeGrant(secondGrant, secondPhone.publicIdentity)

    const unclaimed = await controller.execute(firstPhone.publicIdentity, firstGrant.payload.grantId, command({ type: 'sync.snapshot' }, now, 'first-page'))
    expect(unclaimed).toMatchObject({ ok: true })
    await claimControl(controller, firstPhone.publicIdentity, firstGrant.payload.grantId, now, false, 'first-page')
    const denied = await controller.execute(secondPhone.publicIdentity, secondGrant.payload.grantId, command({ type: 'control.claim' }, now, 'second-page'))
    expect(denied).toMatchObject({ ok: false, error: { code: 'control_session_in_use' } })

    await claimControl(controller, secondPhone.publicIdentity, secondGrant.payload.grantId, now, true, 'second-page')
    expect(controller.activeControlSession()).toMatchObject({ displayName: 'Second phone', clientInstanceId: 'second-page' })
    const replaced = await controller.execute(firstPhone.publicIdentity, firstGrant.payload.grantId, command({ type: 'sync.snapshot' }, now, 'first-page'))
    expect(replaced).toMatchObject({ ok: true })

    now += 10_001
    expect(controller.activeControlSession()).toBeUndefined()
    await claimControl(controller, firstPhone.publicIdentity, firstGrant.payload.grantId, now, false, 'first-page')
  })

  it('allows concurrent reads but denies takeover to a read-only device', async () => {
    const now = 1_780_000_290_000
    const host = createNodeDeviceIdentity('Home Mac', now)
    const controllerPhone = createNodeDeviceIdentity('Controller phone', now)
    const observerPhone = createNodeDeviceIdentity('Observer phone', now)
    const controller = new RemoteHostController(host.publicIdentity, { now: () => now })
    controller.registerAdapter(new FakeAdapter())
    const controllerGrant = createCapabilityGrant(host, controllerPhone.publicIdentity, ['session.control', 'session.read'], [], { now })
    const observerGrant = createCapabilityGrant(host, observerPhone.publicIdentity, ['session.read'], [], { now })
    controller.authorizeGrant(controllerGrant, controllerPhone.publicIdentity)
    controller.authorizeGrant(observerGrant, observerPhone.publicIdentity)
    await claimControl(controller, controllerPhone.publicIdentity, controllerGrant.payload.grantId, now, false, 'controller-page')

    const snapshot = await controller.execute(observerPhone.publicIdentity, observerGrant.payload.grantId, command({ type: 'sync.snapshot' }, now, 'observer-page'))
    const takeover = await controller.execute(observerPhone.publicIdentity, observerGrant.payload.grantId, command({ type: 'control.claim', takeover: true }, now, 'observer-page'))

    expect(snapshot).toMatchObject({ ok: true })
    expect(takeover).toMatchObject({ ok: false, error: { code: 'capability_denied' } })
    expect(controller.activeControlSession()).toMatchObject({ deviceId: controllerPhone.publicIdentity.deviceId })
  })
})
