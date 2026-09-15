import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { basename, relative, resolve, sep } from 'node:path'
import { toJsonValue, type JsonValue } from './canonical'
import {
  type RemoteAdapterEventListener,
  type RemoteAdapterExecutionContext,
  type RemoteAgentAdapter,
  type RemoteAgentEvent,
  type RemoteAgentSnapshot,
  type RemoteApprovalRequest,
  type RemoteArtifactManifest,
  type RemoteAdapterCommand,
  type RemoteCapability,
  type RemoteMessage,
  type RemoteSessionStatus,
} from './types'

const DEFAULT_ARTIFACT_CHUNK_BYTES = 256 * 1024
const MAX_ARTIFACT_CHUNK_BYTES = 1024 * 1024

type AdapterCommand = RemoteAdapterCommand

interface TurboFluxConversationLike {
  id: string
  title: string
  workspacePath: string
  updatedAt: number
}

interface TurboFluxTurnLike {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool_result'
  content: string
  timestamp: number
  metadata?: { internal?: boolean }
}

interface TurboFluxRequestLike {
  id: string
  kind: 'permission' | 'input'
  question: string
  options?: string[]
  reason?: string
  toolName?: string
}

export interface TurboFluxAutomationApprovalLike {
  id: string
  sessionId: string
  automationName: string
  runId: string
  workspacePath: string
  kind: 'permission' | 'input'
  question: string
  options?: string[]
  toolName?: string
  riskCategory: 'permission' | 'filesystem' | 'network' | 'computer' | 'secret' | 'input'
  targetSummary?: string
  requestedAt: number
  expiresAt: number
}

export interface TurboFluxArtifactLike {
  id: string
  name: string
  path: string
  workspacePath: string
  kind: string
  mime: string
  size: number
  updatedAt: number
  available: boolean
  conversationId?: string
  taskId?: string
}

export interface TurboFluxRemoteSnapshotLike {
  workspace: { path: string; name: string }
  runtime: { status: RemoteSessionStatus; pendingRequests: TurboFluxRequestLike[] }
  conversation: { id: string; turns: TurboFluxTurnLike[] }
  conversationCatalog: TurboFluxConversationLike[]
  conversationRuntimes: Array<{ conversationId: string; status: RemoteSessionStatus; updatedAt: number }>
  artifacts: { artifacts: TurboFluxArtifactLike[] }
}

export interface TurboFluxRemoteRuntime<TEvent = unknown> {
  getSnapshot(): TurboFluxRemoteSnapshotLike
  subscribe(listener: (event: TEvent) => void): () => void
  submitPromptToConversation(sessionId: string, prompt: string, mode?: 'turn' | 'queue' | 'steer'): unknown | Promise<unknown>
  controlConversation(sessionId: string, action: 'pause' | 'resume' | 'stop'): boolean | Promise<boolean>
  newConversation(): unknown | Promise<unknown>
  switchConversation(id: string): unknown | Promise<unknown>
  activateRemoteSession(id: string): unknown | Promise<unknown>
  resolveRequestForConversation(sessionId: string, requestId: string, response: string): boolean | Promise<boolean>
  listRemoteAutomationApprovals?(): TurboFluxAutomationApprovalLike[]
  resolveAutomationApproval?(approvalId: string, response: string, channel: 'remote', deviceId?: string): unknown | Promise<unknown>
  getArtifact(id: string): TurboFluxArtifactLike | null
}

export interface TurboFluxRemoteAdapterOptions {
  id?: string
  name?: string
  now?: () => number
  transcriptLimit?: number
  readArtifact?: (artifact: TurboFluxArtifactLike, offset: number, length: number) => Promise<Uint8Array>
}

function statusFor(value: string): RemoteSessionStatus {
  return ['ready', 'running', 'paused', 'awaiting-action', 'error', 'offline'].includes(value)
    ? value as RemoteSessionStatus
    : 'error'
}

function statusForRunState(value: unknown): RemoteSessionStatus {
  const phase = isRecord(value) ? stringValue(value.phase) : stringValue(value)
  if (phase === 'paused') return 'paused'
  if (phase === 'awaiting_approval' || phase === 'awaiting_input') return 'awaiting-action'
  if (phase === 'recoverable_error') return 'error'
  if (phase === 'completed' || phase === 'idle') return 'ready'
  return 'running'
}

