import type { JsonValue } from './canonical'

export const REMOTE_PROTOCOL_VERSION = 1 as const

export type RemoteCapability =
  | 'session.read'
  | 'session.create'
  | 'session.submit'
  | 'session.steer'
  | 'session.control'
  | 'approval.resolve'
  | 'artifact.list'
  | 'artifact.read'
  | 'terminal.observe'
  | 'terminal.write'
  | 'computer.control'
  | 'adapter.manage'

export interface DevicePublicIdentity {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION
  deviceId: string
  displayName: string
  signingPublicKey: string
  exchangePublicKey: string
  createdAt: number
}

export interface NodeDeviceIdentity {
  publicIdentity: DevicePublicIdentity
  signingPrivateKey: string
  exchangePrivateKey: string
}

export interface PairingEndpointHint {
  kind: 'lan' | 'iroh' | 'relay' | 'custom'
  value: string
}

export interface PairingInvitePayload {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION
  inviteId: string
  host: DevicePublicIdentity
  nonce: string
  offeredCapabilities: RemoteCapability[]
  endpointHints: PairingEndpointHint[]
  createdAt: number
  expiresAt: number
}

export interface SignedPairingInvite {
  payload: PairingInvitePayload
  signature: string
}

export interface PairingResponsePayload {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION
  inviteId: string
  inviteNonce: string
  client: DevicePublicIdentity
  requestedCapabilities: RemoteCapability[]
  createdAt: number
}

export interface SignedPairingResponse {
  payload: PairingResponsePayload
  signature: string
}

export interface RemotePairingRequestReceipt {
  status: 'pending'
  requestId: string
  pollToken: string
  expiresAt: number
}

export type RemotePairingStatus =
  | { status: 'pending'; requestId: string; expiresAt: number }
  | { status: 'approved'; requestId: string; grant: SignedCapabilityGrant }
  | { status: 'rejected'; requestId: string; reason: string }
  | { status: 'expired'; requestId: string; reason: string }

export interface CapabilityGrantPayload {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION
  grantId: string
  issuerDeviceId: string
  subjectDeviceId: string
  capabilities: RemoteCapability[]
  workspaceIds: string[]
  issuedAt: number
  expiresAt: number
}

export interface SignedCapabilityGrant {
  payload: CapabilityGrantPayload
  signature: string
}

export interface EncryptedRemoteEnvelope {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION
  messageId: string
  senderDeviceId: string
  recipientDeviceId: string
  createdAt: number
  ephemeralExchangePublicKey: string
  iv: string
  ciphertext: string
  authTag: string
  signature: string
}

export type RemoteAdapterKind = 'native' | 'acp' | 'ag-ui' | 'custom'

export interface RemoteAdapterDescriptor {
  id: string
  name: string
  kind: RemoteAdapterKind
  version: string
  capabilities: RemoteCapability[]
}

export type RemoteSessionStatus = 'ready' | 'running' | 'paused' | 'awaiting-action' | 'error' | 'offline'

export interface RemoteSessionSummary {
  id: string
  title: string
  status: RemoteSessionStatus
  updatedAt: number
  workspaceId?: string
  workspaceName?: string
}

export interface RemoteApprovalRequest {
  id: string
  sessionId: string
  kind: 'permission' | 'input'
  question: string
  options?: string[]
  reason?: string
  toolName?: string
  workspaceId?: string
  createdAt: number
  automation?: {
    name: string
    runId: string
    riskCategory: 'permission' | 'filesystem' | 'network' | 'computer' | 'secret' | 'input'
    targetSummary?: string
    expiresAt: number
  }
}

export interface RemoteArtifactManifest {
  id: string
  sessionId?: string
  taskId?: string
  name: string
  kind: string
  mime: string
  size: number
  contentHash?: string
  updatedAt: number
  available: boolean
  workspaceId?: string
}

export interface RemoteMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  text: string
  createdAt: number
}

export interface RemoteAgentSnapshot {
  schemaVersion: 1
  adapterId: string
  capturedAt: number
  activeSessionId?: string
  sessions: RemoteSessionSummary[]
  messages: RemoteMessage[]
  pendingApprovals: RemoteApprovalRequest[]
  artifacts: RemoteArtifactManifest[]
}

