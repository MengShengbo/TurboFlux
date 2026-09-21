import { isModelRequestRecord } from '@turboflux/contracts/modelUsage'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { AgentTurn, ToolCall, ToolResult } from '@turboflux/contracts/agentTypes'
import { copyToolResultDetails } from '@turboflux/contracts/toolResultData'
import type { WorkActivity, WorkExecutionSnapshot, WorkRunStatus } from '@turboflux/contracts/workExecutionTypes'
import type { AnyConversationEvent } from '@turboflux/contracts/conversationEvent'
import type { PersistedConversation } from './types'
import type {
  AnyAppendConversationEventV2Input,
  ConversationItemV2,
  ConversationRecordV2,
  ConversationV2Provenance,
  ConversationV2Source,
  PortablePathRef,
} from './conversationV2Types'
import {
  conversationV2IdFactory,
  stableConversationV2Id,
} from './conversationV2Ids'

export interface ConversationV2MigrationPlan {
  schemaVersion: 1
  sourceConversationId: string
  workspaceId: string
  workspaceDisplayName: string
  sourceWorkspacePath: string
  events: AnyAppendConversationEventV2Input[]
  counts: {
    turns: number
    messageItems: number
    toolCalls: number
    toolResults: number
    runs: number
    approvals: number
    contextCompactions: number
    plans: number
    activities: number
    artifacts: number
    recoveries: number
    canonicalEvents: number
  }
  warnings: string[]
}

export function legacyWorkspaceId(workspacePath: string): string {
  return stableConversationV2Id('workspace', resolve(workspacePath).replaceAll('\\', '/').toLowerCase())
}

function pathRef(workspacePath: string, workspaceId: string, candidate: string): PortablePathRef | undefined {
  const root = resolve(workspacePath)
  const normalizedCandidate = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate)
  const child = relative(root, normalizedCandidate).replaceAll('\\', '/')
  if (!child) return { scheme: 'workspace', workspaceId, relativePath: '' }
  if (child === '..' || child.startsWith('../')) {
    return { scheme: 'external', displayPath: basename(normalizedCandidate) || 'external path', portability: 'unavailable' }
  }
  return { scheme: 'workspace', workspaceId, relativePath: child }
}

export function portablePathRefsForToolValue(workspacePath: string, workspaceId: string, value: unknown): PortablePathRef[] {
  const refs: PortablePathRef[] = []
  const visit = (candidate: unknown, key?: string): void => {
    if (typeof candidate === 'string' && key && /(?:^|_)(?:path|file|cwd|directory)$/i.test(key)) {
      const ref = pathRef(workspacePath, workspaceId, candidate)
      if (ref) refs.push(ref)
      return
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, key)
      return
    }
    if (candidate && typeof candidate === 'object') {
      for (const [childKey, child] of Object.entries(candidate)) visit(child, childKey)
    }
  }
  visit(value)
  return refs
}

function messageItem(conversation: PersistedConversation, turn: AgentTurn): ConversationItemV2 {
  const ids = conversationV2IdFactory(conversation.id)
  const kind = turn.role === 'assistant' ? 'assistant_message' : 'user_message'
  const turnId = ids.normalize('turn', turn.id)
  const base = {
    schemaVersion: 1 as const,
    id: ids.stable('item', conversation.id, turn.id, 'message'),
    conversationId: conversation.id,
    turnId,
    status: turn.metadata?.interrupted ? 'interrupted' as const : 'completed' as const,
    createdAt: turn.timestamp,
    updatedAt: turn.timestamp,
  }
  return kind === 'assistant_message'
    ? { ...base, kind, payload: { text: turn.content } }
    : { ...base, kind, payload: { text: turn.content, attachmentIds: turn.metadata?.attachments?.map(attachment => ids.normalize('attachment', attachment.id)) ?? [] } }
}

