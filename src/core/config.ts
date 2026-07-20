import { existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getSupportedModelSpec, normalizeNativeReasoningConfig, SUPPORTED_MODEL_SPECS } from './modelRegistry'
import { normalizeApprovalPolicy, type ApprovalPolicy, type NativeReasoningConfig } from '../shared/agentTypes'
import { loadCredentialSnapshot, saveCredentialSnapshot } from './credentialStore'
import { writeFileAtomicSync } from './fileIO'

export interface TurboFluxConfig {
  provider: 'openai' | 'anthropic' | 'deepseek' | 'kimi' | 'glm' | 'openrouter' | 'custom'
  apiKey: string
  baseUrl: string
  model: string
  contextWindow: number
  maxTokens: number
  maxOutputTokens?: number
  modelCapabilities?: ModelCapabilities
  modelMetadataSources?: ModelMetadataSource[]
  approvalPolicy: ApprovalPolicy
  reasoning?: NativeReasoningConfig
  apiConfigs?: TurboFluxApiConfigProfile[]
  activeApiConfigId?: string
  fastContextModel?: FastContextModelConfig
}

export interface ModelPreset {
  id: string
  name: string
  model: string
  provider: TurboFluxProvider
  baseUrl: string
  contextWindow: number
  maxTokens: number
  maxOutputTokens?: number
  reasoning?: NativeReasoningConfig
  description: string
  capabilities?: ModelCapabilities
  metadataSources?: ModelMetadataSource[]
  availability?: 'api' | 'configured' | 'builtin'
}

export type ModelMetadataSource = 'api' | 'gateway' | 'models.dev' | 'builtin' | 'default'

export interface ModelCapabilities {
  tools?: boolean
  vision?: boolean
  reasoning?: boolean
  structuredOutput?: boolean
  inputModalities?: string[]
  outputModalities?: string[]
  supportedParameters?: string[]
  supportedEndpoints?: string[]
  reasoningEfforts?: Array<NonNullable<NativeReasoningConfig['effort']>>
}

export type TurboFluxProvider = TurboFluxConfig['provider']
export type TurboFluxConfigKey = keyof TurboFluxConfig

export interface TurboFluxApiConfigProfile {
  id: string
  name: string
  provider: TurboFluxProvider
  apiKey: string
  baseUrl: string
  model: string
  contextWindow: number
  maxTokens: number
  maxOutputTokens?: number
  modelCapabilities?: ModelCapabilities
  modelMetadataSources?: ModelMetadataSource[]
  reasoning?: NativeReasoningConfig
  createdAt: number
  updatedAt: number
}

export interface FastContextModelConfig {
  mode: 'follow-main' | 'api-config'
  apiConfigId?: string
}

const EMPTY_FAST_CONTEXT_MODEL: FastContextModelConfig = { mode: 'follow-main' }

export interface ProviderPreset {
  id: string
  name: string
  provider: TurboFluxProvider
  baseUrl: string
  defaultModel: string
  description: string
}

const CONFIG_DIR = process.env.TURBOFLUX_CONFIG_DIR || join(homedir(), '.turboflux')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const CONVERSATIONS_DIR = join(CONFIG_DIR, 'conversations')
const CHECKPOINTS_DIR = join(CONFIG_DIR, 'checkpoints')

function hydrateCredentials(raw: Partial<TurboFluxConfig>): Partial<TurboFluxConfig> {
  const stored = loadCredentialSnapshot()
  const envApiKey = process.env.TURBOFLUX_API_KEY?.trim()
  const activeId = typeof raw.activeApiConfigId === 'string'
    ? raw.activeApiConfigId
    : Array.isArray(raw.apiConfigs) ? raw.apiConfigs[0]?.id : undefined
  const profiles = Array.isArray(raw.apiConfigs)
    ? raw.apiConfigs.map(profile => ({
        ...profile,
        apiKey: envApiKey && profile.id === activeId
          ? envApiKey
          : stored.apiConfigs?.[profile.id] || profile.apiKey || '',
      }))
    : raw.apiConfigs
  return {
    ...raw,
    apiKey: envApiKey || stored.apiKey || raw.apiKey || '',
    apiConfigs: profiles,
  }
}

