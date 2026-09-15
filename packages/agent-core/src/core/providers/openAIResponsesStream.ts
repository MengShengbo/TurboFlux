import type { TokenUsage } from '../../shared/agentTypes'
import {
  MAX_STREAM_REASONING_CHARS,
  MAX_STREAM_TEXT_CHARS,
  MAX_STREAM_TOOL_ARGUMENT_CHARS,
  appendBoundedString,
  extractResponsesReasoningEventDelta,
  extractResponsesReasoningSummary,
} from '../modelStream'

export interface OpenAIResponsesStreamToolCall {
  id: string
  name: string
  argumentsJson: string
}

export interface OpenAIResponsesStreamSnapshot {
  text: string
  reasoning: string
  toolCalls: OpenAIResponsesStreamToolCall[]
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  sawTerminalEvent: boolean
  streamFailure: string
  receivedData: boolean
}

export interface OpenAIResponsesStreamCallbacks {
  onTextDelta?: (text: string) => void
  onReasoningDelta?: (text: string) => void
  onToolCallDelta?: (toolCall: OpenAIResponsesStreamToolCall) => void
  onUsage?: (usage: TokenUsage) => void
}

export class OpenAIResponsesStreamParser {
  private textContent = ''
  private reasoningContent = ''
  private inputTokens = 0
  private outputTokens = 0
  private reasoningTokens = 0
  private cacheReadTokens = 0
  private sawTerminalEvent = false
  private streamFailure = ''
  private receivedData = false
  private readonly toolCallMap = new Map<string, OpenAIResponsesStreamToolCall>()
  private readonly toolCallAliases = new Map<string, string>()

  constructor(private readonly callbacks: OpenAIResponsesStreamCallbacks = {}) {}

  get hasReceivedData(): boolean {
    return this.receivedData
  }

  handleLine(line: string): void {
    this.receivedData = true
    if (!line.startsWith('data:')) return
    const json = line.slice(5).trim()
    if (!json || json === '[DONE]') return

    try {
      const event = JSON.parse(json) as Record<string, any>
      this.handleEvent(event)
    } catch {}
  }

  snapshot(): OpenAIResponsesStreamSnapshot {
    return {
      text: this.textContent,
      reasoning: this.reasoningContent,
      toolCalls: [...this.toolCallMap.values()].map(toolCall => ({ ...toolCall })),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      reasoningTokens: this.reasoningTokens,
      cacheReadTokens: this.cacheReadTokens,
      sawTerminalEvent: this.sawTerminalEvent,
      streamFailure: this.streamFailure,
      receivedData: this.receivedData,
    }
  }

  private handleEvent(event: Record<string, any>): void {
    const eventType = event.type
    const reasoningDelta = extractResponsesReasoningEventDelta(event)
    if (reasoningDelta) {
      const accepted = appendBoundedString(
        '',
        reasoningDelta,
        Math.max(0, MAX_STREAM_REASONING_CHARS - this.reasoningContent.length),
      )
      this.reasoningContent += accepted
      if (accepted) this.callbacks.onReasoningDelta?.(accepted)
      return
    }

    if (eventType === 'response.output_text.delta' || eventType === 'response.refusal.delta') {
      if (typeof event.delta === 'string' && event.delta) {
        const accepted = appendBoundedString(
          '',
          event.delta,
          Math.max(0, MAX_STREAM_TEXT_CHARS - this.textContent.length),
        )
        this.textContent += accepted
        if (accepted) this.callbacks.onTextDelta?.(accepted)
      }
      return
    }

    if (eventType === 'response.output_item.added' || eventType === 'response.output_item.done') {
      if (event.item?.type === 'function_call') this.ensureToolCall(event.item, event.output_index)
      return
    }

    if (eventType === 'response.function_call_arguments.delta' || eventType === 'response.function_call_arguments.done') {
      this.handleToolCallArguments(event, eventType.endsWith('.done'))
      return
    }

    if (eventType === 'response.completed') {
      this.sawTerminalEvent = true
      this.harvestCompletedOutput(event.response)
      return
    }

    if (eventType === 'response.incomplete' || eventType === 'response.failed') {
      this.sawTerminalEvent = true
      this.harvestCompletedOutput(event.response)
      this.streamFailure = event.response?.error?.message
        || event.response?.incomplete_details?.reason
        || `${eventType}: provider did not complete the response`
      return
    }

    if (eventType === 'error') {
      this.sawTerminalEvent = true
      this.streamFailure = event.error?.message || event.message || 'Responses stream returned an error event'
    }
  }

