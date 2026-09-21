import { isTokenUsage } from '@turboflux/contracts/modelUsage'
import type { ModelRequestRecord } from '@turboflux/contracts/agentTypes'
import type { AgentTurn, ToolCall, ToolResult } from '@turboflux/contracts/agentTypes'
import { copyToolResultDetails } from '@turboflux/contracts/toolResultData'
import { ConversationRepositoryV2 } from './conversationRepositoryV2'
import { planConversationV2Migration } from './conversationV2Migration'
import { portablePathRefsForToolValue } from './conversationV2Migration'
import { conversationV2IdFactory } from './conversationV2Ids'
import type { AnyAppendConversationEventV2Input, ConversationItemV2, ConversationRunV2, ConversationTranscriptProjectionV2, ConversationTurnV2, ConversationV2ItemStatus, ConversationV2RunStatus } from './conversationV2Types'
import type { ConversationMeta, PersistedConversation } from './types'
import type { AnyConversationEvent } from '@turboflux/contracts/conversationEvent'
import type { WorkActivity, WorkExecutionSnapshot, WorkRun, WorkRunStatus, WorkStep, WorkStepStatus } from '@turboflux/contracts/workExecutionTypes'

function canonicalEventId(event: AnyConversationEvent, suffix: string = event.type): string {
  return conversationV2IdFactory(event.conversationId).stable('canonical', event.eventId, suffix)
}

function runStatus(phase: Extract<AnyConversationEvent, { type: 'run.state_changed' }>['payload']['state']['phase']): ConversationV2RunStatus {
  if (phase === 'completed') return 'completed'
  if (phase === 'recoverable_error') return 'failed'
  if (phase === 'aborting') return 'cancelled'
  if (phase === 'awaiting_approval' || phase === 'awaiting_input' || phase === 'paused') return 'waiting'
  if (phase === 'idle') return 'pending'
  return 'running'
}

function completedStatus(outcome: Extract<AnyConversationEvent, { type: 'run.completed' }>['payload']['outcome']): Extract<ConversationV2RunStatus, 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted'> {
  return outcome
}

function itemStatus(interrupted?: boolean): ConversationV2ItemStatus {
  return interrupted ? 'interrupted' : 'completed'
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function terminalItemStatus(status: unknown): ConversationV2ItemStatus {
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'orphaned') return 'failed'
  if (status === 'cancelled' || status === 'stopped') return 'cancelled'
  if (status === 'interrupted') return 'interrupted'
  return 'running'
}

function terminalRunStatus(status: unknown): ConversationV2RunStatus {
  if (status === 'completed') return 'completed'
  if (status === 'partial') return 'partial'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'paused' || status === 'waiting') return 'waiting'
  if (status === 'pending') return 'pending'
  return 'running'
}

function flattenTaskSteps(value: unknown, normalizeId: (kind: string, value: string) => string): Array<{ id: string; title: string; status: string }> {
  if (!Array.isArray(value)) return []
  const result: Array<{ id: string; title: string; status: string }> = []
  const visit = (candidate: unknown): void => {
    const task = record(candidate)
    if (!task) return
    const id = stringValue(task.id)
    if (id) result.push({ id: normalizeId('step', id), title: stringValue(task.title) ?? 'Task', status: stringValue(task.status) ?? 'pending' })
    if (Array.isArray(task.children)) task.children.forEach(visit)
  }
  value.forEach(visit)
  return result
}

function semanticToolItem(
  conversationId: string,
  runId: string | undefined,
  turnId: string | undefined,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  status: ConversationV2ItemStatus,
  at: number,
  scopedId: (kind: string, value: string) => string,
  output?: string,
): ConversationItemV2 | null {
  const base = { schemaVersion: 1 as const, conversationId, runId, turnId, status, createdAt: at, updatedAt: at }
  if (toolName.startsWith('browser__')) {
    return {
      ...base,
      id: scopedId('browser-activity', toolCallId),
      kind: 'browser_activity',
      payload: { action: toolName.slice('browser__'.length), url: stringValue(args.url), title: stringValue(args.title), result: output },
    }
  }
  if (toolName.startsWith('computer__')) {
    return {
      ...base,
      id: scopedId('computer-activity', toolCallId),
      kind: 'computer_activity',
      payload: { action: toolName.slice('computer__'.length), application: stringValue(args.application) ?? stringValue(args.app) ?? stringValue(args.name), result: output },
    }
  }
  const command = stringValue(args.command) ?? stringValue(args.cmd)
  if (command && /(?:command|shell|terminal|exec|bash)/iu.test(toolName)) {
    return {
      ...base,
      id: scopedId('command-execution', toolCallId),
      kind: 'command_execution',
      payload: { command, exitCode: numberValue(args.exitCode), output, requiresReview: true },
    }
  }
  return null
}

function turnFromProjection(turn: ConversationTurnV2, items: ConversationItemV2[]): AgentTurn {
  const message = items.find(item => item.kind === (turn.role === 'assistant' ? 'assistant_message' : 'user_message'))
  const toolCalls = items.filter(item => item.kind === 'tool_call').map(item => {
    const payload = item.payload as Extract<ConversationItemV2, { kind: 'tool_call' }>['payload']
    return { id: payload.toolCallId, name: payload.toolName, arguments: structuredClone(payload.arguments) } satisfies ToolCall
  })
  const toolResults = items.filter(item => item.kind === 'tool_result').map(item => {
    const payload = item.payload as Extract<ConversationItemV2, { kind: 'tool_result' }>['payload']
    return { toolCallId: payload.toolCallId, name: payload.toolName, output: payload.output, isError: payload.isError, ...copyToolResultDetails(payload) } satisfies ToolResult
  })
  const content = message && (message.kind === 'assistant_message' || message.kind === 'user_message') ? message.payload.text : ''
  return {
    id: turn.id,
    role: turn.role === 'system' && toolResults.length > 0 ? 'tool_result' : turn.role,
    content,
    timestamp: turn.createdAt,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(toolResults.length ? { toolResults } : {}),
    ...((turn.status === 'interrupted' || turn.runId || turn.metadata) ? { metadata: {
      ...structuredClone(turn.metadata),
      ...(turn.status === 'interrupted' ? { interrupted: true } : {}),
      ...(turn.runId ? { workRunId: turn.runId } : {}),
    } } : {}),
  }
}

function restoredRunStatus(status: ConversationV2RunStatus): WorkRunStatus {
  return status === 'interrupted' ? 'partial' : status
}

function restoredStepStatus(status: string): WorkStepStatus {
  if (['pending', 'ready', 'running', 'waiting', 'blocked', 'retrying', 'completed', 'partial', 'failed', 'cancelled', 'skipped'].includes(status)) {
    return status as WorkStepStatus
  }
  return status === 'in_progress' ? 'running' : 'pending'
}

