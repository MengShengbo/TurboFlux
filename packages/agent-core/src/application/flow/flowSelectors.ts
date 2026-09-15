import type { AgentAttachment, AgentCapabilitySelection, AgentMode, AgentRunState, ApprovalPolicy, TokenUsage } from '../../shared/agentTypes'
import type { FlowActiveTask } from '../../shared/flowEvents'
import type { FlowToolDraftState, ThreadFlowState } from './flowReducer'

export type PrimaryFlowActivityCode =
  | 'ready'
  | 'thinking'
  | 'compacting'
  | 'working'
  | 'responding'
  | 'review-required'
  | 'input-required'
  | 'stopping'
  | 'interrupted'
  | 'needs-attention'
  | 'history-unavailable'

export interface PrimaryFlowActivity {
  kind: 'idle' | 'working' | 'streaming' | 'action-required' | 'stopping' | 'completed' | 'error'
  code: PrimaryFlowActivityCode
  label?: string
  detail?: string
}

export interface FlowInputReceipt {
  kind: 'pending' | 'steering' | 'queued' | 'committed' | 'restored'
  intent: 'turn' | 'steer' | 'queued-turn'
  queueCount: number
  reason?: string
  updatedAt: number
  expiresAt?: number
}

export const FLOW_INPUT_RECEIPT_TTL_MS = 4_000

export function selectIsForegroundBusy(state: ThreadFlowState): boolean {
  return state.run.phase === 'starting' || state.run.phase === 'active' || state.run.phase === 'stopping'
}

export function selectAgentRunState(state: ThreadFlowState): AgentRunState {
  return state.run.agentState
}

export function selectAgentMode(state: ThreadFlowState): AgentMode {
  return state.mode
}

export function selectTokenUsage(state: ThreadFlowState): TokenUsage {
  return state.tokenUsage
}

export function selectActiveTask(state: ThreadFlowState): FlowActiveTask | null {
  return state.activeTask
}

export function selectToolDraft(state: ThreadFlowState): FlowToolDraftState | null {
  return state.toolDraft
}

export interface FlowPromptProjection {
  id: string
  prompt: string
  attachments?: AgentAttachment[]
  capabilities?: AgentCapabilitySelection
  approvalPolicy?: ApprovalPolicy
  automationId?: string
  automationRunId?: string
}

function projectInput(state: ThreadFlowState, id: string): FlowPromptProjection | null {
  const input = state.inputs[id]
  if (!input) return null
  return {
    id: input.id,
    prompt: input.text,
    attachments: input.attachments.length > 0
      ? input.attachments.map(attachment => ({ ...attachment }))
      : undefined,
    capabilities: input.capabilities
      ? { items: input.capabilities.items.map(item => ({ ...item })) }
      : undefined,
    approvalPolicy: input.approvalPolicy,
    automationId: input.automationId,
    automationRunId: input.automationRunId,
  }
}

export function selectQueuedInputs(state: ThreadFlowState): FlowPromptProjection[] {
  return state.inputQueue
    .map(id => projectInput(state, id))
    .filter((input): input is FlowPromptProjection => input !== null)
}

export function selectPendingSteeringInputs(state: ThreadFlowState): FlowPromptProjection[] {
  return Object.values(state.inputs)
    .filter(input => input.intent === 'steer' && input.status === 'accepted')
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map(input => projectInput(state, input.id)!)
}

export function selectNeedsAction(state: ThreadFlowState): boolean {
  return state.activeApprovalId !== null
}

export function selectCanSteer(state: ThreadFlowState): boolean {
  return state.run.phase === 'active' && !selectNeedsAction(state)
}

export function selectQueueCount(state: ThreadFlowState): number {
  return state.inputQueue.length
}

export function selectRunningBackgroundCount(state: ThreadFlowState): number {
  return Object.values(state.runtimes).filter(item => item.status === 'running').length
}

