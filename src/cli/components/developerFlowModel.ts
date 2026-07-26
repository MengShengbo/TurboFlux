import type { ActiveTaskContext } from '../../core/taskManager'
import type { AgentRunState } from '../../shared/agentTypes'
import type { FastContextUiSummary } from './layout/fastContextUi'
import { deriveActivityModel } from './agentActivityModel'
import type { StreamingToolDraft } from './tools/toolTypes'
import type { ToolStatus } from './tools/toolTypes'

export type DeveloperFlowTone = 'idle' | 'active' | 'success' | 'warning' | 'error'
export type SubAgentUiStatus = 'running' | 'completed' | 'failed'

export interface DeveloperSubAgentActivity {
  id: string
  label: string
  objective: string
  detail: string
  startedAt: number
  status: SubAgentUiStatus
  completedAt?: number
}

export interface DeveloperFlowInput {
  runState: AgentRunState
  isRunning: boolean
  tools: ToolStatus[]
  draft: StreamingToolDraft | null
  streamText?: string
  thinkingText?: string
  fastContextSummary: FastContextUiSummary
  fastContextActive: boolean
  subagents: readonly DeveloperSubAgentActivity[]
  terminals: number
  queuedCount: number
  task: ActiveTaskContext | null
  objective?: string | null
}

export interface DeveloperFlowModel {
  label: string
  detail: string
  tone: DeveloperFlowTone
  background: string[]
}

const FILE_TOOLS = new Set(['write_file', 'replace_file', 'edit_file', 'multi_edit', 'delete_file'])
const RUN_TOOLS = new Set(['run_command'])
const EXPLORE_TOOLS = new Set([
  'read_file',
  'read_file_full',
  'list_directory',
  'search_files',
  'search_content',
  'search_symbols',
  'search_symbol',
  'search_semantic',
  'get_codemap',
  'explore_code',
  'web_search',
])

export function deriveDeveloperFlow(input: DeveloperFlowInput): DeveloperFlowModel {
  const activity = deriveActivityModel({
    runState: input.runState,
    tools: input.tools,
    draft: input.draft,
    streamText: input.streamText,
    thinkingText: input.thinkingText,
  })
  const activeTool = activity.activeTool
  const activeToolName = input.draft?.name || activeTool?.name || input.runState.activeTool || ''
  const objective = input.task?.title.trim() || input.objective?.trim() || ''
  const background = buildBackgroundSummary(input)

  if (input.runState.phase === 'awaiting_approval') {
    return flow('REVIEW REQUIRED', input.runState.detail || 'Review the pending action', 'warning', background)
  }
  if (input.runState.phase === 'awaiting_input') {
    return flow('INPUT REQUIRED', input.runState.detail || 'The agent is waiting for your answer', 'warning', background)
  }
  if (input.runState.phase === 'paused') {
    return flow('PAUSED', input.runState.detail || 'Work is paused', 'warning', background)
  }
  if (input.runState.phase === 'aborting') {
    return flow('STOPPING', input.runState.detail || 'Stopping active work', 'error', background)
  }
  if (input.runState.phase === 'recoverable_error') {
    return flow('RECOVERING', input.runState.detail || 'The last step can be retried', 'error', background)
  }
  if (input.streamText?.trim()) {
    return flow('RESPONDING', 'Writing the result', 'active', background)
  }
  if (activeToolName) {
    if (FILE_TOOLS.has(activeToolName)) return flow('EDITING', activity.detail, 'active', background)
    if (RUN_TOOLS.has(activeToolName)) return flow('RUNNING', activity.detail, 'active', background)
    if (EXPLORE_TOOLS.has(activeToolName)) return flow('EXPLORING', activity.detail, 'active', background)
    if (activeToolName === 'spawn_agent') return flow('DELEGATING', activity.detail, 'active', background)
    return flow('WORKING', activity.detail, 'active', background)
  }
  if (input.thinkingText?.trim() || input.runState.phase === 'thinking') {
    return flow('PLANNING', objective || input.runState.detail || 'Planning the next step', 'active', background)
  }
  if (input.runState.phase === 'tool_running' || input.isRunning) {
    return flow('EXECUTING', objective || input.runState.detail || 'Continuing the current task', 'active', background)
  }

  const runningSubagent = input.subagents.find(agent => agent.status === 'running')
  if (runningSubagent) {
    return flow('BACKGROUND', `${runningSubagent.label} is working`, 'active', background)
  }
  if (input.fastContextActive) {
    return flow('EXPLORING', `FastContext is ${formatFastContextPhase(input.fastContextSummary.phase)}`, 'active', background)
  }

  return flow('READY', 'Ready for the next task', 'success', background)
}

function buildBackgroundSummary(input: DeveloperFlowInput): string[] {
  const items: string[] = []
  if (input.fastContextActive) {
    const evidence = input.fastContextSummary.absorbed > 0
      ? ` · ${input.fastContextSummary.absorbed} evidence`
      : ''
    items.push(`FC ${formatFastContextPhase(input.fastContextSummary.phase)}${evidence}`)
  } else if (
    input.isRunning
    && input.fastContextSummary.events > 0
    && input.fastContextSummary.phase === 'completed'
  ) {
    items.push('FC evidence ready')
  } else if (input.fastContextSummary.events > 0 && input.fastContextSummary.phase === 'error') {
    items.push('FC failed')
  } else if (input.isRunning && input.fastContextSummary.events > 0 && input.fastContextSummary.phase === 'cancelled') {
    items.push('FC cancelled')
  }

  for (const agent of input.subagents.slice(-2)) {
    if (agent.status === 'completed') items.push(`${agent.label} result ready`)
    else if (agent.status === 'failed') items.push(`${agent.label} failed`)
    else items.push(`${agent.label} ${normalizeSubagentDetail(agent.detail)}`)
  }

  if (input.terminals > 0) items.push(`${input.terminals} terminal${input.terminals === 1 ? '' : 's'} active`)
  if (input.queuedCount > 0) items.push(`${input.queuedCount} queued`)
  return items
}

function flow(
  label: string,
  detail: string,
  tone: DeveloperFlowTone,
  background: string[],
): DeveloperFlowModel {
  return { label, detail: trimTrailingEllipsis(detail), tone, background }
}

function formatFastContextPhase(phase: FastContextUiSummary['phase']): string {
  if (phase === 'synthesizing') return 'assembling'
  if (phase === 'ranking') return 'ranking'
  if (phase === 'mapping' || phase === 'scanning') return 'mapping'
  if (phase === 'completed') return 'ready'
  if (phase === 'cancelled') return 'cancelled'
  return 'needs attention'
}

function normalizeSubagentDetail(detail: string): string {
  const normalized = detail.trim().replace(/^turn\s+/i, 'turn ')
  const turn = normalized.match(/^turn\s+(\d+\/\d+)$/i)
  if (turn) return turn[1]
  return trimTrailingEllipsis(normalized || 'working')
}

function trimTrailingEllipsis(value: string): string {
  return value.trim().replace(/(?:\.\.\.|…)+$/, '')
}
