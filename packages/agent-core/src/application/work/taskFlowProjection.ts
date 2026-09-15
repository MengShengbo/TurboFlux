import type { AgentTurn } from '../../shared/agentTypes'
import type { AnyConversationEvent } from '../events/index'
import type { WorkNode, WorkProjectionSnapshot } from './workProjection'
import type { WorkSessionSnapshot } from './workSession'

export type TaskFlowNodeKind = 'thinking' | 'answer' | 'input' | 'tool' | 'runtime' | 'approval' | 'phase'
export type TaskFlowNodeStatus = 'waiting' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface TaskFlowNode {
  id: string
  anchorSeq?: number
  lastSeq?: number
  runId?: string
  turnId?: string
  responseId?: string
  callId?: string
  toolName?: string
  parentId?: string
  ordinal: number
  kind: TaskFlowNodeKind
  phase: 'reasoning' | 'execution' | 'delivery' | 'control'
  status: TaskFlowNodeStatus
  content: string
  detail?: string
  createdAt: number
  updatedAt: number
  settled: boolean
}

export interface TaskFlowProjectionState {
  conversationId: string
  source: 'work'
  revision: number
  activeRunId?: string
  lastSeq: number
  nodes: Readonly<Record<string, TaskFlowNode>>
  order: readonly string[]
  sequenceGaps: readonly number[]
}

function phaseForKind(kind: TaskFlowNodeKind): TaskFlowNode['phase'] {
  if (kind === 'thinking') return 'reasoning'
  if (kind === 'answer') return 'delivery'
  if (kind === 'approval' || kind === 'input') return 'control'
  return 'execution'
}

function taskKindForWorkNode(node: WorkNode): TaskFlowNodeKind {
  return node.kind === 'reasoning' ? 'thinking' : node.kind
}

function taskNodeForWorkNode(node: WorkNode, activeRunId?: string): TaskFlowNode {
  const kind = taskKindForWorkNode(node)
  const staleOpenNode = !node.settled && (!activeRunId || !node.runId || node.runId !== activeRunId)
  return {
    id: node.key,
    anchorSeq: node.anchorSeq,
    lastSeq: node.lastSeq,
    runId: node.runId,
    turnId: node.turnId,
    responseId: node.responseId,
    callId: node.callId,
    toolName: node.toolName,
    parentId: node.responseId || node.runId,
    ordinal: node.ordinal,
    kind,
    phase: phaseForKind(kind),
    status: staleOpenNode ? 'interrupted' : node.status,
    content: node.content,
    detail: node.detail,
    createdAt: node.startedAt,
    updatedAt: node.updatedAt,
    settled: node.settled || staleOpenNode,
  }
}

export function projectWorkProjection(projection: WorkProjectionSnapshot): TaskFlowProjectionState {
  return {
    conversationId: projection.sessionId,
    source: 'work',
    revision: projection.revision,
    activeRunId: projection.activeRunId,
    lastSeq: projection.lastSeq,
    nodes: Object.fromEntries(Object.entries(projection.nodes).map(([key, node]) => [key, taskNodeForWorkNode(node, projection.activeRunId)])),
    order: projection.order.filter(key => Boolean(projection.nodes[key])),
    sequenceGaps: [],
  }
}

export function applyTaskFlowWorkSnapshot(
  state: TaskFlowProjectionState | null,
  snapshot: WorkSessionSnapshot,
): TaskFlowProjectionState {
  const projection = snapshot.projection
  if (
    state?.source === 'work'
    && state.conversationId === projection.sessionId
    && state.revision === projection.revision
    && state.lastSeq === projection.lastSeq
  ) return state
  return projectWorkProjection(projection)
}