function stripCredentials(config: TurboFluxConfig): TurboFluxConfig {
  return {
    ...config,
    apiKey: '',
    apiConfigs: config.apiConfigs?.map(profile => ({ ...profile, apiKey: '' })),
  }
}

function writeConfigDocument(config: TurboFluxConfig): void {
  writeFileAtomicSync(CONFIG_FILE, JSON.stringify(stripCredentials(config), null, 2), 0o600)
}

export const DEFAULT_FREE_MODEL = ''
export const DEFAULT_CONTEXT_WINDOW = 200_000
export const DEFAULT_MAX_TOKENS = 16_384
export const TURBOFLUX_PROVIDERS: TurboFluxProvider[] = ['openai', 'anthropic', 'deepseek', 'kimi', 'glm', 'openrouter', 'custom']

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
    defaultModel: 'gpt-5.6',
    description: 'Official OpenAI-compatible API.',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-opus-4-8',
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
  {
    id: 'kimi',
    name: 'Kimi',
    provider: 'kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k3',
    description: 'Moonshot Kimi OpenAI-compatible API.',
  },
  {
    id: 'glm',
    name: 'GLM',
    provider: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-5.2',
    description: 'Zhipu GLM OpenAI-compatible API.',
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
  maxOutputTokens: spec.maxOutputTokens,
  reasoning: normalizeNativeReasoningConfig(spec.id, undefined, spec.provider),
  description: spec.description,
  capabilities: {
    vision: spec.supportsVision,
    reasoning: Boolean(normalizeNativeReasoningConfig(spec.id, undefined, spec.provider)),
  },
  metadataSources: ['builtin'],
  availability: 'builtin',
}))

const DEFAULT_CONFIG: TurboFluxConfig = {
  provider: 'custom',
  apiKey: '',
  baseUrl: '',
  model: DEFAULT_FREE_MODEL,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  maxTokens: DEFAULT_MAX_TOKENS,
  approvalPolicy: 'ask',
  reasoning: undefined,
  apiConfigs: [],
  activeApiConfigId: undefined,
  fastContextModel: EMPTY_FAST_CONTEXT_MODEL,
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
  const approvalPolicy = normalizeApprovalPolicy(raw.approvalPolicy, DEFAULT_CONFIG.approvalPolicy)
  const profiles = normalizeApiConfigProfiles((raw as any).apiConfigs)
  let activeApiConfigId = typeof raw.activeApiConfigId === 'string' ? raw.activeApiConfigId : undefined
  const activeProfile = profiles.find(profile => profile.id === activeApiConfigId)
  const hasCurrentConfig = Boolean(model || baseUrl || apiKey)
  const now = Date.now()
  let nextProfiles = profiles
  if (!activeProfile && hasCurrentConfig) {
    const migrated = buildApiConfigProfile({
      id: activeApiConfigId || 'main',
      name: 'Main',
      provider,
      apiKey,
      baseUrl,
      model,
      contextWindow,
      maxTokens,
      reasoning: normalizeNativeReasoningConfig(model, raw.reasoning, provider, raw.modelCapabilities),
      createdAt: now,
      updatedAt: now,
    })
    nextProfiles = upsertApiConfigProfile(profiles, migrated)
    activeApiConfigId = migrated.id
  } else if (!activeProfile) {
    activeApiConfigId = nextProfiles[0]?.id
  }

  const selected = nextProfiles.find(profile => profile.id === activeApiConfigId)
  const fastContextModel = normalizeFastContextModelConfig((raw as any).fastContextModel, nextProfiles)
  return {
    provider: selected?.provider ?? provider,
    apiKey: selected?.apiKey ?? apiKey,
    baseUrl: selected?.baseUrl ?? baseUrl,
    model: selected?.model ?? model,
    contextWindow: selected?.contextWindow ?? contextWindow,
    maxTokens: selected?.maxTokens ?? maxTokens,
    maxOutputTokens: selected?.maxOutputTokens,
    modelCapabilities: selected?.modelCapabilities,
    modelMetadataSources: selected?.modelMetadataSources,
    approvalPolicy,
    reasoning: selected?.reasoning ?? normalizeNativeReasoningConfig(model, raw.reasoning, provider, raw.modelCapabilities),
    apiConfigs: nextProfiles,
    activeApiConfigId,
    fastContextModel,
  }
}

