import type { ReasoningEffort } from '../shared/agentTypes'
import type { APIConfig } from '../state/types'
import { resolveNativeReasoningRequest } from './modelRegistry'

export function shouldOmitSamplingTemperature(config: APIConfig): boolean {
  return resolveNativeReasoningRequest(
    config.defaultModel,
    config.reasoning,
    config.provider,
    config.modelCapabilities,
  )?.omitTemperature === true
}

export function looksLikeKimiModel(model?: string): boolean {
  return /(?:^|[/_.:-])(?:kimi|moonshot)(?:$|[/_.:-])/i.test(String(model || '').trim())
}

export function setOpenAIChatMaxTokens(
  body: Record<string, unknown>,
  maxTokens: number,
  provider?: APIConfig['provider'] | string,
  model?: string,
): 'max_tokens' | 'max_completion_tokens' | null {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return null
  const key = provider === 'kimi' || looksLikeKimiModel(model)
    ? 'max_completion_tokens'
    : 'max_tokens'
  delete body.max_tokens
  delete body.max_completion_tokens
  body[key] = Math.floor(maxTokens)
  return key
}

export function extractUnsupportedRequestParam(error?: string): string | null {
  if (!error) return null
  const quoted = error.match(/Unsupported parameter:\s*["'`]?([A-Za-z0-9_.-]+)["'`]?/i)
  if (quoted?.[1]) return quoted[1]
  const named = error.match(/(?:unknown|unrecognized|unsupported|invalid)\s+(?:parameter|field|key|argument)\s*[:=]?\s*["'`]?([A-Za-z0-9_.-]+)["'`]?/i)
  if (named?.[1]) return named[1]
  const deprecated = error.match(/["'`]?([A-Za-z0-9_.-]+)["'`]?\s+is\s+deprecated\b/i)
  if (deprecated?.[1]) return deprecated[1]
  if (!/(?:extra inputs?|extra fields?|not permitted|not allowed|unsupported|unrecognized|deprecated)/i.test(error)) return null
  const knownOptionalParams = [
    'cache_control', 'anthropic-beta', 'output_config', 'thinking', 'reasoning_effort',
    'reasoning', 'summary', 'temperature', 'stream_options', 'parallel_tool_calls', 'tool_choice',
    'tools', 'prompt_cache_key', 'prompt_cache_retention', 'store', 'text.verbosity', 'verbosity', 'text',
    'max_completion_tokens', 'max_output_tokens', 'max_tokens',
  ]
  return knownOptionalParams.find(param => error.toLowerCase().includes(param.toLowerCase())) || null
}

export function removeOpenAICompatibleRequestParam(body: Record<string, unknown>, param: string): boolean {
  const pathParts = param.split('.')
  const rootParam = pathParts[0]
  if (pathParts.length > 1) {
    let target: Record<string, unknown> | undefined = body
    for (const key of pathParts.slice(0, -1)) {
      const value = target?.[key]
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        target = undefined
        break
      }
      target = value as Record<string, unknown>
    }
    const nestedKey = pathParts[pathParts.length - 1]
    if (target && Object.prototype.hasOwnProperty.call(target, nestedKey)) {
      delete target[nestedKey]
      const rootValue = body[rootParam]
      if (rootValue && typeof rootValue === 'object' && !Array.isArray(rootValue) && Object.keys(rootValue).length === 0) {
        delete body[rootParam]
      }
      return true
    }
  }
  if (rootParam === 'summary') {
    const reasoning = body.reasoning
    if (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning) && Object.prototype.hasOwnProperty.call(reasoning, 'summary')) {
      delete (reasoning as Record<string, unknown>).summary
      return true
    }
  }
  if (rootParam === 'verbosity') {
    const text = body.text
    if (text && typeof text === 'object' && !Array.isArray(text) && Object.prototype.hasOwnProperty.call(text, 'verbosity')) {
      delete (text as Record<string, unknown>).verbosity
      if (Object.keys(text as Record<string, unknown>).length === 0) delete body.text
      return true
    }
  }
  const removable = new Set([
    'temperature', 'max_output_tokens', 'max_completion_tokens', 'max_tokens',
    'stream_options', 'tools', 'tool_choice', 'parallel_tool_calls',
    'thinking', 'reasoning', 'reasoning_effort', 'output_config',
    'prompt_cache_key', 'prompt_cache_retention', 'store', 'text',
  ])
  if (!removable.has(rootParam)) return false
  if (rootParam === 'max_completion_tokens' && Object.prototype.hasOwnProperty.call(body, rootParam)) {
    const value = body[rootParam]
    delete body[rootParam]
    if (!Object.prototype.hasOwnProperty.call(body, 'max_tokens')) body.max_tokens = value
    return true
  }
  const aliases = new Set<string>([rootParam])
  if (rootParam === 'max_output_tokens' || rootParam === 'max_completion_tokens' || rootParam === 'max_tokens') {
    aliases.add('max_output_tokens')
    aliases.add('max_completion_tokens')
    aliases.add('max_tokens')
  }
  if (rootParam === 'tools' || rootParam === 'tool_choice' || rootParam === 'parallel_tool_calls') {
    aliases.add('tools')
    aliases.add('tool_choice')
    aliases.add('parallel_tool_calls')
  }
  let removed = false
  for (const key of aliases) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      delete body[key]
      removed = true
    }
  }
  return removed
}

const REASONING_EFFORT_FALLBACKS: ReasoningEffort[] = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']

export function downgradeReasoningEffort(body: Record<string, unknown>): { from: ReasoningEffort; to: ReasoningEffort } | null {
  const candidates: Array<{ target: Record<string, unknown>; key: string }> = [{ target: body, key: 'reasoning_effort' }]
  for (const key of ['output_config', 'reasoning']) {
    const value = body[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      candidates.push({ target: value as Record<string, unknown>, key: 'effort' })
    }
  }

  for (const candidate of candidates) {
    const current = candidate.target[candidate.key]
    if (typeof current !== 'string') continue
    const index = REASONING_EFFORT_FALLBACKS.indexOf(current as ReasoningEffort)
    if (index < 0 || index >= REASONING_EFFORT_FALLBACKS.length - 1) continue
    const next = REASONING_EFFORT_FALLBACKS[index + 1]
    candidate.target[candidate.key] = next
    return { from: current as ReasoningEffort, to: next }
  }
  return null
}

export function isReasoningEffortValueError(error?: string): boolean {
  if (!error || !/(?:reasoning[_ .-]?effort|output_config.*effort|effort)/i.test(error)) return false
  return /(?:invalid|unsupported value|not supported|allowed values|one of|must be)/i.test(error)
}

export function removeAnthropicCompatibleRequestParam(
  body: Record<string, unknown>,
  headers: Record<string, string>,
  param: string,
): boolean {
  const pathParts = param.split('.')
  const rootParam = pathParts[0]
  const nestedParam = pathParts[pathParts.length - 1]
  if (rootParam === 'cache_control' || nestedParam === 'cache_control') {
    let removed = false
    const strip = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(strip)
      if (!value || typeof value !== 'object') return value
      const output: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'cache_control') {
          removed = true
          continue
        }
        output[key] = strip(child)
      }
      return output
    }
    for (const key of ['system', 'messages', 'tools']) {
      if (body[key] !== undefined) body[key] = strip(body[key])
    }
    return removed
  }
  if (rootParam === 'anthropic-beta' || rootParam === 'anthropic_beta') {
    if (headers['anthropic-beta'] === undefined) return false
    delete headers['anthropic-beta']
    return true
  }
  const removable = new Set(['temperature', 'thinking', 'output_config', 'tool_choice'])
  if (!removable.has(rootParam) || !Object.prototype.hasOwnProperty.call(body, rootParam)) return false
  delete body[rootParam]
  return true
}
