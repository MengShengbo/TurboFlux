import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getSupportedModelSpec, isSupportedModel, SUPPORTED_MODEL_SPECS } from './modelRegistry'

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
  baseUrl: string
  contextWindow: number
  maxTokens: number
  description: string
}

export type TurboFluxProvider = TurboFluxConfig['provider']
export type TurboFluxConfigKey = keyof TurboFluxConfig

const CONFIG_DIR = join(homedir(), '.turboflux')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const CONVERSATIONS_DIR = join(CONFIG_DIR, 'conversations')
const CHECKPOINTS_DIR = join(CONFIG_DIR, 'checkpoints')

export const LOCAL_PROXY_BASE_URL = 'http://127.0.0.1:8787'
export const LOCAL_PROXY_API_KEY = 'turboflux-local'
export const DEFAULT_FREE_MODEL = 'gpt-5.5'
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
export const DEFAULT_MAX_TOKENS = 16_384
export const TURBOFLUX_PROVIDERS: TurboFluxProvider[] = ['openai', 'anthropic', 'deepseek', 'openrouter', 'custom']

export const MODEL_PRESETS: ModelPreset[] = SUPPORTED_MODEL_SPECS.map(spec => ({
  id: spec.id,
  name: spec.name,
  model: spec.id,
  baseUrl: LOCAL_PROXY_BASE_URL,
  contextWindow: spec.contextWindow,
  maxTokens: spec.defaultRequestTokens,
  description: spec.description,
}))

interface BackendModelConfig {
  id?: unknown
  model?: unknown
  name?: unknown
  contextWindow?: unknown
  context_window?: unknown
  maxTokens?: unknown
  max_tokens?: unknown
  description?: unknown
}

interface BackendConfigResponse {
  upstreamBaseUrl?: unknown
  defaultModel?: unknown
  models?: unknown
}

const DEFAULT_CONFIG: TurboFluxConfig = {
  provider: 'custom',
  apiKey: LOCAL_PROXY_API_KEY,
  baseUrl: LOCAL_PROXY_BASE_URL,
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
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : DEFAULT_CONFIG.model
  const baseUrl = typeof raw.baseUrl === 'string' && raw.baseUrl.trim() ? raw.baseUrl.trim() : DEFAULT_CONFIG.baseUrl
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
        throw new Error('Invalid baseUrl. Use a full URL such as http://127.0.0.1:8787')
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

function normalizeBackendModel(raw: BackendModelConfig): ModelPreset | null {
  const id = typeof (raw.id ?? raw.model) === 'string' ? String(raw.id ?? raw.model).trim() : ''
  const spec = getSupportedModelSpec(id)
  if (!id || !spec) return null
  return {
    id: spec.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : spec.name,
    model: spec.id,
    baseUrl: LOCAL_PROXY_BASE_URL,
    contextWindow: positiveInteger(raw.contextWindow ?? raw.context_window, spec.contextWindow),
    maxTokens: positiveInteger(raw.maxTokens ?? raw.max_tokens, spec.defaultRequestTokens),
    description: typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : spec.description,
  }
}

function normalizeBackendModels(models: unknown, defaultModel?: unknown): ModelPreset[] {
  const normalized = Array.isArray(models)
    ? models.flatMap(item => {
      if (!item || typeof item !== 'object') return []
      const model = normalizeBackendModel(item as BackendModelConfig)
      return model ? [model] : []
    })
    : []
  const deduped = [...new Map(normalized.map(model => [model.model, model])).values()]
  const fallbackDefault = typeof defaultModel === 'string' && defaultModel.trim() ? defaultModel.trim() : ''
  const fallbackSpec = getSupportedModelSpec(fallbackDefault)
  if (fallbackDefault && !deduped.some(model => model.model === fallbackDefault)) {
    if (fallbackSpec) deduped.unshift({
      id: fallbackSpec.id,
      name: fallbackSpec.name,
      model: fallbackSpec.id,
      baseUrl: LOCAL_PROXY_BASE_URL,
      contextWindow: fallbackSpec.contextWindow,
      maxTokens: fallbackSpec.defaultRequestTokens,
      description: fallbackSpec.description,
    })
  }
  return deduped
}

export async function fetchLocalBackendPresets(baseUrl = LOCAL_PROXY_BASE_URL): Promise<ModelPreset[]> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/admin/api/config`, {
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) return []
    const payload = await response.json() as BackendConfigResponse
    return normalizeBackendModels(payload.models, payload.defaultModel)
  } catch {
    return []
  }
}

export async function getModelPresets(baseUrl = LOCAL_PROXY_BASE_URL): Promise<ModelPreset[]> {
  const backendPresets = await fetchLocalBackendPresets(baseUrl)
  return backendPresets.length > 0 ? backendPresets : MODEL_PRESETS
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
    const presets = await getModelPresets()
    const initial = applyKnownModelMetadata({ ...DEFAULT_CONFIG }, presets)
    writeFileSync(CONFIG_FILE, JSON.stringify(initial, null, 2), 'utf-8')
    return initial
  }

  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8').replace(/^\uFEFF/, '')
    const userConfig = JSON.parse(raw)
    const merged = normalizeConfig({ ...DEFAULT_CONFIG, ...userConfig })
    if (looksLikeLegacyBundledDefault(userConfig)) {
      const migrated = {
        ...merged,
        provider: 'custom',
        apiKey: LOCAL_PROXY_API_KEY,
        baseUrl: LOCAL_PROXY_BASE_URL,
      } satisfies TurboFluxConfig
      writeFileSync(CONFIG_FILE, JSON.stringify(migrated, null, 2), 'utf-8')
      return migrated
    }
    const presets = await getModelPresets(merged.baseUrl || LOCAL_PROXY_BASE_URL)
    if (!merged.apiKey) merged.apiKey = LOCAL_PROXY_API_KEY
    if (!merged.baseUrl) merged.baseUrl = LOCAL_PROXY_BASE_URL
    if (!merged.model) merged.model = DEFAULT_FREE_MODEL
    const withBackendMetadata = applyKnownModelMetadata(merged, presets)
    if (
      withBackendMetadata.contextWindow === 128_000 &&
      withBackendMetadata.baseUrl.replace(/\/+$/, '') === LOCAL_PROXY_BASE_URL &&
      (withBackendMetadata.model === DEFAULT_FREE_MODEL || withBackendMetadata.model === 'deepseek-v4-pro')
    ) {
      withBackendMetadata.contextWindow = DEFAULT_CONTEXT_WINDOW
      writeFileSync(CONFIG_FILE, JSON.stringify(withBackendMetadata, null, 2), 'utf-8')
    }
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
    model: preset.model,
    baseUrl: preset.baseUrl,
    contextWindow: preset.contextWindow,
    maxTokens: preset.maxTokens,
  }
}
