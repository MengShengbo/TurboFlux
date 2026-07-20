import type { AgentTurn, ThinkingTrace } from '../../shared/agentTypes'
import type { ModelPreset } from '../../core/config'
import type { ModelDiscoveryResult } from '../../core/modelDiscovery'
import type { Message } from './messages/Messages'
import type { ToolStatus } from './tools/ToolCallTree'

function isMessageRole(role: string): role is Message['role'] {
  return role === 'user' || role === 'assistant' || role === 'system'
}

export function formatTaskToolSummary(completed: number, total: number, running: number, errored: number): string {
  if (total === 0) return 'planning'
  const parts = [`tools ${completed}/${total}`]
  if (running > 0) parts.push(`${running} running`)
  if (errored > 0) parts.push(`${errored} failed`)
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
  hasToolOutput: boolean,
  interrupted: boolean,
): { visibleText: string; thinkingText: string } {
  if (!interrupted && !hasToolOutput && !visibleText.trim() && thinkingText.trim()) {
    return { visibleText: thinkingText, thinkingText: '' }
  }
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

export function formatTaskProgressLabel(progress: number): string {
  if (progress >= 95 && progress < 100) return 'finishing'
  if (progress > 0 && progress < 95) return `${Math.round(progress)}%`
  return ''
}

export function formatTaskToolName(name: string): string {
  switch (name) {
    case 'read_file': return 'read'
    case 'read_file_full': return 'read full'
    case 'search_content': return 'search'
    case 'search_files': return 'find files'
    case 'search_symbols': return 'symbols'
    case 'get_codemap': return 'codemap'
    case 'write_file': return 'write'
    case 'replace_file': return 'replace'
    case 'edit_file': return 'edit'
    case 'multi_edit': return 'multi-edit'
    case 'run_command': return 'shell'
    case 'read_terminal': return 'read terminal'
    case 'write_terminal': return 'write terminal'
    case 'list_terminals': return 'list terminals'
    case 'kill_terminal': return 'stop terminal'
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
