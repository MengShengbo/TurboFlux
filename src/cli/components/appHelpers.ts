import type { AgentTurn, ThinkingTrace } from '../../shared/agentTypes'
import type { ModelPreset } from '../../core/config'
import type { ModelDiscoveryResult } from '../../core/modelDiscovery'
import type { Message } from './messages/Messages'
import type { ToolStatus } from './tools/ToolCallTree'
import { createTranslator, type Translator } from '../i18n/index'

const DEFAULT_TRANSLATOR = createTranslator('en')

function isMessageRole(role: string): role is Message['role'] {
  return role === 'user' || role === 'assistant' || role === 'system'
}

export function formatTaskToolSummary(completed: number, total: number, running: number, errored: number, t: Translator = DEFAULT_TRANSLATOR): string {
  if (total === 0) return t('ui.task.planning')
  const parts = [t('ui.task.tools', { completed, total })]
  if (running > 0) parts.push(t('ui.task.running', { count: running }))
  if (errored > 0) parts.push(t('ui.task.failed', { count: errored }))
  return parts.join(', ')
}

export function selectAutoMountedModel(
  currentModel: string | undefined,
  source: ModelDiscoveryResult['source'],
  models: ModelPreset[],
): ModelPreset | undefined {
  if (currentModel?.trim() || source === 'fallback') return undefined
  return models[0]
}

export function isThinkingToggleShortcut(input: string, ctrl: boolean): boolean {
  return ctrl && input.toLowerCase() === 'o'
}

