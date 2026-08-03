import type { ActiveTaskContext } from '../../core/taskManager'
import type { AgentRunState } from '../../shared/agentTypes'
import { deriveActivityModel } from './agentActivityModel'
import type { StreamingToolDraft } from './tools/toolTypes'
import type { ToolStatus } from './tools/toolTypes'
import { getToolActivityKind } from './tools/toolPresentation'
import { createTranslator, type Translator } from '../i18n/index'

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

const DEFAULT_TRANSLATOR = createTranslator('en')

export function deriveDeveloperFlow(input: DeveloperFlowInput, t: Translator = DEFAULT_TRANSLATOR): DeveloperFlowModel {
  const activity = deriveActivityModel({
    runState: input.runState,
    tools: input.tools,
    draft: input.draft,
    streamText: input.streamText,
    thinkingText: input.thinkingText,
  }, t)
  const activeTool = activity.activeTool
  const activeToolName = input.draft?.name || activeTool?.name || input.runState.activeTool || ''
  const objective = input.task?.title.trim() || input.objective?.trim() || ''
  const background = buildBackgroundSummary(input, t)

  if (input.runState.phase === 'awaiting_approval') {
    return flow(t('ui.runState.reviewRequired'), input.runState.detail || t('ui.flow.reviewPending'), 'warning', background)
  }
  if (input.runState.phase === 'awaiting_input') {
    return flow(t('ui.runState.inputRequired'), input.runState.detail || t('ui.flow.awaitingAnswer'), 'warning', background)
  }
  if (input.runState.phase === 'paused') {
    return flow(t('ui.runState.paused'), input.runState.detail || t('ui.flow.workPaused'), 'warning', background)
  }
  if (input.runState.phase === 'aborting') {
    return flow(t('ui.runState.stopping'), input.runState.detail || t('ui.flow.stoppingWork'), 'error', background)
  }
  if (input.runState.phase === 'recoverable_error') {
    return flow(t('ui.runState.recovering'), input.runState.detail || t('ui.flow.retryStep'), 'error', background)
  }
  if (input.runState.phase === 'compacting') {
    return flow(t('ui.runState.compacting'), input.runState.detail || t('ui.flow.compactingContext'), 'active', background)
  }
  if (input.streamText?.trim()) {
    return flow(t('ui.flow.responding'), t('ui.flow.writingResult'), 'active', background)
  }
  if (activeToolName) {
    const kind = getToolActivityKind(activeToolName)
    if (kind === 'edit') return flow(t('ui.flow.editing'), activity.detail, 'active', background)
    if (kind === 'run') return flow(t('ui.flow.running'), activity.detail, 'active', background)
    if (kind === 'read') return flow(t('ui.flow.exploring'), activity.detail, 'active', background)
    if (activeToolName === 'spawn_agent') return flow(t('ui.flow.delegating'), activity.detail, 'active', background)
    return flow(t('ui.flow.working'), activity.detail, 'active', background)
  }
  if (input.thinkingText?.trim() || input.runState.phase === 'thinking') {
    return flow(t('ui.runState.planning'), objective || input.runState.detail || t('ui.flow.planningNext'), 'active', background)
  }
  if (input.runState.phase === 'tool_running' || input.isRunning) {
    return flow(t('ui.runState.executing'), objective || input.runState.detail || t('ui.flow.continuingTask'), 'active', background)
  }

  const runningSubagent = input.subagents.find(agent => agent.status === 'running')
  if (runningSubagent) {
    return flow(t('ui.flow.background'), t('ui.flow.agentWorking', { agent: runningSubagent.label }), 'active', background)
  }
  return flow(t('ui.runState.ready'), t('ui.flow.readyNext'), 'success', background)
}

function buildBackgroundSummary(input: DeveloperFlowInput, t: Translator): string[] {
  const items: string[] = []
  for (const agent of input.subagents.slice(-2)) {
    if (agent.status === 'completed') items.push(t('ui.flow.agentResultReady', { agent: agent.label }))
    else if (agent.status === 'failed') items.push(t('ui.flow.agentFailed', { agent: agent.label }))
    else items.push(`${agent.label} ${normalizeSubagentDetail(agent.detail, t)}`)
  }

  if (input.terminals > 0) items.push(t(input.terminals === 1 ? 'ui.flow.terminalsActive' : 'ui.flow.terminalsActivePlural', { count: input.terminals }))
  if (input.queuedCount > 0) items.push(t('ui.flow.queued', { count: input.queuedCount }))
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

function normalizeSubagentDetail(detail: string, t: Translator): string {
  const normalized = detail.trim().replace(/^turn\s+/i, 'turn ')
  const turn = normalized.match(/^turn\s+(\d+\/\d+)$/i)
  if (turn) return turn[1]
  return trimTrailingEllipsis(normalized || t('common.working'))
}

function trimTrailingEllipsis(value: string): string {
  return value.trim().replace(/(?:\.\.\.|…)+$/, '')
}