function createNode(input: {
  id: string
  runId?: string
  turnId?: string
  ordinal: number
  kind: TaskFlowNodeKind
  status: TaskFlowNodeStatus
  content?: string
  at: number
  settled?: boolean
}): TaskFlowNode {
  return {
    id: input.id,
    runId: input.runId,
    turnId: input.turnId,
    parentId: input.runId,
    ordinal: input.ordinal,
    kind: input.kind,
    phase: phaseForKind(input.kind),
    status: input.status,
    content: input.content || '',
    createdAt: input.at,
    updatedAt: input.at,
    settled: input.settled ?? false,
  }
}

function upsertNode(
  state: TaskFlowProjectionState,
  id: string,
  create: () => TaskFlowNode,
  update: (node: TaskFlowNode) => TaskFlowNode,
): TaskFlowProjectionState {
  const existing = state.nodes[id]
  const node = existing ? update(existing) : create()
  return {
    ...state,
    nodes: { ...state.nodes, [id]: node },
    order: existing ? state.order : [...state.order, id],
  }
}

function eventNodeKind(event: AnyConversationEvent): TaskFlowNodeKind | null {
  switch (event.type) {
    case 'turn.started':
      return event.payload.turn.role === 'user' ? 'input' : null
    case 'run.state_changed':
      return 'phase'
    case 'stream.started':
    case 'stream.delta':
    case 'stream.committed':
    case 'stream.ended':
      return event.payload.channel === 'thinking' ? 'thinking' : 'answer'
    case 'tool.delta':
    case 'tool.proposed':
    case 'tool.completed':
      return 'tool'
    case 'runtime.event':
      return 'runtime'
    case 'approval.requested':
    case 'approval.resolved':
    case 'approval.cancelled':
      return 'approval'
    case 'input.state_changed':
      return 'input'
    default:
      return null
  }
}

function eventStatus(event: AnyConversationEvent, fallback: TaskFlowNodeStatus): TaskFlowNodeStatus {
  if (event.type === 'turn.started') return 'completed'
  if (event.type === 'run.state_changed') {
    if (event.payload.state.phase === 'paused') return 'paused'
    return event.payload.state.phase === 'completed'
      ? 'completed'
      : event.payload.state.phase === 'recoverable_error'
        ? 'failed'
        : event.payload.state.phase === 'aborting'
          ? 'interrupted'
          : 'running'
  }
  if (event.type === 'stream.committed') return 'completed'
  if (event.type === 'stream.ended') return event.payload.interrupted ? 'interrupted' : 'completed'
  if (event.type === 'approval.requested') return 'waiting'
  if (event.type === 'tool.completed') return event.payload.toolResult.interruption?.kind === 'pause' ? 'interrupted' : event.payload.toolResult.errorKind === 'abort' ? 'cancelled' : event.payload.toolResult.isError ? 'failed' : 'completed'
  if (event.type === 'approval.resolved') return 'completed'
  if (event.type === 'approval.cancelled') return 'cancelled'
  if (event.type === 'input.state_changed') {
    if (['rejected', 'restored', 'removed', 'cancelled'].includes(event.payload.state)) return 'cancelled'
    return event.payload.state === 'committed' ? 'completed' : 'waiting'
  }
  return fallback
}

function eventContent(event: AnyConversationEvent, previous = ''): string {
  if (event.type === 'turn.started') return event.payload.turn.content
  if (event.type === 'run.state_changed') return event.payload.state.detail || event.payload.state.phase
  if (event.type === 'stream.delta') return `${previous}${event.payload.text}`
  if (event.type === 'stream.committed') return event.payload.text
  if (event.type === 'tool.delta') return event.payload.toolName
  if (event.type === 'tool.proposed') return event.payload.toolCall.name
  if (event.type === 'tool.completed') return event.payload.toolResult.name
  if (event.type === 'runtime.event') return previous || event.payload.kind
  if (event.type === 'approval.requested') return event.payload.toolName || event.payload.kind
  if (event.type === 'input.state_changed') return event.payload.text || previous
  return previous
}

