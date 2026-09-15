export const MAX_STREAM_TEXT_CHARS = 8 * 1024 * 1024
export const MAX_STREAM_REASONING_CHARS = 8 * 1024 * 1024
export const MAX_STREAM_TOOL_ARGUMENT_CHARS = 1 * 1024 * 1024

export function isOutputLimitFinishReason(value: unknown): boolean {
  return typeof value === 'string' && /^(?:length|max_tokens|max_output_tokens)$/i.test(value)
}

export class BoundedStreamBuffer {
  private readonly chunks: string[] = []
  private length = 0
  private truncated = false

  constructor(private readonly maxChars: number) {}

  append(value: string): string {
    if (!value || this.length >= this.maxChars) {
      if (value) this.truncated = true
      return ''
    }
    const remaining = this.maxChars - this.length
    const accepted = value.length > remaining ? value.slice(0, remaining) : value
    if (accepted) {
      this.chunks.push(accepted)
      this.length += accepted.length
    }
    if (accepted.length < value.length) this.truncated = true
    return accepted
  }

  toString(): string {
    const value = this.chunks.join('')
    return this.truncated
      ? `${value}\n\n[stream output truncated after ${this.maxChars.toLocaleString()} characters]`
      : value
  }
}

export function appendBoundedString(current: string, value: string, maxChars: number): string {
  if (!value || current.length >= maxChars) return current
  const remaining = maxChars - current.length
  return current + value.slice(0, remaining)
}

export function extractResponsesReasoningSummary(output: unknown): string {
  if (!Array.isArray(output)) return ''
  const summaries: string[] = []
  for (const item of output) {
    if (!item || typeof item !== 'object' || (item as Record<string, unknown>).type !== 'reasoning') continue
    const record = item as Record<string, unknown>
    for (const collection of [record.summary, record.content]) {
      if (!Array.isArray(collection)) continue
      for (const part of collection) {
        if (typeof part === 'string' && part.trim()) {
          summaries.push(part)
          continue
        }
        if (!part || typeof part !== 'object') continue
        const text = (part as Record<string, unknown>).text
        if (typeof text === 'string' && text.trim()) summaries.push(text)
      }
    }
  }
  return summaries.join('\n\n')
}

export function extractResponsesReasoningEventDelta(event: unknown): string {
  if (!event || typeof event !== 'object') return ''
  const record = event as Record<string, unknown>
  const eventType = typeof record.type === 'string' ? record.type : ''
  if (!/^response\.(?:reasoning(?:_summary(?:_text)?|_text)?|thinking|analysis)\.delta$/i.test(eventType)) {
    return ''
  }

  const delta = record.delta
  if (typeof delta === 'string') return delta
  if (!delta || typeof delta !== 'object') return ''
  const value = delta as Record<string, unknown>
  for (const candidate of [value.text, value.content, value.reasoning_content, value.reasoning]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return ''
}

export function hasCompleteToolPayloads(calls: Array<{ name: string; argumentsJson: string }>): boolean {
  if (calls.length === 0) return false
  return calls.every(call => {
    if (!call.name.trim()) return false
    try {
      JSON.parse(call.argumentsJson || '{}')
      return true
    } catch {
      return false
    }
  })
}