function workExecutionFromProjectionV2(projection: ConversationTranscriptProjectionV2): WorkExecutionSnapshot {
  const itemsByRun = new Map<string, ConversationItemV2[]>()
  for (const item of projection.items) {
    if (!item.runId) continue
    const items = itemsByRun.get(item.runId) ?? []
    items.push(item)
    itemsByRun.set(item.runId, items)
  }
  const runs = projection.runs.map(run => {
    const items = itemsByRun.get(run.id) ?? []
    const plan = [...items].reverse().find(item => item.kind === 'plan')
    const steps = plan?.kind === 'plan'
      ? Object.fromEntries(plan.payload.steps.map((step, index) => [step.id, {
          id: step.id,
          runId: run.id,
          title: step.title,
          description: '',
          status: restoredStepStatus(step.status),
          parentId: null,
          childIds: [],
          dependencyIds: [],
          order: index,
          progress: step.status === 'completed' ? 100 : null,
          progressMode: step.status === 'completed' ? 'structural' : 'indeterminate',
          activityIds: [],
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
        } satisfies WorkStep]))
      : {}
    const activities: Record<string, WorkActivity> = {}
    const resultsByCall = new Map<string, Extract<ConversationItemV2, { kind: 'tool_result' }>>()
    for (const item of items) {
      if (item.kind === 'tool_result' && !resultsByCall.has(item.payload.toolCallId)) resultsByCall.set(item.payload.toolCallId, item)
    }
    for (const call of items.filter((item): item is Extract<ConversationItemV2, { kind: 'tool_call' }> => item.kind === 'tool_call')) {
      const result = resultsByCall.get(call.payload.toolCallId)
      const kind = call.payload.toolName.startsWith('browser__') ? 'browser' : call.payload.toolName.startsWith('computer__') ? 'computer' : 'tool'
      const activity: WorkActivity = {
        id: `activity-${call.payload.toolCallId}`,
        runId: run.id,
        kind,
        title: call.payload.toolName,
        status: result ? (result.payload.isError ? 'failed' : 'completed') : call.status === 'running' ? 'cancelled' : call.status === 'failed' ? 'failed' : 'completed',
        attempt: 1,
        startedAt: call.createdAt,
        updatedAt: result?.updatedAt ?? call.updatedAt,
        completedAt: result?.updatedAt ?? (call.status === 'running' ? undefined : call.updatedAt),
        result: result && !result.payload.isError ? result.payload.output : undefined,
        error: result?.payload.isError ? result.payload.output : undefined,
        metadata: { arguments: structuredClone(call.payload.arguments) },
      }
      activities[activity.id] = activity
    }
    for (const item of items) {
      if (!['browser_activity', 'computer_activity', 'subagent', 'artifact'].includes(item.kind)) continue
      let kind: WorkActivity['kind']
      let title: string
      let result: string | undefined
      if (item.kind === 'browser_activity') {
        kind = 'browser'
        title = item.payload.title ?? item.payload.action
        result = item.payload.result
      } else if (item.kind === 'computer_activity') {
        kind = 'computer'
        title = item.payload.application ?? item.payload.action
        result = item.payload.result
      } else if (item.kind === 'subagent') {
        kind = 'subagent'
        title = item.payload.task
        result = item.payload.result
      } else if (item.kind === 'artifact') {
        kind = 'artifact'
        title = item.payload.name
      } else continue
      const activity: WorkActivity = {
        id: `activity-${item.id}`,
        runId: run.id,
        kind,
        title,
        status: item.status === 'failed' ? 'failed' : item.status === 'cancelled' || item.status === 'interrupted' ? 'cancelled' : item.status === 'running' ? 'cancelled' : 'completed',
        attempt: 1,
        startedAt: item.createdAt,
        updatedAt: item.updatedAt,
        completedAt: item.status === 'running' ? undefined : item.updatedAt,
        result,
        error: item.status === 'failed' ? result : undefined,
      }
      activities[activity.id] = activity
    }
    const status = restoredRunStatus(run.status)
    return {
      id: run.id,
      conversationId: run.conversationId,
      objective: run.objective,
      presentation: run.responseMode ? run.responseMode === 'task' ? 'work' : 'conversation' : Object.keys(steps).length || Object.keys(activities).length ? 'work' : 'conversation',
      responseMode: run.responseMode,
      executionSegments: run.executionSegments?.map(segment => ({ ...segment })),
      status,
      phase: status,
      rootStepIds: Object.keys(steps),
      steps,
      activities,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
      outcome: status === 'failed' ? undefined : run.outcome,
      error: status === 'failed' ? run.outcome : undefined,
      recoveredFromPersistence: true,
    } satisfies WorkRun
  })
  const currentRun = [...runs].reverse().find(run => ['pending', 'running', 'waiting', 'paused'].includes(run.status))
  return { schemaVersion: 1, currentRunId: currentRun?.id ?? null, runs }
}

interface RestoredCanonicalCandidate {
  order: number
  at: number
  key: string
  runId?: string
  turnId?: string
  itemId?: string
  type: AnyConversationEvent['type']
  payload: unknown
}