function eventNodeId(event: AnyConversationEvent, kind: TaskFlowNodeKind): string | undefined {
  if (kind === 'phase') return `phase:${event.runId || event.conversationId}`
  if (kind === 'input' && event.type === 'turn.started') return `input:${event.payload.turn.id}`
  if (kind === 'thinking' || kind === 'answer') {
    if (event.stepId) return `step:${event.stepId}:${kind === 'thinking' ? 'reasoning' : 'answer'}`
    if (event.turnId) return `turn:${event.turnId}:response:${kind === 'thinking' ? 'reasoning' : 'answer'}`
  }
  if (!event.itemId) return undefined
  if (kind === 'tool') return `tool:${event.itemId}`
  if (kind === 'approval') return `approval:${event.itemId}`
  if (kind === 'input') return `input:${event.itemId}`
  return event.itemId
}

export function createTaskFlowProjection(conversationId: string): TaskFlowProjectionState {
  return { conversationId, source: 'work', revision: 0, lastSeq: 0, nodes: {}, order: [], sequenceGaps: [] }
}

export function applyTaskFlowEvent(
  state: TaskFlowProjectionState,
  event: AnyConversationEvent,
): TaskFlowProjectionState {
  if (event.threadId !== state.conversationId || event.conversationId !== state.conversationId) return state
  if (event.type === 'conversation.activated' && event.seq <= state.lastSeq) {
    state = createTaskFlowProjection(state.conversationId)
  } else if (event.seq <= state.lastSeq) {
    return state
  }
  const sequenceGaps = event.seq > state.lastSeq + 1
    ? [...state.sequenceGaps, event.seq]
    : state.sequenceGaps
  let next: TaskFlowProjectionState = {
    ...state,
    revision: state.revision + 1,
    activeRunId: event.type === 'run.started'
      ? event.runId
      : event.type === 'run.completed'
        ? undefined
        : state.activeRunId,
    lastSeq: event.seq,
    sequenceGaps,
  }
  if (event.type === 'run.state_changed') {
    const paused = event.payload.state.phase === 'paused'
    next.nodes = Object.fromEntries(Object.entries(next.nodes).map(([id, node]) => [id,
      node.runId === event.runId && !node.settled && (node.status === 'running' || node.status === 'paused')
        ? { ...node, status: paused ? 'paused' : 'running', updatedAt: event.at }
        : node,
    ]))
  }
  if (event.type === 'step.completed' && event.stepId && event.payload.outcome !== 'completed') {
    next.nodes = Object.fromEntries(Object.entries(next.nodes).map(([id, node]) => [id,
      node.kind === 'tool' && node.runId === event.runId && node.responseId === `step:${event.stepId}` && !node.settled
        ? { ...node, status: event.payload.outcome, settled: true, updatedAt: event.at }
        : node,
    ]))
  }
  if (event.type === 'turn.completed') {
    const turn = event.payload.turn
    if (turn.role !== 'assistant') return next
    const terminalStatus: TaskFlowNodeStatus = turn.metadata?.interrupted ? 'interrupted' : 'completed'
    const nodes: Record<string, TaskFlowNode> = Object.fromEntries(
      Object.entries(next.nodes).map(([id, node]) => [id, (
        node.runId === event.runId && node.turnId === turn.id && !node.settled
          ? { ...node, status: terminalStatus, settled: true, updatedAt: event.at }
          : node
      )]),
    )
    return { ...next, nodes }
  }
  const kind = eventNodeKind(event)
  const nodeId = kind ? eventNodeId(event, kind) : undefined
  if (!kind || !nodeId) {
    if (event.type === 'run.completed') {
      const terminalStatus: TaskFlowNodeStatus = event.payload.outcome === 'failed'
        ? 'failed'
        : event.payload.outcome === 'cancelled'
          ? 'cancelled'
          : event.payload.outcome === 'interrupted'
            ? 'interrupted'
            : 'completed'
      const nodes: Record<string, TaskFlowNode> = Object.fromEntries(
        Object.entries(next.nodes).map(([id, node]) => [id, (
          node.runId === event.runId && !node.settled
            ? { ...node, status: terminalStatus, settled: true, updatedAt: event.at }
            : node
        )]),
      )
      return { ...next, nodes }
    }
    return next
  }
  if (event.type === 'stream.ended' && !next.nodes[nodeId]) return next
  const paused = next.nodes[`phase:${event.runId || event.conversationId}`]?.status === 'paused'
  const status = eventStatus(event, kind === 'approval' || kind === 'input' ? 'waiting' : paused ? 'paused' : 'running')
  const settled = ['completed', 'failed', 'cancelled', 'interrupted'].includes(status)
  next = upsertNode(
    next,
    nodeId,
    () => createNode({
      id: nodeId,
      runId: event.runId,
      turnId: event.turnId,
      ordinal: event.seq,
      kind,
      status,
      content: eventContent(event),
      at: event.at,
      settled,
    }),
    node => ({
      ...node,
      runId: node.runId || event.runId,
      turnId: node.turnId || event.turnId,
      status,
      content: eventContent(event, node.content),
      detail: event.type === 'run.state_changed' ? event.payload.state.detail : node.detail,
      updatedAt: event.at,
      settled: node.settled || settled,
    }),
  )
  if (event.type === 'tool.delta' || event.type === 'tool.proposed') {
    const node = next.nodes[nodeId]!
    next.nodes = { ...next.nodes, [nodeId]: {
      ...node,
      callId: event.itemId,
      toolName: eventContent(event),
      responseId: event.type === 'tool.delta' && event.stepId ? `step:${event.stepId}` : undefined,
    } }
  }
  return next
}