function buildApiConfigProfile(raw: Partial<TurboFluxApiConfigProfile> & Partial<TurboFluxConfig>): TurboFluxApiConfigProfile {
  const now = Date.now()
  const provider = normalizeProvider(raw.provider, DEFAULT_CONFIG.provider)
  const model = typeof raw.model === 'string' ? raw.model.trim() : DEFAULT_CONFIG.model
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/+$/, '') : DEFAULT_CONFIG.baseUrl
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : DEFAULT_CONFIG.apiKey
  const contextWindow = positiveInteger(raw.contextWindow, DEFAULT_CONFIG.contextWindow)
  const maxTokens = positiveInteger(raw.maxTokens, DEFAULT_CONFIG.maxTokens)
  const maxOutputTokens = raw.maxOutputTokens === undefined ? undefined : positiveInteger(raw.maxOutputTokens, maxTokens)
  const reasoning = normalizeNativeReasoningConfig(model, raw.reasoning, provider, raw.modelCapabilities)
  const id = typeof raw.id === 'string' && raw.id.trim()
    ? raw.id.trim()
    : `api_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : defaultApiConfigName(provider, model, id),
    provider,
    apiKey,
    baseUrl,
    model,
    contextWindow,
    maxTokens,
    maxOutputTokens,
    modelCapabilities: raw.modelCapabilities,
    modelMetadataSources: raw.modelMetadataSources,
    reasoning,
    createdAt: positiveInteger(raw.createdAt, now),
    updatedAt: positiveInteger(raw.updatedAt, now),
  }
}

function normalizeApiConfigProfiles(value: unknown): TurboFluxApiConfigProfile[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const profiles: TurboFluxApiConfigProfile[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const profile = buildApiConfigProfile(item as Partial<TurboFluxApiConfigProfile>)
    let id = profile.id
    let suffix = 2
    while (seen.has(id)) {
      id = `${profile.id}-${suffix++}`
    }
    seen.add(id)
    profiles.push({ ...profile, id })
  }
  return profiles
}

function normalizeFastContextModelConfig(_value: unknown, _profiles: TurboFluxApiConfigProfile[]): FastContextModelConfig {
  return { mode: 'follow-main' }
}

function emptyConfigWithProfiles(fastContextModel: FastContextModelConfig = EMPTY_FAST_CONTEXT_MODEL): TurboFluxConfig {
  return {
    ...DEFAULT_CONFIG,
    apiConfigs: [],
    activeApiConfigId: undefined,
    fastContextModel,
  }
}

export function createEmptyConfig(): TurboFluxConfig {
  return emptyConfigWithProfiles()
}

function defaultApiConfigName(provider: TurboFluxProvider, model: string, id: string): string {
  const presetName = PROVIDER_PRESETS.find(preset => preset.provider === provider && preset.id !== 'custom')?.name
    || PROVIDER_PRESETS.find(preset => preset.provider === provider)?.name
    || provider
  return model ? `${presetName} / ${model}` : id
}

function upsertApiConfigProfile(profiles: TurboFluxApiConfigProfile[] | undefined, profile: TurboFluxApiConfigProfile): TurboFluxApiConfigProfile[] {
  const list = profiles ?? []
  const index = list.findIndex(item => item.id === profile.id)
  if (index < 0) return [...list, profile]
  return list.map((item, i) => i === index ? { ...profile, createdAt: item.createdAt || profile.createdAt } : item)
}

function activeFieldsFromProfile(config: TurboFluxConfig, profile?: TurboFluxApiConfigProfile): TurboFluxConfig {
  if (!profile) return config
  return {
    ...config,
    provider: profile.provider,
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    model: profile.model,
    contextWindow: profile.contextWindow,
    maxTokens: profile.maxTokens,
    maxOutputTokens: profile.maxOutputTokens,
    modelCapabilities: profile.modelCapabilities,
    modelMetadataSources: profile.modelMetadataSources,
    reasoning: profile.reasoning,
    activeApiConfigId: profile.id,
  }
}

function syncActiveProfile(config: TurboFluxConfig): TurboFluxConfig {
  const normalizedProfiles = normalizeApiConfigProfiles(config.apiConfigs)
  const hasCurrentConfig = Boolean(config.model || config.baseUrl || config.apiKey)
  if (normalizedProfiles.length === 0 && !hasCurrentConfig) {
    return {
      ...config,
      provider: normalizeProvider(config.provider, DEFAULT_CONFIG.provider),
      apiKey: '',
      baseUrl: '',
      model: '',
      contextWindow: positiveInteger(config.contextWindow, DEFAULT_CONFIG.contextWindow),
      maxTokens: positiveInteger(config.maxTokens, DEFAULT_CONFIG.maxTokens),
      reasoning: undefined,
      apiConfigs: [],
      activeApiConfigId: undefined,
      fastContextModel: EMPTY_FAST_CONTEXT_MODEL,
    }
  }
  const activeId = config.activeApiConfigId || normalizedProfiles[0]?.id || 'main'
  const existing = normalizedProfiles.find(profile => profile.id === activeId)
  const now = Date.now()
  const activeProfile = buildApiConfigProfile({
    ...(existing ?? {}),
    id: activeId,
    name: existing?.name || defaultApiConfigName(config.provider, config.model, activeId),
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    maxOutputTokens: config.maxOutputTokens,
    modelCapabilities: config.modelCapabilities,
    modelMetadataSources: config.modelMetadataSources,
    reasoning: config.reasoning,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  })
  const profiles = upsertApiConfigProfile(normalizedProfiles, activeProfile)
  return activeFieldsFromProfile({
    ...config,
    apiConfigs: profiles,
    activeApiConfigId: activeId,
    fastContextModel: normalizeFastContextModelConfig(config.fastContextModel, profiles),
  }, activeProfile)
}

export function setConfigValue(config: TurboFluxConfig, key: string, value: string): TurboFluxConfig {
  const updateActive = (next: TurboFluxConfig): TurboFluxConfig => syncActiveProfile(next)
  switch (key) {
    case 'provider': {
      if (!TURBOFLUX_PROVIDERS.includes(value as TurboFluxProvider)) {
        throw new Error(`Invalid provider. Use one of: ${TURBOFLUX_PROVIDERS.join(', ')}`)
      }
      return updateActive({ ...config, provider: value as TurboFluxProvider })
    }
    case 'apiKey':
      return updateActive({ ...config, apiKey: value })
    case 'baseUrl': {
      try {
        new URL(value)
      } catch {
        throw new Error('Invalid baseUrl. Use a full URL such as https://api.example.com/v1')
      }
      return updateActive({ ...config, baseUrl: value.replace(/\/+$/, '') })
    }
    case 'model':
      if (!value.trim()) throw new Error('model cannot be empty')
      return updateActive({
        ...config,
        model: value.trim(),
        maxOutputTokens: undefined,
        modelCapabilities: undefined,
        modelMetadataSources: undefined,
        reasoning: normalizeNativeReasoningConfig(value.trim(), config.reasoning, config.provider),
      })
    case 'approvalPolicy':
      if (!['ask', 'agent', 'full', 'request', 'auto'].includes(value.toLowerCase())) {
        throw new Error('approvalPolicy must be ask, agent, or full')
      }
      return { ...config, approvalPolicy: normalizeApprovalPolicy(value.toLowerCase(), config.approvalPolicy) }
    case 'reasoningEnabled': {
      const normalized = value.toLowerCase()
      if (!['true', 'false', 'on', 'off', 'enabled', 'disabled'].includes(normalized)) {
        throw new Error('reasoningEnabled must be on or off')
      }
      return updateActive({
        ...config,
        reasoning: normalizeNativeReasoningConfig(config.model, {
          ...config.reasoning,
          enabled: ['true', 'on', 'enabled'].includes(normalized),
        }, config.provider, config.modelCapabilities),
      })
    }
    case 'reasoningEffort':
      return updateActive({
        ...config,
        reasoning: normalizeNativeReasoningConfig(config.model, {
          ...config.reasoning,
          effort: value.toLowerCase() as NativeReasoningConfig['effort'],
        }, config.provider, config.modelCapabilities),
      })
    case 'reasoningBudgetTokens': {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 1024) throw new Error('reasoningBudgetTokens must be at least 1024')
      return updateActive({
        ...config,
        reasoning: normalizeNativeReasoningConfig(config.model, {
          ...config.reasoning,
          budgetTokens: parsed,
        }, config.provider, config.modelCapabilities),
      })
    }
    case 'contextWindow':
    case 'maxTokens': {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${key} must be a positive integer`)
      }
      if (key === 'maxTokens' && config.maxOutputTokens && parsed > config.maxOutputTokens) {
        throw new Error(`maxTokens cannot exceed this model's ${config.maxOutputTokens} token output limit`)
      }
      return updateActive({ ...config, [key]: parsed } as TurboFluxConfig)
    }
    default:
      throw new Error(`Unknown config key "${key}". Valid keys: provider, apiKey, baseUrl, model, contextWindow, maxTokens, approvalPolicy, reasoningEnabled, reasoningEffort, reasoningBudgetTokens`)
  }
}

