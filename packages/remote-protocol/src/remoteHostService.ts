import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  NodePairingAuthority,
  createNodeDeviceIdentity,
  decodePairingInvite,
  encodePairingInvite,
  verifyCapabilityGrant,
} from './nodeCrypto'
import { RemoteHostController, type RemoteHostControllerOptions } from './host'
import { RemoteSecureGateway } from './secureGateway'
import {
  type PersistedRemoteCommand,
  type PersistedRemotePairing,
  type RemoteHostPersistentState,
  type RemoteStateStore,
} from './stateStore'
import { TurboFluxRemoteAdapter, type TurboFluxRemoteAdapterOptions, type TurboFluxRemoteRuntime } from './turbofluxAdapter'
import {
  type DevicePublicIdentity,
  type EncryptedRemoteEnvelope,
  type NodeDeviceIdentity,
  type PairingEndpointHint,
  type RemoteCapability,
  type RemotePairingRequestReceipt,
  type RemotePairingStatus,
  type SignedCapabilityGrant,
  type SignedPairingInvite,
  type SignedPairingResponse,
} from './types'

export interface RemoteHostServiceOptions<TEvent> {
  displayName: string
  runtime: TurboFluxRemoteRuntime<TEvent>
  stateStore?: RemoteStateStore
  identity?: NodeDeviceIdentity
  adapter?: TurboFluxRemoteAdapterOptions
  controller?: RemoteHostControllerOptions
  now?: () => number
}

export interface AcceptRemotePairingOptions {
  capabilities?: readonly RemoteCapability[]
  workspaceIds?: readonly string[]
  ttlMs?: number
}

export interface RemotePairedDeviceSummary {
  deviceId: string
  displayName: string
  connectionKind: 'encrypted-device'
  capabilities: RemoteCapability[]
  workspaceIds: string[]
  pairedAt: number
  expiresAt: number
}

export interface RemotePendingPairingSummary {
  requestId: string
  deviceId: string
  displayName: string
  connectionKind: 'encrypted-device'
  fingerprint: string
  capabilities: RemoteCapability[]
  workspaceIds: string[]
  requestedAt: number
  expiresAt: number
}

interface RemotePairingRequestRecord extends RemotePendingPairingSummary {
  inviteId: string
  pollTokenHash: Buffer
  response: SignedPairingResponse
  options: AcceptRemotePairingOptions
  status: RemotePairingStatus['status']
  grant?: SignedCapabilityGrant
  reason?: string
}

function pairingTokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

const MAX_PENDING_PAIRING_REQUESTS = 64

function assertPendingPairingCapacity(pairingRequests: Map<string, unknown>): void {
  if (pairingRequests.size >= MAX_PENDING_PAIRING_REQUESTS) {
    throw new Error('Too many pending pairing requests; reject or wait for existing ones to expire')
  }
}

function deviceFingerprint(device: DevicePublicIdentity): string {
  return createHash('sha256')
    .update(device.signingPublicKey)
    .update(device.exchangePublicKey)
    .digest('hex')
    .slice(0, 24)
    .match(/.{1,4}/gu)!
    .join(' ')
}

export class RemoteHostService<TEvent = unknown> {
  readonly adapter: TurboFluxRemoteAdapter<TEvent>
  readonly controller: RemoteHostController
  readonly gateway: RemoteSecureGateway
  private readonly authority: NodePairingAuthority
  private readonly pairedDevices = new Map<string, { device: DevicePublicIdentity; grant: SignedCapabilityGrant; pairedAt: number }>()
  private readonly commandRecords = new Map<string, PersistedRemoteCommand>()
  private readonly pairingRequests = new Map<string, RemotePairingRequestRecord>()
  private readonly pairingRequestByInvite = new Map<string, string>()
  private readonly pairingDefaultsByInvite = new Map<string, AcceptRemotePairingOptions>()
  private stateTransition: Promise<unknown> = Promise.resolve()

  private constructor(
    readonly identity: NodeDeviceIdentity,
    private readonly stateStore: RemoteStateStore | undefined,
    runtime: TurboFluxRemoteRuntime<TEvent>,
    options: RemoteHostServiceOptions<TEvent>,
    private readonly now: () => number,
  ) {
    this.adapter = new TurboFluxRemoteAdapter(runtime, options.adapter)
    this.controller = new RemoteHostController(identity.publicIdentity, {
      ...options.controller,
      now,
      commandLedger: {
        find: dedupeKey => {
          const record = this.commandRecords.get(dedupeKey)
          return record ? structuredClone(record) : undefined
        },
        begin: record => this.beginCommand(record),
        complete: record => this.completeCommand(record),
      },
    })
    this.controller.registerAdapter(this.adapter)
    this.gateway = new RemoteSecureGateway(identity, this.controller)
    this.authority = new NodePairingAuthority(identity, now)
  }

