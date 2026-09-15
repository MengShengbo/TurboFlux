import { createHash, randomUUID } from 'node:crypto'
import { canonicalStringify, toJsonValue, type JsonValue } from './canonical'
import { verifyCapabilityGrant } from './nodeCrypto'
import { type PersistedRemoteCommand } from './stateStore'
import {
  REMOTE_PROTOCOL_VERSION,
  type DevicePublicIdentity,
  type RemoteAgentAdapter,
  type RemoteAdapterExecutionContext,
  type RemoteAgentEvent,
  type RemoteCapability,
  type RemoteCommand,
  type RemoteCommandResult,
  type RemoteControlSessionSummary,
  type RemoteEventEnvelope,
  type RemoteEventWindow,
  type SignedCapabilityGrant,
} from './types'

const DEFAULT_EVENT_LIMIT = 4_096
const DEFAULT_COMMAND_RESULT_LIMIT = 2_048
const DEFAULT_COMMAND_LEDGER_TTL_MS = 24 * 60 * 60_000
const DEFAULT_CONTROL_SESSION_TTL_MS = 30_000

export interface RemoteCommandLedger {
  find(dedupeKey: string): PersistedRemoteCommand | undefined
  begin(record: PersistedRemoteCommand): Promise<void>
  complete(record: PersistedRemoteCommand): Promise<void>
}

function mutatesRemoteRuntime(command: RemoteCommand): boolean {
  return command.type === 'session.create'
    || command.type === 'session.activate'
    || command.type === 'session.submit'
    || command.type === 'session.control'
    || command.type === 'approval.resolve'
}

function commandHash(command: RemoteCommand): string {
  return createHash('sha256').update(canonicalStringify(toJsonValue(command))).digest('base64url')
}

function requiredCapability(command: RemoteCommand): RemoteCapability {
  if (command.type === 'control.claim' || command.type === 'control.release') return 'session.control'
  if (command.type === 'sync.snapshot' || command.type === 'sync.events') return 'session.read'
  if (command.type === 'session.create') return 'session.create'
  if (command.type === 'session.activate') return 'session.control'
  if (command.type === 'session.submit') return command.mode === 'steer' ? 'session.steer' : 'session.submit'
  if (command.type === 'session.control') return 'session.control'
  if (command.type === 'approval.resolve') return 'approval.resolve'
  if (command.type === 'artifact.list') return 'artifact.list'
  return 'artifact.read'
}

function errorResult(commandId: string, code: string, message: string): RemoteCommandResult {
  return {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    commandId,
    ok: false,
    error: { code, message },
  }
}

function cloneResult(result: RemoteCommandResult): RemoteCommandResult {
  return structuredClone(result)
}

export interface RemoteHostControllerOptions {
  eventLimit?: number
  commandResultLimit?: number
  now?: () => number
  commandLedger?: RemoteCommandLedger
  controlSessionTtlMs?: number
}

export class RemoteHostController {
  private readonly adapters = new Map<string, RemoteAgentAdapter>()
  private readonly adapterUnsubscribers = new Map<string, () => void>()
  private readonly grants = new Map<string, SignedCapabilityGrant>()
  private readonly revokedGrantIds = new Set<string>()
  private readonly listeners = new Set<(event: RemoteEventEnvelope) => void>()
  private readonly events: RemoteEventEnvelope[] = []
  private readonly commandResults = new Map<string, { commandHash: string; result: RemoteCommandResult }>()
  private readonly inFlightCommands = new Map<string, { commandHash: string; promise: Promise<RemoteCommandResult> }>()
  private readonly commandResultOrder: string[] = []
  private readonly eventLimit: number
  private readonly commandResultLimit: number
  private readonly now: () => number
  private readonly commandLedger: RemoteCommandLedger | undefined
  private readonly controlSessionTtlMs: number
  private controlSession: RemoteControlSessionSummary & { grantId: string } | undefined
  private nextSeq = 0

