import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getSupportedModelSpec, SUPPORTED_MODEL_SPECS } from './modelRegistry'

export interface TurboFluxConfig {
  provider: 'openai' | 'anthropic' | 'deepseek' | 'openrouter' | 'custom'
  apiKey: string
  baseUrl: string
  model: string
  contextWindow: number
  maxTokens: number
}

export interface ModelPreset {
  id: string
  name: string
  model: string
  provider: TurboFluxProvider
  baseUrl: string
  contextWindow: number
  maxTokens: number
  description: string
}

export type TurboFluxProvider = TurboFluxConfig['provider']
export type TurboFluxConfigKey = keyof TurboFluxConfig

export interface ProviderPreset {
  id: string
  name: string
  provider: TurboFluxProvider
  baseUrl: string
  defaultModel: string
  description: string
}

const CONFIG_DIR = join(homedir(), '.turboflux')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const CONVERSATIONS_DIR = join(CONFIG_DIR, 'conversations')
const CHECKPOINTS_DIR = join(CONFIG_DIR, 'checkpoints')

export const DEFAULT_FREE_MODEL = ''
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
export const DEFAULT_MAX_TOKENS = 16_384
export const TURBOFLUX_PROVIDERS: TurboFluxProvider[] = ['openai', 'anthropic', 'deepseek', 'openrouter', 'custom']

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'custom',
    name: 'Custom OpenAI-compatible',
    provider: 'custom',
    baseUrl: '',
    defaultModel: '',
    description: 'Custom OpenAI-compatible API endpoint.',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.5',
    description: 'Official OpenAI-compatible API.',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-6',
    description: 'Official Anthropic Messages API.',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'gpt-5.5',
    description: 'OpenAI-compatible model router.',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    description: 'OpenAI-compatible DeepSeek API.',
  },
]

export function getProviderPreset(idOrProvider: string): ProviderPreset | undefined {
  const key = idOrProvider.trim().toLowerCase()
  return PROVIDER_PRESETS.find(p => p.id === key)
    ?? PROVIDER_PRESETS.find(p => p.provider === key && p.id !== 'custom')
    ?? PROVIDER_PRESETS.find(p => p.provider === key)
}

export function baseUrlForProvider(provider: TurboFluxProvider): string {
  return PROVIDER_PRESETS.find(p => p.provider === provider && p.id !== 'custom')?.baseUrl
    ?? ''
}

export const MODEL_PRESETS: ModelPreset[] = SUPPORTED_MODEL_SPECS.map(spec => ({
  id: spec.id,
  name: spec.name,
  model: spec.id,
  provider: providerForModel(spec.id),
  baseUrl: baseUrlForProvider(providerForModel(spec.id)),
  contextWindow: spec.contextWindow,
  maxTokens: spec.defaultRequestTokens,
  description: spec.description,
}))

const DEFAULT_CONFIG: TurboFluxConfig = {
  provider: 'custom',
  apiKey: '',
  baseUrl: '',
  model: DEFAULT_FREE_MODEL,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  maxTokens: DEFAULT_MAX_TOKENS,
}

export function providerForModel(model: string, fallback: TurboFluxProvider = 'custom'): TurboFluxProvider {
  const provider = getSupportedModelSpec(model)?.provider
  if (!provider) return fallback
  return provider === 'deepseek' ? 'deepseek' : provider
}

function looksLikeLegacyBundledDefault(config: Partial<TurboFluxConfig>): boolean {
  const baseUrl = config.baseUrl?.replace(/\/+$/, '')
  const model = config.model ?? DEFAULT_FREE_MODEL
  return config.provider === 'openai'
    && (baseUrl === 'https://api.deepseek.com' || baseUrl === 'https://api.deepseek.com/v1')
    && (model === DEFAULT_FREE_MODEL || model === 'deepseek-v4-pro')
    && typeof config.apiKey === 'string'
    && config.apiKey.startsWith('sk-')
}

function looksLikeLegacyLocalProxyDefault(config: Partial<TurboFluxConfig>): boolean {
  const rawBaseUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : ''
  let isRetiredLocalEndpoint = false
  try {
    const parsed = new URL(rawBaseUrl)
    isRetiredLocalEndpoint = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) && parsed.port === '8787'
  } catch {}
  return (config.provider === 'custom' || config.provider === undefined)
    && isRetiredLocalEndpoint
    && (config.apiKey === 'turboflux-local' || config.apiKey === undefined || config.apiKey === '')
    && (!config.model || config.model === 'gpt-5.5' || config.model === 'deepseek-v4-pro')
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeProvider(value: unknown, fallback: TurboFluxProvider): TurboFluxProvider {
  return typeof value === 'string' && TURBOFLUX_PROVIDERS.includes(value as TurboFluxProvider)
    ? value as TurboFluxProvider
    : fallback
}

function normalizeConfig(raw: Partial<TurboFluxConfig>): TurboFluxConfig {
  const provider = normalizeProvider(raw.provider, DEFAULT_CONFIG.provider)
  const model = typeof raw.model === 'string' ? raw.model.trim() : DEFAULT_CONFIG.model
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : DEFAULT_CONFIG.baseUrl
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : DEFAULT_CONFIG.apiKey
  const contextWindow = positiveInteger(raw.contextWindow, DEFAULT_CONFIG.contextWindow)
  const maxTokens = positiveInteger(raw.maxTokens, DEFAULT_CONFIG.maxTokens)
  return { provider, apiKey, baseUrl, model, contextWindow, maxTokens }
}

