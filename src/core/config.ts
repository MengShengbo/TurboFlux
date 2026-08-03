import { existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getSupportedModelSpec, normalizeNativeReasoningConfig, SUPPORTED_MODEL_SPECS } from './modelRegistry'
import {
  normalizeApprovalPolicy,
  normalizeCapabilityProfile,
  resolveCapabilityProfileForApproval,
  type ApprovalPolicy,
  type CapabilityProfile,
  type NativeReasoningConfig,
} from '../shared/agentTypes'
import {
  getCredentialsFile,
  loadCredentialSnapshot,
  serializeCredentialSnapshot,
  type CredentialSnapshot,
} from './credentialStore'
import {
  quarantineCorruptFileSync,
  recoverFilesAtomicSync,
  withFileLockSync,
  writeFileAtomicSync,
  writeFilesAtomicSync,
} from './fileIO'

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
  capabilityProfile?: CapabilityProfile
  gitEnabled: boolean
  reasoning?: NativeReasoningConfig
  apiConfigs?: TurboFluxApiConfigProfile[]
  activeApiConfigId?: string
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
const CONFIG_TRANSACTION_FILE = join(CONFIG_DIR, '.config-transaction.json')
const CONFIG_LOCK_FILE = join(CONFIG_DIR, '.config.lock')

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

function legacyCredentialSnapshot(raw: Partial<TurboFluxConfig>): CredentialSnapshot {
  return {
    apiKey: typeof raw.apiKey === 'string' && raw.apiKey ? raw.apiKey : undefined,
    apiConfigs: Object.fromEntries(
      (Array.isArray(raw.apiConfigs) ? raw.apiConfigs : [])
        .filter(profile => typeof profile?.id === 'string' && typeof profile.apiKey === 'string' && profile.apiKey)
        .map(profile => [profile.id, profile.apiKey]),
    ),
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
  capabilityProfile: 'workspace-write',
  gitEnabled: true,
  reasoning: undefined,
  apiConfigs: [],
  activeApiConfigId: undefined,
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
  const capabilityProfile = resolveCapabilityProfileForApproval(
    approvalPolicy,
    raw.capabilityProfile,
    DEFAULT_CONFIG.capabilityProfile,
  )
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
      maxOutputTokens: raw.maxOutputTokens,
      modelCapabilities: raw.modelCapabilities,
      modelMetadataSources: raw.modelMetadataSources,
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
    capabilityProfile,
    gitEnabled: raw.gitEnabled !== false,
    reasoning: selected?.reasoning ?? normalizeNativeReasoningConfig(model, raw.reasoning, provider, raw.modelCapabilities),
    apiConfigs: nextProfiles,
    activeApiConfigId,
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

function emptyConfigWithProfiles(): TurboFluxConfig {
  return {
    ...DEFAULT_CONFIG,
    apiConfigs: [],
    activeApiConfigId: undefined,
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

function syncActiveProfile(config: TurboFluxConfig, touchUpdatedAt = true): TurboFluxConfig {
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
    }
  }
  const activeId = config.activeApiConfigId || normalizedProfiles[0]?.id || 'main'
  const existing = normalizedProfiles.find(profile => profile.id === activeId)
  const now = Date.now()
  const activeFieldsChanged = !existing || existing.provider !== config.provider
    || existing.apiKey !== config.apiKey
    || existing.baseUrl !== config.baseUrl.replace(/\/+$/, '')
    || existing.model !== config.model.trim()
    || existing.contextWindow !== config.contextWindow
    || existing.maxTokens !== config.maxTokens
    || existing.maxOutputTokens !== config.maxOutputTokens
    || JSON.stringify(existing.modelCapabilities) !== JSON.stringify(config.modelCapabilities)
    || JSON.stringify(existing.modelMetadataSources) !== JSON.stringify(config.modelMetadataSources)
    || JSON.stringify(existing.reasoning) !== JSON.stringify(normalizeNativeReasoningConfig(config.model, config.reasoning, config.provider, config.modelCapabilities))
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
    updatedAt: touchUpdatedAt && activeFieldsChanged ? now : existing?.updatedAt || now,
  })
  const profiles = upsertApiConfigProfile(normalizedProfiles, activeProfile)
  return activeFieldsFromProfile({
    ...config,
    apiConfigs: profiles,
    activeApiConfigId: activeId,
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
      {
        const approvalPolicy = normalizeApprovalPolicy(value.toLowerCase(), config.approvalPolicy)
        const capabilityProfile = approvalPolicy === 'full'
          ? 'danger-full-access'
          : config.approvalPolicy === 'full' && config.capabilityProfile === 'danger-full-access'
            ? 'workspace-write'
            : normalizeCapabilityProfile(config.capabilityProfile)
        return { ...config, approvalPolicy, capabilityProfile }
      }
    case 'capabilityProfile':
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(value.toLowerCase())) {
        throw new Error('capabilityProfile must be read-only, workspace-write, or danger-full-access')
      }
      {
        const capabilityProfile = normalizeCapabilityProfile(value.toLowerCase(), config.capabilityProfile)
        const approvalPolicy = config.approvalPolicy === 'full' && capabilityProfile !== 'danger-full-access'
          ? 'agent'
          : config.approvalPolicy
        return { ...config, approvalPolicy, capabilityProfile }
      }
    case 'gitEnabled': {
      const normalized = value.toLowerCase()
      if (!['true', 'false', 'on', 'off', 'enabled', 'disabled'].includes(normalized)) {
        throw new Error('gitEnabled must be on or off')
      }
      return { ...config, gitEnabled: ['true', 'on', 'enabled'].includes(normalized) }
    }
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
      throw new Error(`Unknown config key "${key}". Valid keys: provider, apiKey, baseUrl, model, contextWindow, maxTokens, approvalPolicy, capabilityProfile, gitEnabled, reasoningEnabled, reasoningEffort, reasoningBudgetTokens`)
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
  const dirs = [CONFIG_DIR, CONVERSATIONS_DIR]
  if (workspacePath) {
    dirs.push(join(workspacePath, '.turboflux', 'memory'))
  }
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }
}

