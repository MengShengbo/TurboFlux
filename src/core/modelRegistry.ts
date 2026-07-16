import type { TiktokenEncoding } from 'js-tiktoken'
import type { NativeReasoningConfig, ReasoningEffort } from '../shared/agentTypes'

export type SupportedModelProvider = 'openai' | 'anthropic' | 'deepseek' | 'kimi' | 'glm'
export type SupportedModelId =
  | 'gpt-5.6'
  | 'gpt-5.6-sol'
  | 'gpt-5.6-terra'
  | 'gpt-5.6-luna'
  | 'gpt-5.5'
  | 'gpt-5.4'
  | 'claude-fable-5'
  | 'claude-mythos-5'
  | 'claude-mythos-preview'
  | 'claude-opus-4-8'
  | 'claude-sonnet-5'
  | 'claude-haiku-4-5-20251001'
  | 'claude-opus-4-7'
  | 'claude-opus-4-6'
  | 'claude-sonnet-4-6'
  | 'deepseek-v4-pro'
  | 'deepseek-v4-flash'
  | 'kimi-k3'
  | 'kimi-k2.7-code'
  | 'kimi-k2.7-code-highspeed'
  | 'kimi-k2.6'
  | 'kimi-k2.5'
  | 'glm-5.2'
  | 'glm-5.1'
  | 'glm-5'
  | 'glm-5-turbo'
  | 'glm-4.7'
  | 'glm-4.6'
  | 'glm-4.5'

export type ReasoningControlKind = 'effort' | 'adaptive-effort' | 'budget' | 'toggle-effort' | 'toggle' | 'fixed'

export interface ModelReasoningCapabilities {
  family: SupportedModelProvider
  control: ReasoningControlKind
  efforts: ReasoningEffort[]
  supportsToggle: boolean
  defaultEnabled: boolean
  defaultEffort?: ReasoningEffort
  defaultBudgetTokens?: number
  omitTemperature: boolean
  preservesReasoningContent?: boolean
  description: string
}

export interface NativeReasoningRequest {
  enabled: boolean
  reasoningEffort?: ReasoningEffort
  thinking?: {
    type: 'disabled' | 'enabled' | 'adaptive'
    budget_tokens?: number
    keep?: 'all'
  }
  outputConfig?: { effort: ReasoningEffort }
  omitTemperature: boolean
}

export interface SupportedModelSpec {
  id: SupportedModelId
  aliases: string[]
  name: string
  provider: SupportedModelProvider
  contextWindow: number
  maxOutputTokens: number
  defaultRequestTokens: number
  tokenizer?: TiktokenEncoding
  supportsProviderTokenCount?: boolean
  supportsVision?: boolean
  description: string
  sourceNote: string
}

const OPENAI_LONG_CONTEXT = 1_050_000
const CLAUDE_LONG_CONTEXT = 1_000_000
const DEEPSEEK_LONG_CONTEXT = 1_000_000
const KIMI_LONG_CONTEXT = 1_000_000
const GLM_LONG_CONTEXT = 1_000_000

function modelSpec(
  id: SupportedModelId,
  name: string,
  provider: SupportedModelProvider,
  contextWindow: number,
  maxOutputTokens: number,
  description: string,
  sourceNote: string,
  options: Partial<SupportedModelSpec> = {},
): SupportedModelSpec {
  return {
    id,
    aliases: [],
    name,
    provider,
    contextWindow,
    maxOutputTokens,
    defaultRequestTokens: 16_384,
    description,
    sourceNote,
    ...options,
  }
}