  private ensureToolCall(item: Record<string, any>, outputIndex?: number): OpenAIResponsesStreamToolCall {
    const id = typeof item.call_id === 'string' && item.call_id
      ? item.call_id
      : typeof item.id === 'string' && item.id
        ? item.id
        : `call_${outputIndex ?? this.toolCallMap.size}`
    let entry = this.toolCallMap.get(id)
    if (!entry) {
      entry = {
        id,
        name: typeof item.name === 'string' ? item.name : '',
        argumentsJson: typeof item.arguments === 'string' ? item.arguments : '',
      }
      this.toolCallMap.set(id, entry)
    } else {
      if (typeof item.name === 'string' && item.name) entry.name = item.name
      if (typeof item.arguments === 'string' && item.arguments) entry.argumentsJson = item.arguments
    }
    if (typeof item.id === 'string') this.toolCallAliases.set(item.id, id)
    if (typeof item.call_id === 'string') this.toolCallAliases.set(item.call_id, id)
    if (typeof outputIndex === 'number') this.toolCallAliases.set(`idx-${outputIndex}`, id)
    return entry
  }

  private handleToolCallArguments(event: Record<string, any>, complete: boolean): void {
    const alias = typeof event.item_id === 'string'
      ? event.item_id
      : typeof event.call_id === 'string'
        ? event.call_id
        : `idx-${event.output_index ?? 0}`
    const canonicalId = this.toolCallAliases.get(alias) || alias
    const entry = this.toolCallMap.get(canonicalId)
      || this.ensureToolCall({ call_id: canonicalId, name: event.name || '' }, event.output_index)
    if (complete && typeof event.arguments === 'string') {
      entry.argumentsJson = event.arguments
    } else if (typeof event.delta === 'string') {
      entry.argumentsJson = appendBoundedString(entry.argumentsJson, event.delta, MAX_STREAM_TOOL_ARGUMENT_CHARS)
    }
    this.callbacks.onToolCallDelta?.({ ...entry })
  }

  private updateUsage(usage: Record<string, any> | undefined): void {
    if (!usage) return
    this.inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : this.inputTokens
    this.outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : this.outputTokens
    const reportedReasoningTokens = usage.output_tokens_details?.reasoning_tokens
    if (typeof reportedReasoningTokens === 'number') this.reasoningTokens = reportedReasoningTokens
    const cached = usage.input_tokens_details?.cached_tokens
    if (typeof cached === 'number') this.cacheReadTokens = cached
    this.callbacks.onUsage?.({
      input: this.inputTokens,
      output: this.outputTokens,
      cached: this.cacheReadTokens,
      total: this.inputTokens + this.outputTokens,
      source: 'provider',
    })
  }

  private harvestCompletedOutput(response: Record<string, any> | undefined): void {
    this.updateUsage(response?.usage)
    if (!Array.isArray(response?.output)) return
    const completedReasoning = extractResponsesReasoningSummary(response.output)
    if (completedReasoning && completedReasoning !== this.reasoningContent) {
      const delta = completedReasoning.startsWith(this.reasoningContent)
        ? completedReasoning.slice(this.reasoningContent.length)
        : this.reasoningContent
          ? `\n\n${completedReasoning}`
          : completedReasoning
      const accepted = appendBoundedString(
        '',
        delta,
        Math.max(0, MAX_STREAM_REASONING_CHARS - this.reasoningContent.length),
      )
      this.reasoningContent += accepted
      if (accepted) this.callbacks.onReasoningDelta?.(accepted)
    }
    for (const item of response.output) {
      if (!item || typeof item !== 'object') continue
      if (item.type === 'function_call') {
        this.ensureToolCall(item)
        continue
      }
      if (item.type !== 'message' || this.textContent) continue
      const completedText = Array.isArray(item.content)
        ? item.content
            .filter((part: any) => part?.type === 'output_text' && typeof part.text === 'string')
            .map((part: any) => part.text)
            .join('')
        : ''
      if (!completedText) continue
      const accepted = appendBoundedString(
        '',
        completedText,
        Math.max(0, MAX_STREAM_TEXT_CHARS - this.textContent.length),
      )
      this.textContent += accepted
      if (accepted) this.callbacks.onTextDelta?.(accepted)
    }
  }
}
