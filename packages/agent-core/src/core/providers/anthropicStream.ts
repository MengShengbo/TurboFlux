import type { AnthropicThinkingBlock, TokenUsage } from '../../shared/agentTypes'
import {
  BoundedStreamBuffer,
  MAX_STREAM_REASONING_CHARS,
  MAX_STREAM_TEXT_CHARS,
  MAX_STREAM_TOOL_ARGUMENT_CHARS,
  appendBoundedString,
  isOutputLimitFinishReason,
} from '../modelStream'

export interface AnthropicStreamToolCall {
  id: string
  name: string
  argumentsJson: string
}

export interface AnthropicStreamSnapshot {
  text: string
  reasoning: string
  rawReasoningBlocks: AnthropicThinkingBlock[]
  toolCalls: AnthropicStreamToolCall[]
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  sawTerminalEvent: boolean
  interrupted: boolean
  receivedData: boolean
}

export interface AnthropicStreamCallbacks {
  extractReasoningDelta: (delta: unknown) => string
  onTextDelta?: (text: string) => void
  onReasoningDelta?: (text: string) => void
  onToolCallDelta?: (toolCall: AnthropicStreamToolCall) => void
  onUsage?: (usage: TokenUsage) => void
}

export class AnthropicStreamParser {
  private readonly textBuffer = new BoundedStreamBuffer(MAX_STREAM_TEXT_CHARS)
  private readonly reasoningBuffer = new BoundedStreamBuffer(MAX_STREAM_REASONING_CHARS)
  private readonly rawReasoningBlocks: AnthropicThinkingBlock[] = []
  private readonly contentBlockTypes = new Map<number, string>()
  private readonly contentBlockReasoningIndex = new Map<number, number>()
  private readonly toolCallMap = new Map<string, AnthropicStreamToolCall>()
  private inputTokens = 0
  private outputTokens = 0
  private cacheReadTokens = 0
  private cacheCreationTokens = 0
  private sawTerminalEvent = false
  private interrupted = false
  private pendingSseEventType = ''
  private receivedData = false

  constructor(private readonly callbacks: AnthropicStreamCallbacks) {}

  get hasReceivedData(): boolean {
    return this.receivedData
  }

  handleLine(line: string): void {
    this.receivedData = true
    if (line.startsWith('event:')) {
      this.pendingSseEventType = line.slice(6).trim()
      return
    }
    if (!line.startsWith('data:')) return
    const json = line.slice(5).trim()
    if (!json || json === '[DONE]') return

    try {
      const event = JSON.parse(json) as Record<string, any>
      const eventType = event.type || this.pendingSseEventType
      this.pendingSseEventType = ''
      this.handleEvent(eventType, event)
    } catch {}
  }

  snapshot(): AnthropicStreamSnapshot {
    return {
      text: this.textBuffer.toString(),
      reasoning: this.reasoningBuffer.toString(),
      rawReasoningBlocks: this.rawReasoningBlocks.map(block => ({ ...block })),
      toolCalls: [...this.toolCallMap.values()].map(toolCall => ({ ...toolCall })),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheCreationTokens: this.cacheCreationTokens,
      sawTerminalEvent: this.sawTerminalEvent,
      interrupted: this.interrupted,
      receivedData: this.receivedData,
    }
  }

  private handleEvent(eventType: string, event: Record<string, any>): void {
    if (eventType === 'content_block_delta') {
      this.handleContentBlockDelta(event)
      return
    }
    if (eventType === 'content_block_start') {
      this.handleContentBlockStart(event)
      return
    }
    if (eventType === 'message_stop') {
      this.sawTerminalEvent = true
      return
    }
    if (eventType === 'message_delta') {
      this.handleMessageDelta(event)
      return
    }
    if (eventType === 'message_start') this.handleMessageStart(event)
  }

