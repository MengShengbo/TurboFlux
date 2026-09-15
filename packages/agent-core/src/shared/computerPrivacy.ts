import type { AgentTurn, ToolCall, ToolResult } from './agentTypes'
import { isBuiltInComputerTool } from './computerToolPresentation'
import type { ContextHandoff, ContextHandoffFacts, ContextReservoirEntry, ContextSegment } from '../state/types'

export const COMPUTER_RESULT_REDACTED = '[Computer operation details are ephemeral and were not persisted. Observe the current application again before continuing.]'
export const COMPUTER_ERROR_REDACTED = '[Computer operation failed. Details were not persisted; observe the current application again before retrying.]'
export const COMPUTER_DETAIL_REDACTED = '[redacted computer detail]'

function computerResultMessage(result: Pick<ToolResult, 'isError'>): string {
  return result.isError ? COMPUTER_ERROR_REDACTED : COMPUTER_RESULT_REDACTED
}

export function redactComputerToolCall(toolCall: ToolCall): ToolCall {
  if (!isBuiltInComputerTool(toolCall.name)) return toolCall
  return {
    id: toolCall.id,
    name: toolCall.name,
    arguments: {},
  }
}

export function redactComputerToolResult(toolResult: ToolResult): ToolResult {
  if (!isBuiltInComputerTool(toolResult.name)) return toolResult
  return {
    toolCallId: toolResult.toolCallId,
    name: toolResult.name,
    output: computerResultMessage(toolResult),
    isError: toolResult.isError,
    errorKind: toolResult.errorKind,
  }
}

function persistedToolResultContent(results: ToolResult[]): string {
  return results
    .map(result => `${result.name}: ${result.isError ? '[failed]' : '[ok]'} ${(result.output || '').slice(0, 500)}`)
    .join('\n\n')
}

export function turnContainsComputerActivity(turn: AgentTurn): boolean {
  return Boolean(
    turn.toolCalls?.some(toolCall => isBuiltInComputerTool(toolCall.name))
    || turn.toolResults?.some(toolResult => isBuiltInComputerTool(toolResult.name)),
  )
}

export function redactComputerTurn(turn: AgentTurn): AgentTurn {
  if (!turnContainsComputerActivity(turn)) return turn
  const toolCalls = turn.toolCalls?.map(redactComputerToolCall)
  const toolResults = turn.toolResults?.map(redactComputerToolResult)
  return {
    ...turn,
    content: turn.role === 'tool_result' && toolResults
      ? persistedToolResultContent(toolResults)
      : turn.content,
    toolCalls,
    toolResults,
  }
}

export function redactComputerTurns(turns: AgentTurn[]): AgentTurn[] {
  return turns.map(redactComputerTurn)
}

function computerTurnsForSegment(segment: ContextSegment, turns: AgentTurn[]): AgentTurn[] {
  if (segment.coveredTurnIds?.length) {
    const covered = new Set(segment.coveredTurnIds)
    return turns.filter(turn => covered.has(turn.id) && turnContainsComputerActivity(turn))
  }
  const startIndex = turns.findIndex(turn => turn.id === segment.startMessageId)
  const endIndex = turns.findIndex(turn => turn.id === segment.endMessageId)
  if (startIndex >= 0 && endIndex >= startIndex) {
    return turns.slice(startIndex, endIndex + 1).filter(turnContainsComputerActivity)
  }
  return []
}

function collectSensitiveValue(value: unknown, values: Set<string>, seen: WeakSet<object>): void {
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (normalized.length >= 3) values.add(normalized)
    return
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = String(value)
    if (normalized.length >= 3) values.add(normalized)
    return
  }
  if (!value || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveValue(item, values, seen)
    return
  }
  for (const item of Object.values(value)) collectSensitiveValue(item, values, seen)
}

function collectComputerSensitiveValues(turns: AgentTurn[]): Set<string> {
  const values = new Set<string>()
  const seen = new WeakSet<object>()
  for (const turn of turns) {
    for (const toolCall of turn.toolCalls || []) {
      if (!isBuiltInComputerTool(toolCall.name)) continue
      collectSensitiveValue(toolCall.arguments, values, seen)
    }
    for (const toolResult of turn.toolResults || []) {
      if (!isBuiltInComputerTool(toolResult.name)) continue
      collectSensitiveValue(toolResult.output, values, seen)
      try {
        collectSensitiveValue(JSON.parse(toolResult.output), values, seen)
      } catch {}
      collectSensitiveValue(toolResult.attachments, values, seen)
    }
  }
  return values
}

function redactSensitiveText(text: string, values: Set<string>): string {
  let redacted = text
  for (const value of [...values].sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(value).join(COMPUTER_DETAIL_REDACTED)
  }
  return redacted
}

function segmentHasComputerActivity(segment: ContextSegment, computerTurns: AgentTurn[]): boolean {
  const facts = segment.handoff?.facts
  return computerTurns.length > 0 || Boolean(
    facts?.commands.some(command => isBuiltInComputerTool(command.tool))
    || facts?.errors.some(error => isBuiltInComputerTool(error.tool))
    || segment.summary.includes('computer__')
    || segment.handoff?.modelSummary.includes('computer__'),
  )
}

function redactComputerHandoffFacts(facts: ContextHandoffFacts, sensitiveValues: Set<string>): ContextHandoffFacts {
  return {
    ...facts,
    files: facts.files.map(file => ({ ...file, operations: [...file.operations] })),
    commands: facts.commands
      .filter(command => !isBuiltInComputerTool(command.tool))
      .map(command => ({
        ...command,
        command: redactSensitiveText(command.command, sensitiveValues),
        result: command.result ? redactSensitiveText(command.result, sensitiveValues) : undefined,
      })),
    decisions: facts.decisions.map(decision => ({ ...decision })),
    errors: facts.errors
      .filter(error => !isBuiltInComputerTool(error.tool))
      .map(error => ({ ...error })),
    progress: facts.progress.map(progress => ({
      ...progress,
      text: redactSensitiveText(progress.text, sensitiveValues),
    })),
    workspace: {
      ...facts.workspace,
      activeTask: facts.workspace.activeTask
        ? redactSensitiveText(facts.workspace.activeTask, sensitiveValues)
        : undefined,
    },
  }
}

function redactComputerHandoff(handoff: ContextHandoff, sensitiveValues: Set<string>): ContextHandoff {
  return {
    ...handoff,
    modelSummary: redactSensitiveText(handoff.modelSummary, sensitiveValues),
    facts: redactComputerHandoffFacts(handoff.facts, sensitiveValues),
    document: redactSensitiveText(handoff.document, sensitiveValues),
    compactDocument: redactSensitiveText(handoff.compactDocument, sensitiveValues),
  }
}

export function redactComputerSegment(segment: ContextSegment, turns: AgentTurn[]): ContextSegment {
  const computerTurns = computerTurnsForSegment(segment, turns)
  if (!segmentHasComputerActivity(segment, computerTurns)) return segment
  const sensitiveValues = collectComputerSensitiveValues(computerTurns)
  return {
    ...segment,
    summary: redactSensitiveText(segment.summary, sensitiveValues),
    handoff: segment.handoff ? redactComputerHandoff(segment.handoff, sensitiveValues) : undefined,
  }
}

export function redactComputerContextSegments(segments: ContextSegment[], turns: AgentTurn[]): ContextSegment[] {
  return segments.map(segment => redactComputerSegment(segment, turns))
}

export function redactComputerReservoir(entries: ContextReservoirEntry[]): ContextReservoirEntry[] {
  return entries.map(entry => ({
    ...entry,
    turns: redactComputerTurns(entry.turns),
  }))
}
