import type { TiktokenEncoding } from 'js-tiktoken'
import type { ResolvedThinkingMode } from '../shared/agentTypes'

export type SupportedModelProvider = 'openai' | 'anthropic' | 'deepseek'
export type SupportedModelId =
  | 'deepseek-v4-pro'
  | 'deepseek-v4-flash'
  | 'gpt-5.5'
  | 'gpt-5.4'
  | 'claude-opus-4-8'
  | 'claude-opus-4-7'
  | 'claude-opus-4-6'
  | 'claude-sonnet-4-6'

export type ModelReasoningParam =
  | { kind: 'openai-chat'; effort: 'none' | 'medium' | 'xhigh' }
  | { kind: 'deepseek-chat'; thinking: 'disabled' | 'enabled'; effort?: 'high' | 'max' }
  | { kind: 'anthropic-adaptive'; thinking: 'disabled' | 'adaptive'; effort?: 'medium' | 'high' | 'max' }

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

export const SUPPORTED_MODEL_SPECS: SupportedModelSpec[] = [
  {
    id: 'deepseek-v4-pro',
    aliases: ['DeepSeekV4Pro', 'DeepSeek-V4-Pro'],
    name: 'DeepSeek V4 Pro',
    provider: 'deepseek',
    contextWindow: DEEPSEEK_LONG_CONTEXT,
    maxOutputTokens: 384_000,
    defaultRequestTokens: 16_384,
    description: 'Flagship DeepSeek V4 route with controllable high/max thinking.',
    sourceNote: 'DeepSeek V4 public API/materials describe 1M context and high/max reasoning effort.',
  },
  {
    id: 'deepseek-v4-flash',
    aliases: ['DeepSeekV4-Flash', 'DeepSeek-V4-Flash', 'DeepSeekV4Flash'],
    name: 'DeepSeek V4 Flash',
    provider: 'deepseek',
    contextWindow: DEEPSEEK_LONG_CONTEXT,
    maxOutputTokens: 384_000,
    defaultRequestTokens: 16_384,
    description: 'Cost-efficient DeepSeek V4 route with controllable high/max thinking.',
    sourceNote: 'DeepSeek V4 public API/materials describe 1M context and high/max reasoning effort.',
  },
  {
    id: 'gpt-5.5',
    aliases: ['GPT5.5', 'GPT-5.5'],
    name: 'GPT-5.5',
    provider: 'openai',
    contextWindow: OPENAI_LONG_CONTEXT,
    maxOutputTokens: 128_000,
    defaultRequestTokens: 16_384,
    tokenizer: 'o200k_base',
    supportsVision: true,
    description: 'OpenAI frontier model for coding and professional work.',
    sourceNote: 'OpenAI API model page lists 1.05M context, 128K output, and reasoning effort none/low/medium/high/xhigh.',
  },
  {
    id: 'gpt-5.4',
    aliases: ['GPT5.4', 'GPT-5.4'],
    name: 'GPT-5.4',
    provider: 'openai',
    contextWindow: OPENAI_LONG_CONTEXT,
    maxOutputTokens: 128_000,
    defaultRequestTokens: 16_384,
    tokenizer: 'o200k_base',
    supportsVision: true,
    description: 'OpenAI frontier model for complex professional work.',
    sourceNote: 'OpenAI API model page lists 1.05M context, 128K output, and reasoning effort none/low/medium/high/xhigh.',
  },
  {
    id: 'claude-opus-4-8',
    aliases: ['ClaudeOpus4.8', 'Claude-Opus-4.8'],
    name: 'Claude Opus 4.8',
    provider: 'anthropic',
    contextWindow: CLAUDE_LONG_CONTEXT,
    maxOutputTokens: 128_000,
    defaultRequestTokens: 16_384,
    supportsProviderTokenCount: true,
    supportsVision: true,
    description: 'Anthropic flagship for long-horizon agentic coding and complex reasoning.',
    sourceNote: 'Anthropic model overview lists claude-opus-4-8, 1M context, 128K output, adaptive thinking, and effort support.',
  },
  {
    id: 'claude-opus-4-7',
    aliases: ['ClaudeOpus4.7', 'Claude-Opus-4.7'],
    name: 'Claude Opus 4.7',
    provider: 'anthropic',
    contextWindow: CLAUDE_LONG_CONTEXT,
    maxOutputTokens: 128_000,
    defaultRequestTokens: 16_384,
    supportsProviderTokenCount: true,
    supportsVision: true,
    description: 'Anthropic Opus generation with adaptive thinking and xhigh/max effort.',
    sourceNote: 'Anthropic extended-thinking and effort docs list Opus 4.7 adaptive thinking and effort support.',
  },
  {
    id: 'claude-opus-4-6',
    aliases: ['ClaudeOpus4.6', 'Claude-Opus-4.6'],
    name: 'Claude Opus 4.6',
    provider: 'anthropic',
    contextWindow: CLAUDE_LONG_CONTEXT,
    maxOutputTokens: 128_000,
    defaultRequestTokens: 16_384,
    supportsProviderTokenCount: true,
    supportsVision: true,
    description: 'Anthropic Opus model where adaptive thinking is recommended over manual budgets.',
    sourceNote: 'Anthropic docs list Opus 4.6 adaptive thinking as recommended and 128K synchronous output.',
  },
  {
    id: 'claude-sonnet-4-6',
    aliases: ['ClaudeSonnet4.6', 'Claude-Sonnet-4.6'],
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    contextWindow: CLAUDE_LONG_CONTEXT,
    maxOutputTokens: 64_000,
    defaultRequestTokens: 16_384,
    supportsProviderTokenCount: true,
    supportsVision: true,
    description: 'Anthropic balanced model with 1M context and adaptive thinking.',
    sourceNote: 'Anthropic model overview lists claude-sonnet-4-6, 1M context, 64K output, adaptive thinking, and effort support.',
  },
]

const MODEL_LOOKUP = new Map<string, SupportedModelSpec>()

for (const spec of SUPPORTED_MODEL_SPECS) {
  MODEL_LOOKUP.set(spec.id, spec)
  for (const alias of spec.aliases) {
    MODEL_LOOKUP.set(normalizeModelKey(alias), spec)
  }
}

export function normalizeModelKey(value?: string): string {
  return (value || '').trim().toLowerCase()
}

export function getSupportedModelSpec(value?: string): SupportedModelSpec | undefined {
  return MODEL_LOOKUP.get(normalizeModelKey(value))
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

export function resolveReasoningParam(model: string, mode: ResolvedThinkingMode): ModelReasoningParam | null {
  const spec = getSupportedModelSpec(model)
  if (!spec) return null

  if (spec.provider === 'openai') {
    return {
      kind: 'openai-chat',
      effort: mode === 'off' ? 'none' : mode === 'max' ? 'xhigh' : 'medium',
    }
  }

  if (spec.provider === 'deepseek') {
    return mode === 'off'
      ? { kind: 'deepseek-chat', thinking: 'disabled' }
      : { kind: 'deepseek-chat', thinking: 'enabled', effort: mode === 'max' ? 'max' : 'high' }
  }

  if (spec.provider === 'anthropic') {
    return mode === 'off'
      ? { kind: 'anthropic-adaptive', thinking: 'disabled' }
      : { kind: 'anthropic-adaptive', thinking: 'adaptive', effort: mode === 'max' ? 'max' : spec.id === 'claude-sonnet-4-6' ? 'medium' : 'high' }
  }

  return null
}