  static async create<TEvent>(options: RemoteHostServiceOptions<TEvent>): Promise<RemoteHostService<TEvent>> {
    const now = options.now ?? Date.now
    const state = options.stateStore
      ? await options.stateStore.loadOrCreate(options.displayName, now())
      : { schemaVersion: 2 as const, identity: options.identity ?? createNodeDeviceIdentity(options.displayName, now()), pairings: [], commands: [] }
    const service = new RemoteHostService(state.identity, options.stateStore, options.runtime, options, now)
    for (const record of state.commands
      .filter(record => record.expiresAt > now())
      .sort((left, right) => left.startedAt - right.startedAt)
      .slice(-2_048)) {
      service.commandRecords.set(record.dedupeKey, structuredClone(record))
    }
    for (const pairing of state.pairings) {
      if (!verifyCapabilityGrant(pairing.grant, state.identity.publicIdentity, pairing.device, now())) continue
      service.pairedDevices.set(pairing.device.deviceId, structuredClone(pairing))
      service.controller.authorizeGrant(pairing.grant, pairing.device)
    }
    return service
  }

  createPairingInvite(
    capabilities: readonly RemoteCapability[],
    endpointHints: readonly PairingEndpointHint[],
    ttlMs?: number,
    approvalDefaults: AcceptRemotePairingOptions = {},
  ): SignedPairingInvite {
    const invite = this.authority.createInvite(capabilities, endpointHints, ttlMs)
    this.pairingDefaultsByInvite.set(invite.payload.inviteId, {
      capabilities: approvalDefaults.capabilities ? [...approvalDefaults.capabilities] : undefined,
      workspaceIds: approvalDefaults.workspaceIds ? [...approvalDefaults.workspaceIds] : undefined,
      ttlMs: approvalDefaults.ttlMs,
    })
    return invite
  }

  createPairingCode(
    capabilities: readonly RemoteCapability[],
    endpointHints: readonly PairingEndpointHint[],
    ttlMs?: number,
  ): string {
    return encodePairingInvite(this.createPairingInvite(capabilities, endpointHints, ttlMs))
  }

  createPairingCodeFromInvite(invite: SignedPairingInvite): string {
    return encodePairingInvite(invite)
  }

  inspectPairingCode(value: string): SignedPairingInvite {
    return decodePairingInvite(value, this.now())
  }

  requestPairing(response: SignedPairingResponse, options: AcceptRemotePairingOptions = {}): RemotePairingRequestReceipt {
    this.cleanupPairingRequests()
    assertPendingPairingCapacity(this.pairingRequests)
    const invite = this.authority.inspectResponse(response)
    if (this.pairingRequestByInvite.has(invite.payload.inviteId)) throw new Error('Pairing invite already has a pending device confirmation')
    const defaults = this.pairingDefaultsByInvite.get(invite.payload.inviteId)
    const effectiveOptions: AcceptRemotePairingOptions = {
      capabilities: defaults?.capabilities ?? options.capabilities ?? response.payload.requestedCapabilities,
      workspaceIds: defaults?.workspaceIds ?? options.workspaceIds ?? [],
      ttlMs: defaults?.ttlMs ?? options.ttlMs,
    }
    const requested = new Set(response.payload.requestedCapabilities)
    if (effectiveOptions.capabilities?.some(capability => !requested.has(capability))) {
      throw new Error('Capability grant exceeds the pairing request')
    }
    const requestId = randomUUID()
    const pollToken = randomBytes(32).toString('base64url')
    const requestedAt = this.now()
    const expiresAt = Math.min(invite.payload.expiresAt, requestedAt + 5 * 60_000)
    const record: RemotePairingRequestRecord = {
      requestId,
      inviteId: invite.payload.inviteId,
      deviceId: response.payload.client.deviceId,
      displayName: response.payload.client.displayName,
      connectionKind: 'encrypted-device',
      fingerprint: deviceFingerprint(response.payload.client),
      capabilities: [...(effectiveOptions.capabilities ?? [])],
      workspaceIds: [...(effectiveOptions.workspaceIds ?? [])],
      requestedAt,
      expiresAt,
      pollTokenHash: pairingTokenHash(pollToken),
      response: structuredClone(response),
      options: effectiveOptions,
      status: 'pending',
    }
    this.pairingRequests.set(requestId, record)
    this.pairingRequestByInvite.set(invite.payload.inviteId, requestId)
    return { status: 'pending', requestId, pollToken, expiresAt }
  }