function credentialSnapshotForSave(config: TurboFluxConfig, fallback: CredentialSnapshot = {}): CredentialSnapshot {
  const stored = loadCredentialSnapshot()
  const envApiKey = process.env.TURBOFLUX_API_KEY?.trim()
  const activeId = config.activeApiConfigId
  const persistentActiveKey = activeId
    ? stored.apiConfigs?.[activeId] ?? fallback.apiConfigs?.[activeId] ?? stored.apiKey ?? fallback.apiKey
    : stored.apiKey ?? fallback.apiKey
  const apiConfigs = Object.fromEntries((config.apiConfigs || []).flatMap(profile => {
    const key = envApiKey && profile.id === activeId && profile.apiKey === envApiKey
      ? stored.apiConfigs?.[profile.id] ?? fallback.apiConfigs?.[profile.id] ?? persistentActiveKey
      : profile.apiKey
    return key ? [[profile.id, key]] : []
  }))
  const apiKey = envApiKey && config.apiKey === envApiKey
    ? persistentActiveKey
    : config.apiKey || undefined
  return { apiKey, apiConfigs }
}

function persistConfig(config: TurboFluxConfig, fallbackCredentials?: CredentialSnapshot): TurboFluxConfig {
  const normalized = syncActiveProfile(normalizeConfig(config))
  const credentials = credentialSnapshotForSave(normalized, fallbackCredentials)
  writeFilesAtomicSync([
    {
      filePath: getCredentialsFile(),
      content: serializeCredentialSnapshot(credentials),
      mode: 0o600,
    },
    {
      filePath: CONFIG_FILE,
      content: JSON.stringify(stripCredentials(normalized), null, 2),
      mode: 0o600,
    },
  ], CONFIG_TRANSACTION_FILE)
  return normalized
}