export const SUPPORTED_MODEL_SPECS: SupportedModelSpec[] = [
  modelSpec('gpt-5.6', 'GPT-5.6', 'openai', OPENAI_LONG_CONTEXT, 128_000, 'GPT-5.6 flagship alias.', 'OpenAI model guidance: gpt-5.6 routes to gpt-5.6-sol.', { aliases: ['GPT5.6'], tokenizer: 'o200k_base', supportsVision: true }),
  modelSpec('gpt-5.6-sol', 'GPT-5.6 Sol', 'openai', OPENAI_LONG_CONTEXT, 128_000, 'Frontier GPT-5.6 route.', 'OpenAI model guidance, July 2026.', { aliases: ['GPT5.6Sol'], tokenizer: 'o200k_base', supportsVision: true }),
  modelSpec('gpt-5.6-terra', 'GPT-5.6 Terra', 'openai', OPENAI_LONG_CONTEXT, 128_000, 'Balanced GPT-5.6 route.', 'OpenAI model guidance, July 2026.', { aliases: ['GPT5.6Terra'], tokenizer: 'o200k_base', supportsVision: true }),
  modelSpec('gpt-5.6-luna', 'GPT-5.6 Luna', 'openai', OPENAI_LONG_CONTEXT, 128_000, 'Low-latency GPT-5.6 route.', 'OpenAI model guidance, July 2026.', { aliases: ['GPT5.6Luna'], tokenizer: 'o200k_base', supportsVision: true }),
  modelSpec('gpt-5.5', 'GPT-5.5', 'openai', OPENAI_LONG_CONTEXT, 128_000, 'Previous GPT frontier generation.', 'OpenAI reasoning guide.', { aliases: ['GPT5.5'], tokenizer: 'o200k_base', supportsVision: true }),
  modelSpec('gpt-5.4', 'GPT-5.4', 'openai', OPENAI_LONG_CONTEXT, 128_000, 'Previous GPT frontier generation.', 'OpenAI reasoning guide.', { aliases: ['GPT5.4'], tokenizer: 'o200k_base', supportsVision: true }),

  modelSpec('claude-fable-5', 'Claude Fable 5', 'anthropic', CLAUDE_LONG_CONTEXT, 128_000, 'Current highest-capability Claude API model.', 'Anthropic models overview, July 2026.', { supportsProviderTokenCount: true, supportsVision: true }),
  modelSpec('claude-mythos-5', 'Claude Mythos 5', 'anthropic', CLAUDE_LONG_CONTEXT, 128_000, 'Limited-availability Claude model for approved Project Glasswing customers.', 'Anthropic models overview, July 2026.', { supportsProviderTokenCount: true, supportsVision: true }),
  modelSpec('claude-mythos-preview', 'Claude Mythos Preview', 'anthropic', CLAUDE_LONG_CONTEXT, 128_000, 'Invitation-only defensive cybersecurity Claude model.', 'Anthropic models overview, July 2026.', { supportsProviderTokenCount: true, supportsVision: true }),
  modelSpec('claude-opus-4-8', 'Claude Opus 4.8', 'anthropic', CLAUDE_LONG_CONTEXT, 128_000, 'Claude for agentic coding and enterprise work.', 'Anthropic models overview, July 2026.', { aliases: ['ClaudeOpus4.8'], supportsProviderTokenCount: true, supportsVision: true }),
  modelSpec('claude-sonnet-5', 'Claude Sonnet 5', 'anthropic', CLAUDE_LONG_CONTEXT, 128_000, 'Current balanced Claude model.', 'Anthropic models overview, July 2026.', { supportsProviderTokenCount: true, supportsVision: true }),
  modelSpec('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 'anthropic', 200_000, 64_000, 'Current low-latency Claude model.', 'Anthropic models overview, July 2026.', { aliases: ['claude-haiku-4-5'], supportsProviderTokenCount: true, supportsVision: true }),
  modelSpec('claude-opus-4-7', 'Claude Opus 4.7', 'anthropic', CLAUDE_LONG_CONTEXT, 128_000, 'Claude Opus with adaptive thinking and xhigh effort.', 'Anthropic effort guide.', { aliases: ['ClaudeOpus4.7'], supportsProviderTokenCount: true, supportsVision: true }),
  modelSpec('claude-opus-4-6', 'Claude Opus 4.6', 'anthropic', CLAUDE_LONG_CONTEXT, 128_000, 'Claude Opus with adaptive thinking.', 'Anthropic effort guide.', { aliases: ['ClaudeOpus4.6'], supportsProviderTokenCount: true, supportsVision: true }),
  modelSpec('claude-sonnet-4-6', 'Claude Sonnet 4.6', 'anthropic', CLAUDE_LONG_CONTEXT, 64_000, 'Claude Sonnet with adaptive thinking.', 'Anthropic effort guide.', { aliases: ['ClaudeSonnet4.6'], supportsProviderTokenCount: true, supportsVision: true }),

  modelSpec('deepseek-v4-pro', 'DeepSeek V4 Pro', 'deepseek', DEEPSEEK_LONG_CONTEXT, 384_000, 'DeepSeek V4 high-capability route.', 'DeepSeek models and pricing.', { aliases: ['DeepSeekV4Pro', 'DeepSeek-V4-Pro'] }),
  modelSpec('deepseek-v4-flash', 'DeepSeek V4 Flash', 'deepseek', DEEPSEEK_LONG_CONTEXT, 384_000, 'DeepSeek V4 low-latency route.', 'DeepSeek models and pricing.', { aliases: ['DeepSeekV4Flash', 'DeepSeek-V4-Flash', 'deepseek-chat', 'deepseek-reasoner'] }),

  modelSpec('kimi-k3', 'Kimi K3', 'kimi', KIMI_LONG_CONTEXT, 128_000, 'Current Kimi flagship thinking model.', 'Kimi API model and thinking guides.', { supportsVision: true }),
  modelSpec('kimi-k2.7-code', 'Kimi K2.7 Code', 'kimi', KIMI_LONG_CONTEXT, 128_000, 'Kimi coding model with fixed preserved thinking.', 'Kimi API thinking guide.'),
  modelSpec('kimi-k2.7-code-highspeed', 'Kimi K2.7 Code Highspeed', 'kimi', KIMI_LONG_CONTEXT, 128_000, 'High-speed Kimi K2.7 Code route.', 'Kimi API thinking guide.'),
  modelSpec('kimi-k2.6', 'Kimi K2.6', 'kimi', KIMI_LONG_CONTEXT, 128_000, 'Kimi model with switchable preserved thinking.', 'Kimi API thinking guide.'),
  modelSpec('kimi-k2.5', 'Kimi K2.5', 'kimi', KIMI_LONG_CONTEXT, 128_000, 'Kimi model with switchable thinking.', 'Kimi API thinking guide.'),

  modelSpec('glm-5.2', 'GLM-5.2', 'glm', GLM_LONG_CONTEXT, 65_536, 'Current GLM coding and agent model.', 'Zhipu GLM-5.2 model guide.'),
  modelSpec('glm-5.1', 'GLM-5.1', 'glm', GLM_LONG_CONTEXT, 65_536, 'GLM 5.1 reasoning model.', 'Zhipu model guide.'),
  modelSpec('glm-5', 'GLM-5', 'glm', 200_000, 65_536, 'GLM 5 reasoning model.', 'Zhipu model guide.'),
  modelSpec('glm-5-turbo', 'GLM-5 Turbo', 'glm', 200_000, 65_536, 'GLM 5 low-latency route.', 'Zhipu model guide.'),
  modelSpec('glm-4.7', 'GLM-4.7', 'glm', 200_000, 65_536, 'GLM 4.7 reasoning model.', 'Zhipu model guide.'),
  modelSpec('glm-4.6', 'GLM-4.6', 'glm', 200_000, 65_536, 'GLM 4.6 reasoning model.', 'Zhipu model guide.'),
  modelSpec('glm-4.5', 'GLM-4.5', 'glm', 128_000, 65_536, 'GLM 4.5 reasoning model.', 'Zhipu model guide.'),
]

const MODEL_LOOKUP = new Map<string, SupportedModelSpec>()
for (const spec of SUPPORTED_MODEL_SPECS) {
  MODEL_LOOKUP.set(normalizeModelKey(spec.id), spec)
  for (const alias of spec.aliases) MODEL_LOOKUP.set(normalizeModelKey(alias), spec)
}

export function normalizeModelKey(value?: string): string {
  return (value || '').trim().toLowerCase()
}

function modelFamilyKey(value?: string): string {
  const normalized = normalizeModelKey(value)
  return normalized.includes('/') ? normalized.slice(normalized.lastIndexOf('/') + 1) : normalized
}

export function getSupportedModelSpec(value?: string): SupportedModelSpec | undefined {
  const normalized = normalizeModelKey(value)
  return MODEL_LOOKUP.get(normalized) ?? MODEL_LOOKUP.get(modelFamilyKey(normalized))
}

export function isSupportedModel(value?: string): boolean {
  return Boolean(getSupportedModelSpec(value))
}

export function canonicalModelId(value?: string): SupportedModelId | undefined {
  return getSupportedModelSpec(value)?.id
}

export function resolveTokenizerForModel(value?: string): TiktokenEncoding | undefined {
  return getSupportedModelSpec(value)?.tokenizer
}

export function resolveProviderForModel(value?: string): SupportedModelProvider | undefined {
  return getSupportedModelSpec(value)?.provider
}

function capabilities(
  family: SupportedModelProvider,
  control: ReasoningControlKind,
  efforts: ReasoningEffort[],
  options: Partial<ModelReasoningCapabilities>,
): ModelReasoningCapabilities {
  return {
    family,
    control,
    efforts,
    supportsToggle: control !== 'fixed',
    defaultEnabled: true,
    omitTemperature: control !== 'effort',
    description: 'Provider-native reasoning control.',
    ...options,
  }
}

export function getModelReasoningCapabilities(model: string, provider?: string): ModelReasoningCapabilities | null {
  const key = modelFamilyKey(model)
  const providerKey = normalizeModelKey(provider)

  if (/^claude-(?:fable-5|mythos-(?:5|preview))/.test(key)) {
    return capabilities('anthropic', 'adaptive-effort', ['low', 'medium', 'high', 'xhigh', 'max'], {
      supportsToggle: false,
      defaultEffort: 'high',
      description: 'Adaptive thinking is always on; effort controls total response work.',
    })
  }
  if (/^claude-(?:opus-4-(?:8|7)|sonnet-5)/.test(key)) {
    return capabilities('anthropic', 'adaptive-effort', ['low', 'medium', 'high', 'xhigh', 'max'], {
      defaultEffort: 'high',
      description: 'Adaptive thinking with native low through max effort.',
    })
  }
  if (/^claude-(?:opus|sonnet)-4-6/.test(key)) {
    return capabilities('anthropic', 'adaptive-effort', ['low', 'medium', 'high', 'max'], {
      defaultEffort: key.includes('sonnet') ? 'medium' : 'high',
      description: 'Adaptive thinking with native effort; manual budgets are deprecated.',
    })
  }
  if (/^claude-opus-4-5/.test(key)) {
    return capabilities('anthropic', 'adaptive-effort', ['low', 'medium', 'high'], {
      defaultEffort: 'high',
      description: 'Adaptive thinking with native low, medium, and high effort.',
    })
  }
  if (/^claude-/.test(key) || providerKey === 'anthropic') {
    return capabilities('anthropic', 'budget', [], {
      defaultBudgetTokens: 8_192,
      description: 'Manual extended thinking controlled by a token budget.',
    })
  }

  if (/^gpt-5\.6(?:$|-)/.test(key)) {
    return capabilities('openai', 'effort', ['none', 'low', 'medium', 'high', 'xhigh', 'max'], {
      defaultEffort: 'medium',
      omitTemperature: false,
      description: 'GPT-5.6 native reasoning effort.',
    })
  }
  if (/^(?:gpt-5(?:\.|$)|o[1-9](?:-|$))/.test(key)) {
    return capabilities('openai', 'effort', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'], {
      defaultEffort: 'medium',
      omitTemperature: false,
      description: 'OpenAI model-native reasoning effort; accepted values remain model-dependent.',
    })
  }

  if (/^deepseek-v4-(?:pro|flash)/.test(key) || providerKey === 'deepseek') {
    return capabilities('deepseek', 'toggle-effort', ['high', 'max'], {
      defaultEffort: 'high',
      preservesReasoningContent: true,
      description: 'Thinking toggle with effective high and max effort levels.',
    })
  }

  if (/^kimi-k3/.test(key)) {
    return capabilities('kimi', 'fixed', ['max'], {
      supportsToggle: false,
      defaultEffort: 'max',
      preservesReasoningContent: true,
      description: 'Thinking is always on; Kimi K3 currently accepts max effort only.',
    })
  }
  if (/^kimi-k2\.7-code/.test(key)) {
    return capabilities('kimi', 'fixed', [], {
      supportsToggle: false,
      preservesReasoningContent: true,
      description: 'Thinking and preserved thinking are always on with no request control.',
    })
  }
  if (/^kimi-k2\.(?:6|5)/.test(key)) {
    return capabilities('kimi', 'toggle', [], {
      preservesReasoningContent: key.startsWith('kimi-k2.6'),
      description: 'Kimi thinking can be enabled or disabled for this model.',
    })
  }

  if (/^glm-5\.2/.test(key)) {
    return capabilities('glm', 'toggle-effort', ['max'], {
      defaultEffort: 'max',
      omitTemperature: false,
      preservesReasoningContent: true,
      description: 'GLM-5.2 thinking toggle with native max reasoning effort.',
    })
  }
  if (/^glm-(?:5(?:$|-|\.1)|4\.(?:5|6|7))/.test(key) || providerKey === 'glm') {
    return capabilities('glm', 'toggle', [], {
      omitTemperature: false,
      preservesReasoningContent: true,
      description: 'GLM native thinking toggle.',
    })
  }

  return null
}

