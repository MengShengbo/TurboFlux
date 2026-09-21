import type { ModelProtocol } from '@turboflux/models/modelProtocol'
import { CacheMonitor, type CacheBreakResult, type PromptStateSnapshot } from './cacheMonitor'

export interface SentModelCacheRequest {
  protocol: ModelProtocol
  provider: string
  serializedBody: string
  headers?: Record<string, string>
  strategy?: string | null
  requestStartedAt?: number
  responseReceivedAt?: number
}

export interface ModelCacheUsage {
  inputTokens: number
  cacheReadTokens: number
  cacheCreationTokens?: number
}

/** Derive diagnostics from the body actually sent, including compatibility retries. */
export function modelCacheSnapshot(request: SentModelCacheRequest): PromptStateSnapshot {
  const body = JSON.parse(request.serializedBody) as Record<string, unknown>
  const tools = Array.isArray(body.tools) ? body.tools : []
  const messages = request.protocol === 'openai_responses'
    ? Array.isArray(body.input) ? body.input : typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : []
    : Array.isArray(body.messages) ? body.messages : []
  const system = request.protocol === 'openai_responses'
    ? body.instructions ?? ''
    : request.protocol === 'anthropic_messages'
      ? body.system ?? ''
      : messages.filter(message => message?.role === 'system' || message?.role === 'developer')
  const params = Object.fromEntries(Object.entries(body).filter(([key]) =>
    !['tools', 'input', 'messages', 'instructions', 'system'].includes(key)))
  // Authentication and per-request trace identifiers are never retained here.
  const protocolHeaders = Object.fromEntries(Object.entries(request.headers ?? {})
    .filter(([name]) => ['anthropic-version', 'anthropic-beta'].includes(name.toLowerCase()))
    .map(([name, value]) => [name.toLowerCase(), value]))

  return {
    systemPrompt: typeof system === 'string' ? system : JSON.stringify(system),
    model: typeof body.model === 'string' ? body.model : '',
    provider: request.provider,
    strategy: request.strategy,
    toolCount: tools.length,
    toolNames: tools.map(tool => {
      const name = tool?.function?.name ?? tool?.name
      return typeof name === 'string' ? name : 'unknown'
    }),
    toolSchemas: tools,
    messages,
    cacheControl: request.protocol,
    extraBodyParams: { ...params, protocolHeaders },
  }
}

/** Only an observed response with input usage can replace the cache baseline. */
export function observeModelCache(
  monitor: CacheMonitor,
  request: SentModelCacheRequest,
  usage: ModelCacheUsage,
): CacheBreakResult | undefined {
  if (!Number.isFinite(usage.inputTokens) || usage.inputTokens <= 0) return undefined
  monitor.recordPromptState(modelCacheSnapshot(request))
  const responseReceivedAt = request.responseReceivedAt ?? Date.now()
  const timing = typeof request.requestStartedAt === 'number'
    && Number.isFinite(request.requestStartedAt) && Number.isFinite(responseReceivedAt)
    && request.requestStartedAt <= responseReceivedAt
    ? { requestStartedAt: request.requestStartedAt, responseReceivedAt }
    : undefined
  return monitor.checkCacheBreak(usage.cacheReadTokens, usage.cacheCreationTokens ?? 0, usage.inputTokens, timing)
}
