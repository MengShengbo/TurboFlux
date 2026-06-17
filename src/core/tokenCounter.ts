import { getEncoding, type Tiktoken, type TiktokenEncoding } from 'js-tiktoken'
import { resolveTokenizerForModel } from './modelRegistry'

export type TokenCountSource = 'provider' | 'tokenizer' | 'estimate' | 'unavailable'

export interface TokenCountResult {
  tokens: number
  source: TokenCountSource
  tokenizer?: string
  reason?: string
}

interface CountOptions {
  provider?: string
  model?: string
  allowEstimate?: boolean
}

const encoderCache = new Map<TiktokenEncoding, Tiktoken>()

function resolveEncodingName(options: CountOptions): TiktokenEncoding | null {
  void options.provider
  return resolveTokenizerForModel(options.model) ?? null
}

function getEncoder(name: TiktokenEncoding): Tiktoken {
  const cached = encoderCache.get(name)
  if (cached) return cached
  const encoder = getEncoding(name)
  encoderCache.set(name, encoder)
  return encoder
}

export function roughTokenCountEstimation(text: string, bytesPerToken = 4): number {
  return Math.max(0, Math.round((text || '').length / bytesPerToken))
}

function estimatedCount(text: string, options: CountOptions): TokenCountResult {
  return {
    tokens: roughTokenCountEstimation(text),
    source: 'estimate',
    reason: `Rough token estimate for model "${options.model || 'unknown'}" (${options.provider || 'unknown provider'}): characters / 4`,
  }
}

export function countTextTokens(text: string, options: CountOptions = {}): TokenCountResult {
  const encodingName = resolveEncodingName(options)
  if (!encodingName) {
    if (options.allowEstimate !== false) {
      return estimatedCount(text || '', options)
    }
    return {
      tokens: 0,
      source: 'unavailable',
      reason: `No tokenizer mapping for model "${options.model || 'unknown'}" (${options.provider || 'unknown provider'})`,
    }
  }

  const encoder = getEncoder(encodingName)
  return {
    tokens: encoder.encode(text || '').length,
    source: 'tokenizer',
    tokenizer: encodingName,
  }
}

export function countValueTokens(value: unknown, options: CountOptions = {}): TokenCountResult {
  if (typeof value === 'string') return countTextTokens(value, options)
  return countTextTokens(JSON.stringify(value ?? ''), options)
}

export function countMessagesTokens(messages: Array<Record<string, unknown>>, options: CountOptions = {}): TokenCountResult {
  let total = 0
  let tokenizer: string | undefined
  let usedEstimate = false
  for (const message of messages) {
    const count = countValueTokens(message, options)
    if (count.source === 'unavailable') return count
    total += count.tokens + 4
    tokenizer = count.tokenizer
    if (count.source === 'estimate') usedEstimate = true
  }
  return usedEstimate
    ? { tokens: total, source: 'estimate', reason: `Rough message token estimate for model "${options.model || 'unknown'}" (${options.provider || 'unknown provider'})` }
    : { tokens: total, source: 'tokenizer', tokenizer }
}

export function countTurnishTokens(value: unknown, options: CountOptions = {}): TokenCountResult {
  return countValueTokens(value, options)
}

export async function countAnthropicMessagesWithProvider(params: {
  baseUrl: string
  apiKey: string
  model: string
  messages: Array<Record<string, unknown>>
  system?: unknown
  tools?: unknown[]
  customHeaders?: Record<string, string>
  fetchImpl?: typeof fetch
}): Promise<TokenCountResult> {
  const fetcher = params.fetchImpl ?? fetch
  const response = await fetcher(`${params.baseUrl.replace(/\/+$/, '')}/messages/count_tokens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${params.apiKey}`,
      'x-api-key': params.apiKey,
      'anthropic-version': '2023-06-01',
      ...(params.customHeaders ?? {}),
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      ...(params.system ? { system: params.system } : {}),
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
    }),
  })

  if (!response.ok) {
    return {
      tokens: 0,
      source: 'unavailable',
      reason: `Anthropic count_tokens failed: ${response.status}`,
    }
  }

  const payload = await response.json() as { input_tokens?: unknown }
  return typeof payload.input_tokens === 'number'
    ? { tokens: payload.input_tokens, source: 'provider' }
    : { tokens: 0, source: 'unavailable', reason: 'Anthropic count_tokens response omitted input_tokens' }
}