export function normalizeNativeReasoningConfig(
  model: string,
  config?: NativeReasoningConfig,
  provider?: string,
): NativeReasoningConfig | undefined {
  const capability = getModelReasoningCapabilities(model, provider)
  if (!capability) return undefined

  const enabled = capability.supportsToggle ? config?.enabled ?? capability.defaultEnabled : true
  const requestedEffort = config?.effort
  const effort = capability.efforts.length > 0
    ? capability.efforts.includes(requestedEffort as ReasoningEffort)
      ? requestedEffort
      : capability.defaultEffort ?? capability.efforts[0]
    : undefined
  const budgetTokens = capability.control === 'budget'
    ? Math.max(1_024, Math.min(128_000, Math.round(config?.budgetTokens ?? capability.defaultBudgetTokens ?? 8_192)))
    : undefined

  return { enabled, effort, budgetTokens }
}

export function resolveNativeReasoningRequest(
  model: string,
  config?: NativeReasoningConfig,
  provider?: string,
): NativeReasoningRequest | null {
  const capability = getModelReasoningCapabilities(model, provider)
  const normalized = normalizeNativeReasoningConfig(model, config, provider)
  if (!capability || !normalized) return null

  const request: NativeReasoningRequest = {
    enabled: normalized.enabled !== false,
    omitTemperature: capability.omitTemperature && normalized.enabled !== false,
  }

  if (capability.control === 'effort') {
    request.reasoningEffort = request.enabled
      ? normalized.effort
      : capability.efforts.includes('none') ? 'none' : undefined
    request.omitTemperature = request.reasoningEffort !== 'none'
  } else if (capability.control === 'adaptive-effort') {
    request.thinking = request.enabled ? { type: 'adaptive' } : { type: 'disabled' }
    if (request.enabled && normalized.effort) request.outputConfig = { effort: normalized.effort }
  } else if (capability.control === 'budget') {
    request.thinking = request.enabled
      ? { type: 'enabled', budget_tokens: normalized.budgetTokens }
      : { type: 'disabled' }
  } else if (capability.control === 'toggle-effort') {
    request.thinking = { type: request.enabled ? 'enabled' : 'disabled' }
    if (request.enabled && normalized.effort) request.reasoningEffort = normalized.effort
  } else if (capability.control === 'toggle') {
    request.thinking = { type: request.enabled ? 'enabled' : 'disabled' }
  } else if (capability.control === 'fixed' && normalized.effort) {
    request.reasoningEffort = normalized.effort
  }

  if (capability.family === 'kimi' && request.enabled && request.thinking && capability.preservesReasoningContent) {
    request.thinking.keep = 'all'
  }
  return request
}

export function formatNativeReasoningSetting(model: string, config?: NativeReasoningConfig, provider?: string): string | null {
  const capability = getModelReasoningCapabilities(model, provider)
  const normalized = normalizeNativeReasoningConfig(model, config, provider)
  if (!capability || !normalized) return null
  if (normalized.enabled === false) return 'off'
  if (normalized.effort) return normalized.effort
  if (capability.control === 'budget') return `${normalized.budgetTokens}t`
  if (capability.control === 'fixed') return 'fixed'
  return 'on'
}
