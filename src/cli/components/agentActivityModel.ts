import type { AgentRunPhase, AgentRunState } from '../../shared/agentTypes'
import type { ToolStatus } from './tools/toolTypes'
import type { StreamingToolDraft } from './tools/toolTypes'
import { formatDraftToolLabel, formatRunningToolLabel } from './tools/toolPresentation'
import { createTranslator, type Translator } from '../i18n/index'

export interface ActivityModelInput {
  runState?: AgentRunState
  tools: ToolStatus[]
  draft?: StreamingToolDraft | null
  streamText?: string
  thinkingText?: string
  idleLabel?: string | null
}

export interface ActivityModel {
  visible: boolean
  phase: AgentRunPhase
  label: string
  detail: string
  activeTool?: ToolStatus
  hasThinking: boolean
  hasAnswer: boolean
  hasTools: boolean
}

const DEFAULT_TRANSLATOR = createTranslator('en')

export function deriveActivityModel(input: ActivityModelInput, t: Translator = DEFAULT_TRANSLATOR): ActivityModel {
  const phaseLabels: Record<AgentRunPhase, string> = {
    idle: t('ui.activity.phase.ready'),
    thinking: t('ui.activity.phase.thinking'),
    compacting: t('ui.activity.phase.compacting'),
    tool_running: t('ui.activity.phase.working'),
    awaiting_approval: t('ui.activity.phase.awaitingApproval'),
    awaiting_input: t('ui.activity.phase.awaitingInput'),
    paused: t('ui.activity.phase.paused'),
    aborting: t('ui.activity.phase.stopping'),
    recoverable_error: t('ui.activity.phase.recovering'),
    completed: t('ui.activity.phase.done'),
  }
  const phase = input.runState?.phase ?? 'idle'
  const activeTool = [...input.tools].reverse().find(tool => tool.status === 'running')
  const hasThinking = Boolean(input.thinkingText?.trim())
  const hasAnswer = Boolean(input.streamText?.trim())
  const hasTools = input.tools.length > 0 || Boolean(input.draft)
  const detail = (activeTool ? formatToolActivity(activeTool, t) : '')
    || (input.draft ? `${formatDraftToolLabel(input.draft, t)}...` : '')
    || input.runState?.detail?.trim()
    || input.idleLabel?.trim()
    || phaseLabels[phase]
  const visible = phase !== 'idle' && phase !== 'completed'
    || hasThinking
    || hasAnswer
    || hasTools
    || Boolean(input.idleLabel)

  return {
    visible,
    phase,
    label: phaseLabels[phase],
    detail,
    activeTool,
    hasThinking,
    hasAnswer,
    hasTools,
  }
}

export function formatToolActivity(tool: Pick<ToolStatus, 'name' | 'args'>, t: Translator = DEFAULT_TRANSLATOR): string {
  return `${formatRunningToolLabel(tool, t)}...`
}
