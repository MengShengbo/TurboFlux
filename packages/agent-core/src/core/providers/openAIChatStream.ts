import type { TokenUsage } from '../../shared/agentTypes'
import {
  BoundedStreamBuffer,
  MAX_STREAM_REASONING_CHARS,
  MAX_STREAM_TEXT_CHARS,
  MAX_STREAM_TOOL_ARGUMENT_CHARS,
  appendBoundedString,
  isOutputLimitFinishReason,
} from '../modelStream'

export interface OpenAIChatStreamToolCall {
  id: string
  name: string
  argumentsJson: string
}

export interface OpenAIChatStreamSnapshot {
  text: string
  reasoning: string
  toolCalls: OpenAIChatStreamToolCall[]
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheMissTokens: number | null
  sawTerminalEvent: boolean
  interrupted: boolean
  receivedData: boolean
}

export interface OpenAIChatStreamCallbacks {
  extractReasoningDelta: (delta: unknown) => string
  onTextDelta?: (text: string) => void
  onReasoningDelta?: (text: string) => void
  onToolCallDelta?: (toolCall: OpenAIChatStreamToolCall) => void
  onUsage?: (usage: TokenUsage) => void
}

export class OpenAIChatStreamParser {
  private readonly textBuffer = new BoundedStreamBuffer(MAX_STREAM_TEXT_CHARS)
  private readonly reasoningBuffer = new BoundedStreamBuffer(MAX_STREAM_REASONING_CHARS)
  private readonly toolCallMap = new Map<number, OpenAIChatStreamToolCall>()
  private inputTokens = 0
  private outputTokens = 0
  private reasoningTokens = 0
  private cacheReadTokens = 0
  private cacheMissTokens: number | null = null
  private sawTerminalEvent = false
  private interrupted = false
  private receivedData = false

  constructor(private readonly callbacks: OpenAIChatStreamCallbacks) {}

  get hasReceivedData(): boolean {
    return this.receivedData
  }

  handleLine(line: string): void {
    this.receivedData = true
    if (!line.startsWith('data:')) return
    const json = line.slice(5).trim()
    if (json === '[DONE]') {
      this.sawTerminalEvent = true
      return
    }
    if (!json) return

    try {
      const chunk = JSON.parse(json) as Record<string, any>
      this.handleUsage(chunk.usage)

      const choice = chunk.choices?.[0]
      if (!choice) return
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        this.sawTerminalEvent = true
        this.interrupted = this.interrupted || isOutputLimitFinishReason(choice.finish_reason)
      }

      const delta = choice.delta
      if (!delta) return
      const reasoningText = this.callbacks.extractReasoningDelta(delta)
      if (reasoningText) {
        const accepted = this.reasoningBuffer.append(reasoningText)
        if (accepted) this.callbacks.onReasoningDelta?.(accepted)
      }
      if (delta.content) {
        const accepted = this.textBuffer.append(delta.content)
        if (accepted) this.callbacks.onTextDelta?.(accepted)
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const toolCall of delta.tool_calls) this.handleToolCallDelta(toolCall)
      }
    } catch {}
  }

  snapshot(): OpenAIChatStreamSnapshot {
    return {
      text: this.textBuffer.toString(),
      reasoning: this.reasoningBuffer.toString(),
      toolCalls: [...this.toolCallMap.values()].map(toolCall => ({ ...toolCall })),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      reasoningTokens: this.reasoningTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheMissTokens: this.cacheMissTokens,
      sawTerminalEvent: this.sawTerminalEvent,
      interrupted: this.interrupted,
      receivedData: this.receivedData,
    }
  }

  private handleUsage(usage: Record<string, any> | undefined): void {
    if (!usage) return
    this.inputTokens = usage.prompt_tokens || this.inputTokens
    this.outputTokens = usage.completion_tokens || this.outputTokens
    const reportedReasoningTokens = usage.completion_tokens_details?.reasoning_tokens
      ?? usage.output_tokens_details?.reasoning_tokens
    if (typeof reportedReasoningTokens === 'number') this.reasoningTokens = reportedReasoningTokens

    const openaiCached = usage.prompt_tokens_details?.cached_tokens
    if (typeof openaiCached === 'number') this.cacheReadTokens = openaiCached
    if (typeof usage.prompt_cache_hit_tokens === 'number') {
      this.cacheReadTokens = usage.prompt_cache_hit_tokens
    }
    if (typeof usage.prompt_cache_miss_tokens === 'number') {
      this.cacheMissTokens = usage.prompt_cache_miss_tokens
    }
    this.callbacks.onUsage?.({
      input: this.inputTokens,
      output: this.outputTokens,
      cached: this.cacheReadTokens,
      total: this.inputTokens + this.outputTokens,
      source: 'provider',
    })
  }

  private handleToolCallDelta(toolCall: Record<string, any>): void {
    const index = toolCall.index ?? 0
    if (!this.toolCallMap.has(index)) {
      this.toolCallMap.set(index, {
        id: toolCall.id || `tc-${index}`,
        name: toolCall.function?.name || '',
        argumentsJson: '',
      })
    }
    const entry = this.toolCallMap.get(index)!
    if (toolCall.id) entry.id = toolCall.id
    if (toolCall.function?.name) entry.name = toolCall.function.name
    if (!toolCall.function?.arguments) return
    entry.argumentsJson = appendBoundedString(
      entry.argumentsJson,
      toolCall.function.arguments,
      MAX_STREAM_TOOL_ARGUMENT_CHARS,
    )
    this.callbacks.onToolCallDelta?.({ ...entry })
  }
}