  constructor(readonly hostIdentity: DevicePublicIdentity, options: RemoteHostControllerOptions = {}) {
    this.eventLimit = Math.max(64, options.eventLimit ?? DEFAULT_EVENT_LIMIT)
    this.commandResultLimit = Math.max(64, options.commandResultLimit ?? DEFAULT_COMMAND_RESULT_LIMIT)
    this.now = options.now ?? Date.now
    this.commandLedger = options.commandLedger
    this.controlSessionTtlMs = Math.max(5_000, options.controlSessionTtlMs ?? DEFAULT_CONTROL_SESSION_TTL_MS)
  }

  registerAdapter(adapter: RemoteAgentAdapter): () => void {
    if (this.adapters.has(adapter.descriptor.id)) throw new Error(`Remote adapter already registered: ${adapter.descriptor.id}`)
    this.adapters.set(adapter.descriptor.id, adapter)
    const unsubscribe = adapter.subscribe(event => this.appendEvent(adapter.descriptor.id, event))
    this.adapterUnsubscribers.set(adapter.descriptor.id, unsubscribe)
    return () => this.unregisterAdapter(adapter.descriptor.id)
  }

  unregisterAdapter(adapterId: string): void {
    this.adapterUnsubscribers.get(adapterId)?.()
    this.adapterUnsubscribers.delete(adapterId)
    this.adapters.delete(adapterId)
  }

  authorizeGrant(grant: SignedCapabilityGrant, subject: DevicePublicIdentity): void {
    if (!verifyCapabilityGrant(grant, this.hostIdentity, subject, this.now())) throw new Error('Remote capability grant is invalid or expired')
    this.grants.set(grant.payload.grantId, structuredClone(grant))
    this.revokedGrantIds.delete(grant.payload.grantId)
  }

  revokeGrant(grantId: string): void {
    this.grants.delete(grantId)
    this.revokedGrantIds.add(grantId)
    if (this.controlSession?.grantId === grantId) this.controlSession = undefined
  }

  activeControlSession(): RemoteControlSessionSummary | undefined {
    this.cleanupControlSession()
    if (!this.controlSession) return undefined
    const { grantId: _grantId, ...summary } = this.controlSession
    return structuredClone(summary)
  }

  clearControlSession(): void {
    this.controlSession = undefined
  }