export function historicalTaskFlowNodeId(turn: AgentTurn, kind: 'thinking' | 'answer'): string {
  return `turn:${turn.id}:${kind}`
}

export function taskFlowNodeIdForTurn(
  state: TaskFlowProjectionState | null,
  turn: AgentTurn,
  kind: 'thinking' | 'answer' | 'input',
): string {
  const match = state?.order.find(id => {
    const node = state.nodes[id]
    return node?.turnId === turn.id && node.kind === kind
  })
  if (match) return match
  if (kind === 'input') return `input:${turn.id}`
  return historicalTaskFlowNodeId(turn, kind)
}

export function taskFlowNodeIdForTool(state: TaskFlowProjectionState | null, callId: string): string {
  const canonicalId = `tool:${callId}`
  if (state?.nodes[canonicalId]) return canonicalId
  const match = state?.order.find(id => state.nodes[id]?.callId === callId)
  return match || callId
}

export function latestTaskFlowNodeId(
  state: TaskFlowProjectionState,
  kind: TaskFlowNodeKind,
  options: { unsettled?: boolean } = {},
): string | undefined {
  return [...state.order].reverse().find(id => {
    const node = state.nodes[id]
    return node?.kind === kind && (options.unsettled !== true || !node.settled)
  })
}

export function syncTaskFlowLiveText(
  state: TaskFlowProjectionState,
  kind: Extract<TaskFlowNodeKind, 'thinking' | 'answer'>,
  content: string,
  updatedAt = Date.now(),
): TaskFlowProjectionState {
  if (!content) return state
  const id = latestTaskFlowNodeId(state, kind, { unsettled: true })
  if (!id) return state
  const node = state.nodes[id]
  if (!node || node.content === content) return state
  return {
    ...state,
    revision: state.revision + 1,
    nodes: {
      ...state.nodes,
      [id]: { ...node, content, updatedAt },
    },
  }
}

export function orderTaskFlowNodeIds(state: TaskFlowProjectionState, ids: readonly string[]): string[] {
  const position = new Map(state.order.map((id, index) => [id, index]))
  return ids
    .map((id, index) => ({ id, index, position: position.get(id) }))
    .sort((left, right) => {
      if (left.position === undefined && right.position === undefined) return left.index - right.index
      if (left.position === undefined) return 1
      if (right.position === undefined) return -1
      return left.position - right.position || left.index - right.index
    })
    .map(item => item.id)
}