function canonicalEventsFromProjectionV2(projection: ConversationTranscriptProjectionV2, turnsById: Map<string, AgentTurn>): AnyConversationEvent[] {
  const conversationId = projection.conversation?.id
  if (!conversationId) return []
  const fallbackOrder = projection.throughSeq + 1
  type Coordinates = { runId?: string; turnId?: string; itemId?: string }
  const orderKey = (type: string, coordinates: Coordinates): string => JSON.stringify([type, coordinates.runId || null, coordinates.turnId || null, coordinates.itemId || null])
  const orders = new Map<string, { first: number; last: number }>()
  const remember = (type: string, coordinates: Coordinates, seq: number): void => {
    const key = orderKey(type, coordinates)
    const existing = orders.get(key)
    if (existing) existing.last = seq
    else orders.set(key, { first: seq, last: seq })
  }
  // Preserve first/last occurrence order, including approval events with optional coordinates.
  for (const entry of projection.timeline) {
    if (entry.type === 'run.started' || entry.type === 'run.completed' || entry.type === 'run.recovered') {
      remember(entry.type, { runId: entry.runId }, entry.seq)
    } else if (entry.type === 'turn.started' || entry.type === 'turn.completed') {
      remember(entry.type, { turnId: entry.turnId }, entry.seq)
    } else if (entry.type === 'model.request_updated') {
      remember(entry.type, { itemId: entry.itemId }, entry.seq)
    } else if (entry.type === 'item.created') {
      remember(entry.type, { itemId: entry.itemId }, entry.seq)
    } else if (entry.type === 'approval.requested' || entry.type === 'approval.resolved' || entry.type === 'approval.cancelled') {
      remember(entry.type, {}, entry.seq)
      if (entry.runId) remember(entry.type, { runId: entry.runId }, entry.seq)
      if (entry.turnId) remember(entry.type, { turnId: entry.turnId }, entry.seq)
      if (entry.runId && entry.turnId) remember(entry.type, { runId: entry.runId, turnId: entry.turnId }, entry.seq)
    }
  }
  const timelineOrder = (
    type: string,
    coordinates: Coordinates = {},
    useLast = false,
  ): number => {
    const match = orders.get(orderKey(type, coordinates))
    return (useLast ? match?.last : match?.first) ?? fallbackOrder
  }
  const candidates: RestoredCanonicalCandidate[] = []
  const add = (candidate: Omit<RestoredCanonicalCandidate, 'order'> & { order?: number }) => {
    candidates.push({ ...candidate, order: candidate.order ?? fallbackOrder })
  }

  for (const run of projection.runs) {
    add({
      order: timelineOrder('run.started', { runId: run.id }),
      at: run.startedAt,
      key: `run:${run.id}:started`,
      runId: run.id,
      type: 'run.started',
      payload: { objective: run.objective },
    })
    if (['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(run.status)) {
      add({
        order: timelineOrder(run.status === 'interrupted' ? 'run.recovered' : 'run.completed', { runId: run.id }, true),
        at: run.completedAt ?? run.updatedAt,
        key: `run:${run.id}:completed`,
        runId: run.id,
        type: 'run.completed',
        payload: { outcome: run.status, error: run.status === 'failed' ? run.outcome : undefined },
      })
    }
  }

  for (const request of projection.modelRequests ?? []) {
    const restored = request.status === 'running' ? { ...request, status: 'interrupted' as const, usageFinal: false } : request
    add({ order: timelineOrder('model.request_updated', { itemId: conversationV2IdFactory(conversationId).normalize('request', request.id) }, true), at: request.updatedAt, key: `model-request:${request.id}`, runId: request.runId,
      itemId: request.id, type: 'model.request_updated', payload: { request: structuredClone(restored) } })
    if (request.usage.source === 'provider') add({
      order: timelineOrder('model.request_updated', { itemId: conversationV2IdFactory(conversationId).normalize('request', request.id) }, true), at: request.updatedAt, key: `model-usage:${request.id}`, runId: request.runId, itemId: request.id,
      type: 'usage.updated', payload: { usage: { ...request.usage }, requestId: request.requestId, attemptId: request.id },
    })
  }

  for (const turn of projection.turns) {
    const restoredTurn = structuredClone(turnsById.get(turn.id)!)
    add({
      order: timelineOrder('turn.started', { turnId: turn.id }),
      at: turn.createdAt,
      key: `turn:${turn.id}:started`,
      runId: turn.runId,
      turnId: turn.id,
      itemId: turn.id,
      type: 'turn.started',
      payload: { turn: restoredTurn },
    })
    if (turn.status !== 'started') {
      add({
        order: timelineOrder('turn.completed', { turnId: turn.id }, true),
        at: turn.completedAt ?? turn.createdAt,
        key: `turn:${turn.id}:completed`,
        runId: turn.runId,
        turnId: turn.id,
        itemId: turn.id,
        type: 'turn.completed',
        payload: { turn: restoredTurn },
      })
    }
  }

  for (const item of projection.items) {
    const common = {
      order: timelineOrder('item.created', { itemId: item.id }),
      at: item.createdAt,
      runId: item.runId,
      turnId: item.turnId,
      itemId: item.id,
    }
    if (item.kind === 'reasoning' && item.payload.text) {
      add({ ...common, key: `item:${item.id}:reasoning`, type: 'stream.committed', payload: { channel: 'thinking', text: item.payload.text } })
    } else if (item.kind === 'assistant_message' && item.payload.text) {
      add({ ...common, key: `item:${item.id}:answer`, type: 'stream.committed', payload: { channel: 'answer', text: item.payload.text } })
    } else if (item.kind === 'tool_call') {
      add({
        ...common,
        key: `item:${item.id}:tool-call`,
        type: 'tool.proposed',
        payload: { toolCall: { id: item.payload.toolCallId, name: item.payload.toolName, arguments: structuredClone(item.payload.arguments) } },
      })
    } else if (item.kind === 'tool_result') {
      add({
        ...common,
        key: `item:${item.id}:tool-result`,
        type: 'tool.completed',
        payload: { toolResult: { toolCallId: item.payload.toolCallId, name: item.payload.toolName, output: item.payload.output, isError: item.payload.isError, ...copyToolResultDetails(item.payload) } },
      })
    } else if (item.kind === 'approval') {
      add({
        ...common,
        order: timelineOrder('approval.requested', { runId: item.runId, turnId: item.turnId }),
        key: `item:${item.id}:approval-requested`,
        type: 'approval.requested',
        payload: { requestId: item.payload.requestId, kind: item.payload.requestKind, question: item.payload.question },
      })
      if (item.status !== 'pending' && item.status !== 'running') {
        add({
          ...common,
          order: timelineOrder(item.status === 'cancelled' ? 'approval.cancelled' : 'approval.resolved', { runId: item.runId, turnId: item.turnId }, true),
          at: item.updatedAt,
          key: `item:${item.id}:approval-settled`,
          type: item.status === 'cancelled' ? 'approval.cancelled' : 'approval.resolved',
          payload: item.status === 'cancelled'
            ? { requestId: item.payload.requestId, reason: 'cancelled' }
            : { requestId: item.payload.requestId, decision: item.payload.decision },
        })
      }
    }
  }

  return candidates
    .sort((left, right) => left.order - right.order || left.at - right.at || left.key.localeCompare(right.key))
    .map((candidate, index) => ({
      schemaVersion: 1,
      eventId: `${conversationId}:v2-restored:${candidate.key}`,
      conversationId,
      threadId: conversationId,
      runId: candidate.runId,
      turnId: candidate.turnId,
      itemId: candidate.itemId,
      seq: index + 1,
      at: candidate.at,
      source: 'migration',
      provenance: 'restored',
      type: candidate.type,
      payload: candidate.payload,
    } as AnyConversationEvent))
}

export function persistedConversationFromProjectionV2(
  projection: ConversationTranscriptProjectionV2,
  workspacePath: string,
): PersistedConversation | null {
  const conversation = projection.conversation
  if (!conversation || conversation.status === 'archived') return null
  const itemsByTurn = new Map<string, ConversationItemV2[]>()
  for (const item of projection.items) {
    if (!item.turnId) continue
    const items = itemsByTurn.get(item.turnId) ?? []
    items.push(item)
    itemsByTurn.set(item.turnId, items)
  }
  const turns = projection.turns.map(turn => turnFromProjection(turn, itemsByTurn.get(turn.id) ?? []))
  return {
    id: conversation.id,
    title: conversation.title,
    titleSource: conversation.titleSource,
    workspacePath,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    mode: conversation.mode,
    model: conversation.model,
    provider: conversation.provider,
    turnCount: turns.length,
    turns,
    ...(projection.modelRequests ? { modelRequests: projection.modelRequests.map(record => structuredClone(record.status === 'running' ? { ...record, status: 'interrupted' as const, usageFinal: false } : record)) } : {}),
    canonicalEvents: canonicalEventsFromProjectionV2(projection, new Map(turns.map(turn => [turn.id, turn]))),
    workExecution: workExecutionFromProjectionV2(projection),
    recovery: {
      interrupted: projection.runs.some(run => run.status === 'interrupted'),
      truncatedJournal: false,
      unresolvedToolCalls: 0,
    },
  }
}

export class ConversationRuntimeRepositoryV2 {
  private readonly repository: ConversationRepositoryV2

  constructor(
    root: string,
    private readonly profileId: string,
    private readonly workspaceId: string,
    private readonly workspacePath: string,
    private readonly now: () => number = Date.now,
  ) {
    this.repository = new ConversationRepositoryV2(root, now)
  }

  persist(conversation: PersistedConversation): void {
    const ids = conversationV2IdFactory(conversation.id)
    const eventId = ids.stable
    const previousProjection = this.repository.projection(conversation.id)
    const existing = previousProjection.conversation
    const plan = planConversationV2Migration(this.profileId, conversation, {
      workspaceId: this.workspaceId,
      source: 'runtime',
      provenance: 'live',
    })
    this.repository.append(plan.events)
    const updates = plan.events.flatMap(event => {
      if (event.type !== 'item.created') return []
      const previous = previousProjection.items.find(item => item.id === event.payload.item.id)
      if (!previous || (previous.status === event.payload.item.status && JSON.stringify(previous.payload) === JSON.stringify(event.payload.item.payload))) return []
      return [{
        eventId: eventId('item-update', conversation.id, event.payload.item.id, event.payload.item.status, JSON.stringify(event.payload.item.payload)),
        profileId: this.profileId,
        conversationId: conversation.id,
        workspaceId: this.workspaceId,
        runId: event.runId,
        turnId: event.turnId,
        itemId: event.payload.item.id,
        source: 'runtime' as const,
        provenance: 'live' as const,
        type: 'item.updated' as const,
        at: conversation.updatedAt,
        payload: { status: event.payload.item.status, updatedAt: conversation.updatedAt, payload: event.payload.item.payload },
      }]
    })
    if (updates.length) this.repository.append(updates)
    if (existing && (existing.title !== conversation.title || existing.titleSource !== (conversation.titleSource ?? 'generated'))) {
      this.repository.append([{
        eventId: eventId('rename', conversation.id, conversation.title, conversation.updatedAt),
        profileId: this.profileId,
        conversationId: conversation.id,
        workspaceId: this.workspaceId,
        source: 'user',
        provenance: 'live',
        type: 'conversation.renamed',
        at: conversation.updatedAt,
        payload: { title: conversation.title, titleSource: conversation.titleSource ?? 'generated' },
      }])
    }
  }

  synchronizeMetadata(conversation: PersistedConversation): void {
    const current = this.repository.projection(conversation.id).conversation
    if (!current) {
      this.persist(conversation)
      return
    }
    const ids = conversationV2IdFactory(conversation.id)
    const events: AnyAppendConversationEventV2Input[] = []
    if (current.title !== conversation.title || current.titleSource !== (conversation.titleSource ?? 'generated')) {
      events.push({
        eventId: ids.stable('rename', conversation.id, conversation.title, conversation.updatedAt),
        profileId: this.profileId,
        conversationId: conversation.id,
        workspaceId: this.workspaceId,
        source: 'runtime',
        provenance: 'live',
        type: 'conversation.renamed',
        at: conversation.updatedAt,
        payload: { title: conversation.title, titleSource: conversation.titleSource ?? 'generated' },
      })
    }
    if (current.mode !== conversation.mode || current.provider !== conversation.provider || current.model !== conversation.model) {
      events.push({
        eventId: ids.stable('configuration', conversation.id, conversation.mode, conversation.provider, conversation.model),
        profileId: this.profileId,
        conversationId: conversation.id,
        workspaceId: this.workspaceId,
        source: 'runtime',
        provenance: 'live',
        type: 'conversation.configuration_changed',
        at: conversation.updatedAt,
        payload: { mode: conversation.mode, provider: conversation.provider, model: conversation.model },
      })
    }
    if (events.length) this.repository.append(events)
  }

  rewrite(conversation: PersistedConversation): void {
    const current = this.repository.projection(conversation.id).conversation
    if (!current) {
      this.persist(conversation)
      return
    }
    const ids = conversationV2IdFactory(conversation.id)
    const retainedTurnIds = conversation.turns.map(turn => ids.normalize('turn', turn.id))
    this.repository.append([{
      eventId: ids.stable('rewrite', conversation.id, conversation.updatedAt, ...retainedTurnIds),
      profileId: this.profileId,
      conversationId: conversation.id,
      workspaceId: this.workspaceId,
      source: 'runtime',
      provenance: 'live',
      type: 'conversation.rewritten',
      at: conversation.updatedAt,
      payload: { retainedTurnIds, rewrittenAt: conversation.updatedAt },
    }])
    this.persist(conversation)
    this.synchronizeMetadata(conversation)
  }

  appendCanonical(event: AnyConversationEvent, conversation: PersistedConversation): void {
    const ids = conversationV2IdFactory(conversation.id)
    const portableId = ids.normalize
    const scopedId = ids.scoped
    const eventId = ids.stable
    let projection = this.repository.projection(conversation.id)
    if (!projection.conversation) {
      this.repository.append([{
        eventId: eventId('canonical', conversation.id, 'created'),
        profileId: this.profileId,
        conversationId: conversation.id,
        workspaceId: this.workspaceId,
        source: 'runtime',
        provenance: event.provenance,
        type: 'conversation.created',
        at: conversation.createdAt,
        payload: {
          record: {
            schemaVersion: 2,
            id: conversation.id,
            profileId: this.profileId,
            workspaceId: this.workspaceId,
            title: conversation.title,
            titleSource: conversation.titleSource ?? 'generated',
            mode: conversation.mode,
            provider: conversation.provider,
            model: conversation.model,
            status: 'active',
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
            lastEventSeq: 0,
            turnCount: 0,
            runCount: 0,
            tags: [],
          },
        },
      }])
      projection = this.repository.projection(conversation.id)
    }
    const common = {
      profileId: this.profileId,
      conversationId: conversation.id,
      workspaceId: this.workspaceId,
      runId: event.runId ? portableId('run', event.runId) : undefined,
      turnId: event.turnId ? portableId('turn', event.turnId) : undefined,
      itemId: event.itemId ? portableId('item', event.itemId) : undefined,
      source: event.source === 'workbench' ? 'flow' as const : event.source,
      provenance: event.provenance,
      at: event.at,
    }
    const inputs: AnyAppendConversationEventV2Input[] = []
    const upsertItem = (item: ConversationItemV2, suffix: string): void => {
      const previous = projection.items.find(candidate => candidate.id === item.id)
      if (previous) {
        inputs.push({
          ...common,
          eventId: canonicalEventId(event, `${suffix}-updated`),
          runId: item.runId,
          turnId: item.turnId,
          itemId: item.id,
          type: 'item.updated',
          payload: { status: item.status, updatedAt: item.updatedAt, payload: item.payload },
        })
      } else {
        inputs.push({
          ...common,
          eventId: canonicalEventId(event, `${suffix}-created`),
          runId: item.runId,
          turnId: item.turnId,
          itemId: item.id,
          type: 'item.created',
          payload: { item },
        })
      }
    }
    const projectExecution = (snapshot: Record<string, unknown> | null | undefined): void => {
      const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : []
      for (const candidate of runs) {
        const workRun = record(candidate)
        const sourceRunId = stringValue(workRun?.id)
        if (!workRun || !sourceRunId) continue
        const runId = portableId('run', sourceRunId)
        if (event.type === 'execution.updated' && event.runId && sourceRunId !== event.runId
          && projection.runs.some(run => run.id === runId)) continue
        const status = terminalRunStatus(workRun.status)
        const timing = {
          responseMode: workRun.responseMode as WorkRun['responseMode'],
          executionSegments: workRun.executionSegments as WorkRun['executionSegments'],
        }
        if (!projection.runs.some(run => run.id === runId)) {
          const run: ConversationRunV2 = {
            ...timing,
            id: runId,
            conversationId: conversation.id,
            workspaceId: this.workspaceId,
            objective: stringValue(workRun.objective) ?? conversation.title,
            status,
            provider: conversation.provider,
            model: conversation.model,
            startedAt: numberValue(workRun.startedAt) ?? event.at,
            updatedAt: numberValue(workRun.updatedAt) ?? event.at,
            completedAt: numberValue(workRun.completedAt),
            outcome: stringValue(workRun.outcome) ?? stringValue(workRun.error),
          }
          inputs.push({ ...common, eventId: canonicalEventId(event, `work-run-${runId}-started`), runId, type: 'run.started', payload: { run } })
        } else if (['completed', 'partial', 'failed', 'cancelled'].includes(status)) {
          inputs.push({ ...common, eventId: canonicalEventId(event, `work-run-${runId}-completed`), runId, type: 'run.completed', payload: { ...timing, status: status as Extract<ConversationV2RunStatus, 'completed' | 'partial' | 'failed' | 'cancelled'>, completedAt: numberValue(workRun.completedAt) ?? event.at, outcome: stringValue(workRun.outcome) ?? stringValue(workRun.error) } })
        } else {
          inputs.push({ ...common, eventId: canonicalEventId(event, `work-run-${runId}-updated`), runId, type: 'run.state_changed', payload: { ...timing, status, updatedAt: numberValue(workRun.updatedAt) ?? event.at, outcome: stringValue(workRun.outcome) ?? stringValue(workRun.error) } })
        }
        const steps = record(workRun.steps)
        const plan: ConversationItemV2 = {
          schemaVersion: 1,
          id: scopedId('plan', runId),
          conversationId: conversation.id,
          runId,
          kind: 'plan',
          status: ['completed', 'partial'].includes(status) ? 'completed' : status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'running',
          createdAt: numberValue(workRun.startedAt) ?? event.at,
          updatedAt: numberValue(workRun.updatedAt) ?? event.at,
          payload: { steps: Object.values(steps ?? {}).map(value => record(value)).filter((value): value is Record<string, unknown> => Boolean(value)).map(step => ({ id: portableId('step', String(step.id)), title: String(step.title), status: String(step.status) })) },
        }
        upsertItem(plan, `work-plan-${runId}`)
        const activities = record(workRun.activities)
        for (const value of Object.values(activities ?? {})) {
          const activity = record(value)
          const sourceActivityId = stringValue(activity?.id)
          const kind = stringValue(activity?.kind)
          if (!activity || !sourceActivityId || !kind) continue
          const activityId = portableId('activity', sourceActivityId)
          const activityStatus = terminalItemStatus(activity.status)
          const activityBase = {
            schemaVersion: 1 as const,
            id: scopedId('activity', activityId),
            conversationId: conversation.id,
            runId,
            status: activityStatus,
            createdAt: numberValue(activity.startedAt) ?? event.at,
            updatedAt: numberValue(activity.updatedAt) ?? event.at,
          }
          let item: ConversationItemV2
          if (kind === 'browser') item = { ...activityBase, kind: 'browser_activity', payload: { action: stringValue(activity.title) ?? 'browser', result: stringValue(activity.result) ?? stringValue(activity.error) } }
          else if (kind === 'computer') item = { ...activityBase, kind: 'computer_activity', payload: { action: stringValue(activity.title) ?? 'computer', result: stringValue(activity.result) ?? stringValue(activity.error) } }
          else if (kind === 'subagent') item = { ...activityBase, kind: 'subagent', payload: { agentId: activityId, task: stringValue(activity.title) ?? 'Subagent task', result: stringValue(activity.result) ?? stringValue(activity.error) } }
          else if (kind === 'artifact') {
            const artifactId = portableId('artifact', stringValue(record(activity.metadata)?.artifactId) ?? activityId)
            const path = portablePathRefsForToolValue(this.workspacePath, this.workspaceId, { path: activity.path })[0]
            item = { ...activityBase, kind: 'artifact', payload: { artifactId, name: stringValue(activity.title) ?? artifactId, path } }
            inputs.push({ ...common, eventId: canonicalEventId(event, `work-artifact-${artifactId}-registered`), runId, itemId: item.id, type: 'artifact.registered', payload: { artifactId, itemId: item.id } })
          } else item = { ...activityBase, kind: 'notification', payload: { level: activityStatus === 'failed' ? 'error' : activityStatus === 'completed' ? 'success' : 'info', message: [stringValue(activity.title), stringValue(activity.detail), stringValue(activity.result) ?? stringValue(activity.error)].filter(Boolean).join(' · ') } }
          upsertItem(item, `work-activity-${activityId}`)
        }
      }
    }
    switch (event.type) {
      case 'run.started': {
        const runId = common.runId
        if (!runId) break
        const run: ConversationRunV2 = {
          id: runId,
          conversationId: conversation.id,
          workspaceId: this.workspaceId,
          objective: event.payload.objective ?? conversation.title,
          status: 'running',
          provider: conversation.provider,
          model: conversation.model,
          startedAt: event.at,
          updatedAt: event.at,
        }
        inputs.push({ ...common, eventId: canonicalEventId(event), type: 'run.started', payload: { run } })
        break
      }
      case 'run.state_changed':
        if (common.runId) inputs.push({ ...common, eventId: canonicalEventId(event), type: 'run.state_changed', payload: { status: runStatus(event.payload.state.phase), updatedAt: event.payload.state.updatedAt, outcome: event.payload.state.detail } })
        break
      case 'run.completed':
        if (event.payload.run) {
          projectExecution({ runs: [event.payload.run] })
          break
        }
        if (common.runId) inputs.push({ ...common, eventId: canonicalEventId(event), type: 'run.completed', payload: {
          status: completedStatus(event.payload.outcome),
          completedAt: event.at,
          outcome: event.payload.error,
        } })
        break
      case 'turn.started': {
        const turn = event.payload.turn
        const turnId = portableId('turn', turn.id)
        inputs.push({ ...common, eventId: canonicalEventId(event), turnId, type: 'turn.started', payload: { turn: { id: turnId, conversationId: conversation.id, runId: common.runId, role: turn.role === 'tool_result' ? 'system' : turn.role, status: 'started', createdAt: turn.timestamp } } })
        if (turn.role === 'user') {
          const item: ConversationItemV2 = { schemaVersion: 1, id: scopedId('message', turn.id), conversationId: conversation.id, runId: common.runId, turnId, kind: 'user_message', status: itemStatus(turn.metadata?.interrupted), createdAt: turn.timestamp, updatedAt: turn.timestamp, payload: { text: turn.content, attachmentIds: turn.metadata?.attachments?.map(attachment => portableId('attachment', attachment.id)) ?? [] } }
          inputs.push({ ...common, eventId: canonicalEventId(event, 'message'), turnId, itemId: item.id, type: 'item.created', payload: { item } })
        }
        break
      }
      case 'model.request_updated': {
        const request = structuredClone(event.payload.request)
        request.runId = common.runId
        inputs.push({ ...common, itemId: ids.normalize('request', request.id), eventId: canonicalEventId(event), type: 'model.request_updated', payload: { request } })
        break
      }
      case 'usage.updated': {
        // Current engines persist attempt snapshots separately. Legacy events
        // still have a stable request identity when a step/run id is available.
        if (event.payload.attemptId || !isTokenUsage(event.payload.usage)) break
        const id = ids.stable('legacy-model-request', event.runId ?? conversation.id, event.stepId ?? 'declaration')
        const previous = projection.modelRequests?.find(record => record.id === id)
        const request: ModelRequestRecord = {
          id, requestId: id, runId: common.runId, model: conversation.model, provider: conversation.provider,
          purpose: 'legacy', status: 'completed', startedAt: previous?.startedAt ?? event.at, updatedAt: event.at,
          usage: { ...event.payload.usage }, usageFinal: event.payload.usage.source === 'provider',
        }
        inputs.push({ ...common, eventId: canonicalEventId(event), type: 'model.request_updated', payload: { request } })
        break
      }
      case 'turn.completed': {
        const turn = event.payload.turn
        const turnId = portableId('turn', turn.id)
        if (!projection.turns.some(candidate => candidate.id === turnId)) {
          inputs.push({ ...common, eventId: canonicalEventId(event, 'started'), turnId, type: 'turn.started', payload: { turn: { id: turnId, conversationId: conversation.id, runId: common.runId, role: turn.role === 'tool_result' ? 'system' : turn.role, status: 'started', createdAt: turn.timestamp } } })
        }
        if (turn.role === 'assistant' && turn.content) {
          const item: ConversationItemV2 = { schemaVersion: 1, id: scopedId('message', turn.id), conversationId: conversation.id, runId: common.runId, turnId, kind: 'assistant_message', status: itemStatus(turn.metadata?.interrupted), createdAt: turn.timestamp, updatedAt: turn.timestamp, payload: { text: turn.content } }
          inputs.push({ ...common, eventId: canonicalEventId(event, 'message'), turnId, itemId: item.id, type: 'item.created', payload: { item } })
        }
        const metadata = turn.metadata ? Object.fromEntries(Object.entries(turn.metadata)
          .filter(([key]) => ['tokens', 'model', 'duration', 'modelRequestId', 'modelAttemptId', 'internal', 'internalKind'].includes(key))) : undefined
        inputs.push({ ...common, eventId: canonicalEventId(event), turnId, type: 'turn.completed', payload: {
          completedAt: event.at, interrupted: turn.metadata?.interrupted, ...(metadata ? { metadata } : {}),
        } })
        break
      }
      case 'stream.committed':
        if (event.payload.channel === 'thinking' && event.payload.text) {
          const id = event.itemId ? scopedId('reasoning', event.itemId) : canonicalEventId(event, 'reasoning')
          const item: ConversationItemV2 = { schemaVersion: 1, id, conversationId: conversation.id, runId: common.runId, turnId: common.turnId, kind: 'reasoning', status: 'completed', createdAt: event.at, updatedAt: event.at, payload: { text: event.payload.text, omitted: false } }
          inputs.push({ ...common, eventId: canonicalEventId(event), itemId: id, type: 'item.created', payload: { item } })
        }
        break
      case 'tool.proposed': {
        const tool = event.payload.toolCall
        const toolCallId = portableId('tool', tool.id)
        const id = scopedId('tool-call', tool.id)
        const item: ConversationItemV2 = { schemaVersion: 1, id, conversationId: conversation.id, runId: common.runId, turnId: common.turnId, kind: 'tool_call', status: 'running', createdAt: event.at, updatedAt: event.at, payload: { toolCallId, toolName: tool.name, arguments: structuredClone(tool.arguments), pathRefs: portablePathRefsForToolValue(this.workspacePath, this.workspaceId, tool.arguments), requiresReview: true } }
        inputs.push({ ...common, eventId: canonicalEventId(event), itemId: id, type: 'item.created', payload: { item } })
        const semantic = semanticToolItem(conversation.id, common.runId, common.turnId, toolCallId, tool.name, tool.arguments, 'running', event.at, scopedId)
        if (semantic) upsertItem(semantic, 'semantic-tool')
        break
      }
      case 'tool.completed': {
        const result = event.payload.toolResult
        const toolCallId = portableId('tool', result.toolCallId)
        const id = scopedId('tool-result', result.toolCallId)
        const item: ConversationItemV2 = { schemaVersion: 1, id, conversationId: conversation.id, runId: common.runId, turnId: common.turnId, kind: 'tool_result', status: result.isError ? 'failed' : 'completed', createdAt: event.at, updatedAt: event.at, payload: { toolCallId, toolName: result.name, output: result.output, isError: result.isError, pathRefs: portablePathRefsForToolValue(this.workspacePath, this.workspaceId, result), ...copyToolResultDetails(result) } }
        inputs.push({ ...common, eventId: canonicalEventId(event), itemId: id, type: 'item.created', payload: { item } })
        const call = projection.items.find(candidate => candidate.kind === 'tool_call' && candidate.payload.toolCallId === toolCallId)
        const args = call?.kind === 'tool_call' ? call.payload.arguments : {}
        const semantic = semanticToolItem(conversation.id, common.runId, common.turnId, toolCallId, result.name, args, result.isError ? 'failed' : 'completed', event.at, scopedId, result.output)
        if (semantic) upsertItem(semantic, 'semantic-tool')
        if (result.changeSummary) {
          const path = portablePathRefsForToolValue(this.workspacePath, this.workspaceId, { path: result.changeSummary.path })[0]
          if (path) {
            const change: ConversationItemV2 = {
              schemaVersion: 1,
              id: scopedId('file-change', result.toolCallId),
              conversationId: conversation.id,
              runId: common.runId,
              turnId: common.turnId,
              kind: 'file_change',
              status: result.isError ? 'failed' : 'completed',
              createdAt: event.at,
              updatedAt: event.at,
              payload: { path, change: result.changeSummary.operation === 'write' ? 'created' : result.changeSummary.operation === 'edit' ? 'modified' : 'deleted' },
            }
            upsertItem(change, 'file-change')
          }
        }
        for (const attachment of result.attachments ?? []) {
          const artifactId = portableId('artifact', attachment.id)
          const artifactItemId = scopedId('artifact', attachment.id)
          const path = portablePathRefsForToolValue(this.workspacePath, this.workspaceId, { path: attachment.path })[0]
          const artifact: ConversationItemV2 = {
            schemaVersion: 1,
            id: artifactItemId,
            conversationId: conversation.id,
            runId: common.runId,
            turnId: common.turnId,
            kind: 'artifact',
            status: 'completed',
            createdAt: event.at,
            updatedAt: event.at,
            payload: { artifactId, name: attachment.filename, mime: attachment.mime, path, size: attachment.size },
          }
          upsertItem(artifact, `artifact-${artifactId}`)
          inputs.push({ ...common, eventId: canonicalEventId(event, `artifact-${artifactId}-registered`), itemId: artifactItemId, type: 'artifact.registered', payload: { artifactId, itemId: artifactItemId } })
        }
        break
      }
      case 'approval.requested':
        inputs.push({ ...common, eventId: canonicalEventId(event), type: 'approval.requested', payload: { requestId: portableId('approval', event.payload.requestId), requestKind: event.payload.kind, question: event.payload.question } })
        break
      case 'approval.resolved':
        inputs.push({ ...common, eventId: canonicalEventId(event), type: 'approval.resolved', payload: { requestId: portableId('approval', event.payload.requestId), decision: event.payload.decision } })
        break
      case 'approval.cancelled':
        inputs.push({ ...common, eventId: canonicalEventId(event), type: 'approval.cancelled', payload: { requestId: portableId('approval', event.payload.requestId), reason: event.payload.reason ?? 'cancelled' } })
        break
      case 'input.state_changed': {
        const inputId = portableId('input', event.payload.inputId)
        if (event.payload.state === 'accepted') inputs.push({ ...common, eventId: canonicalEventId(event), type: 'input.queued', payload: { inputId, text: event.payload.text ?? '' } })
        else if (event.payload.state === 'committed') inputs.push({ ...common, eventId: canonicalEventId(event), type: 'input.committed', payload: { inputId } })
        else inputs.push({ ...common, eventId: canonicalEventId(event), type: 'input.removed', payload: { inputId, reason: event.payload.reason ?? 'rejected' } })
        break
      }
      case 'context.compaction': {
        const state = event.payload.state
        const sourceItemIds = [state.startMessageId, state.endMessageId].filter((id): id is string => Boolean(id))
        const compactionId = portableId('compaction', state.id)
        if (state.phase === 'started') inputs.push({ ...common, eventId: canonicalEventId(event), type: 'context.compaction_started', payload: { compactionId, sourceItemIds } })
        else if (state.phase === 'completed') {
          const segment = conversation.contextSegments?.find(candidate => (
            (!state.startMessageId || candidate.startMessageId === state.startMessageId)
            && (!state.endMessageId || candidate.endMessageId === state.endMessageId)
          ))
          inputs.push({ ...common, eventId: canonicalEventId(event), type: 'context.compaction_committed', payload: { compactionId, itemId: scopedId('compaction', state.id), summary: segment?.summary, model: segment?.isModelGenerated ? conversation.model : undefined } })
        }
        else if (state.phase === 'failed' || state.phase === 'interrupted') inputs.push({ ...common, eventId: canonicalEventId(event), type: 'context.compaction_failed', payload: { compactionId, error: state.error ?? state.detail ?? state.phase } })
        break
      }
      case 'notification.raised': {
        const id = event.itemId ? portableId('notification', event.itemId) : canonicalEventId(event, 'notification')
        const item: ConversationItemV2 = { schemaVersion: 1, id, conversationId: conversation.id, runId: common.runId, kind: 'notification', status: 'completed', createdAt: event.at, updatedAt: event.at, payload: event.payload }
        inputs.push({ ...common, eventId: canonicalEventId(event), itemId: id, type: 'item.created', payload: { item } })
        break
      }
      case 'execution.updated':
      case 'runtime.event': {
        const kind = event.type === 'execution.updated' ? 'work:execution' : event.payload.kind
        const payload = event.type === 'execution.updated'
          ? { snapshot: event.payload.snapshot } as Record<string, unknown>
          : event.payload.payload as Record<string, unknown> | undefined
        if (kind === 'subagent:start' && payload) {
          const agentId = portableId('agent', String(payload.agentId))
          const id = scopedId('subagent', String(payload.agentId))
          const item: ConversationItemV2 = { schemaVersion: 1, id, conversationId: conversation.id, runId: common.runId, kind: 'subagent', status: 'running', createdAt: event.at, updatedAt: event.at, payload: { agentId, task: String(payload.objective ?? payload.label ?? 'Subagent task') } }
          inputs.push({ ...common, eventId: canonicalEventId(event), itemId: id, type: 'item.created', payload: { item } })
        } else if (kind === 'subagent:end' && payload) {
          const id = scopedId('subagent', String(payload.agentId))
          const previous = projection.items.find(candidate => candidate.id === id)
          if (previous?.kind === 'subagent') {
            const updated: ConversationItemV2 = {
              ...previous,
              status: payload.ok === true ? 'completed' : 'failed',
              updatedAt: event.at,
              payload: { ...previous.payload, result: payload.ok === true ? `Completed in ${numberValue(payload.elapsedMs) ?? 0} ms` : 'Subagent failed' },
            }
            upsertItem(updated, 'subagent-end')
          } else inputs.push({ ...common, eventId: canonicalEventId(event), itemId: id, type: 'item.completed', payload: { status: payload.ok === true ? 'completed' : 'failed', completedAt: event.at } })
        } else if (kind === 'subagent:progress' && payload) {
          const id = scopedId('subagent', String(payload.agentId))
          const progress = record(payload.event)
          const previous = projection.items.find(candidate => candidate.id === id)
          if (previous?.kind === 'subagent' && progress) {
            const detail = stringValue(progress.summary) ?? stringValue(progress.text) ?? stringValue(progress.type)
            if (detail) upsertItem({ ...previous, updatedAt: event.at, payload: { ...previous.payload, result: detail } }, 'subagent-progress')
          }
        } else if (kind === 'context:segment_created' && payload) {
          const segment = record(payload.segment)
          if (segment) {
            const id = scopedId('compaction-segment', `${String(segment.startMessageId)}-${String(segment.endMessageId)}`)
            const item: ConversationItemV2 = {
              schemaVersion: 1,
              id,
              conversationId: conversation.id,
              runId: common.runId,
              kind: 'context_compaction',
              status: 'completed',
              createdAt: numberValue(segment.createdAt) ?? event.at,
              updatedAt: event.at,
              payload: {
                sourceItemIds: [stringValue(segment.startMessageId), stringValue(segment.endMessageId)].filter((value): value is string => Boolean(value)),
                summary: stringValue(segment.summary),
                model: segment.isModelGenerated === true ? conversation.model : undefined,
              },
            }
            upsertItem(item, 'context-segment')
          }
        } else if (kind === 'task:system' && payload) {
          const item: ConversationItemV2 = {
            schemaVersion: 1,
            id: scopedId('plan', common.runId ?? conversation.id),
            conversationId: conversation.id,
            runId: common.runId,
            kind: 'plan',
            status: 'running',
            createdAt: event.at,
            updatedAt: event.at,
            payload: { steps: flattenTaskSteps(payload.tree, portableId) },
          }
          upsertItem(item, 'task-system')
        } else if (kind === 'active:task' && payload) {
          const task = record(payload.context)
          if (task) {
            const item: ConversationItemV2 = {
              schemaVersion: 1,
              id: scopedId('plan', common.runId ?? conversation.id),
              conversationId: conversation.id,
              runId: common.runId,
              kind: 'plan',
              status: numberValue(task.progress) === 100 ? 'completed' : 'running',
              createdAt: numberValue(task.startedAt) ?? event.at,
              updatedAt: event.at,
              payload: { steps: [{ id: portableId('step', stringValue(task.taskId) ?? 'active-task'), title: stringValue(task.title) ?? 'Active task', status: numberValue(task.progress) === 100 ? 'completed' : 'in_progress' }] },
            }
            upsertItem(item, 'active-task')
          }
        } else if (kind === 'task:update' && payload) {
          const taskId = stringValue(payload.taskId)
          if (taskId) {
            const item: ConversationItemV2 = {
              schemaVersion: 1,
              id: scopedId('plan', common.runId ?? conversation.id),
              conversationId: conversation.id,
              runId: common.runId,
              kind: 'plan',
              status: numberValue(payload.progress) === 100 ? 'completed' : 'running',
              createdAt: event.at,
              updatedAt: event.at,
              payload: { steps: [{ id: portableId('step', taskId), title: taskId, status: stringValue(payload.status) ?? 'pending' }] },
            }
            upsertItem(item, 'task-update')
          }
        } else if (kind === 'work:execution' && payload) {
          projectExecution(record(payload.snapshot))
        } else if ((kind === 'runtime-task:created' || kind === 'runtime-task:updated' || kind === 'runtime-task:finished') && payload) {
          const task = record(payload.task)
          const sourceTaskId = stringValue(task?.id)
          if (task && sourceTaskId) {
            const taskId = portableId('runtime-task', sourceTaskId)
            const command = stringValue(task.command)
            const cwd = portablePathRefsForToolValue(this.workspacePath, this.workspaceId, { cwd: task.cwd })[0]
            const item: ConversationItemV2 = command
              ? { schemaVersion: 1, id: scopedId('runtime-task', taskId), conversationId: conversation.id, runId: common.runId, kind: 'command_execution', status: terminalItemStatus(task.status), createdAt: numberValue(task.startedAt) ?? event.at, updatedAt: numberValue(task.updatedAt) ?? event.at, payload: { command, cwd, exitCode: numberValue(task.exitCode), requiresReview: true } }
              : { schemaVersion: 1, id: scopedId('runtime-task', taskId), conversationId: conversation.id, runId: common.runId, kind: 'notification', status: terminalItemStatus(task.status), createdAt: numberValue(task.startedAt) ?? event.at, updatedAt: event.at, payload: { level: task.status === 'failed' ? 'error' : task.status === 'completed' ? 'success' : 'info', message: stringValue(record(task.presentation)?.title) ?? stringValue(task.kind) ?? 'Runtime task' } }
            upsertItem(item, `runtime-task-${taskId}`)
          }
        }
        break
      }
    }
    if (inputs.length) this.repository.append(inputs)
  }

  load(conversationId: string): PersistedConversation | null {
    const projection = this.repository.projection(conversationId)
    const conversation = projection.conversation
    if (!conversation || conversation.status === 'archived' || conversation.workspaceId !== this.workspaceId) return null
    return persistedConversationFromProjectionV2(projection, this.workspacePath)
  }

  list(): ConversationMeta[] {
    return this.repository.list({ workspaceId: this.workspaceId, status: 'idle', limit: 200 }).conversations.map(conversation => ({
      id: conversation.id,
      title: conversation.title,
      titleSource: conversation.titleSource,
      workspacePath: this.workspacePath,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      mode: conversation.mode,
      model: conversation.model,
      provider: conversation.provider,
      turnCount: conversation.turnCount,
    }))
  }

  rename(conversationId: string, title: string, titleSource: 'custom' | 'generated', at = this.now()): boolean {
    const current = this.repository.projection(conversationId).conversation
    if (!current || current.status === 'archived' || current.workspaceId !== this.workspaceId) return false
    this.repository.append([{
      eventId: conversationV2IdFactory(conversationId).stable('rename', conversationId, title, at), profileId: this.profileId, conversationId, workspaceId: this.workspaceId,
      source: 'user', provenance: 'live', type: 'conversation.renamed', at, payload: { title, titleSource },
    }])
    return true
  }

  archive(conversationId: string, at = this.now()): boolean {
    const current = this.repository.projection(conversationId).conversation
    if (!current || current.status === 'archived' || current.workspaceId !== this.workspaceId) return false
    this.repository.append([{
      eventId: conversationV2IdFactory(conversationId).stable('archive', conversationId, at), profileId: this.profileId, conversationId, workspaceId: this.workspaceId,
      source: 'user', provenance: 'live', type: 'conversation.archived', at, payload: { archivedAt: at },
    }])
    return true
  }
}