  subscribe(listener: (event: RemoteEventEnvelope) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getEvents(afterSeq: number): RemoteEventWindow {
    const earliestSeq = this.events[0]?.seq ?? this.nextSeq + 1
    return {
      events: this.events.filter(event => event.seq > afterSeq).map(event => structuredClone(event)),
      earliestSeq,
      lastSeq: this.nextSeq,
      hasGap: afterSeq > 0 && afterSeq < earliestSeq - 1,
    }
  }

  async execute(
    subject: DevicePublicIdentity,
    grantId: string,
    command: RemoteCommand,
  ): Promise<RemoteCommandResult> {
    const dedupeKey = `${subject.deviceId}:${command.commandId}`
    const fingerprint = commandHash(command)
    const cached = this.commandResults.get(dedupeKey)
    if (cached) {
      if (cached.commandHash !== fingerprint) return errorResult(command.commandId, 'command_id_conflict', 'Remote command ID was reused with different content')
      return cloneResult(cached.result)
    }
    const persisted = mutatesRemoteRuntime(command) ? this.commandLedger?.find(dedupeKey) : undefined
    if (persisted && (persisted.grantId !== grantId || persisted.commandHash !== fingerprint)) {
      return errorResult(command.commandId, 'command_id_conflict', 'Remote command ID was reused with different authorization or content')
    }
    if (persisted?.status === 'completed' && persisted.result) {
      this.rememberResult(dedupeKey, fingerprint, persisted.result)
      return cloneResult(persisted.result)
    }
    if (persisted?.status === 'in_progress') {
      return errorResult(command.commandId, 'command_outcome_unknown', 'The command began before the host restarted; it will not be executed again')
    }
    const inFlight = this.inFlightCommands.get(dedupeKey)
    if (inFlight) {
      if (inFlight.commandHash !== fingerprint) return errorResult(command.commandId, 'command_id_conflict', 'Remote command ID was reused with different content')
      return cloneResult(await inFlight.promise)
    }
    const execution = this.executeOnce(subject, grantId, command, dedupeKey, fingerprint)
    this.inFlightCommands.set(dedupeKey, { commandHash: fingerprint, promise: execution })
    try {
      return cloneResult(await execution)
    } finally {
      if (this.inFlightCommands.get(dedupeKey)?.promise === execution) this.inFlightCommands.delete(dedupeKey)
    }
  }

  private async executeOnce(
    subject: DevicePublicIdentity,
    grantId: string,
    command: RemoteCommand,
    dedupeKey: string,
    fingerprint: string,
  ): Promise<RemoteCommandResult> {
    let grant: { capabilities: readonly RemoteCapability[]; workspaceIds: readonly string[] }
    try {
      grant = this.assertAuthorized(subject, grantId, command)
    } catch (error) {
      const code = error instanceof RemoteHostError ? error.code : 'remote_internal_error'
      const result = errorResult(command.commandId, code, error instanceof Error ? error.message : String(error))
      this.rememberResult(dedupeKey, fingerprint, result)
      return result
    }
    const ledgerRecord: PersistedRemoteCommand | undefined = mutatesRemoteRuntime(command) && this.commandLedger
      ? {
          dedupeKey,
          subjectDeviceId: subject.deviceId,
          grantId,
          commandId: command.commandId,
          commandHash: fingerprint,
          status: 'in_progress',
          startedAt: this.now(),
          expiresAt: this.now() + DEFAULT_COMMAND_LEDGER_TTL_MS,
        }
      : undefined
    if (ledgerRecord) {
      try {
        await this.commandLedger!.begin(ledgerRecord)
      } catch (error) {
        return errorResult(command.commandId, 'command_ledger_unavailable', error instanceof Error ? error.message : String(error))
      }
    }
    let result: RemoteCommandResult
    try {
      const data = command.type === 'control.claim'
        ? this.claimControlSession(subject, grantId, command.clientInstanceId, command.takeover === true)
        : command.type === 'control.release'
          ? this.releaseControlSession(subject, grantId, command.clientInstanceId)
          : mutatesRemoteRuntime(command)
            ? await this.dispatchControlled(subject, grantId, command, grant.workspaceIds)
            : await this.dispatch(command, grant.workspaceIds, {
                deviceId: subject.deviceId,
                clientInstanceId: command.clientInstanceId,
              })
      result = {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        commandId: command.commandId,
        ok: true,
        data: data === undefined ? undefined : toJsonValue(data),
      }
    } catch (error) {
      const code = error instanceof RemoteHostError ? error.code : 'remote_internal_error'
      result = errorResult(command.commandId, code, error instanceof Error ? error.message : String(error))
    }
    if (ledgerRecord) {
      try {
        await this.commandLedger!.complete({ ...ledgerRecord, status: 'completed', result: cloneResult(result) })
      } catch {
        result = errorResult(command.commandId, 'command_result_persist_failed', 'The command finished but its result could not be persisted; its outcome will not be retried')
      }
    }
    this.rememberResult(dedupeKey, fingerprint, result)
    return result
  }

  close(): void {
    for (const unsubscribe of this.adapterUnsubscribers.values()) unsubscribe()
    this.adapterUnsubscribers.clear()
    this.adapters.clear()
    this.listeners.clear()
    this.controlSession = undefined
  }

  private assertAuthorized(
    subject: DevicePublicIdentity,
    grantId: string,
    command: RemoteCommand,
  ): { capabilities: readonly RemoteCapability[]; workspaceIds: readonly string[] } {
    if (command.protocolVersion !== REMOTE_PROTOCOL_VERSION) throw new RemoteHostError('protocol_version', 'Unsupported remote command version')
    if (Math.abs(this.now() - command.createdAt) > 10 * 60_000) throw new RemoteHostError('command_expired', 'Remote command timestamp is outside the accepted window')
    if (this.revokedGrantIds.has(grantId)) throw new RemoteHostError('grant_revoked', 'Remote capability grant was revoked')
    const signedGrant = this.grants.get(grantId)
    const grant = signedGrant?.payload
    if (!grant) throw new RemoteHostError('grant_missing', 'Remote capability grant is unavailable')
    if (grant.subjectDeviceId !== subject.deviceId) throw new RemoteHostError('grant_subject', 'Remote capability grant belongs to another device')
    if (grant.expiresAt < this.now()) {
      throw new RemoteHostError('grant_expired', 'Remote capability grant has expired')
    }
    const capability = requiredCapability(command)
    if (!grant.capabilities.includes(capability)) throw new RemoteHostError('capability_denied', `Remote capability is required: ${capability}`)
    if (typeof command.clientInstanceId !== 'string' || !command.clientInstanceId.trim() || command.clientInstanceId.length > 128) {
      throw new RemoteHostError('control_session_invalid', 'Remote command has an invalid client instance identity')
    }
    if (grant.workspaceIds.length > 0 && command.type !== 'control.claim' && command.type !== 'control.release' && command.type !== 'sync.snapshot' && command.type !== 'sync.events') {
      const adapter = this.adapters.get(command.adapterId)
      if (!adapter) throw new RemoteHostError('adapter_missing', `Remote adapter is unavailable: ${command.adapterId}`)
      const workspaceId = command.type === 'session.create'
        ? command.workspaceId
        : adapter.resolveWorkspaceId?.(command)
      if (!workspaceId) throw new RemoteHostError('workspace_unknown', 'Remote command workspace could not be resolved')
      if (!grant.workspaceIds.includes(workspaceId)) throw new RemoteHostError('workspace_denied', 'Remote capability grant does not cover this workspace')
    }
    return { capabilities: grant.capabilities, workspaceIds: grant.workspaceIds }
  }

  private dispatchControlled(
    subject: DevicePublicIdentity,
    grantId: string,
    command: Exclude<RemoteCommand, { type: 'control.claim' | 'control.release' }>,
    workspaceIds: readonly string[],
  ): Promise<JsonValue | void> {
    this.assertControlSession(subject, grantId, command.clientInstanceId)
    return this.dispatch(command, workspaceIds, {
      deviceId: subject.deviceId,
      clientInstanceId: command.clientInstanceId,
    })
  }

  private claimControlSession(
    subject: DevicePublicIdentity,
    grantId: string,
    clientInstanceId: string,
    takeover: boolean,
  ): RemoteControlSessionSummary {
    this.cleanupControlSession()
    const current = this.controlSession
    const matches = current?.deviceId === subject.deviceId
      && current.grantId === grantId
      && current.clientInstanceId === clientInstanceId
    if (current && !matches && !takeover) {
      throw new RemoteHostError('control_session_in_use', `Another mobile page is controlling this desktop: ${current.displayName}`)
    }
    const now = this.now()
    this.controlSession = {
      clientInstanceId,
      deviceId: subject.deviceId,
      displayName: subject.displayName,
      grantId,
      connectedAt: matches ? current.connectedAt : now,
      lastSeenAt: now,
      expiresAt: now + this.controlSessionTtlMs,
    }
    return this.activeControlSession()!
  }

  private releaseControlSession(subject: DevicePublicIdentity, grantId: string, clientInstanceId: string): JsonValue {
    this.cleanupControlSession()
    const current = this.controlSession
    const released = current?.deviceId === subject.deviceId
      && current.grantId === grantId
      && current.clientInstanceId === clientInstanceId
    if (released) this.controlSession = undefined
    return toJsonValue({ released })
  }

  private assertControlSession(subject: DevicePublicIdentity, grantId: string, clientInstanceId: string): void {
    this.cleanupControlSession()
    const current = this.controlSession
    if (!current) throw new RemoteHostError('control_session_required', 'This mobile page must claim the remote control session first')
    if (current.deviceId !== subject.deviceId || current.grantId !== grantId || current.clientInstanceId !== clientInstanceId) {
      throw new RemoteHostError('control_session_replaced', `Remote control was taken over by another page: ${current.displayName}`)
    }
    const now = this.now()
    current.lastSeenAt = now
    current.expiresAt = now + this.controlSessionTtlMs
  }

  private cleanupControlSession(): void {
    if (this.controlSession && this.controlSession.expiresAt <= this.now()) this.controlSession = undefined
  }

  private async dispatch(
    command: Exclude<RemoteCommand, { type: 'control.claim' | 'control.release' }>,
    workspaceIds: readonly string[],
    context: RemoteAdapterExecutionContext,
  ): Promise<JsonValue | void> {
    if (command.type === 'sync.snapshot') {
      const snapshots = await Promise.all([...this.adapters.values()].map(adapter => adapter.getSnapshot()))
      return toJsonValue({
        hostDeviceId: this.hostIdentity.deviceId,
        capturedAt: this.now(),
        adapters: [...this.adapters.values()].map(adapter => structuredClone(adapter.descriptor)),
        snapshots: snapshots.map(snapshot => this.filterSnapshot(snapshot, workspaceIds)),
      })
    }
    if (command.type === 'sync.events') return toJsonValue(this.filterEventWindow(this.getEvents(command.afterSeq), workspaceIds))
    const adapter = this.adapters.get(command.adapterId)
    if (!adapter) throw new RemoteHostError('adapter_missing', `Remote adapter is unavailable: ${command.adapterId}`)
    if (!adapter.descriptor.capabilities.includes(requiredCapability(command))) {
      throw new RemoteHostError('adapter_capability', `Remote adapter does not support: ${requiredCapability(command)}`)
    }
    return adapter.execute(command, context)
  }

  private appendEvent(adapterId: string, event: RemoteAgentEvent): void {
    const adapter = this.adapters.get(adapterId)
    const envelope: RemoteEventEnvelope = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      seq: this.nextSeq + 1,
      eventId: randomUUID(),
      adapterId,
      at: this.now(),
      workspaceId: adapter?.resolveEventWorkspaceId?.(event),
      event: structuredClone(event),
    }
    this.nextSeq = envelope.seq
    this.events.push(envelope)
    while (this.events.length > this.eventLimit) this.events.shift()
    for (const listener of this.listeners) listener(structuredClone(envelope))
  }

