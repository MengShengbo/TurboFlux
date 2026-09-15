import type { AgentAttachment, AgentCapabilitySelection, AgentMode, AgentRunState, ApprovalPolicy, TokenUsage } from '../../shared/agentTypes'
import type {
  AnyFlowEvent,
  FlowApprovalDecision,
  FlowApprovalKind,
  FlowActiveTask,
  FlowInputIntent,
  FlowRunOutcome,
  FlowToolOutcome,
} from '../../shared/flowEvents'

export const MAX_FLOW_STREAM_TEXT_CHARS = 16 * 1024
export const MAX_FLOW_NOTIFICATION_ITEMS = 64
export const MAX_FLOW_HISTORY_ITEMS = 128
export const MAX_FLOW_APPROVAL_HISTORY_ITEMS = 64
export const MAX_FLOW_VIOLATIONS = 64

export type FlowRunPhase = 'idle' | 'starting' | 'active' | 'stopping' | 'terminal'
export type FlowInputStatus = 'submitted' | 'durable' | 'accepted' | 'queued' | 'rejected' | 'committed' | 'restored' | 'cancelled'
export type FlowApprovalStatus = 'requested' | 'presented' | 'resolved' | 'cancelled'
export type FlowToolStatus = 'proposed' | 'awaiting_approval' | 'running' | FlowToolOutcome
export type FlowRuntimeStatus = 'running' | FlowToolOutcome

export interface FlowRunState {
  id: string | null
  phase: FlowRunPhase
  objective?: string
  outcome?: FlowRunOutcome
  error?: string
  startedAt?: number
  updatedAt: number
  agentState: AgentRunState
}

export interface FlowInputItem {
  id: string
  intent: FlowInputIntent
  text: string
  attachmentIds: string[]
  attachments: AgentAttachment[]
  capabilities?: AgentCapabilitySelection
  approvalPolicy?: ApprovalPolicy
  automationId?: string
  automationRunId?: string
  status: FlowInputStatus
  reason?: string
  createdAt: number
  updatedAt: number
}

export interface FlowApprovalItem {
  id: string
  kind: FlowApprovalKind
  status: FlowApprovalStatus
  toolName?: string
  reason?: string
  decision?: FlowApprovalDecision
  createdAt: number
  updatedAt: number
}

export interface FlowToolItem {
  id: string
  name: string
  status: FlowToolStatus
  error?: string
  createdAt: number
  updatedAt: number
}

export interface FlowStreamState {
  itemId: string | null
  channel: 'answer' | 'thinking'
  status: 'idle' | 'streaming' | 'ended'
  tail: string
  committed: string
  interrupted: boolean
  updatedAt: number
}

export interface FlowRuntimeItem {
  id: string
  kind: string
  label?: string
  status: FlowRuntimeStatus
  error?: string
  createdAt: number
  updatedAt: number
}

export interface FlowNotificationItem {
  id: string
  priority: number
  category: string
  message?: string
  acknowledged: boolean
  createdAt: number
  updatedAt: number
}

export interface FlowToolDraftState {
  id: string
  name: string
  partialJson: string
  startedAt: number
  updatedAt: number
}

export interface FlowInvariantViolation {
  eventId: string
  seq: number
  code: 'sequence_gap' | 'missing_item_id' | 'unknown_item' | 'terminal_reversal' | 'identity_mismatch'
  detail: string
}

export interface ThreadFlowState {
  schemaVersion: 2
  sessionId: string
  threadId: string
  lastSeq: number
  lastEventAt: number
  run: FlowRunState
  mode: AgentMode
  tokenUsage: TokenUsage
  activeTask: FlowActiveTask | null
  toolDraft: FlowToolDraftState | null
  draft: { text: string; attachmentIds: string[] }
  inputs: Record<string, FlowInputItem>
  inputQueue: string[]
  approvals: Record<string, FlowApprovalItem>
  approvalQueue: string[]
  activeApprovalId: string | null
  tools: Record<string, FlowToolItem>
  streams: Record<'answer' | 'thinking', FlowStreamState>
  runtimes: Record<string, FlowRuntimeItem>
  notifications: Record<string, FlowNotificationItem>
  persistence: {
    phase: 'clean' | 'flushing' | 'degraded'
    queued: number
    lastFlushDurationMs?: number
    error?: string
  }
  violations: FlowInvariantViolation[]
}