export type RemoteAgentEvent =
  | { type: 'run.started'; sessionId: string; runId: string; objective?: string }
  | { type: 'run.state'; sessionId: string; runId?: string; status: RemoteSessionStatus }
  | { type: 'run.completed'; sessionId: string; runId?: string; outcome: 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted'; error?: string }
  | { type: 'message.delta'; sessionId: string; messageId: string; channel: 'answer' | 'reasoning'; delta: string }
  | { type: 'message.completed'; sessionId: string; messageId: string; channel: 'answer' | 'reasoning'; text: string }
  | { type: 'tool.started'; sessionId: string; toolCallId: string; toolName: string; title?: string }
  | { type: 'tool.completed'; sessionId: string; toolCallId: string; toolName: string; success: boolean; summary?: string }
  | { type: 'approval.requested'; request: RemoteApprovalRequest }
  | { type: 'approval.resolved'; sessionId: string; requestId: string; decision?: string }
  | { type: 'artifact.available'; artifact: RemoteArtifactManifest }
  | { type: 'notification'; sessionId?: string; level: 'info' | 'success' | 'warning' | 'error'; message: string }
  | { type: 'custom'; sessionId?: string; name: string; payload: JsonValue }

export interface RemoteEventEnvelope {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION
  seq: number
  eventId: string
  adapterId: string
  at: number
  workspaceId?: string
  event: RemoteAgentEvent
}

interface RemoteCommandBase {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION
  commandId: string
  clientInstanceId: string
  createdAt: number
}

export type RemoteCommand =
  | (RemoteCommandBase & { type: 'control.claim'; takeover?: boolean })
  | (RemoteCommandBase & { type: 'control.release' })
  | (RemoteCommandBase & { type: 'sync.snapshot' })
  | (RemoteCommandBase & { type: 'sync.events'; afterSeq: number })
  | (RemoteCommandBase & { type: 'session.create'; adapterId: string; workspaceId?: string; title?: string })
  | (RemoteCommandBase & { type: 'session.activate'; adapterId: string; sessionId: string })
  | (RemoteCommandBase & { type: 'session.submit'; adapterId: string; sessionId: string; prompt: string; mode?: 'turn' | 'queue' | 'steer' })
  | (RemoteCommandBase & { type: 'session.control'; adapterId: string; sessionId: string; action: 'pause' | 'resume' | 'stop' })
  | (RemoteCommandBase & { type: 'approval.resolve'; adapterId: string; sessionId: string; requestId: string; response: string })
  | (RemoteCommandBase & { type: 'artifact.list'; adapterId: string; sessionId?: string })
  | (RemoteCommandBase & { type: 'artifact.read'; adapterId: string; artifactId: string; offset?: number; length?: number })

export type RemoteAdapterCommand = Exclude<RemoteCommand, { type: 'control.claim' | 'control.release' | 'sync.snapshot' | 'sync.events' }>

export interface RemoteControlSessionSummary {
  clientInstanceId: string
  deviceId: string
  displayName: string
  connectedAt: number
  lastSeenAt: number
  expiresAt: number
}

export interface RemoteCommandResult {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION
  commandId: string
  ok: boolean
  data?: JsonValue
  error?: {
    code: string
    message: string
  }
}

export interface RemoteEventWindow {
  events: RemoteEventEnvelope[]
  earliestSeq: number
  lastSeq: number
  hasGap: boolean
}

export type RemoteWireMessage =
  | { kind: 'command'; grantId: string; command: RemoteCommand }
  | { kind: 'result'; result: RemoteCommandResult }

export type RemoteAdapterEventListener = (event: RemoteAgentEvent) => void

export interface RemoteAdapterExecutionContext {
  deviceId: string
  clientInstanceId: string
}

export interface RemoteAgentAdapter {
  readonly descriptor: RemoteAdapterDescriptor
  getSnapshot(): Promise<RemoteAgentSnapshot> | RemoteAgentSnapshot
  execute(command: RemoteAdapterCommand, context?: RemoteAdapterExecutionContext): Promise<JsonValue | void> | JsonValue | void
  subscribe(listener: RemoteAdapterEventListener): () => void
  resolveWorkspaceId?(command: RemoteAdapterCommand): string | undefined
  resolveEventWorkspaceId?(event: RemoteAgentEvent): string | undefined
}