function applyKnownModelMetadata(config: TurboFluxConfig, presets: ModelPreset[]): TurboFluxConfig {
  const spec = getSupportedModelSpec(config.model)
  return spec ? {
    ...config,
    model: spec.id,
    reasoning: normalizeNativeReasoningConfig(spec.id, config.reasoning, spec.provider),
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
    const initial = applyKnownModelMetadata(normalizeConfig(hydrateCredentials(DEFAULT_CONFIG)), MODEL_PRESETS)
    writeConfigDocument(initial)
    return initial
  }

  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8').replace(/^\uFEFF/, '')
    const userConfig = JSON.parse(raw)
    const merged = normalizeConfig(hydrateCredentials({ ...DEFAULT_CONFIG, ...userConfig }))
  if (looksLikeLegacyLocalProxyDefault(userConfig)) {
      const reset = emptyConfigWithProfiles()
      writeConfigDocument(reset)
      return reset
    }
    if (looksLikeLegacyBundledDefault(userConfig)) {
      const migrated = emptyConfigWithProfiles()
      writeConfigDocument(migrated)
      return migrated
    }
    const withBackendMetadata = applyKnownModelMetadata(merged, MODEL_PRESETS)
    if (
      withBackendMetadata.contextWindow !== merged.contextWindow ||
      withBackendMetadata.maxTokens !== merged.maxTokens ||
      withBackendMetadata.model !== merged.model
    ) {
      saveConfig(withBackendMetadata)
    } else if (userConfig.apiKey || userConfig.apiConfigs?.some((profile: TurboFluxApiConfigProfile) => profile.apiKey)) {
      saveConfig(withBackendMetadata)
    }
    return syncActiveProfile(withBackendMetadata)
  } catch {
    return normalizeConfig(DEFAULT_CONFIG)
  }
}