function emptyStream(channel: 'answer' | 'thinking'): FlowStreamState {
  return {
    itemId: null,
    channel,
    status: 'idle',
    tail: '',
    committed: '',
    interrupted: false,
    updatedAt: 0,
  }
}

export function createThreadFlowState(sessionId: string, threadId: string): ThreadFlowState {
  return {
    schemaVersion: 2,
    sessionId,
    threadId,
    lastSeq: 0,
    lastEventAt: 0,
    run: {
      id: null,
      phase: 'idle',
      updatedAt: 0,
      agentState: { phase: 'idle', updatedAt: 0 },
    },
    mode: 'vibe',
    tokenUsage: { source: 'unknown' },
    activeTask: null,
    toolDraft: null,
    draft: { text: '', attachmentIds: [] },
    inputs: {},
    inputQueue: [],
    approvals: {},
    approvalQueue: [],
    activeApprovalId: null,
    tools: {},
    streams: { answer: emptyStream('answer'), thinking: emptyStream('thinking') },
    runtimes: {},
    notifications: {},
    persistence: { phase: 'clean', queued: 0 },
    violations: [],
  }
}

function violation(
  state: ThreadFlowState,
  event: AnyFlowEvent,
  code: FlowInvariantViolation['code'],
  detail: string,
): ThreadFlowState {
  return {
    ...state,
    violations: [...state.violations, { eventId: event.eventId, seq: event.seq, code, detail }],
  }
}

function requireItemId(state: ThreadFlowState, event: AnyFlowEvent): [ThreadFlowState, string | null] {
  if (event.itemId) return [state, event.itemId]
  return [violation(state, event, 'missing_item_id', `${event.type} requires itemId`), null]
}

function removeValue(values: string[], value: string): string[] {
  return values.filter(candidate => candidate !== value)
}

function appendBoundedStreamText(current: string, delta: string): string {
  if (delta.length >= MAX_FLOW_STREAM_TEXT_CHARS) return delta.slice(-MAX_FLOW_STREAM_TEXT_CHARS)
  const retained = MAX_FLOW_STREAM_TEXT_CHARS - delta.length
  return `${current.slice(-retained)}${delta}`
}

function retainRecentNotifications(notifications: Record<string, FlowNotificationItem>): Record<string, FlowNotificationItem> {
  const values = Object.values(notifications)
  const retained = values
    .sort((left, right) => (
      Number(left.acknowledged) - Number(right.acknowledged)
      || right.priority - left.priority
      || right.updatedAt - left.updatedAt
      || right.createdAt - left.createdAt
    ))
    .slice(0, MAX_FLOW_NOTIFICATION_ITEMS)
  if (retained.length === values.length) return notifications
  return Object.fromEntries(retained.map(notification => [notification.id, notification]))
}

function retainRecentItems<T extends { id: string; createdAt: number; updatedAt: number }>(
  items: Record<string, T>,
  maxHistoryItems: number,
  keepActive: (item: T) => boolean,
): Record<string, T> {
  const values = Object.values(items)
  const active = values.filter(keepActive)
  const history = values
    .filter(item => !keepActive(item))
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id))
    .slice(0, maxHistoryItems)
  if (active.length + history.length === values.length) return items
  return Object.fromEntries([...active, ...history].map(item => [item.id, item]))
}

function compactFlowHistory(state: ThreadFlowState): ThreadFlowState {
  const inputValues = Object.values(state.inputs)
  const latestInput = [...inputValues].sort((left, right) => (
    right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id)
  ))[0]
  const queuedInputs = new Set(state.inputQueue)
  const inputs = retainRecentItems(state.inputs, MAX_FLOW_HISTORY_ITEMS, input => (
    queuedInputs.has(input.id)
    || ['submitted', 'durable', 'accepted', 'queued'].includes(input.status)
    || input.id === latestInput?.id
  ))
  const approvalQueue = new Set(state.approvalQueue)
  const approvals = retainRecentItems(state.approvals, MAX_FLOW_APPROVAL_HISTORY_ITEMS, approval => (
    approvalQueue.has(approval.id)
    || approval.id === state.activeApprovalId
    || approval.status === 'requested'
    || approval.status === 'presented'
  ))
  const tools = retainRecentItems(state.tools, MAX_FLOW_HISTORY_ITEMS, tool => (
    tool.status === 'proposed' || tool.status === 'awaiting_approval' || tool.status === 'running'
  ))
  const runtimes = retainRecentItems(state.runtimes, MAX_FLOW_HISTORY_ITEMS, runtime => runtime.status === 'running')
  const notifications = retainRecentNotifications(state.notifications)
  const violations = state.violations.length > MAX_FLOW_VIOLATIONS
    ? state.violations.slice(-MAX_FLOW_VIOLATIONS)
    : state.violations
  if (
    inputs === state.inputs
    && approvals === state.approvals
    && tools === state.tools
    && runtimes === state.runtimes
    && notifications === state.notifications
    && violations === state.violations
  ) return state
  return { ...state, inputs, approvals, tools, runtimes, notifications, violations }
}