export async function loadConfig(): Promise<TurboFluxConfig> {
  ensureDirectories()
  return withFileLockSync(CONFIG_LOCK_FILE, () => {
    recoverFilesAtomicSync(CONFIG_TRANSACTION_FILE)
    if (!existsSync(CONFIG_FILE)) {
      const initial = applyKnownModelMetadata(normalizeConfig(hydrateCredentials(DEFAULT_CONFIG)), MODEL_PRESETS)
      writeConfigDocument(initial)
      return initial
    }

    let userConfig: Partial<TurboFluxConfig>
    try {
      const raw = readFileSync(CONFIG_FILE, 'utf-8').replace(/^\uFEFF/, '')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Configuration must be a JSON object')
      userConfig = parsed as Partial<TurboFluxConfig>
    } catch (error) {
      const backupPath = quarantineCorruptFileSync(CONFIG_FILE)
      console.warn(`TurboFlux preserved an invalid configuration file at ${backupPath}: ${error instanceof Error ? error.message : String(error)}`)
      const recovered = applyKnownModelMetadata(normalizeConfig(hydrateCredentials(DEFAULT_CONFIG)), MODEL_PRESETS)
      writeConfigDocument(recovered)
      return recovered
    }

    const legacyCredentials = legacyCredentialSnapshot(userConfig)
    const merged = normalizeConfig(hydrateCredentials({ ...DEFAULT_CONFIG, ...userConfig }))
    if (looksLikeLegacyLocalProxyDefault(userConfig) || looksLikeLegacyBundledDefault(userConfig)) {
      return persistConfig(emptyConfigWithProfiles())
    }
    const withBackendMetadata = applyKnownModelMetadata(merged, MODEL_PRESETS)
    const hasLegacyCredentials = Boolean(userConfig.apiKey)
      || (Array.isArray(userConfig.apiConfigs) && userConfig.apiConfigs.some(profile => Boolean(profile.apiKey)))
    const needsFullAccessMigration = withBackendMetadata.approvalPolicy === 'full'
      && userConfig.capabilityProfile !== 'danger-full-access'
    if (
      withBackendMetadata.contextWindow !== merged.contextWindow ||
      withBackendMetadata.maxTokens !== merged.maxTokens ||
      withBackendMetadata.model !== merged.model ||
      hasLegacyCredentials ||
      needsFullAccessMigration
    ) {
      return persistConfig(withBackendMetadata, legacyCredentials)
    }
    return syncActiveProfile(withBackendMetadata, false)
  })
}

export function saveConfig(config: TurboFluxConfig): TurboFluxConfig {
  ensureDirectories()
  return withFileLockSync(CONFIG_LOCK_FILE, () => {
    recoverFilesAtomicSync(CONFIG_TRANSACTION_FILE)
    return persistConfig(config)
  })
}

export function getConfigDir(): string {
  return CONFIG_DIR
}

export function getConfigFile(): string {
  return CONFIG_FILE
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
    gitEnabled: true,
    reasoning: normalizeNativeReasoningConfig(spec?.id ?? selectedModel, undefined, preset.provider),
    apiConfigs: [],
    activeApiConfigId: 'main',
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
  const existing = normalized.apiConfigs?.find(item => item.id === profile.id)
  const unchanged = existing
    && existing.name === profile.name
    && existing.provider === profile.provider
    && existing.apiKey === profile.apiKey
    && existing.baseUrl === profile.baseUrl
    && existing.model === profile.model
    && existing.contextWindow === profile.contextWindow
    && existing.maxTokens === profile.maxTokens
    && existing.maxOutputTokens === profile.maxOutputTokens
    && JSON.stringify(existing.modelCapabilities) === JSON.stringify(profile.modelCapabilities)
    && JSON.stringify(existing.modelMetadataSources) === JSON.stringify(profile.modelMetadataSources)
    && JSON.stringify(existing.reasoning) === JSON.stringify(profile.reasoning)
  const storedProfile = {
    ...profile,
    createdAt: existing?.createdAt || profile.createdAt,
    updatedAt: unchanged ? existing.updatedAt : Date.now(),
  }
  const profiles = upsertApiConfigProfile(normalized.apiConfigs, storedProfile)
  const next = {
    ...normalized,
    apiConfigs: profiles,
    activeApiConfigId: makeActive ? profile.id : normalized.activeApiConfigId,
  }
  const selected = profiles.find(item => item.id === next.activeApiConfigId)
  return activeFieldsFromProfile(next, selected)
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
  }
  return activeFieldsFromProfile(next, profiles.find(profile => profile.id === nextActiveId))
}