export function saveConfig(config: TurboFluxConfig): void {
  ensureDirectories()
  const normalized = syncActiveProfile(normalizeConfig(config))
  saveCredentialSnapshot({
    apiKey: normalized.apiKey || undefined,
    apiConfigs: Object.fromEntries((normalized.apiConfigs || []).filter(profile => profile.apiKey).map(profile => [profile.id, profile.apiKey])),
  })
  writeConfigDocument(normalized)
}

export function getConfigDir(): string {
  return CONFIG_DIR
}

export function redactConfig(config: TurboFluxConfig): TurboFluxConfig {
  return {
    ...config,
    apiKey: config.apiKey ? '***' : '',
    apiConfigs: config.apiConfigs?.map(profile => ({ ...profile, apiKey: profile.apiKey ? '***' : '' })),
  }
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
  return syncActiveProfile({
    ...config,
    provider: preset.provider,
    model: preset.model,
    baseUrl: preset.baseUrl,
    contextWindow: preset.contextWindow,
    maxTokens: Math.min(preset.maxTokens, preset.maxOutputTokens ?? preset.maxTokens),
    maxOutputTokens: preset.maxOutputTokens,
    modelCapabilities: preset.capabilities,
    modelMetadataSources: preset.metadataSources,
    reasoning: normalizeNativeReasoningConfig(preset.model, preset.reasoning ?? config.reasoning, preset.provider, preset.capabilities),
  })
}