export function resolveAssistantStreamDisplay(
  visibleText: string,
  thinkingText: string,
  _hasToolOutput: boolean,
  _interrupted: boolean,
): { visibleText: string; thinkingText: string } {
  return { visibleText, thinkingText }
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return '0s'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}m${rest.toString().padStart(2, '0')}s`
}

export function formatTaskProgressLabel(progress: number, t: Translator = DEFAULT_TRANSLATOR): string {
  if (progress >= 95 && progress < 100) return t('ui.task.finishing')
  if (progress > 0 && progress < 95) return `${Math.round(progress)}%`
  return ''
}

export function formatTaskToolName(name: string, t: Translator = DEFAULT_TRANSLATOR): string {
  switch (name) {
    case 'read_file': return t('ui.task.tool.read')
    case 'read_file_full': return t('ui.task.tool.readFull')
    case 'search_content': return t('ui.task.tool.search')
    case 'search_files': return t('ui.task.tool.findFiles')
    case 'search_symbols': return t('ui.task.tool.symbols')
    case 'get_codemap': return t('ui.task.tool.codemap')
    case 'write_file': return t('ui.task.tool.write')
    case 'replace_file': return t('ui.task.tool.replace')
    case 'edit_file': return t('ui.task.tool.edit')
    case 'multi_edit': return t('ui.task.tool.multiEdit')
    case 'run_command': return t('ui.task.tool.shell')
    case 'read_terminal': return t('ui.task.tool.readTerminal')
    case 'write_terminal': return t('ui.task.tool.writeTerminal')
    case 'list_terminals': return t('ui.task.tool.listTerminals')
    case 'kill_terminal': return t('ui.task.tool.stopTerminal')
    default: return name
  }
}

export function serializeToolArgsForUi(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined
  const clone: Record<string, unknown> = { ...args }
  for (const key of ['content', 'data', 'old_content', 'new_content', 'old_string', 'new_string']) {
    if (typeof clone[key] === 'string') clone[key] = `<${(clone[key] as string).length} chars>`
  }
  if (Array.isArray(clone.edits)) {
    clone.edits = clone.edits.map(edit => {
      if (!edit || typeof edit !== 'object') return edit
      const next: Record<string, unknown> = { ...(edit as Record<string, unknown>) }
      for (const key of ['old_string', 'new_string']) {
        if (typeof next[key] === 'string') next[key] = `<${(next[key] as string).length} chars>`
      }
      return next
    })
  }
  return JSON.stringify(clone)
}

export function turnsToMessages(turns: AgentTurn[]): Message[] {
  const resultByToolCallId = new Map<string, NonNullable<AgentTurn['toolResults']>[number]>()
  for (const turn of turns) {
    if (turn.role !== 'tool_result' || !turn.toolResults) continue
    for (const result of turn.toolResults) resultByToolCallId.set(result.toolCallId, result)
  }

  return turns.flatMap(turn => {
    if (!isMessageRole(turn.role)) return []
    if (turn.metadata?.internal === true) return []
    const tools = turn.toolCalls?.map(toolCall => {
      const result = resultByToolCallId.get(toolCall.id)
      return {
        id: toolCall.id,
        name: toolCall.name,
        status: result?.isError ? 'error' as const : 'done' as const,
        args: serializeToolArgsForUi(toolCall.arguments),
        output: result?.output?.slice(0, 200),
        startTime: turn.timestamp,
        endTime: result ? turn.timestamp + 1 : undefined,
      }
    })
    const changes = turn.toolCalls?.flatMap(toolCall => {
      const summary = resultByToolCallId.get(toolCall.id)?.changeSummary
      return summary ? [summary] : []
    })
    return [{
      id: turn.id,
      role: turn.role,
      content: turn.content,
      tools: tools && tools.length > 0 ? tools : undefined,
      changes: changes && changes.length > 0 ? changes : undefined,
      interrupted: turn.metadata?.interrupted === true,
      thinking: turn.metadata?.thinking
        ? {
            ...turn.metadata.thinking,
            ...(turn.metadata.reasoningEffort ? { effort: turn.metadata.reasoningEffort } : {}),
          }
        : undefined,
    }]
  })
}

export function normalizeEnvFlag(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase()
}

export function shouldUseNoFlicker(interactive: boolean, singleShot?: string, requested = true): boolean {
  if (!interactive || singleShot) return false
  const forced = normalizeEnvFlag(process.env.TURBOFLUX_NO_FLICKER)
  if (forced === '0' || forced === 'false' || forced === 'no' || forced === 'off') return false
  if (forced === '1' || forced === 'true' || forced === 'yes' || forced === 'on') return true
  return requested
}

export function resolveLandingFrameWidth(columns: number): number {
  const safeColumns = Math.max(24, Math.floor(columns))
  return Math.max(24, Math.min(96, Math.max(24, Math.floor(safeColumns * 0.64)), safeColumns - 6))
}

export function shouldShowLandingView(input: {
  messageCount: number
  isRunning: boolean
  hasPendingAsk: boolean
  cursorMode: boolean
  hasOverlay: boolean
  queuedCount: number
}): boolean {
  return input.messageCount === 0
    && !input.isRunning
    && !input.hasPendingAsk
    && !input.cursorMode
    && !input.hasOverlay
    && input.queuedCount === 0
}

export function sliceTurnsBeforeNthUserTurn(turns: AgentTurn[], userTurnOrdinal: number): AgentTurn[] {
  if (userTurnOrdinal < 0) return turns
  let seenUsers = 0
  for (let i = 0; i < turns.length; i++) {
    if (turns[i]?.role !== 'user') continue
    if (seenUsers === userTurnOrdinal) return turns.slice(0, i)
    seenUsers += 1
  }
  return turns
}

export function getEngineUserOrdinalForUiMessage(messages: Message[], turns: AgentTurn[], targetMessageIndex: number): number {
  const engineUserTurns = turns.filter(turn => turn.role === 'user')
  let engineUserOrdinal = 0
  for (let i = 0; i <= targetMessageIndex; i++) {
    const message = messages[i]
    if (!message || message.role !== 'user') continue
    const nextEngineTurn = engineUserTurns[engineUserOrdinal]
    if (i === targetMessageIndex) return engineUserOrdinal
    if (nextEngineTurn?.content === message.content) engineUserOrdinal += 1
  }
  return engineUserOrdinal
}

export function estimateOutputTokensForDisplay(text: string): number {
  const trimmed = text.trim()
  return trimmed ? Math.max(1, Math.ceil(trimmed.length / 4)) : 0
}

export function createThinkingTrace(content: string, startedAt?: number, interrupted = false): ThinkingTrace | undefined {
  if (!content.trim()) return undefined
  const endedAt = Date.now()
  return {
    content,
    isStreaming: false,
    status: interrupted ? 'interrupted' : 'complete',
    source: 'provider',
    startedAt,
    durationMs: startedAt ? Math.max(0, endedAt - startedAt) : undefined,
    tokenCount: Math.max(1, Math.ceil(content.length / 4)),
  }
}