  pairingStatus(requestId: string, pollToken: string): RemotePairingStatus {
    this.cleanupPairingRequests()
    const request = this.pairingRequests.get(requestId)
    if (!request || !this.validPollToken(request, pollToken)) throw new Error('Pairing request is unavailable')
    if (request.status === 'approved' && request.grant) return { status: 'approved', requestId, grant: structuredClone(request.grant) }
    if (request.status === 'rejected') return { status: 'rejected', requestId, reason: request.reason ?? 'Pairing was rejected on the desktop' }
    if (request.status === 'expired') return { status: 'expired', requestId, reason: request.reason ?? 'Pairing request expired' }
    return { status: 'pending', requestId, expiresAt: request.expiresAt }
  }

  listPendingPairings(): RemotePendingPairingSummary[] {
    this.cleanupPairingRequests()
    return [...this.pairingRequests.values()]
      .filter(request => request.status === 'pending')
      .map(({ requestId, deviceId, displayName, connectionKind, fingerprint, capabilities, workspaceIds, requestedAt, expiresAt }) => ({
        requestId,
        deviceId,
        displayName,
        connectionKind,
        fingerprint,
        capabilities: [...capabilities],
        workspaceIds: [...workspaceIds],
        requestedAt,
        expiresAt,
      }))
      .sort((left, right) => left.requestedAt - right.requestedAt)
  }

  refreshPairingInvites(reason = 'Pairing link was refreshed on the desktop'): void {
    this.cleanupPairingRequests()
    this.authority.invalidateAll()
    for (const request of this.pairingRequests.values()) {
      if (request.status !== 'pending') continue
      request.status = 'rejected'
      request.reason = reason
    }
    this.pairingRequestByInvite.clear()
    this.pairingDefaultsByInvite.clear()
  }

  async approvePairing(requestId: string, overrides: AcceptRemotePairingOptions = {}): Promise<SignedCapabilityGrant | undefined> {
    return this.enqueueStateTransition(async () => {
      this.cleanupPairingRequests()
      const request = this.pairingRequests.get(requestId)
      if (!request || request.status !== 'pending') throw new Error('Pairing request is unavailable or no longer pending')
      const options: AcceptRemotePairingOptions = {
        capabilities: overrides.capabilities ?? request.options.capabilities,
        workspaceIds: overrides.workspaceIds ?? request.options.workspaceIds,
        ttlMs: overrides.ttlMs ?? request.options.ttlMs,
      }
      let grant: SignedCapabilityGrant
      try {
        grant = this.authority.accept(request.response, options)
      } catch (error) {
        request.status = this.now() >= request.expiresAt ? 'expired' : 'rejected'
        request.reason = error instanceof Error ? error.message : String(error)
        this.pairingRequestByInvite.delete(request.inviteId)
        throw error
      }
      const pairing = { device: structuredClone(request.response.payload.client), grant: structuredClone(grant), pairedAt: this.now() }
      const previous = this.pairedDevices.get(pairing.device.deviceId)
      const nextPairings = new Map(this.pairedDevices)
      nextPairings.set(pairing.device.deviceId, pairing)
      try {
        await this.persistSnapshot(nextPairings, this.commandRecords)
      } catch (error) {
        request.status = 'rejected'
        request.reason = 'Desktop could not securely save the device authorization'
        this.pairingRequestByInvite.delete(request.inviteId)
        throw error
      }
      if (previous) this.controller.revokeGrant(previous.grant.payload.grantId)
      this.controller.authorizeGrant(grant, pairing.device)
      this.replacePairings(nextPairings)
      request.status = 'approved'
      request.grant = structuredClone(grant)
      this.pairingRequestByInvite.delete(request.inviteId)
      this.pairingDefaultsByInvite.delete(request.inviteId)
      return grant
    })
  }

  async rejectPairing(requestId: string, reason = 'Pairing was rejected on the desktop'): Promise<boolean> {
    return this.enqueueStateTransition(async () => {
      this.cleanupPairingRequests()
      const request = this.pairingRequests.get(requestId)
      if (!request || request.status !== 'pending') return false
      request.status = 'rejected'
      request.reason = reason
      this.authority.reject(request.inviteId)
      this.pairingRequestByInvite.delete(request.inviteId)
      this.pairingDefaultsByInvite.delete(request.inviteId)
      return true
    })
  }

  listPairedDevices(): RemotePairedDeviceSummary[] {
    this.cleanupPairingRequests()
    return [...this.pairedDevices.values()].map(pairing => ({
      deviceId: pairing.device.deviceId,
      displayName: pairing.device.displayName,
      connectionKind: 'encrypted-device' as const,
      capabilities: [...pairing.grant.payload.capabilities],
      workspaceIds: [...pairing.grant.payload.workspaceIds],
      pairedAt: pairing.pairedAt,
      expiresAt: pairing.grant.payload.expiresAt,
    }))
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    return this.enqueueStateTransition(async () => {
      const pairing = this.pairedDevices.get(deviceId)
      if (!pairing) return false
      const nextPairings = new Map(this.pairedDevices)
      nextPairings.delete(deviceId)
      await this.persistSnapshot(nextPairings, this.commandRecords)
      this.controller.revokeGrant(pairing.grant.payload.grantId)
      this.replacePairings(nextPairings)
      return true
    })
  }