export function configFromProviderPreset(preset: ProviderPreset, apiKey: string, model?: string, baseUrl?: string): TurboFluxConfig {
  const selectedModel = model?.trim() || preset.defaultModel
  const spec = getSupportedModelSpec(selectedModel)
  const selectedApiKey = apiKey || ''
  return syncActiveProfile({
    provider: preset.provider,
    apiKey: selectedApiKey,
    baseUrl: (baseUrl?.trim() || preset.baseUrl).replace(/\/+$/, ''),
    model: spec?.id ?? selectedModel,
    contextWindow: spec?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: spec?.defaultRequestTokens ?? DEFAULT_MAX_TOKENS,
    maxOutputTokens: spec?.maxOutputTokens,
    modelCapabilities: spec ? {
      vision: spec.supportsVision,
      reasoning: Boolean(normalizeNativeReasoningConfig(spec.id, undefined, preset.provider)),
    } : undefined,
    modelMetadataSources: spec ? ['builtin'] : ['default'],
    approvalPolicy: 'ask',
    reasoning: normalizeNativeReasoningConfig(spec?.id ?? selectedModel, undefined, preset.provider),
    apiConfigs: [],
    activeApiConfigId: 'main',
    fastContextModel: { mode: 'follow-main' },
  })
}

export function getApiConfigProfiles(config: TurboFluxConfig): TurboFluxApiConfigProfile[] {
  return normalizeConfig(config).apiConfigs ?? []
}

export function getActiveApiConfigProfile(config: TurboFluxConfig): TurboFluxApiConfigProfile | undefined {
  const normalized = normalizeConfig(config)
  return normalized.apiConfigs?.find(profile => profile.id === normalized.activeApiConfigId)
}

export function saveApiConfigProfile(config: TurboFluxConfig, profile: TurboFluxApiConfigProfile, makeActive = true): TurboFluxConfig {
  const normalized = normalizeConfig(config)
  const profiles = upsertApiConfigProfile(normalized.apiConfigs, { ...profile, updatedAt: Date.now() })
  const next = {
    ...normalized,
    apiConfigs: profiles,
    activeApiConfigId: makeActive ? profile.id : normalized.activeApiConfigId,
  }
  const selected = profiles.find(item => item.id === next.activeApiConfigId)
  return activeFieldsFromProfile({ ...next, fastContextModel: normalizeFastContextModelConfig(next.fastContextModel, profiles) }, selected)
}

export function createApiConfigProfile(input: Partial<TurboFluxApiConfigProfile> & Partial<TurboFluxConfig>): TurboFluxApiConfigProfile {
  return buildApiConfigProfile(input)
}

export function switchActiveApiConfig(config: TurboFluxConfig, apiConfigId: string): TurboFluxConfig {
  const normalized = normalizeConfig(config)
  const profile = normalized.apiConfigs?.find(item => item.id === apiConfigId)
  if (!profile) throw new Error(`API config not found: ${apiConfigId}`)
  return activeFieldsFromProfile({ ...normalized, activeApiConfigId: apiConfigId }, profile)
}

export function deleteApiConfigProfile(config: TurboFluxConfig, apiConfigId: string): TurboFluxConfig {
  const normalized = normalizeConfig(config)
  const profiles = (normalized.apiConfigs ?? []).filter(profile => profile.id !== apiConfigId)
  if (profiles.length === 0) {
    return emptyConfigWithProfiles()
  }
  const nextActiveId = normalized.activeApiConfigId === apiConfigId
    ? profiles[0]?.id
    : normalized.activeApiConfigId
  const next = {
    ...normalized,
    apiConfigs: profiles,
    activeApiConfigId: nextActiveId,
    fastContextModel: normalized.fastContextModel?.apiConfigId === apiConfigId
      ? { mode: 'follow-main' as const }
      : normalized.fastContextModel,
  }
  return activeFieldsFromProfile({ ...next, fastContextModel: normalizeFastContextModelConfig(next.fastContextModel, profiles) }, profiles.find(p => p.id === nextActiveId))
}

export function setFastContextModelConfig(config: TurboFluxConfig, _fastContextModel: FastContextModelConfig): TurboFluxConfig {
  const normalized = normalizeConfig(config)
  return {
    ...normalized,
    fastContextModel: { mode: 'follow-main' },
  }
}

export function getFastContextApiConfig(_config: TurboFluxConfig): TurboFluxApiConfigProfile | undefined {
  return undefined
}