function updateInput(
  state: ThreadFlowState,
  event: AnyFlowEvent,
  status: FlowInputStatus,
  reason?: string,
): ThreadFlowState {
  let next = state
  let itemId: string | null
  ;[next, itemId] = requireItemId(next, event)
  if (!itemId) return next
  const current = next.inputs[itemId]
  if (!current) return violation(next, event, 'unknown_item', `Unknown input ${itemId}`)
  if (current.status === 'committed' || current.status === 'cancelled') {
    return violation(next, event, 'terminal_reversal', `Input ${itemId} is already ${current.status}`)
  }
  return {
    ...next,
    inputs: {
      ...next.inputs,
      [itemId]: { ...current, status, reason, updatedAt: event.at },
    },
  }
}

function updateApprovalTerminal(
  state: ThreadFlowState,
  event: AnyFlowEvent,
  status: Extract<FlowApprovalStatus, 'resolved' | 'cancelled'>,
  decision?: FlowApprovalDecision,
  reason?: string,
): ThreadFlowState {
  let next = state
  let itemId: string | null
  ;[next, itemId] = requireItemId(next, event)
  if (!itemId) return next
  const current = next.approvals[itemId]
  if (!current) return violation(next, event, 'unknown_item', `Unknown approval ${itemId}`)
  if (current.status === 'resolved' || current.status === 'cancelled') {
    return violation(next, event, 'terminal_reversal', `Approval ${itemId} is already ${current.status}`)
  }
  const queue = removeValue(next.approvalQueue, itemId)
  return {
    ...next,
    approvals: {
      ...next.approvals,
      [itemId]: { ...current, status, decision, reason: reason ?? current.reason, updatedAt: event.at },
    },
    approvalQueue: queue,
    activeApprovalId: next.activeApprovalId === itemId ? queue[0] ?? null : next.activeApprovalId,
  }
}

