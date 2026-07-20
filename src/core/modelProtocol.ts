import type { APIConfig } from '../state/types'
import { normalizeBaseUrl } from './normalizeBaseUrl'

export type ModelProtocol = 'anthropic_messages' | 'openai_chat' | 'openai_responses'

export type ModelProtocolErrorKind = 'http' | 'network' | 'response_shape' | 'stream' | 'internal'

export interface ModelProtocolAttempt {
  protocol: ModelProtocol
  url: string
  status?: number
  error: string
  receivedStreamData: boolean
  fallbackAllowed: boolean
}

export interface ModelProtocolErrorOptions {
  protocol: ModelProtocol
  url: string
  status?: number
  kind?: ModelProtocolErrorKind
  receivedStreamData?: boolean
}

const PROTOCOL_LABELS: Record<ModelProtocol, string> = {
  anthropic_messages: 'Anthropic Messages',
  openai_chat: 'OpenAI Chat Completions',
  openai_responses: 'OpenAI Responses',
}

const PROTOCOL_PATHS: Record<ModelProtocol, string> = {
  anthropic_messages: '/messages',
  openai_chat: '/chat/completions',
  openai_responses: '/responses',
}

const DIRECT_FALLBACK_STATUSES = new Set([404, 405, 415])
const NEVER_CROSS_PROTOCOL_STATUSES = new Set([401, 403, 408, 409, 425, 429])
const PROTOCOL_MISMATCH_DETAIL = new RegExp([
  '(?:unknown|unsupported|unrecognized|invalid|missing|required|expected|must provide|does not support|not found)',
  '.{0,100}',
  '(?:endpoint|route|path|url|schema|payload|request format|model|messages|input|max_tokens|anthropic-version|x-api-key|authorization|content-type|tool_choice|tools|stream|thinking|output_config|cache_control)',
  '|(?:endpoint|route|path|url|schema|payload|request format|model|messages|input|max_tokens|anthropic-version|x-api-key|authorization|content-type|thinking|output_config|cache_control)',
  '.{0,100}',
  '(?:unknown|unsupported|unrecognized|invalid|missing|required|expected|not found)',
].join(''), 'i')

export class ModelProtocolRequestError extends Error {
  readonly protocol: ModelProtocol
  readonly url: string
  readonly status?: number
  readonly kind: ModelProtocolErrorKind
  readonly receivedStreamData: boolean

  constructor(message: string, options: ModelProtocolErrorOptions) {
    super(compactProtocolError(message))
    this.name = 'ModelProtocolRequestError'
    this.protocol = options.protocol
    this.url = options.url
    this.status = options.status
    this.kind = options.kind || (options.status ? 'http' : 'internal')
    this.receivedStreamData = options.receivedStreamData === true
  }
}

export function protocolLabel(protocol: ModelProtocol): string {
  return PROTOCOL_LABELS[protocol]
}

export function protocolPath(protocol: ModelProtocol): string {
  return PROTOCOL_PATHS[protocol]
}

export function buildModelProtocolUrl(baseUrl: string, protocol: ModelProtocol): string {
  return `${normalizeBaseUrl(baseUrl)}${protocolPath(protocol)}`
}

export function planModelProtocols(provider: APIConfig['provider'], model: string): ModelProtocol[] {
  if (provider === 'anthropic' || looksLikeClaudeModel(model)) {
    return ['anthropic_messages', 'openai_chat', 'openai_responses']
  }
  if (provider === 'openai' || looksLikeResponsesPreferredModel(model)) {
    return ['openai_responses', 'openai_chat', 'anthropic_messages']
  }
  return ['openai_chat', 'openai_responses', 'anthropic_messages']
}

export function looksLikeClaudeModel(model: string): boolean {
  return /(?:^|[/_.:-])claude(?:$|[/_.:-])/i.test(model.trim())
}

export function looksLikeResponsesPreferredModel(model: string): boolean {
  return /(?:^|[/_.:-])(?:gpt-5(?:$|[/_.:-])|o[1-9](?:$|[/_.:-])|codex(?:$|[/_.:-]))/i.test(model.trim())
}

