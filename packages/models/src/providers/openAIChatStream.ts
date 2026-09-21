import type { TokenUsage } from '@turboflux/contracts/agentTypes'
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
  onResponseId?: (id: string) => void
}

export class OpenAIChatStreamParser {
  private readonly textBuffer = new BoundedStreamBuffer(MAX_STREAM_TEXT_CHARS)
  private readonly reasoningBuffer = new BoundedStreamBuffer(MAX_STREAM_REASONING_CHARS)
  private readonly toolCallMap = new Map<number, OpenAIChatStreamToolCall>()
  private usage: TokenUsage = { source: 'unknown' }
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
      if (typeof chunk.id === 'string') this.callbacks.onResponseId?.(chunk.id)
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
    const numeric = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
    if (numeric(usage.prompt_tokens)) this.usage.input = this.inputTokens = usage.prompt_tokens
    if (numeric(usage.completion_tokens)) this.usage.output = this.outputTokens = usage.completion_tokens
    const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens
    if (numeric(reasoning)) this.usage.reasoning = this.reasoningTokens = reasoning
    const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens
    if (numeric(cached)) this.usage.cached = this.cacheReadTokens = cached
    if (numeric(usage.prompt_cache_miss_tokens)) this.cacheMissTokens = usage.prompt_cache_miss_tokens
    if (this.usage.input === undefined && this.usage.output === undefined) return
    this.usage.source = 'provider'
    if (this.usage.input !== undefined && this.usage.output !== undefined) this.usage.total = this.usage.input + this.usage.output
    this.callbacks.onUsage?.({ ...this.usage })
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
