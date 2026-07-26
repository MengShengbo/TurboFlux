import type { AgentRunPhase, AgentRunState } from '../../shared/agentTypes'
import type { ToolStatus } from './tools/toolTypes'
import type { StreamingToolDraft } from './tools/toolTypes'

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

const PHASE_LABELS: Record<AgentRunPhase, string> = {
  idle: 'Ready',
  thinking: 'Thinking...',
  tool_running: 'Working...',
  awaiting_approval: 'Waiting for approval...',
  awaiting_input: 'Waiting for input...',
  paused: 'Paused',
  aborting: 'Stopping...',
  recoverable_error: 'Recovering...',
  completed: 'Done',
}

export function deriveActivityModel(input: ActivityModelInput): ActivityModel {
  const phase = input.runState?.phase ?? 'idle'
  const activeTool = [...input.tools].reverse().find(tool => tool.status === 'running')
  const hasThinking = Boolean(input.thinkingText?.trim())
  const hasAnswer = Boolean(input.streamText?.trim())
  const hasTools = input.tools.length > 0 || Boolean(input.draft)
  const detail = (activeTool ? formatToolActivity(activeTool) : '')
    || formatDraftActivity(input.draft)
    || input.runState?.detail?.trim()
    || input.idleLabel?.trim()
    || PHASE_LABELS[phase]
  const visible = phase !== 'idle' && phase !== 'completed'
    || hasThinking
    || hasAnswer
    || hasTools
    || Boolean(input.idleLabel)

  return {
    visible,
    phase,
    label: PHASE_LABELS[phase],
    detail,
    activeTool,
    hasThinking,
    hasAnswer,
    hasTools,
  }
}

function formatDraftActivity(draft?: StreamingToolDraft | null): string {
  if (!draft) return ''
  const args = parseArgs(draft.partialJson)
  const path = typeof args.path === 'string' ? args.path : ''
  const verb = draft.name.includes('write') ? 'Preparing write'
    : draft.name.includes('edit') || draft.name.includes('replace') ? 'Preparing edit'
      : `Preparing ${draft.name.replaceAll('_', ' ')}`
  return path ? `${verb} ${path}...` : `${verb}...`
}

export function formatToolActivity(tool: Pick<ToolStatus, 'name' | 'args'>): string {
  const args = parseArgs(tool.args)
  const path = typeof args.path === 'string' ? args.path : ''
  const command = typeof args.command === 'string' ? args.command : ''
  const query = typeof args.query === 'string' ? args.query : typeof args.pattern === 'string' ? args.pattern : ''

  switch (tool.name) {
    case 'write_file': return path ? `Writing ${path}...` : 'Writing file...'
    case 'replace_file':
    case 'edit_file':
    case 'multi_edit': return path ? `Editing ${path}...` : 'Editing file...'
    case 'delete_file': return path ? `Deleting ${path}...` : 'Deleting file...'
    case 'run_command': return command ? `Running ${command}...` : 'Running command...'
    case 'read_file':
    case 'read_file_full': return path ? `Reading ${path}...` : 'Reading file...'
    case 'search_content':
    case 'search_files':
    case 'search_symbols':
    case 'search_semantic': return query ? `Searching ${query}...` : 'Searching...'
    default: return `Using ${tool.name.replaceAll('_', ' ')}...`
  }
}

function parseArgs(value?: string): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}