function workspaceIdForPath(path: string): string {
  const digest = createHash('sha256').update(resolve(path)).digest('base64url').slice(0, 22)
  return `workspace-${digest}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object')
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function projectArtifact(artifact: TurboFluxArtifactLike): RemoteArtifactManifest {
  return {
    id: artifact.id,
    sessionId: artifact.conversationId,
    taskId: artifact.taskId,
    name: artifact.name.slice(0, 160),
    kind: artifact.kind,
    mime: artifact.mime,
    size: artifact.size,
    updatedAt: artifact.updatedAt,
    available: artifact.available,
    workspaceId: workspaceIdForPath(artifact.workspacePath),
  }
}

async function readLocalArtifact(artifact: TurboFluxArtifactLike, offset: number, length: number): Promise<Uint8Array> {
  const [workspacePath, artifactPath] = await Promise.all([realpath(artifact.workspacePath), realpath(artifact.path)])
  const containedPath = relative(workspacePath, artifactPath)
  if (!containedPath || containedPath === '..' || containedPath.startsWith(`..${sep}`)) {
    throw new Error('Artifact is outside its workspace')
  }
  const file = await open(artifactPath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await file.read(buffer, 0, length, offset)
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

export class TurboFluxRemoteAdapter<TEvent = unknown> implements RemoteAgentAdapter {
  readonly descriptor
  private readonly listeners = new Set<RemoteAdapterEventListener>()
  private readonly now: () => number
  private readonly transcriptLimit: number
  private readonly readArtifact: NonNullable<TurboFluxRemoteAdapterOptions['readArtifact']>
  private runtimeUnsubscribe: (() => void) | undefined
  private previousSnapshot: TurboFluxRemoteSnapshotLike | undefined

  constructor(private readonly runtime: TurboFluxRemoteRuntime<TEvent>, options: TurboFluxRemoteAdapterOptions = {}) {
    this.now = options.now ?? Date.now
    this.transcriptLimit = Math.max(20, Math.min(2_000, options.transcriptLimit ?? 500))
    this.readArtifact = options.readArtifact ?? readLocalArtifact
    this.descriptor = {
      id: options.id ?? 'turboflux-native',
      name: options.name ?? 'TurboFlux',
      kind: 'native' as const,
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
  }

  getSnapshot(): RemoteAgentSnapshot {
    const snapshot = this.runtime.getSnapshot()
    this.previousSnapshot = snapshot
    const runtimeStatus = new Map(snapshot.conversationRuntimes.map(item => [item.conversationId, item]))
    const sessions = snapshot.conversationCatalog.map(conversation => {
      const state = runtimeStatus.get(conversation.id)
      return {
        id: conversation.id,
        title: conversation.title.slice(0, 160),
        status: conversation.id === snapshot.conversation.id ? statusFor(snapshot.runtime.status) : statusFor(state?.status ?? 'ready'),
        updatedAt: state?.updatedAt ?? conversation.updatedAt,
        workspaceId: workspaceIdForPath(conversation.workspacePath),
        workspaceName: conversation.workspacePath === snapshot.workspace.path ? snapshot.workspace.name : basename(conversation.workspacePath),
      }
    })
    const activeWorkspaceId = workspaceIdForPath(snapshot.workspace.path)
    const foregroundApprovals = snapshot.runtime.pendingRequests.map(request => this.projectApproval(request, snapshot.conversation.id, activeWorkspaceId))
    const foregroundApprovalIds = new Set(foregroundApprovals.map(request => request.id))
    const automationApprovals = (this.runtime.listRemoteAutomationApprovals?.() ?? [])
      .filter(request => !foregroundApprovalIds.has(request.id))
      .map(request => this.projectAutomationApproval(request))
    const pendingApprovals = [...foregroundApprovals, ...automationApprovals]
    const messages = snapshot.conversation.turns
      .filter(turn => !turn.metadata?.internal && turn.role !== 'system')
      .slice(-this.transcriptLimit)
      .map(turn => ({
        id: turn.id,
        sessionId: snapshot.conversation.id,
        role: turn.role === 'tool_result' ? 'tool' as const : turn.role,
        text: turn.content,
        createdAt: turn.timestamp,
      })) satisfies RemoteMessage[]
    return {
      schemaVersion: 1,
      adapterId: this.descriptor.id,
      capturedAt: this.now(),
      activeSessionId: snapshot.conversation.id,
      sessions,
      messages,
      pendingApprovals,
      artifacts: snapshot.artifacts.artifacts.map(projectArtifact),
    }
  }

  async execute(command: AdapterCommand, context?: RemoteAdapterExecutionContext): Promise<JsonValue | void> {
    if (command.type === 'session.create') {
      const activeWorkspaceId = workspaceIdForPath(this.runtime.getSnapshot().workspace.path)
      if (command.workspaceId && command.workspaceId !== activeWorkspaceId) throw new Error('Creating a session in an inactive workspace is not supported')
      await this.runtime.newConversation()
      return toJsonValue({ sessionId: this.runtime.getSnapshot().conversation.id })
    }
    if (command.type === 'session.activate') {
      await this.activateSession(command.sessionId)
      return toJsonValue({ activeSessionId: command.sessionId })
    }
    if (command.type === 'session.submit') {
      const result = await this.runtime.submitPromptToConversation(command.sessionId, command.prompt, command.mode)
      const submitStatus = isRecord(result) ? stringValue(result.status) : undefined
      if (command.mode === 'steer' && submitStatus && submitStatus !== 'steering') throw new Error('The session did not accept remote steering')
      return toJsonValue({ accepted: true, status: submitStatus ?? command.mode ?? 'turn' })
    }
    if (command.type === 'session.control') {
      const changed = await this.runtime.controlConversation(command.sessionId, command.action)
      return toJsonValue({ changed, action: command.action })
    }
    if (command.type === 'approval.resolve') {
      const automationApproval = this.runtime.listRemoteAutomationApprovals?.().find(request => request.id === command.requestId)
      if (automationApproval && this.runtime.resolveAutomationApproval) {
        if (!automationApproval.options?.includes(command.response)) throw new Error('Automation approval response is not available to this remote client')
        if (!context?.deviceId || context.clientInstanceId !== command.clientInstanceId) throw new Error('Authenticated remote device context is unavailable')
        await this.runtime.resolveAutomationApproval(command.requestId, command.response, 'remote', context.deviceId)
        return toJsonValue({ resolved: true })
      }
      const resolved = await this.runtime.resolveRequestForConversation(command.sessionId, command.requestId, command.response)
      if (!resolved) throw new Error('Approval request is unavailable in this session')
      return toJsonValue({ resolved })
    }
    if (command.type === 'artifact.list') {
      const artifacts = this.runtime.getSnapshot().artifacts.artifacts
        .filter(artifact => !command.sessionId || artifact.conversationId === command.sessionId)
        .map(projectArtifact)
      return toJsonValue({ artifacts })
    }
    const artifact = this.runtime.getArtifact(command.artifactId)
    if (!artifact?.available) throw new Error('Artifact is unavailable')
    const offset = Math.max(0, Math.floor(command.offset ?? 0))
    const requestedLength = Math.max(1, Math.floor(command.length ?? DEFAULT_ARTIFACT_CHUNK_BYTES))
    const length = Math.min(MAX_ARTIFACT_CHUNK_BYTES, requestedLength, Math.max(0, artifact.size - offset))
    const bytes = length > 0 ? await this.readArtifact(artifact, offset, length) : new Uint8Array()
    const nextOffset = offset + bytes.byteLength
    return toJsonValue({
      artifact: projectArtifact(artifact),
      offset,
      nextOffset,
      eof: nextOffset >= artifact.size,
      encoding: 'base64url',
      data: Buffer.from(bytes).toString('base64url'),
    })
  }

  subscribe(listener: RemoteAdapterEventListener): () => void {
    this.listeners.add(listener)
    if (!this.runtimeUnsubscribe) {
      this.previousSnapshot = this.runtime.getSnapshot()
      this.runtimeUnsubscribe = this.runtime.subscribe(event => this.handleRuntimeEvent(event))
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.runtimeUnsubscribe?.()
        this.runtimeUnsubscribe = undefined
      }
    }
  }

  resolveWorkspaceId(command: AdapterCommand): string | undefined {
    const snapshot = this.runtime.getSnapshot()
    if (command.type === 'session.create') return command.workspaceId ?? workspaceIdForPath(snapshot.workspace.path)
    if (command.type === 'artifact.read') {
      const artifact = this.runtime.getArtifact(command.artifactId)
      return artifact ? workspaceIdForPath(artifact.workspacePath) : undefined
    }
    const sessionId = command.type === 'artifact.list' ? command.sessionId : command.sessionId
    if (!sessionId) return workspaceIdForPath(snapshot.workspace.path)
    const conversation = snapshot.conversationCatalog.find(item => item.id === sessionId)
    return conversation ? workspaceIdForPath(conversation.workspacePath) : undefined
  }

  resolveEventWorkspaceId(event: RemoteAgentEvent): string | undefined {
    if (event.type === 'approval.requested' && event.request.workspaceId) return event.request.workspaceId
    if (event.type === 'artifact.available' && event.artifact.workspaceId) return event.artifact.workspaceId
    const snapshot = this.runtime.getSnapshot()
    const sessionId = 'sessionId' in event ? event.sessionId : undefined
    const conversation = sessionId ? snapshot.conversationCatalog.find(item => item.id === sessionId) : undefined
    return workspaceIdForPath(conversation?.workspacePath ?? snapshot.workspace.path)
  }

  private async activateSession(sessionId: string): Promise<void> {
    const snapshot = this.runtime.getSnapshot()
    if (!snapshot.conversationCatalog.some(item => item.id === sessionId)) throw new Error(`Session not found: ${sessionId}`)
    if (snapshot.conversation.id !== sessionId) await this.runtime.activateRemoteSession(sessionId)
  }

  private projectApproval(request: TurboFluxRequestLike, sessionId: string, workspaceId: string, createdAt = this.now()): RemoteApprovalRequest {
    return {
      id: request.id,
      sessionId,
      kind: request.kind,
      question: request.question,
      options: request.options ? [...request.options] : undefined,
      reason: request.reason,
      toolName: request.toolName,
      workspaceId,
      createdAt,
    }
  }

  private projectAutomationApproval(request: TurboFluxAutomationApprovalLike): RemoteApprovalRequest {
    return {
      id: request.id,
      sessionId: request.sessionId,
      kind: request.kind,
      question: request.question,
      options: request.options ? [...request.options] : undefined,
      toolName: request.toolName,
      workspaceId: workspaceIdForPath(request.workspacePath),
      createdAt: request.requestedAt,
      automation: {
        name: request.automationName,
        runId: request.runId,
        riskCategory: request.riskCategory,
        targetSummary: request.targetSummary,
        expiresAt: request.expiresAt,
      },
    }
  }

  private handleRuntimeEvent(value: TEvent): void {
    const event = value as unknown
    if (!isRecord(event) || typeof event.type !== 'string') return
    if (event.type === 'snapshot' && isRecord(event.snapshot)) {
      const next = event.snapshot as unknown as TurboFluxRemoteSnapshotLike
      this.emitSnapshotChanges(this.previousSnapshot, next)
      this.previousSnapshot = next
      return
    }
    if (event.type === 'conversation-event' && typeof event.conversationId === 'string' && isRecord(event.event)) {
      this.emitConversationEvent(event.conversationId, event.event)
      return
    }
    if (event.type === 'runtime-error') {
      this.emit({ type: 'notification', sessionId: stringValue(event.conversationId), level: 'error', message: stringValue(event.message) ?? 'TurboFlux runtime error' })
      return
    }
    if (event.type === 'automation-notification') {
      const level = stringValue(event.level)
      this.emit({
        type: 'notification',
        sessionId: stringValue(event.conversationId),
        level: level === 'success' || level === 'warning' || level === 'error' ? level : 'info',
        message: (stringValue(event.message) ?? '').slice(0, 4_000),
      })
      return
    }
    if (event.type === 'conversation-run' && typeof event.conversationId === 'string') {
      const status = stringValue(event.status)
      this.emit({
        type: 'run.completed',
        sessionId: event.conversationId,
        outcome: status === 'completed' || status === 'partial' ? status : status === 'interrupted' ? 'interrupted' : 'failed',
      })
    }
  }

  private emitConversationEvent(sessionId: string, event: Record<string, unknown>): void {
    const type = stringValue(event.type)
    const payload = isRecord(event.payload) ? event.payload : {}
    const runId = stringValue(event.runId)
    const messageId = stringValue(event.itemId) ?? stringValue(event.turnId) ?? runId ?? `${sessionId}:${stringValue(event.seq) ?? this.now()}`
    if (type === 'run.started') this.emit({ type: 'run.started', sessionId, runId: runId ?? messageId, objective: stringValue(payload.objective) })
    else if (type === 'run.state_changed') this.emit({ type: 'run.state', sessionId, runId, status: statusForRunState(payload.state) })
    else if (type === 'run.completed') {
      const outcome = stringValue(payload.outcome)
      this.emit({ type: 'run.completed', sessionId, runId, outcome: outcome === 'completed' || outcome === 'partial' ? outcome : outcome === 'cancelled' ? 'cancelled' : outcome === 'interrupted' ? 'interrupted' : 'failed', error: stringValue(payload.error) })
    } else if (type === 'stream.delta' || type === 'stream.committed') {
      const channel = stringValue(payload.channel) === 'thinking' ? 'reasoning' as const : 'answer' as const
      const text = stringValue(payload.text) ?? ''
      this.emit(type === 'stream.delta'
        ? { type: 'message.delta', sessionId, messageId, channel, delta: text }
        : { type: 'message.completed', sessionId, messageId, channel, text })
    } else if (type === 'turn.completed' && isRecord(payload.turn)) {
      const turn = payload.turn
      if (turn.role === 'assistant') this.emit({ type: 'message.completed', sessionId, messageId: stringValue(turn.id) ?? messageId, channel: 'answer', text: stringValue(turn.content) ?? '' })
    } else if (type === 'tool.proposed' && isRecord(payload.toolCall)) {
      const toolCall = payload.toolCall
      this.emit({ type: 'tool.started', sessionId, toolCallId: stringValue(toolCall.id) ?? messageId, toolName: stringValue(toolCall.name) ?? 'tool' })
    } else if (type === 'tool.completed' && isRecord(payload.toolResult)) {
      const toolResult = payload.toolResult
      this.emit({ type: 'tool.completed', sessionId, toolCallId: stringValue(toolResult.toolCallId) ?? messageId, toolName: stringValue(toolResult.toolName) ?? 'tool', success: !toolResult.error, summary: stringValue(toolResult.error) })
    } else if (type === 'approval.requested') {
      const kind = stringValue(payload.kind)
      this.emit({ type: 'approval.requested', request: this.projectApproval({ id: stringValue(payload.requestId) ?? messageId, kind: kind === 'input' ? 'input' : 'permission', question: stringValue(payload.question) ?? 'Remote approval required', options: Array.isArray(payload.options) ? payload.options.filter((item): item is string => typeof item === 'string') : undefined, reason: stringValue(payload.reason), toolName: stringValue(payload.toolName) }, sessionId, this.resolveSessionWorkspaceId(sessionId), typeof event.at === 'number' ? event.at : this.now()) })
    } else if (type === 'approval.resolved' || type === 'approval.cancelled') {
      this.emit({ type: 'approval.resolved', sessionId, requestId: stringValue(payload.requestId) ?? messageId, decision: stringValue(payload.decision) ?? stringValue(payload.reason) })
    } else if (type === 'notification.raised') {
      const level = stringValue(payload.level)
      this.emit({ type: 'notification', sessionId, level: level === 'success' || level === 'warning' || level === 'error' ? level : 'info', message: stringValue(payload.message) ?? '' })
    }
  }

  private emitSnapshotChanges(previous: TurboFluxRemoteSnapshotLike | undefined, next: TurboFluxRemoteSnapshotLike): void {
    if (!previous) return
    const previousRuntime = new Map(previous.conversationRuntimes.map(item => [item.conversationId, item.status]))
    for (const runtime of next.conversationRuntimes) {
      if (previousRuntime.get(runtime.conversationId) !== runtime.status) this.emit({ type: 'run.state', sessionId: runtime.conversationId, status: statusFor(runtime.status) })
    }
    const previousRequests = new Set(previous.runtime.pendingRequests.map(request => request.id))
    for (const request of next.runtime.pendingRequests) {
      if (!previousRequests.has(request.id)) this.emit({ type: 'approval.requested', request: this.projectApproval(request, next.conversation.id, workspaceIdForPath(next.workspace.path)) })
    }
    const nextRequests = new Set(next.runtime.pendingRequests.map(request => request.id))
    for (const request of previous.runtime.pendingRequests) {
      if (!nextRequests.has(request.id)) this.emit({ type: 'approval.resolved', sessionId: previous.conversation.id, requestId: request.id })
    }
    const previousArtifacts = new Map(previous.artifacts.artifacts.map(artifact => [artifact.id, artifact.updatedAt]))
    for (const artifact of next.artifacts.artifacts) {
      if (previousArtifacts.get(artifact.id) !== artifact.updatedAt) this.emit({ type: 'artifact.available', artifact: projectArtifact(artifact) })
    }
  }

  private resolveSessionWorkspaceId(sessionId: string): string {
    const snapshot = this.runtime.getSnapshot()
    const conversation = snapshot.conversationCatalog.find(item => item.id === sessionId)
    return workspaceIdForPath(conversation?.workspacePath ?? snapshot.workspace.path)
  }

  private emit(event: RemoteAgentEvent): void {
    for (const listener of this.listeners) listener(structuredClone(event))
  }
}

export { workspaceIdForPath as turboFluxWorkspaceId }