function toolCallItem(conversation: PersistedConversation, workspaceId: string, turn: AgentTurn, toolCall: ToolCall): ConversationItemV2 {
  const ids = conversationV2IdFactory(conversation.id)
  const turnId = ids.normalize('turn', turn.id)
  return {
    schemaVersion: 1,
    id: ids.stable('item', conversation.id, turn.id, 'tool-call', toolCall.id),
    conversationId: conversation.id,
    turnId,
    kind: 'tool_call',
    status: 'completed',
    createdAt: turn.timestamp,
    updatedAt: turn.timestamp,
    payload: {
      toolCallId: ids.normalize('tool', toolCall.id),
      toolName: toolCall.name,
      arguments: structuredClone(toolCall.arguments),
      pathRefs: portablePathRefsForToolValue(conversation.workspacePath, workspaceId, toolCall.arguments),
      requiresReview: true,
    },
  }
}

function toolResultItem(conversation: PersistedConversation, workspaceId: string, turn: AgentTurn, result: ToolResult): ConversationItemV2 {
  const ids = conversationV2IdFactory(conversation.id)
  const turnId = ids.normalize('turn', turn.id)
  return {
    schemaVersion: 1,
    id: ids.stable('item', conversation.id, turn.id, 'tool-result', result.toolCallId),
    conversationId: conversation.id,
    turnId,
    kind: 'tool_result',
    status: result.isError ? 'failed' : 'completed',
    createdAt: turn.timestamp,
    updatedAt: turn.timestamp,
    payload: {
      toolCallId: ids.normalize('tool', result.toolCallId),
      toolName: result.name,
      output: result.output,
      isError: result.isError,
      ...copyToolResultDetails(result),
      pathRefs: portablePathRefsForToolValue(conversation.workspacePath, workspaceId, result),
    },
  }
}

function migratedRunStatus(status: WorkRunStatus): 'pending' | 'running' | 'waiting' | 'completed' | 'partial' | 'failed' | 'cancelled' {
  if (status === 'waiting' || status === 'paused') return 'waiting'
  return status
}

function canonicalRunStatus(event: Extract<AnyConversationEvent, { type: 'run.state_changed' }>): 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' {
  const phase = event.payload.state.phase
  if (phase === 'idle') return 'pending'
  if (phase === 'awaiting_approval' || phase === 'awaiting_input' || phase === 'paused') return 'waiting'
  if (phase === 'completed') return 'completed'
  if (phase === 'recoverable_error') return 'failed'
  if (phase === 'aborting') return 'cancelled'
  return 'running'
}

function activityItem(
  conversation: PersistedConversation,
  workspaceId: string,
  runId: string,
  activity: WorkActivity,
): ConversationItemV2 {
  const ids = conversationV2IdFactory(conversation.id)
  const base = {
    schemaVersion: 1 as const,
    id: ids.stable('item', conversation.id, runId, 'activity', activity.id),
    conversationId: conversation.id,
    runId,
    status: activity.status === 'completed' ? 'completed' as const
      : activity.status === 'failed' ? 'failed' as const
        : activity.status === 'cancelled' ? 'cancelled' as const
          : activity.status === 'recovered' ? 'interrupted' as const
            : 'running' as const,
    createdAt: activity.startedAt,
    updatedAt: activity.updatedAt,
  }
  if (activity.kind === 'browser') return { ...base, kind: 'browser_activity', payload: { action: activity.title, result: activity.result ?? activity.error } }
  if (activity.kind === 'computer') return { ...base, kind: 'computer_activity', payload: { action: activity.title, result: activity.result ?? activity.error } }
  if (activity.kind === 'subagent') return { ...base, kind: 'subagent', payload: { agentId: ids.normalize('agent', activity.id), task: activity.title, result: activity.result ?? activity.error } }
  if (activity.kind === 'artifact') {
    const sourceArtifactId = typeof activity.metadata?.artifactId === 'string' ? activity.metadata.artifactId : activity.id
    const artifactId = ids.normalize('artifact', sourceArtifactId)
    return {
      ...base,
      kind: 'artifact',
      payload: {
        artifactId,
        name: activity.title,
        path: activity.path ? pathRef(conversation.workspacePath, workspaceId, activity.path) : undefined,
      },
    }
  }
  const command = typeof activity.metadata?.command === 'string' ? activity.metadata.command : undefined
  if (activity.kind === 'tool' && command) {
    return {
      ...base,
      kind: 'command_execution',
      payload: { command, cwd: activity.path ? pathRef(conversation.workspacePath, workspaceId, activity.path) : undefined, output: activity.result ?? activity.error, requiresReview: true },
    }
  }
  return { ...base, kind: 'notification', payload: { level: base.status === 'failed' ? 'error' : base.status === 'completed' ? 'success' : 'info', message: [activity.title, activity.detail, activity.result ?? activity.error].filter(Boolean).join(' · ') } }
}