export function shouldFallbackProtocol(error: ModelProtocolRequestError): boolean {
  if (error.receivedStreamData) return false
  if (error.kind === 'response_shape') return true
  if (error.status === undefined) return false
  if (NEVER_CROSS_PROTOCOL_STATUSES.has(error.status) || error.status >= 500) return false
  if (DIRECT_FALLBACK_STATUSES.has(error.status)) return true
  if (error.status === 400 || error.status === 422) {
    return PROTOCOL_MISMATCH_DETAIL.test(error.message)
  }
  return false
}

export function toProtocolAttempt(error: ModelProtocolRequestError): ModelProtocolAttempt {
  return {
    protocol: error.protocol,
    url: error.url,
    status: error.status,
    error: error.message,
    receivedStreamData: error.receivedStreamData,
    fallbackAllowed: shouldFallbackProtocol(error),
  }
}

export function formatProtocolAttempt(attempt: ModelProtocolAttempt): string {
  const status = attempt.status ? `HTTP ${attempt.status}` : attempt.receivedStreamData ? 'stream error' : 'request error'
  const detail = attempt.status && new RegExp(`^HTTP\\s+${attempt.status}\\b`, 'i').test(attempt.error)
    ? attempt.error
    : `${status}: ${attempt.error}`
  return `${protocolLabel(attempt.protocol)} ${attempt.url} — ${detail}`
}

export function formatProtocolFailure(attempts: ModelProtocolAttempt[]): string {
  if (attempts.length === 0) return 'Model request failed before a protocol attempt was recorded.'
  const lines = attempts.map((attempt, index) => `${index + 1}. ${formatProtocolAttempt(attempt)}`)
  return `All compatible model protocols failed:\n${lines.join('\n')}`
}

export function compactProtocolError(message: string, maxLength = 700): string {
  const compact = String(message || 'Model request failed').replace(/\s+/g, ' ').trim()
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact
}

export function toResponsesTools(tools: unknown[]): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = []
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    const record = tool as Record<string, unknown>
    const fn = record.function && typeof record.function === 'object'
      ? record.function as Record<string, unknown>
      : null
    if (record.type !== 'function' || !fn || typeof fn.name !== 'string') continue
    converted.push({
      type: 'function',
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : undefined,
      parameters: fn.parameters && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} },
      ...(typeof fn.strict === 'boolean' ? { strict: fn.strict } : {}),
    })
  }
  return converted
}

export function toResponsesInput(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = []
  for (const message of messages) {
    const role = typeof message.role === 'string' ? message.role : ''
    if (role === 'system' || role === 'developer') continue

    if (role === 'tool') {
      const callId = typeof message.tool_call_id === 'string' ? message.tool_call_id : ''
      if (!callId) continue
      input.push({
        type: 'function_call_output',
        call_id: callId,
        output: stringifyResponseContent(message.content),
      })
      continue
    }

    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      if (hasResponseContent(message.content)) {
        input.push({ role: 'assistant', content: convertResponseMessageContent(message.content) })
      }
      for (const toolCall of message.tool_calls) {
        if (!toolCall || typeof toolCall !== 'object') continue
        const record = toolCall as Record<string, unknown>
        const fn = record.function && typeof record.function === 'object'
          ? record.function as Record<string, unknown>
          : null
        if (!fn || typeof fn.name !== 'string') continue
        const callId = typeof record.id === 'string' && record.id ? record.id : `call_${input.length}`
        input.push({
          type: 'function_call',
          call_id: callId,
          name: fn.name,
          arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}),
        })
      }
      continue
    }

    if (role === 'user' || role === 'assistant') {
      input.push({ role, content: convertResponseMessageContent(message.content) })
    }
  }
  return input
}

function hasResponseContent(content: unknown): boolean {
  if (typeof content === 'string') return Boolean(content)
  return Array.isArray(content) && content.length > 0
}

function stringifyResponseContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === undefined || content === null) return ''
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function convertResponseMessageContent(content: unknown): unknown {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : stringifyResponseContent(content)
  return content.map(block => {
    if (!block || typeof block !== 'object') return { type: 'input_text', text: String(block) }
    const record = block as Record<string, unknown>
    if (record.type === 'text') return { type: 'input_text', text: typeof record.text === 'string' ? record.text : '' }
    if (record.type === 'image_url') {
      const imageUrl = record.image_url && typeof record.image_url === 'object'
        ? (record.image_url as Record<string, unknown>).url
        : record.image_url
      return { type: 'input_image', image_url: imageUrl }
    }
    return record
  })
}