  async stopRemoteControlSession(reason = 'Remote control was stopped on the desktop'): Promise<number> {
    return this.enqueueStateTransition(async () => {
      const revoked = this.pairedDevices.size
      const nextPairings = new Map<string, PersistedRemotePairing>()
      await this.persistSnapshot(nextPairings, this.commandRecords)
      for (const pairing of this.pairedDevices.values()) this.controller.revokeGrant(pairing.grant.payload.grantId)
      this.replacePairings(nextPairings)
      this.controller.clearControlSession()
      this.refreshPairingInvites(reason)
      return revoked
    })
  }

  async handle(envelope: EncryptedRemoteEnvelope): Promise<EncryptedRemoteEnvelope> {
    const pairing = this.pairedDevices.get(envelope.senderDeviceId)
    if (!pairing) throw new Error('Remote device is not paired')
    return this.gateway.handle(envelope, pairing.device)
  }

  close(): void {
    this.controller.close()
  }

  private async beginCommand(record: PersistedRemoteCommand): Promise<void> {
    await this.enqueueStateTransition(async () => {
      const pairing = this.pairedDevices.get(record.subjectDeviceId)
      if (!pairing || pairing.grant.payload.grantId !== record.grantId) throw new Error('Remote device authorization changed before command execution')
      if (this.commandRecords.has(record.dedupeKey)) throw new Error('Remote command is already recorded')
      const nextCommands = this.nextCommandRecords(record)
      await this.persistSnapshot(this.pairedDevices, nextCommands)
      this.replaceCommands(nextCommands)
    })
  }

  private async completeCommand(record: PersistedRemoteCommand): Promise<void> {
    await this.enqueueStateTransition(async () => {
      if (!this.commandRecords.has(record.dedupeKey)) throw new Error('Remote command ledger entry is unavailable')
      const nextCommands = this.nextCommandRecords(record)
      await this.persistSnapshot(this.pairedDevices, nextCommands)
      this.replaceCommands(nextCommands)
    })
  }

  private nextCommandRecords(record: PersistedRemoteCommand): Map<string, PersistedRemoteCommand> {
    const records = [...this.commandRecords.values()]
      .filter(item => item.expiresAt > this.now() && item.dedupeKey !== record.dedupeKey)
      .sort((left, right) => left.startedAt - right.startedAt)
      .slice(-2_047)
    return new Map([...records, record].map(item => [item.dedupeKey, structuredClone(item)]))
  }

  private async persistSnapshot(
    pairings: ReadonlyMap<string, PersistedRemotePairing>,
    commands: ReadonlyMap<string, PersistedRemoteCommand>,
  ): Promise<void> {
    if (!this.stateStore) return
    const state: RemoteHostPersistentState = {
      schemaVersion: 2,
      identity: this.identity,
      pairings: [...pairings.values()].map(pairing => structuredClone(pairing)),
      commands: [...commands.values()].map(record => structuredClone(record)),
    }
    await this.stateStore.save(state)
  }

  private replacePairings(pairings: ReadonlyMap<string, PersistedRemotePairing>): void {
    this.pairedDevices.clear()
    for (const [deviceId, pairing] of pairings) this.pairedDevices.set(deviceId, structuredClone(pairing))
  }

  private replaceCommands(commands: ReadonlyMap<string, PersistedRemoteCommand>): void {
    this.commandRecords.clear()
    for (const [dedupeKey, record] of commands) this.commandRecords.set(dedupeKey, structuredClone(record))
  }

  private enqueueStateTransition<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.stateTransition.catch(() => undefined).then(operation)
    this.stateTransition = next.then(() => undefined, () => undefined)
    return next
  }

  private cleanupPairingRequests(): void {
    const now = this.now()
    for (const request of this.pairingRequests.values()) {
      if (request.status === 'pending' && request.expiresAt <= now) {
        request.status = 'expired'
        request.reason = 'Pairing request expired before desktop confirmation'
        this.pairingRequestByInvite.delete(request.inviteId)
        this.pairingDefaultsByInvite.delete(request.inviteId)
      }
      if (request.expiresAt + 10 * 60_000 <= now) this.pairingRequests.delete(request.requestId)
    }
  }

  private validPollToken(request: RemotePairingRequestRecord, pollToken: string): boolean {
    const actual = pairingTokenHash(pollToken)
    return actual.length === request.pollTokenHash.length && timingSafeEqual(actual, request.pollTokenHash)
  }

}