export interface ConversationV2PlanOptions {
  workspaceId?: string
  source?: ConversationV2Source
  provenance?: ConversationV2Provenance
}

export function planConversationV2Migration(
  profileId: string,
  conversation: PersistedConversation,
  options: ConversationV2PlanOptions = {},
): ConversationV2MigrationPlan {
  const ids = conversationV2IdFactory(conversation.id)
  const stableId = ids.stable
  const normalizeConversationV2Id = ids.normalize
  const scopedConversationV2Id = ids.scoped
  const workspaceId = options.workspaceId ?? legacyWorkspaceId(conversation.workspacePath)
  const source = options.source ?? 'migration'
  const provenance = options.provenance ?? 'migrated'
  const record: ConversationRecordV2 = {
    schemaVersion: 2,
    id: conversation.id,
    profileId,
    workspaceId,
    title: conversation.title,
    titleSource: conversation.titleSource ?? 'generated',
    mode: conversation.mode,
    provider: conversation.provider,
    model: conversation.model,
    status: 'idle',
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastEventSeq: 0,
    turnCount: 0,
    runCount: 0,
    tags: [],
  }
  const events: AnyAppendConversationEventV2Input[] = [{
    eventId: stableId('migration', conversation.id, 'created'),
    profileId,
    conversationId: conversation.id,
    workspaceId,
    source,
    provenance,
    type: 'conversation.created',
    at: conversation.createdAt,
    payload: { record },
  }]
  let messageItems = 0
  let toolCalls = 0
  let toolResults = 0
  const runIds = new Set<string>()
  const approvalIds = new Set<string>()
  const compactionIds = new Set<string>()
  const planIds = new Set<string>()
  const activityIds = new Set<string>()
  const artifactIds = new Set<string>()
  let recoveries = 0
  let canonicalEvents = 0
  for (const turn of conversation.turns) {
    const role = turn.role === 'tool_result' ? 'system' : turn.role
    const runId = turn.metadata?.workRunId ? normalizeConversationV2Id('run', turn.metadata.workRunId) : undefined
    const turnId = normalizeConversationV2Id('turn', turn.id)
    events.push({
      eventId: stableId('migration', conversation.id, turn.id, 'start'),
      profileId,
      conversationId: conversation.id,
      workspaceId,
      runId,
      turnId,
      source,
      provenance,
      type: 'turn.started',
      at: turn.timestamp,
      payload: { turn: { id: turnId, conversationId: conversation.id, runId, role, status: 'started', createdAt: turn.timestamp } },
    })
    if (turn.content || turn.role !== 'tool_result') {
      const item = messageItem(conversation, turn)
      item.runId = runId
      events.push({
        eventId: stableId('migration', conversation.id, item.id, 'created'),
        profileId,
        conversationId: conversation.id,
        workspaceId,
        runId,
        turnId,
        itemId: item.id,
        source,
        provenance,
        type: 'item.created',
        at: turn.timestamp,
        payload: { item },
      })
      messageItems += 1
    }
    if (turn.metadata?.thinking?.content) {
      const item: ConversationItemV2 = {
        schemaVersion: 1,
        id: stableId('item', conversation.id, turn.id, 'reasoning'),
        conversationId: conversation.id,
        runId,
        turnId,
        kind: 'reasoning',
        status: turn.metadata.interrupted ? 'interrupted' : 'completed',
        createdAt: turn.metadata.thinking.startedAt ?? turn.timestamp,
        updatedAt: turn.timestamp,
        payload: { text: turn.metadata.thinking.content, omitted: false },
      }
      events.push({ eventId: stableId('migration', conversation.id, item.id, 'created'), profileId, conversationId: conversation.id, workspaceId, runId, turnId, itemId: item.id, source, provenance, type: 'item.created', at: item.createdAt, payload: { item } })
      activityIds.add(item.id)
    }
    for (const toolCall of turn.toolCalls ?? []) {
      const item = toolCallItem(conversation, workspaceId, turn, toolCall)
      item.runId = runId
      events.push({
        eventId: stableId('migration', conversation.id, item.id, 'created'), profileId, conversationId: conversation.id, workspaceId, runId, turnId, itemId: item.id,
        source, provenance, type: 'item.created', at: turn.timestamp, payload: { item },
      })
      let semantic: ConversationItemV2 | null = null
      if (toolCall.name.startsWith('browser__')) semantic = { schemaVersion: 1, id: stableId('item', conversation.id, turn.id, 'browser', toolCall.id), conversationId: conversation.id, runId, turnId, kind: 'browser_activity', status: 'completed', createdAt: turn.timestamp, updatedAt: turn.timestamp, payload: { action: toolCall.name.slice('browser__'.length), url: typeof toolCall.arguments.url === 'string' ? toolCall.arguments.url : undefined } }
      else if (toolCall.name.startsWith('computer__')) semantic = { schemaVersion: 1, id: stableId('item', conversation.id, turn.id, 'computer', toolCall.id), conversationId: conversation.id, runId, turnId, kind: 'computer_activity', status: 'completed', createdAt: turn.timestamp, updatedAt: turn.timestamp, payload: { action: toolCall.name.slice('computer__'.length), application: typeof toolCall.arguments.application === 'string' ? toolCall.arguments.application : typeof toolCall.arguments.app === 'string' ? toolCall.arguments.app : undefined } }
      else {
        const command = typeof toolCall.arguments.command === 'string' ? toolCall.arguments.command : typeof toolCall.arguments.cmd === 'string' ? toolCall.arguments.cmd : undefined
        if (command && /(?:command|shell|terminal|exec|bash)/iu.test(toolCall.name)) semantic = { schemaVersion: 1, id: stableId('item', conversation.id, turn.id, 'command', toolCall.id), conversationId: conversation.id, runId, turnId, kind: 'command_execution', status: 'completed', createdAt: turn.timestamp, updatedAt: turn.timestamp, payload: { command, cwd: portablePathRefsForToolValue(conversation.workspacePath, workspaceId, { cwd: toolCall.arguments.cwd })[0], requiresReview: true } }
      }
      if (semantic) {
        events.push({ eventId: stableId('migration', conversation.id, semantic.id, 'created'), profileId, conversationId: conversation.id, workspaceId, runId, turnId, itemId: semantic.id, source, provenance, type: 'item.created', at: turn.timestamp, payload: { item: semantic } })
        activityIds.add(semantic.id)
      }
      toolCalls += 1
    }
    for (const result of turn.toolResults ?? []) {
      const item = toolResultItem(conversation, workspaceId, turn, result)
      item.runId = runId
      events.push({
        eventId: stableId('migration', conversation.id, item.id, 'created'), profileId, conversationId: conversation.id, workspaceId, runId, turnId, itemId: item.id,
        source, provenance, type: 'item.created', at: turn.timestamp, payload: { item },
      })
      if (result.changeSummary) {
        const path = pathRef(conversation.workspacePath, workspaceId, result.changeSummary.path)
        if (path) {
          const change: ConversationItemV2 = { schemaVersion: 1, id: stableId('item', conversation.id, turn.id, 'file-change', result.toolCallId), conversationId: conversation.id, runId, turnId, kind: 'file_change', status: result.isError ? 'failed' : 'completed', createdAt: turn.timestamp, updatedAt: turn.timestamp, payload: { path, change: result.changeSummary.operation === 'write' ? 'created' : result.changeSummary.operation === 'edit' ? 'modified' : 'deleted' } }
          events.push({ eventId: stableId('migration', conversation.id, change.id, 'created'), profileId, conversationId: conversation.id, workspaceId, runId, turnId, itemId: change.id, source, provenance, type: 'item.created', at: turn.timestamp, payload: { item: change } })
          activityIds.add(change.id)
        }
      }
      for (const attachment of result.attachments ?? []) {
        const artifactId = normalizeConversationV2Id('artifact', attachment.id)
        const artifact: ConversationItemV2 = { schemaVersion: 1, id: stableId('item', conversation.id, turn.id, 'artifact', attachment.id), conversationId: conversation.id, runId, turnId, kind: 'artifact', status: 'completed', createdAt: turn.timestamp, updatedAt: turn.timestamp, payload: { artifactId, name: attachment.filename, mime: attachment.mime, path: pathRef(conversation.workspacePath, workspaceId, attachment.path), size: attachment.size } }
        events.push({ eventId: stableId('migration', conversation.id, artifact.id, 'created'), profileId, conversationId: conversation.id, workspaceId, runId, turnId, itemId: artifact.id, source, provenance, type: 'item.created', at: turn.timestamp, payload: { item: artifact } })
        events.push({ eventId: stableId('migration', conversation.id, artifact.id, 'registered'), profileId, conversationId: conversation.id, workspaceId, runId, turnId, itemId: artifact.id, source, provenance, type: 'artifact.registered', at: turn.timestamp, payload: { artifactId, itemId: artifact.id } })
        artifactIds.add(artifactId)
      }
      toolResults += 1
    }
    events.push({
      eventId: stableId('migration', conversation.id, turn.id, 'complete'),
      profileId,
      conversationId: conversation.id,
      workspaceId,
      runId,
      turnId,
      source,
      provenance,
      type: 'turn.completed',
      at: turn.timestamp,
      payload: { completedAt: turn.timestamp, interrupted: turn.metadata?.interrupted,
        ...(turn.metadata ? { metadata: Object.fromEntries(Object.entries(turn.metadata)
          .filter(([key]) => ['tokens', 'model', 'duration', 'modelRequestId', 'modelAttemptId', 'internal', 'internalKind'].includes(key))) } : {}),
      },
    })
  }

  for (const request of conversation.modelRequests ?? []) {
    if (!isModelRequestRecord(request)) continue
    events.push({
      eventId: stableId('migration-request', conversation.id, request.id, request.updatedAt, JSON.stringify(request)),
      profileId, conversationId: conversation.id, workspaceId,
      runId: request.runId ? normalizeConversationV2Id('run', request.runId) : undefined,
      source, provenance, type: 'model.request_updated', at: request.updatedAt,
      payload: { request: { ...structuredClone(request), runId: request.runId ? normalizeConversationV2Id('run', request.runId) : undefined } },
    })
  }

  for (const legacy of conversation.canonicalEvents ?? []) {
    canonicalEvents += 1
    const runId = legacy.runId ? normalizeConversationV2Id('run', legacy.runId) : undefined
    const turnId = legacy.turnId ? normalizeConversationV2Id('turn', legacy.turnId) : undefined
    const itemId = legacy.itemId ? normalizeConversationV2Id('item', legacy.itemId) : undefined
    const common = {
      profileId,
      conversationId: conversation.id,
      workspaceId,
      runId,
      turnId,
      itemId,
      source,
      provenance,
      legacyEventId: legacy.eventId,
      at: legacy.at,
    }
    const migratedEventId = (suffix = legacy.type) => stableId('migration', conversation.id, 'canonical', legacy.eventId, suffix)
    if (legacy.type === 'model.request_updated') {
      events.push({ ...common, eventId: migratedEventId(), type: 'model.request_updated', payload: { request: { ...structuredClone(legacy.payload.request), runId } } })
    } else if (legacy.type === 'run.started' && runId) {
      runIds.add(runId)
      events.push({ ...common, eventId: migratedEventId(), type: 'run.started', payload: { run: { id: runId, conversationId: conversation.id, workspaceId, objective: legacy.payload.objective ?? conversation.title, status: 'running', provider: conversation.provider, model: conversation.model, startedAt: legacy.at, updatedAt: legacy.at } } })
    } else if (legacy.type === 'run.state_changed' && runId) {
      events.push({ ...common, eventId: migratedEventId(), type: 'run.state_changed', payload: { status: canonicalRunStatus(legacy), updatedAt: legacy.payload.state.updatedAt, outcome: legacy.payload.state.detail } })
    } else if (legacy.type === 'run.completed' && runId) {
      events.push({ ...common, eventId: migratedEventId(), type: 'run.completed', payload: { status: legacy.payload.outcome, completedAt: legacy.at, outcome: legacy.payload.error } })
    } else if (legacy.type === 'approval.requested') {
      approvalIds.add(legacy.payload.requestId)
      events.push({ ...common, eventId: migratedEventId(), type: 'approval.requested', payload: { requestId: normalizeConversationV2Id('approval', legacy.payload.requestId), requestKind: legacy.payload.kind, question: legacy.payload.question } })
    } else if (legacy.type === 'approval.resolved') {
      approvalIds.add(legacy.payload.requestId)
      events.push({ ...common, eventId: migratedEventId(), type: 'approval.resolved', payload: { requestId: normalizeConversationV2Id('approval', legacy.payload.requestId), decision: legacy.payload.decision } })
    } else if (legacy.type === 'approval.cancelled') {
      approvalIds.add(legacy.payload.requestId)
      events.push({ ...common, eventId: migratedEventId(), type: 'approval.cancelled', payload: { requestId: normalizeConversationV2Id('approval', legacy.payload.requestId), reason: legacy.payload.reason ?? 'Legacy approval cancelled during migration.' } })
    } else if (legacy.type === 'input.state_changed') {
      const inputId = normalizeConversationV2Id('input', legacy.payload.inputId)
      if (legacy.payload.state === 'accepted') events.push({ ...common, eventId: migratedEventId(), type: 'input.queued', payload: { inputId, text: legacy.payload.text ?? '' } })
      else if (legacy.payload.state === 'committed') events.push({ ...common, eventId: migratedEventId(), type: 'input.committed', payload: { inputId } })
      else events.push({ ...common, eventId: migratedEventId(), type: 'input.removed', payload: { inputId, reason: legacy.payload.reason ?? 'Legacy input removed during migration.' } })
    } else if (legacy.type === 'context.compaction') {
      const state = legacy.payload.state
      compactionIds.add(state.id)
      const compactionId = normalizeConversationV2Id('compaction', state.id)
      const sourceItemIds = [state.startMessageId, state.endMessageId].filter((value): value is string => Boolean(value))
      if (state.phase === 'started') events.push({ ...common, eventId: migratedEventId(), type: 'context.compaction_started', payload: { compactionId, sourceItemIds } })
      else if (state.phase === 'completed') {
        const segment = conversation.contextSegments?.find(candidate => (!state.startMessageId || candidate.startMessageId === state.startMessageId) && (!state.endMessageId || candidate.endMessageId === state.endMessageId))
        events.push({ ...common, eventId: migratedEventId(), type: 'context.compaction_committed', payload: { compactionId, itemId: scopedConversationV2Id('compaction', state.id), summary: segment?.summary, model: segment?.isModelGenerated ? conversation.model : undefined } })
      } else if (state.phase === 'failed' || state.phase === 'interrupted') events.push({ ...common, eventId: migratedEventId(), type: 'context.compaction_failed', payload: { compactionId, error: state.error ?? state.detail ?? state.phase } })
    } else if (legacy.type === 'notification.raised') {
      const item: ConversationItemV2 = { schemaVersion: 1, id: stableId('item', conversation.id, 'notification', legacy.eventId), conversationId: conversation.id, runId, kind: 'notification', status: 'completed', createdAt: legacy.at, updatedAt: legacy.at, payload: legacy.payload }
      events.push({ ...common, eventId: migratedEventId(), itemId: item.id, type: 'item.created', payload: { item } })
      activityIds.add(item.id)
    } else if (legacy.type === 'runtime.event') {
      const payload = legacy.payload.payload && typeof legacy.payload.payload === 'object' && !Array.isArray(legacy.payload.payload) ? legacy.payload.payload as Record<string, unknown> : undefined
      if (legacy.payload.kind === 'subagent:start' && payload) {
        const sourceAgentId = String(payload.agentId)
        const agentId = normalizeConversationV2Id('agent', sourceAgentId)
        const item: ConversationItemV2 = { schemaVersion: 1, id: scopedConversationV2Id('subagent', sourceAgentId), conversationId: conversation.id, runId, kind: 'subagent', status: 'running', createdAt: legacy.at, updatedAt: legacy.at, payload: { agentId, task: String(payload.objective ?? payload.label ?? 'Subagent task') } }
        events.push({ ...common, eventId: migratedEventId(), itemId: item.id, type: 'item.created', payload: { item } })
        activityIds.add(item.id)
      } else if (legacy.payload.kind === 'subagent:end' && payload) {
        const itemId = scopedConversationV2Id('subagent', String(payload.agentId))
        events.push({ ...common, eventId: migratedEventId(), itemId, type: 'item.completed', payload: { status: payload.ok === true ? 'completed' : 'failed', completedAt: legacy.at } })
        activityIds.add(itemId)
      }
    }
  }

  const workExecution: WorkExecutionSnapshot | undefined = conversation.workExecution
  for (const run of workExecution?.runs ?? []) {
    const runId = normalizeConversationV2Id('run', run.id)
    runIds.add(runId)
    const runStatus = migratedRunStatus(run.status)
    events.push({
      eventId: stableId('migration', conversation.id, 'work-run', run.id, 'started'), profileId, conversationId: conversation.id, workspaceId, runId,
      source, provenance, type: 'run.started', at: run.startedAt,
      payload: { run: { id: runId, conversationId: conversation.id, workspaceId, objective: run.objective, status: runStatus, provider: conversation.provider, model: conversation.model, startedAt: run.startedAt, updatedAt: run.updatedAt, completedAt: run.completedAt, outcome: run.outcome ?? run.error, recoveredFromPersistence: run.recoveredFromPersistence, responseMode: run.responseMode, executionSegments: run.executionSegments } },
    })
    if (runStatus === 'completed' || runStatus === 'partial' || runStatus === 'failed' || runStatus === 'cancelled') {
      events.push({ eventId: stableId('migration', conversation.id, 'work-run', run.id, 'completed'), profileId, conversationId: conversation.id, workspaceId, runId, source, provenance, type: 'run.completed', at: run.completedAt ?? run.updatedAt, payload: { status: runStatus, completedAt: run.completedAt ?? run.updatedAt, outcome: run.outcome ?? run.error } })
    }
    const plan: ConversationItemV2 = {
      schemaVersion: 1,
      id: scopedConversationV2Id('plan', run.id),
      conversationId: conversation.id,
      runId,
      kind: 'plan',
      status: runStatus === 'completed' || runStatus === 'partial' ? 'completed' : runStatus === 'failed' ? 'failed' : runStatus === 'cancelled' ? 'cancelled' : 'running',
      createdAt: run.startedAt,
      updatedAt: run.updatedAt,
      payload: { steps: Object.values(run.steps).map(step => ({ id: normalizeConversationV2Id('step', step.id), title: step.title, status: step.status })) },
    }
    events.push({ eventId: stableId('migration', conversation.id, plan.id, 'created'), profileId, conversationId: conversation.id, workspaceId, runId, itemId: plan.id, source, provenance, type: 'item.created', at: plan.createdAt, payload: { item: plan } })
    planIds.add(plan.id)
    for (const activity of Object.values(run.activities)) {
      const item = activityItem(conversation, workspaceId, runId, activity)
      events.push({ eventId: stableId('migration', conversation.id, item.id, 'created'), profileId, conversationId: conversation.id, workspaceId, runId, itemId: item.id, source, provenance, type: 'item.created', at: item.createdAt, payload: { item } })
      activityIds.add(item.id)
      if (item.kind === 'artifact') {
        artifactIds.add(item.payload.artifactId)
        events.push({ eventId: stableId('migration', conversation.id, item.id, 'registered'), profileId, conversationId: conversation.id, workspaceId, runId, itemId: item.id, source, provenance, type: 'artifact.registered', at: item.updatedAt, payload: { artifactId: item.payload.artifactId, itemId: item.id } })
      }
    }
  }

  const compaction = conversation.contextCompactionState
  if (compaction && !compactionIds.has(compaction.id)) {
    compactionIds.add(compaction.id)
    const compactionId = normalizeConversationV2Id('compaction', compaction.id)
    const sourceItemIds = [compaction.startMessageId, compaction.endMessageId].filter((value): value is string => Boolean(value))
    events.push({ eventId: stableId('migration', conversation.id, 'compaction', compaction.id, 'started'), profileId, conversationId: conversation.id, workspaceId, source, provenance, type: 'context.compaction_started', at: compaction.startedAt, payload: { compactionId, sourceItemIds } })
    if (compaction.phase === 'completed') {
      const segment = conversation.contextSegments?.find(candidate => (!compaction.startMessageId || candidate.startMessageId === compaction.startMessageId) && (!compaction.endMessageId || candidate.endMessageId === compaction.endMessageId))
      events.push({ eventId: stableId('migration', conversation.id, 'compaction', compaction.id, 'committed'), profileId, conversationId: conversation.id, workspaceId, source, provenance, type: 'context.compaction_committed', at: compaction.updatedAt, payload: { compactionId, itemId: scopedConversationV2Id('compaction', compaction.id), summary: segment?.summary, model: segment?.isModelGenerated ? conversation.model : undefined } })
    } else if (compaction.phase === 'failed' || compaction.phase === 'interrupted') events.push({ eventId: stableId('migration', conversation.id, 'compaction', compaction.id, 'failed'), profileId, conversationId: conversation.id, workspaceId, source, provenance, type: 'context.compaction_failed', at: compaction.updatedAt, payload: { compactionId, error: compaction.error ?? compaction.detail ?? compaction.phase } })
  }

  for (const approval of conversation.interactionState?.pendingApprovals ?? []) {
    approvalIds.add(approval.requestId)
    const requestId = normalizeConversationV2Id('approval', approval.requestId)
    events.push({ eventId: stableId('migration', conversation.id, 'approval', approval.requestId, 'requested'), profileId, conversationId: conversation.id, workspaceId, source, provenance, type: 'approval.requested', at: conversation.updatedAt, payload: { requestId, requestKind: approval.requestKind, question: approval.question } })
    events.push({ eventId: stableId('migration', conversation.id, 'approval', approval.requestId, 'cancelled'), profileId, conversationId: conversation.id, workspaceId, source, provenance, type: 'approval.cancelled', at: conversation.updatedAt, payload: { requestId, reason: 'Pending approval was cancelled during Conversation V2 migration.' } })
  }

  if (conversation.recovery && (conversation.recovery.interrupted || conversation.recovery.truncatedJournal || conversation.recovery.unresolvedToolCalls > 0)) {
    const reason = conversation.recovery.truncatedJournal ? 'Legacy journal was truncated.' : conversation.recovery.interrupted ? 'Legacy run was interrupted.' : 'Legacy tool calls were unresolved.'
    events.push({ eventId: stableId('migration', conversation.id, 'recovery', 'detected'), profileId, conversationId: conversation.id, workspaceId, source: 'recovery', provenance, type: 'recovery.detected', at: conversation.updatedAt, payload: { reason, throughSeq: conversation.canonicalEvents?.at(-1)?.seq ?? 0 } })
    events.push({ eventId: stableId('migration', conversation.id, 'recovery', 'applied'), profileId, conversationId: conversation.id, workspaceId, source: 'recovery', provenance, type: 'recovery.applied', at: conversation.updatedAt, payload: { reason, throughSeq: conversation.canonicalEvents?.at(-1)?.seq ?? 0 } })
    recoveries = 1
  }
  return {
    schemaVersion: 1,
    sourceConversationId: conversation.id,
    workspaceId,
    workspaceDisplayName: basename(resolve(conversation.workspacePath)) || 'workspace',
    sourceWorkspacePath: resolve(conversation.workspacePath),
    events,
    counts: {
      turns: conversation.turns.length,
      messageItems,
      toolCalls,
      toolResults,
      runs: runIds.size,
      approvals: approvalIds.size,
      contextCompactions: compactionIds.size,
      plans: planIds.size,
      activities: activityIds.size,
      artifacts: artifactIds.size,
      recoveries,
      canonicalEvents,
    },
    warnings: [],
  }
}