export function setConfigValue(config: TurboFluxConfig, key: string, value: string): TurboFluxConfig {
  switch (key) {
    case 'provider': {
      if (!TURBOFLUX_PROVIDERS.includes(value as TurboFluxProvider)) {
        throw new Error(`Invalid provider. Use one of: ${TURBOFLUX_PROVIDERS.join(', ')}`)
      }
      return { ...config, provider: value as TurboFluxProvider }
    }
    case 'apiKey':
      return { ...config, apiKey: value }
    case 'baseUrl': {
      try {
        new URL(value)
      } catch {
        throw new Error('Invalid baseUrl. Use a full URL such as https://api.example.com/v1')
      }
      return { ...config, baseUrl: value.replace(/\/+$/, '') }
    }
    case 'model':
      if (!value.trim()) throw new Error('model cannot be empty')
      return { ...config, model: value.trim() }
    case 'contextWindow':
    case 'maxTokens': {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${key} must be a positive integer`)
      }
      return { ...config, [key]: parsed } as TurboFluxConfig
    }
    default:
      throw new Error(`Unknown config key "${key}". Valid keys: provider, apiKey, baseUrl, model, contextWindow, maxTokens`)
  }
}

export async function getModelPresets(_baseUrl?: string): Promise<ModelPreset[]> {
  return MODEL_PRESETS
}

function applyKnownModelMetadata(config: TurboFluxConfig, presets: ModelPreset[]): TurboFluxConfig {
  const spec = getSupportedModelSpec(config.model)
  return spec ? {
    ...config,
    model: spec.id,
  } : config
}

export function ensureDirectories(workspacePath?: string): void {
  const dirs = [CONFIG_DIR, CONVERSATIONS_DIR, CHECKPOINTS_DIR]
  if (workspacePath) {
    dirs.push(join(workspacePath, '.turboflux', 'memory'))
  }
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }
}

export async function loadConfig(): Promise<TurboFluxConfig> {
  ensureDirectories()

  if (!existsSync(CONFIG_FILE)) {
    const initial = applyKnownModelMetadata({ ...DEFAULT_CONFIG }, MODEL_PRESETS)
    writeFileSync(CONFIG_FILE, JSON.stringify(initial, null, 2), 'utf-8')
    return initial
  }

  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8').replace(/^\uFEFF/, '')
    const userConfig = JSON.parse(raw)
    const merged = normalizeConfig({ ...DEFAULT_CONFIG, ...userConfig })
    if (looksLikeLegacyLocalProxyDefault(userConfig)) {
      writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8')
      return { ...DEFAULT_CONFIG }
    }
    if (looksLikeLegacyBundledDefault(userConfig)) {
      const migrated = {
        ...merged,
        provider: DEFAULT_CONFIG.provider,
        apiKey: '',
        baseUrl: DEFAULT_CONFIG.baseUrl,
        model: DEFAULT_CONFIG.model,
      } satisfies TurboFluxConfig
      writeFileSync(CONFIG_FILE, JSON.stringify(migrated, null, 2), 'utf-8')
      return migrated
    }
    const withBackendMetadata = applyKnownModelMetadata(merged, MODEL_PRESETS)
    if (
      withBackendMetadata.contextWindow !== merged.contextWindow ||
      withBackendMetadata.maxTokens !== merged.maxTokens ||
      withBackendMetadata.model !== merged.model
    ) {
      writeFileSync(CONFIG_FILE, JSON.stringify(withBackendMetadata, null, 2), 'utf-8')
    }
    return withBackendMetadata
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(config: TurboFluxConfig): void {
  ensureDirectories()
  writeFileSync(CONFIG_FILE, JSON.stringify(normalizeConfig(config), null, 2), 'utf-8')
}

export function getConfigDir(): string {
  return CONFIG_DIR
}

export function getConversationsDir(): string {
  return CONVERSATIONS_DIR
}

export function getCheckpointsDir(): string {
  return CHECKPOINTS_DIR
}

export function getPresetByIdOrModel(idOrModel: string): ModelPreset | undefined {
  const spec = getSupportedModelSpec(idOrModel)
  return MODEL_PRESETS.find(p => p.id === (spec?.id ?? idOrModel) || p.model === (spec?.id ?? idOrModel))
}

export function getPresetByIdOrModelFrom(presets: ModelPreset[], idOrModel: string): ModelPreset | undefined {
  const spec = getSupportedModelSpec(idOrModel)
  const canonical = spec?.id ?? idOrModel
  return presets.find(p => p.id === canonical || p.model === canonical)
}

export function applyPreset(config: TurboFluxConfig, preset: ModelPreset): TurboFluxConfig {
  return {
    ...config,
    provider: preset.provider,
    model: preset.model,
    baseUrl: preset.baseUrl,
    contextWindow: preset.contextWindow,
    maxTokens: preset.maxTokens,
  }
}

export function configFromProviderPreset(preset: ProviderPreset, apiKey: string, model?: string, baseUrl?: string): TurboFluxConfig {
  const selectedModel = model?.trim() || preset.defaultModel
  const spec = getSupportedModelSpec(selectedModel)
  const selectedApiKey = apiKey || ''
  return {
    provider: preset.provider,
    apiKey: selectedApiKey,
    baseUrl: (baseUrl?.trim() || preset.baseUrl).replace(/\/+$/, ''),
    model: spec?.id ?? selectedModel,
    contextWindow: spec?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: spec?.defaultRequestTokens ?? DEFAULT_MAX_TOKENS,
  }
}