  private handleContentBlockDelta(event: Record<string, any>): void {
    const delta = event.delta
    const reasoningText = this.callbacks.extractReasoningDelta(delta)
    if (reasoningText) {
      const accepted = this.reasoningBuffer.append(reasoningText)
      const blockIndex = typeof event.index === 'number' ? event.index : -1
      if (blockIndex >= 0 && this.contentBlockTypes.get(blockIndex) === 'thinking') {
        const rawIndex = this.contentBlockReasoningIndex.get(blockIndex)
        if (rawIndex !== undefined) {
          const block = this.rawReasoningBlocks[rawIndex]
          if (block?.type === 'thinking') {
            block.thinking = appendBoundedString(
              block.thinking || '',
              accepted,
              MAX_STREAM_REASONING_CHARS,
            )
          }
        }
      }
      if (accepted) this.callbacks.onReasoningDelta?.(accepted)
      return
    }

    if (delta?.type === 'signature_delta' && typeof delta.signature === 'string') {
      const blockIndex = typeof event.index === 'number' ? event.index : -1
      const rawIndex = blockIndex >= 0 ? this.contentBlockReasoningIndex.get(blockIndex) : undefined
      const block = rawIndex === undefined ? undefined : this.rawReasoningBlocks[rawIndex]
      if (block?.type === 'thinking') block.signature = delta.signature
      return
    }

    if (delta?.type === 'text_delta' && delta.text) {
      const accepted = this.textBuffer.append(delta.text)
      if (accepted) this.callbacks.onTextDelta?.(accepted)
      return
    }

    if (delta?.type === 'input_json_delta' && delta.partial_json) {
      const toolCall = this.toolCallMap.get(`idx-${event.index}`)
      if (!toolCall) return
      toolCall.argumentsJson = appendBoundedString(
        toolCall.argumentsJson,
        delta.partial_json,
        MAX_STREAM_TOOL_ARGUMENT_CHARS,
      )
      this.callbacks.onToolCallDelta?.({ ...toolCall })
    }
  }

  private handleContentBlockStart(event: Record<string, any>): void {
    const contentBlock = event.content_block
    if (typeof event.index === 'number' && contentBlock?.type) {
      this.contentBlockTypes.set(event.index, contentBlock.type)
    }
    if (contentBlock?.type === 'thinking') {
      const block: AnthropicThinkingBlock = {
        type: 'thinking',
        thinking: typeof contentBlock.thinking === 'string' ? contentBlock.thinking : '',
        signature: typeof contentBlock.signature === 'string' ? contentBlock.signature : undefined,
      }
      this.rawReasoningBlocks.push(block)
      if (typeof event.index === 'number') {
        this.contentBlockReasoningIndex.set(event.index, this.rawReasoningBlocks.length - 1)
      }
    } else if (contentBlock?.type === 'redacted_thinking' && typeof contentBlock.data === 'string') {
      this.rawReasoningBlocks.push({ type: 'redacted_thinking', data: contentBlock.data })
    }
    if (contentBlock?.type === 'text' && typeof contentBlock.text === 'string' && contentBlock.text) {
      const accepted = this.textBuffer.append(contentBlock.text)
      if (accepted) this.callbacks.onTextDelta?.(accepted)
    }
    if (contentBlock?.type === 'tool_use') {
      const initialInput = contentBlock.input
        && typeof contentBlock.input === 'object'
        && Object.keys(contentBlock.input).length > 0
        ? JSON.stringify(contentBlock.input)
        : ''
      this.toolCallMap.set(`idx-${event.index}`, {
        id: contentBlock.id || `toolu_${event.index}`,
        name: contentBlock.name,
        argumentsJson: initialInput,
      })
    }
  }

  private handleMessageDelta(event: Record<string, any>): void {
    if (event.delta?.stop_reason) {
      this.sawTerminalEvent = true
      this.interrupted = this.interrupted || isOutputLimitFinishReason(event.delta.stop_reason)
    }
    if (event.delta?.signature) {
      for (let index = this.rawReasoningBlocks.length - 1; index >= 0; index -= 1) {
        const block = this.rawReasoningBlocks[index]
        if (block.type === 'thinking') {
          block.signature = event.delta.signature
          break
        }
      }
    }
    if (!event.usage) return
    this.outputTokens = event.usage.output_tokens || 0
    if (typeof event.usage.cache_read_input_tokens === 'number') {
      this.cacheReadTokens = event.usage.cache_read_input_tokens
    }
    if (typeof event.usage.cache_creation_input_tokens === 'number') {
      this.cacheCreationTokens = event.usage.cache_creation_input_tokens
    }
    this.emitUsage()
  }

  private handleMessageStart(event: Record<string, any>): void {
    if (!event.message?.usage) return
    this.inputTokens = event.message.usage.input_tokens || 0
    this.cacheReadTokens = event.message.usage.cache_read_input_tokens || 0
    this.cacheCreationTokens = event.message.usage.cache_creation_input_tokens || 0
    this.emitUsage()
  }

  private emitUsage(): void {
    const input = this.inputTokens + this.cacheReadTokens + this.cacheCreationTokens
    this.callbacks.onUsage?.({
      input,
      output: this.outputTokens,
      cached: this.cacheReadTokens,
      total: input + this.outputTokens,
      source: 'provider',
    })
  }
}