  private filterSnapshot(snapshot: Awaited<ReturnType<RemoteAgentAdapter['getSnapshot']>>, workspaceIds: readonly string[]) {
    if (workspaceIds.length === 0) return snapshot
    const allowed = new Set(workspaceIds)
    const sessions = snapshot.sessions.filter(session => session.workspaceId && allowed.has(session.workspaceId))
    const sessionIds = new Set(sessions.map(session => session.id))
    return {
      ...snapshot,
      activeSessionId: snapshot.activeSessionId && sessionIds.has(snapshot.activeSessionId) ? snapshot.activeSessionId : undefined,
      sessions,
      messages: snapshot.messages.filter(message => sessionIds.has(message.sessionId)),
      pendingApprovals: snapshot.pendingApprovals.filter(request => request.workspaceId ? allowed.has(request.workspaceId) : sessionIds.has(request.sessionId)),
      artifacts: snapshot.artifacts.filter(artifact => artifact.workspaceId ? allowed.has(artifact.workspaceId) : Boolean(artifact.sessionId && sessionIds.has(artifact.sessionId))),
    }
  }

  private filterEventWindow(window: RemoteEventWindow, workspaceIds: readonly string[]): RemoteEventWindow {
    if (workspaceIds.length === 0) return window
    const allowed = new Set(workspaceIds)
    return { ...window, events: window.events.filter(event => event.workspaceId && allowed.has(event.workspaceId)) }
  }

  private rememberResult(key: string, fingerprint: string, result: RemoteCommandResult): void {
    this.commandResults.set(key, { commandHash: fingerprint, result: cloneResult(result) })
    this.commandResultOrder.push(key)
    while (this.commandResultOrder.length > this.commandResultLimit) {
      const oldest = this.commandResultOrder.shift()
      if (oldest) this.commandResults.delete(oldest)
    }
  }
}

class RemoteHostError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}