export function selectInputReceipt(
  state: ThreadFlowState,
  now = Date.now(),
  terminalTtlMs = FLOW_INPUT_RECEIPT_TTL_MS,
): FlowInputReceipt | null {
  const queueCount = selectQueueCount(state)
  const latest = Object.values(state.inputs).sort((left, right) =>
    right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id)
  )[0]

  if (latest) {
    const base = {
      intent: latest.intent,
      queueCount,
      reason: latest.reason,
      updatedAt: latest.updatedAt,
    }
    if (latest.status === 'restored' && state.draft.text === latest.text) {
      return { ...base, kind: 'restored' }
    }
    if (latest.status === 'restored' && now <= latest.updatedAt + terminalTtlMs) {
      return { ...base, kind: 'restored', expiresAt: latest.updatedAt + terminalTtlMs }
    }
    if (latest.status === 'accepted' && latest.intent === 'steer') {
      return { ...base, kind: 'steering' }
    }
    if (latest.status === 'submitted' || latest.status === 'durable') {
      return { ...base, kind: 'pending' }
    }
    if (latest.status === 'queued') {
      return { ...base, kind: 'queued' }
    }
    if (latest.status === 'committed' && now <= latest.updatedAt + terminalTtlMs) {
      return { ...base, kind: 'committed', expiresAt: latest.updatedAt + terminalTtlMs }
    }
  }

  if (queueCount > 0) {
    const queued = state.inputs[state.inputQueue[0]!]
    return {
      kind: 'queued',
      intent: queued?.intent ?? 'queued-turn',
      queueCount,
      updatedAt: queued?.updatedAt ?? state.lastEventAt,
    }
  }
  return null
}

export function selectUnacknowledgedNotifications(state: ThreadFlowState) {
  return Object.values(state.notifications)
    .filter(notification => !notification.acknowledged)
    .sort((left, right) => right.priority - left.priority || left.createdAt - right.createdAt)
}

export function selectPrimaryActivity(state: ThreadFlowState): PrimaryFlowActivity {
  if (state.activeApprovalId) {
    const approval = state.approvals[state.activeApprovalId]
    return {
      kind: 'action-required',
      code: approval?.kind === 'input' ? 'input-required' : 'review-required',
      detail: approval?.toolName || approval?.reason,
    }
  }
  if (state.persistence.phase === 'degraded') {
    return { kind: 'error', code: 'history-unavailable', detail: state.persistence.error }
  }
  if (state.run.phase === 'stopping') return { kind: 'stopping', code: 'stopping' }
  if (state.streams.answer.status === 'streaming' && state.streams.answer.tail) {
    return { kind: 'streaming', code: 'responding' }
  }
  if (state.run.agentState.phase === 'compacting') {
    return { kind: 'working', code: 'compacting', detail: state.run.agentState.detail }
  }
  const runningTool = Object.values(state.tools).find(tool => tool.status === 'running')
  if (runningTool) return { kind: 'working', code: 'working', detail: runningTool.name }
  if (state.run.phase === 'active') return { kind: 'working', code: 'thinking', detail: state.run.objective }
  if (state.run.phase === 'terminal') {
    if (state.run.outcome === 'succeeded') return { kind: 'completed', code: 'ready' }
    if (state.run.outcome === 'interrupted' || state.run.outcome === 'cancelled') {
      return { kind: 'idle', code: 'interrupted' }
    }
    return { kind: 'error', code: 'needs-attention', detail: state.run.error }
  }
  return { kind: 'idle', code: 'ready' }
}

export interface FlowBackgroundSummaryItem {
  code: 'background-tasks' | 'queued' | 'results-ready'
  count: number
}

export function selectBackgroundSummary(state: ThreadFlowState): FlowBackgroundSummaryItem[] {
  const summary: FlowBackgroundSummaryItem[] = []
  const running = Object.values(state.runtimes).filter(item => item.status === 'running')
  if (running.length > 0) summary.push({ code: 'background-tasks', count: running.length })
  if (state.inputQueue.length > 0) summary.push({ code: 'queued', count: state.inputQueue.length })
  const results = selectUnacknowledgedNotifications(state).filter(item => item.category === 'result-ready')
  if (results.length > 0) summary.push({ code: 'results-ready', count: results.length })
  return summary
}