function reduceFlowEventInternal(current: ThreadFlowState, event: AnyFlowEvent): ThreadFlowState {
  if (event.threadId !== current.threadId || event.sessionId !== current.sessionId) {
    return violation(current, event, 'identity_mismatch', `Expected ${current.sessionId}/${current.threadId}`)
  }
  if (event.seq <= current.lastSeq) return current

  let state: ThreadFlowState = {
    ...current,
    lastSeq: event.seq,
    lastEventAt: Math.max(current.lastEventAt, event.at),
  }
  if (event.seq !== current.lastSeq + 1) {
    state = violation(state, event, 'sequence_gap', `Expected ${current.lastSeq + 1}, received ${event.seq}`)
  }

  switch (event.type) {
    case 'thread.activated':
      return state
    case 'run.started': {
      const runId = event.runId ?? event.itemId
      if (!runId) return violation(state, event, 'missing_item_id', 'run.started requires runId')
      if (state.run.phase !== 'idle' && state.run.phase !== 'terminal' && state.run.id !== runId) {
        return violation(state, event, 'terminal_reversal', `Run ${state.run.id} is still ${state.run.phase}`)
      }
      return {
        ...state,
        run: {
          id: runId,
          phase: 'active',
          objective: event.payload.objective,
          startedAt: event.at,
          updatedAt: event.at,
          agentState: { phase: 'thinking', startedAt: event.at, updatedAt: event.at },
        },
        approvals: {},
        approvalQueue: [],
        activeApprovalId: null,
        tools: {},
        streams: { answer: emptyStream('answer'), thinking: emptyStream('thinking') },
        activeTask: null,
        toolDraft: null,
      }
    }
    case 'run.state_changed': {
      if (state.run.id !== event.runId || state.run.phase === 'terminal') {
        return violation(state, event, 'terminal_reversal', `Cannot update run ${event.runId ?? 'unknown'}`)
      }
      const phase = event.payload.state.phase === 'aborting'
        ? 'stopping'
        : event.payload.state.phase === 'idle'
          ? 'idle'
          : state.run.phase
      return {
        ...state,
        toolDraft: null,
        run: {
          ...state.run,
          phase,
          agentState: { ...event.payload.state },
          updatedAt: event.at,
        },
      }
    }
    case 'run.stopping':
      if (state.run.id !== event.runId || state.run.phase === 'terminal') {
        return violation(state, event, 'terminal_reversal', `Cannot stop run ${event.runId ?? 'unknown'}`)
      }
      return { ...state, run: { ...state.run, phase: 'stopping', updatedAt: event.at } }
    case 'run.completed':
      if (state.run.id !== event.runId || state.run.phase === 'terminal') {
        return violation(state, event, 'terminal_reversal', `Cannot complete run ${event.runId ?? 'unknown'}`)
      }
      return {
        ...state,
        run: {
          ...state.run,
          phase: 'terminal',
          outcome: event.payload.outcome,
          error: event.payload.error,
          updatedAt: event.at,
          agentState: {
            ...state.run.agentState,
            phase: 'completed',
            detail: event.payload.error ?? state.run.agentState.detail,
            updatedAt: event.at,
          },
        },
      }
    case 'session.mode_changed':
      return { ...state, mode: event.payload.mode }
    case 'usage.updated':
      return { ...state, tokenUsage: { ...event.payload.usage } }
    case 'task.active_changed':
      return {
        ...state,
        activeTask: event.payload.task
          ? {
              ...event.payload.task,
              toolCalls: event.payload.task.toolCalls.map(toolCall => ({ ...toolCall })),
            }
          : null,
      }
    case 'tool.draft_changed': {
      const id = event.itemId
      if (!id) return violation(state, event, 'missing_item_id', 'tool.draft_changed requires itemId')
      const previous = state.toolDraft?.id === id ? state.toolDraft : undefined
      return {
        ...state,
        toolDraft: {
          id,
          name: event.payload.name,
          partialJson: event.payload.partialJson,
          startedAt: previous?.startedAt ?? event.at,
          updatedAt: event.at,
        },
      }
    }
    case 'tool.draft_cleared':
      if (event.itemId && state.toolDraft && state.toolDraft.id !== event.itemId) return state
      return { ...state, toolDraft: null }
    case 'input.draft_changed':
      return { ...state, draft: { text: event.payload.text, attachmentIds: [...event.payload.attachmentIds] } }
    case 'input.submitted': {
      let itemId: string | null
      ;[state, itemId] = requireItemId(state, event)
      if (!itemId) return state
      return {
        ...state,
        inputs: {
          ...state.inputs,
          [itemId]: {
            id: itemId,
            intent: event.payload.intent,
            text: event.payload.text,
            attachmentIds: [...event.payload.attachmentIds],
            attachments: event.payload.attachments?.map(attachment => ({ ...attachment })) ?? [],
            capabilities: event.payload.capabilities
              ? { items: event.payload.capabilities.items.map(item => ({ ...item })) }
              : undefined,
            approvalPolicy: event.payload.approvalPolicy,
            automationId: event.payload.automationId,
            automationRunId: event.payload.automationRunId,
            status: 'submitted',
            createdAt: event.at,
            updatedAt: event.at,
          },
        },
      }
    }
    case 'input.durable':
      return updateInput(state, event, 'durable')
    case 'input.accepted':
      return updateInput(state, event, 'accepted')
    case 'input.rejected':
      return updateInput(state, event, 'rejected', event.payload.reason)
    case 'input.committed': {
      const updated = updateInput(state, event, 'committed')
      if (!event.itemId) return updated
      const input = updated.inputs[event.itemId]
      return {
        ...updated,
        inputs: input
          ? {
              ...updated.inputs,
              [event.itemId]: { ...input, text: '', attachmentIds: [], attachments: [] },
            }
          : updated.inputs,
        inputQueue: removeValue(updated.inputQueue, event.itemId),
      }
    }
    case 'input.restored': {
      const updated = updateInput(state, event, 'restored', event.payload.reason)
      const item = event.itemId ? updated.inputs[event.itemId] : undefined
      return {
        ...updated,
        draft: item ? { text: item.text, attachmentIds: [...item.attachmentIds] } : updated.draft,
        inputQueue: event.itemId ? removeValue(updated.inputQueue, event.itemId) : updated.inputQueue,
      }
    }
    case 'input.queued': {
      const updated = updateInput(state, event, 'queued')
      if (!event.itemId || updated.inputQueue.includes(event.itemId)) return updated
      const queue = [...updated.inputQueue]
      queue.splice(Math.max(0, Math.min(event.payload.position, queue.length)), 0, event.itemId)
      return { ...updated, inputQueue: queue }
    }
    case 'input.removed': {
      if (event.payload.reason === 'dequeued') {
        let next = state
        let itemId: string | null
        ;[next, itemId] = requireItemId(next, event)
        if (!itemId) return next
        const current = next.inputs[itemId]
        if (!current) return violation(next, event, 'unknown_item', `Unknown input ${itemId}`)
        return {
          ...next,
          inputs: {
            ...next.inputs,
            [itemId]: { ...current, status: 'durable', reason: undefined, updatedAt: event.at },
          },
          inputQueue: removeValue(next.inputQueue, itemId),
        }
      }
      const updated = updateInput(state, event, 'cancelled', event.payload.reason)
      return event.itemId ? { ...updated, inputQueue: removeValue(updated.inputQueue, event.itemId) } : updated
    }
    case 'approval.requested': {
      let itemId: string | null
      ;[state, itemId] = requireItemId(state, event)
      if (!itemId) return state
      if (state.approvals[itemId]) return state
      const queue = [...state.approvalQueue, itemId]
      return {
        ...state,
        approvals: {
          ...state.approvals,
          [itemId]: {
            id: itemId,
            kind: event.payload.kind,
            status: 'requested',
            toolName: event.payload.toolName,
            reason: event.payload.reason,
            createdAt: event.at,
            updatedAt: event.at,
          },
        },
        approvalQueue: queue,
        activeApprovalId: state.activeApprovalId ?? queue[0],
      }
    }
    case 'approval.presented': {
      let itemId: string | null
      ;[state, itemId] = requireItemId(state, event)
      if (!itemId) return state
      const currentApproval = state.approvals[itemId]
      if (!currentApproval) return violation(state, event, 'unknown_item', `Unknown approval ${itemId}`)
      return {
        ...state,
        approvals: {
          ...state.approvals,
          [itemId]: { ...currentApproval, status: 'presented', updatedAt: event.at },
        },
        activeApprovalId: itemId,
      }
    }
    case 'approval.resolved':
      return updateApprovalTerminal(state, event, 'resolved', event.payload.decision)
    case 'approval.cancelled':
      return updateApprovalTerminal(state, event, 'cancelled', undefined, event.payload.reason)
    case 'tool.proposed':
    case 'tool.awaiting_approval':
    case 'tool.running': {
      let itemId: string | null
      ;[state, itemId] = requireItemId(state, event)
      if (!itemId) return state
      const previous = state.tools[itemId]
      if (previous && ['completed', 'failed', 'cancelled'].includes(previous.status)) {
        return violation(state, event, 'terminal_reversal', `Tool ${itemId} is already ${previous.status}`)
      }
      const status: FlowToolStatus = event.type === 'tool.proposed'
        ? 'proposed'
        : event.type === 'tool.awaiting_approval'
          ? 'awaiting_approval'
          : 'running'
      return {
        ...state,
        tools: {
          ...state.tools,
          [itemId]: {
            id: itemId,
            name: event.payload.name,
            status,
            createdAt: previous?.createdAt ?? event.at,
            updatedAt: event.at,
          },
        },
      }
    }
    case 'tool.completed': {
      let itemId: string | null
      ;[state, itemId] = requireItemId(state, event)
      if (!itemId) return state
      const previous = state.tools[itemId]
      if (!previous) return violation(state, event, 'unknown_item', `Unknown tool ${itemId}`)
      if (['completed', 'failed', 'cancelled'].includes(previous.status)) {
        return violation(state, event, 'terminal_reversal', `Tool ${itemId} is already ${previous.status}`)
      }
      return {
        ...state,
        tools: {
          ...state.tools,
          [itemId]: {
            ...previous,
            name: event.payload.name,
            status: event.payload.outcome,
            error: event.payload.error,
            updatedAt: event.at,
          },
        },
      }
    }
    case 'stream.started': {
      const channel = event.payload.channel
      return {
        ...state,
        streams: {
          ...state.streams,
          [channel]: {
            itemId: event.itemId ?? null,
            channel,
            status: 'streaming',
            tail: '',
            committed: '',
            interrupted: false,
            updatedAt: event.at,
          },
        },
      }
    }
    case 'stream.delta': {
      const channel = event.payload.channel
      const stream = state.streams[channel]
      return {
        ...state,
        streams: {
          ...state.streams,
          [channel]: {
            ...stream,
            status: 'streaming',
            tail: appendBoundedStreamText(stream.tail, event.payload.text),
            updatedAt: event.at,
          },
        },
      }
    }
    case 'stream.committed': {
      const channel = event.payload.channel
      const stream = state.streams[channel]
      return {
        ...state,
        streams: {
          ...state.streams,
          [channel]: {
            ...stream,
            committed: appendBoundedStreamText(stream.committed, event.payload.text),
            tail: '',
            updatedAt: event.at,
          },
        },
      }
    }
    case 'stream.ended': {
      const channel = event.payload.channel
      const stream = state.streams[channel]
      return {
        ...state,
        streams: {
          ...state.streams,
          [channel]: { ...stream, status: 'ended', interrupted: event.payload.interrupted, updatedAt: event.at },
        },
      }
    }
    case 'runtime.started': {
      let itemId: string | null
      ;[state, itemId] = requireItemId(state, event)
      if (!itemId) return state
      return {
        ...state,
        runtimes: {
          ...state.runtimes,
          [itemId]: {
            id: itemId,
            kind: event.payload.kind,
            label: event.payload.label,
            status: 'running',
            createdAt: event.at,
            updatedAt: event.at,
          },
        },
      }
    }
    case 'runtime.completed': {
      let itemId: string | null
      ;[state, itemId] = requireItemId(state, event)
      if (!itemId) return state
      const runtime = state.runtimes[itemId]
      if (!runtime) return violation(state, event, 'unknown_item', `Unknown runtime ${itemId}`)
      if (runtime.status !== 'running') {
        return violation(state, event, 'terminal_reversal', `Runtime ${itemId} is already ${runtime.status}`)
      }
      return {
        ...state,
        runtimes: {
          ...state.runtimes,
          [itemId]: { ...runtime, status: event.payload.outcome, error: event.payload.error, updatedAt: event.at },
        },
      }
    }
    case 'notification.raised': {
      let itemId: string | null
      ;[state, itemId] = requireItemId(state, event)
      if (!itemId) return state
      const notifications = {
        ...state.notifications,
        [itemId]: {
          id: itemId,
          priority: event.payload.priority,
          category: event.payload.category,
          message: event.payload.message,
          acknowledged: false,
          createdAt: event.at,
          updatedAt: event.at,
        },
      }
      return { ...state, notifications: retainRecentNotifications(notifications) }
    }
    case 'notification.acknowledged': {
      let itemId: string | null
      ;[state, itemId] = requireItemId(state, event)
      if (!itemId) return state
      const notification = state.notifications[itemId]
      if (!notification) return violation(state, event, 'unknown_item', `Unknown notification ${itemId}`)
      return {
        ...state,
        notifications: {
          ...state.notifications,
          [itemId]: { ...notification, acknowledged: true, updatedAt: event.at },
        },
      }
    }
    case 'journal.flush_started':
      return { ...state, persistence: { phase: 'flushing', queued: event.payload.queued } }
    case 'journal.flushed':
      return {
        ...state,
        persistence: { phase: 'clean', queued: event.payload.queued, lastFlushDurationMs: event.payload.durationMs },
      }
    case 'journal.degraded':
      return { ...state, persistence: { ...state.persistence, phase: 'degraded', error: event.payload.error } }
  }
}

export function reduceFlowEvent(current: ThreadFlowState, event: AnyFlowEvent): ThreadFlowState {
  return compactFlowHistory(reduceFlowEventInternal(current, event))
}
