import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'
import { REASONING_EFFORTS, type ReasoningEffort } from '../shared/agentTypes'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  MODEL_PRESETS,
  getConfigDir,
  type ModelCapabilities,
  type ModelMetadataSource,
  type ModelPreset,
  type TurboFluxConfig,
} from './config'
import { writeFileAtomicSync } from './fileIO'
import { getModelReasoningCapabilities, getSupportedModelSpec, normalizeNativeReasoningConfig } from './modelRegistry'
import { normalizeBaseUrl } from './normalizeBaseUrl'

const DISCOVERY_CACHE_VERSION = 1
const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000
const REGISTRY_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const MAX_MODELS = 2_000
const MAX_MODEL_ID_LENGTH = 256

type JsonRecord = Record<string, unknown>

interface ParsedModelMetadata {
  contextWindow?: number
  maxOutputTokens?: number
  capabilities: ModelCapabilities
  hasMetadata: boolean
}

interface ModelDiscoveryCacheDocument {
  version: number
  fetchedAt: number
  models: ModelPreset[]
}

interface ModelsDevCacheDocument {
  fetchedAt: number
  data: JsonRecord
}

export interface ModelDiscoveryResult {
  models: ModelPreset[]
  fetchedAt: number
  source: 'network' | 'cache' | 'fallback'
  stale: boolean
  error?: string
}

export interface ModelDiscoveryOptions {
  force?: boolean
}

class ModelDiscoveryHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function nested(record: JsonRecord | undefined, ...path: string[]): unknown {
  let current: unknown = record
  for (const key of path) {
    current = asRecord(current)?.[key]
    if (current === undefined) return undefined
  }
  return current
}

function positiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
    if (Number.isInteger(parsed) && parsed > 0) return parsed
  }
  return undefined
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return stripAnsi(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength)
}

function stringList(value: unknown, maxItems = 64): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result = [...new Set(value
    .map(item => cleanText(item, 96).toLowerCase())
    .filter(Boolean))]
    .slice(0, maxItems)
  return result.length > 0 ? result : undefined
}

function supported(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  const record = asRecord(value)
  return typeof record?.supported === 'boolean' ? record.supported : undefined
}

function mergeBoolean(primary: boolean | undefined, fallback: boolean | undefined): boolean | undefined {
  return primary === undefined ? fallback : primary
}

function mergeLists(primary?: string[], fallback?: string[]): string[] | undefined {
  if (!primary?.length) return fallback
  if (!fallback?.length) return primary
  return [...new Set([...primary, ...fallback])]
}

function mergeCapabilities(primary: ModelCapabilities, fallback: ModelCapabilities): ModelCapabilities {
  return {
    tools: mergeBoolean(primary.tools, fallback.tools),
    vision: mergeBoolean(primary.vision, fallback.vision),
    reasoning: mergeBoolean(primary.reasoning, fallback.reasoning),
    structuredOutput: mergeBoolean(primary.structuredOutput, fallback.structuredOutput),
    inputModalities: mergeLists(primary.inputModalities, fallback.inputModalities),
    outputModalities: mergeLists(primary.outputModalities, fallback.outputModalities),
    supportedParameters: mergeLists(primary.supportedParameters, fallback.supportedParameters),
    supportedEndpoints: mergeLists(primary.supportedEndpoints, fallback.supportedEndpoints),
    reasoningEfforts: mergeLists(primary.reasoningEfforts, fallback.reasoningEfforts) as ReasoningEffort[] | undefined,
  }
}

function capabilityEfforts(capabilities: JsonRecord | undefined, reasoning: JsonRecord | undefined): ReasoningEffort[] | undefined {
  const direct = stringList(reasoning?.supported_efforts)
    ?? stringList(reasoning?.efforts)
    ?? stringList(capabilities?.reasoning_efforts)
  if (direct) {
    const valid = direct.filter(value => REASONING_EFFORTS.includes(value as ReasoningEffort)) as ReasoningEffort[]
    return valid.length > 0 ? valid : undefined
  }

  const effort = asRecord(capabilities?.effort)
  if (!effort) return undefined
  const valid = Object.entries(effort)
    .filter(([key, value]) => REASONING_EFFORTS.includes(key as ReasoningEffort) && supported(value) !== false)
    .map(([key]) => key as ReasoningEffort)
  return valid.length > 0 ? valid : undefined
}

function extractModelMetadata(raw: JsonRecord): ParsedModelMetadata {
  const modelInfo = asRecord(raw.model_info)
  const topProvider = asRecord(raw.top_provider)
  const architecture = asRecord(raw.architecture)
  const capabilities = asRecord(raw.capabilities)
  const reasoning = asRecord(raw.reasoning)
  const supportedParameters = stringList(raw.supported_parameters ?? modelInfo?.supported_parameters)
  const inputModalities = stringList(
    architecture?.input_modalities
      ?? nested(raw, 'modalities', 'input')
      ?? modelInfo?.input_modalities,
  )
  const outputModalities = stringList(
    architecture?.output_modalities
      ?? nested(raw, 'modalities', 'output')
      ?? modelInfo?.output_modalities,
  )
  const reasoningEfforts = capabilityEfforts(capabilities, reasoning)
  const tools = mergeBoolean(
    supported(capabilities?.tools ?? capabilities?.tool_use ?? capabilities?.function_calling),
    supportedParameters?.some(parameter => parameter === 'tools' || parameter === 'tool_choice'),
  )
  const vision = mergeBoolean(
    supported(capabilities?.image_input ?? capabilities?.vision),
    inputModalities?.includes('image'),
  )
  const reasoningSupported = mergeBoolean(
    supported(capabilities?.thinking ?? capabilities?.reasoning),
    reasoning || reasoningEfforts?.length || supportedParameters?.some(parameter => parameter.includes('reasoning'))
      ? true
      : undefined,
  )
  const structuredOutput = mergeBoolean(
    supported(capabilities?.structured_outputs ?? capabilities?.structured_output),
    supportedParameters?.some(parameter => parameter === 'structured_outputs' || parameter === 'response_format'),
  )
  const contextWindow = positiveInteger(
    raw.context_window,
    raw.context_length,
    raw.max_context_length,
    raw.max_input_tokens,
    raw.inputTokenLimit,
    modelInfo?.context_window,
    modelInfo?.context_length,
    modelInfo?.max_input_tokens,
    topProvider?.context_length,
  )
  const maxOutputTokens = positiveInteger(
    raw.max_completion_tokens,
    raw.max_output_tokens,
    raw.outputTokenLimit,
    raw.max_tokens,
    modelInfo?.max_output_tokens,
    modelInfo?.max_tokens,
    topProvider?.max_completion_tokens,
  )
  const parsedCapabilities: ModelCapabilities = {
    tools,
    vision,
    reasoning: reasoningSupported,
    structuredOutput,
    inputModalities,
    outputModalities,
    supportedParameters,
    supportedEndpoints: stringList(raw.supported_endpoint_types ?? modelInfo?.supported_endpoint_types),
    reasoningEfforts,
  }
  const hasMetadata = Boolean(
    contextWindow
      || maxOutputTokens
      || Object.values(parsedCapabilities).some(value => value !== undefined),
  )
  return { contextWindow, maxOutputTokens, capabilities: parsedCapabilities, hasMetadata }
}

function mergeMetadata(primary: ParsedModelMetadata, fallback?: ParsedModelMetadata): ParsedModelMetadata {
  if (!fallback) return primary
  return {
    contextWindow: primary.contextWindow ?? fallback.contextWindow,
    maxOutputTokens: primary.maxOutputTokens ?? fallback.maxOutputTokens,
    capabilities: mergeCapabilities(primary.capabilities, fallback.capabilities),
    hasMetadata: primary.hasMetadata || fallback.hasMetadata,
  }
}

function modelRows(payload: unknown): JsonRecord[] {
  const record = asRecord(payload)
  const rows = Array.isArray(record?.data)
    ? record.data
    : Array.isArray(record?.models)
      ? record.models
      : []
  return rows
    .map(asRecord)
    .filter((row): row is JsonRecord => Boolean(row))
    .slice(0, MAX_MODELS)
}

function modelId(row: JsonRecord): string {
  return cleanText(row.id ?? row.model_name ?? row.name, MAX_MODEL_ID_LENGTH)
    .replace(/^models\//, '')
}

function modelName(row: JsonRecord, fallback: string): string {
  return cleanText(row.display_name ?? row.displayName ?? row.name, 160) || fallback
}

function isAgentCandidate(id: string, metadata: ParsedModelMetadata): boolean {
  if (/(^|[-_/])(embedding|embed|rerank|moderation|tts|whisper|transcrib|dall-e|image)([-_/]|$)/i.test(id)) {
    return false
  }
  const endpoints = metadata.capabilities.supportedEndpoints
  if (!endpoints?.length) return true
  return endpoints.some(endpoint => /chat|response|message|generate.?content/i.test(endpoint))
}

function discoveryCacheDirectory(): string {
  const directory = join(getConfigDir(), 'cache')
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  return directory
}

function apiKeyFingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey || 'anonymous').digest('hex').slice(0, 16)
}

function discoveryCachePath(config: TurboFluxConfig): string {
  const identity = [
    config.activeApiConfigId || 'main',
    config.provider,
    config.baseUrl.replace(/\/+$/, '').toLowerCase(),
    apiKeyFingerprint(config.apiKey),
  ].join('|')
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 24)
  return join(discoveryCacheDirectory(), `models-${hash}.json`)
}

function validCachedModels(value: unknown): value is ModelPreset[] {
  return Array.isArray(value) && value.every(item => {
    const record = asRecord(item)
    return Boolean(
      record
      && typeof record.id === 'string'
      && typeof record.model === 'string'
      && typeof record.contextWindow === 'number'
      && typeof record.maxTokens === 'number',
    )
  })
}

export function readCachedModelDiscovery(config: TurboFluxConfig, allowStale = true): ModelDiscoveryResult | undefined {
  const path = discoveryCachePath(config)
  if (!existsSync(path)) return undefined
  try {
    const document = JSON.parse(readFileSync(path, 'utf-8')) as ModelDiscoveryCacheDocument
    if (document.version !== DISCOVERY_CACHE_VERSION || !validCachedModels(document.models)) return undefined
    const stale = Date.now() - document.fetchedAt >= DISCOVERY_CACHE_TTL_MS
    if (stale && !allowStale) return undefined
    return { models: document.models, fetchedAt: document.fetchedAt, source: 'cache', stale }
  } catch {
    return undefined
  }
}

function writeDiscoveryCache(config: TurboFluxConfig, result: ModelDiscoveryResult): void {
  const document: ModelDiscoveryCacheDocument = {
    version: DISCOVERY_CACHE_VERSION,
    fetchedAt: result.fetchedAt,
    models: result.models,
  }
  writeFileAtomicSync(discoveryCachePath(config), JSON.stringify(document), 0o600)
}

function retryable(error: unknown): boolean {
  return !(error instanceof ModelDiscoveryHttpError) || error.status === 429 || error.status >= 500
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchJson(url: string, headers: Record<string, string>, maxBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
        redirect: 'error',
      })
      if (!response.ok) throw new ModelDiscoveryHttpError(response.status, `Model API returned HTTP ${response.status}`)
      const contentLength = positiveInteger(response.headers.get('content-length'))
      if (contentLength && contentLength > maxBytes) throw new Error('Model API response is too large')
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > maxBytes) throw new Error('Model API response is too large')
      return JSON.parse(new TextDecoder().decode(bytes))
    } catch (error) {
      lastError = error
      if (attempt >= 2 || !retryable(error)) throw error
      await wait(200 * (2 ** attempt) + Math.floor(Math.random() * 100))
    } finally {
      clearTimeout(timeout)
    }
  }
  throw lastError
}

function requestHeaders(config: TurboFluxConfig): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (!config.apiKey) return headers
  if (config.provider === 'anthropic') {
    headers['x-api-key'] = config.apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers.Authorization = `Bearer ${config.apiKey}`
  }
  return headers
}

function modelsUrl(config: TurboFluxConfig): string {
  const baseUrl = config.provider === 'anthropic'
    ? config.baseUrl.replace(/\/+$/, '')
    : normalizeBaseUrl(config.baseUrl)
  return `${baseUrl}/models`
}

function modelInfoUrl(config: TurboFluxConfig): string {
  return `${normalizeBaseUrl(config.baseUrl)}/model/info`
}

async function loadGatewayMetadata(config: TurboFluxConfig, rows: JsonRecord[]): Promise<Map<string, ParsedModelMetadata>> {
  if (!['custom', 'openrouter'].includes(config.provider)) return new Map()
  if (!rows.some(row => !extractModelMetadata(row).contextWindow)) return new Map()
  try {
    const payload = await fetchJson(modelInfoUrl(config), requestHeaders(config))
    return new Map(modelRows(payload).map(row => [modelId(row).toLowerCase(), extractModelMetadata(row)]))
  } catch {
    return new Map()
  }
}

function modelsDevCachePath(): string {
  return join(discoveryCacheDirectory(), 'models-dev.json')
}

function readModelsDevCache(): ModelsDevCacheDocument | undefined {
  const path = modelsDevCachePath()
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ModelsDevCacheDocument
    return parsed && typeof parsed.fetchedAt === 'number' && asRecord(parsed.data) ? parsed : undefined
  } catch {
    return undefined
  }
}

async function loadModelsDev(): Promise<JsonRecord | undefined> {
  const cached = readModelsDevCache()
  if (cached && Date.now() - cached.fetchedAt < REGISTRY_CACHE_TTL_MS) return cached.data
  try {
    const data = asRecord(await fetchJson('https://models.dev/api.json', { Accept: 'application/json' }))
    if (!data) return cached?.data
    writeFileAtomicSync(modelsDevCachePath(), JSON.stringify({ fetchedAt: Date.now(), data }), 0o600)
    return data
  } catch {
    return cached?.data
  }
}

function providerScore(providerId: string, config: TurboFluxConfig): number {
  const id = providerId.toLowerCase()
  if (id === config.provider) return 4
  if (id.includes(config.provider)) return 3
  if (config.provider === 'openrouter' && id === 'openrouter') return 4
  return 0
}

function findModelsDevMetadata(registry: JsonRecord | undefined, id: string, config: TurboFluxConfig): ParsedModelMetadata | undefined {
  if (!registry) return undefined
  const normalized = id.toLowerCase()
  const shortId = normalized.includes('/') ? normalized.slice(normalized.lastIndexOf('/') + 1) : normalized
  let best: { score: number; metadata: ParsedModelMetadata } | undefined

  for (const [providerId, providerValue] of Object.entries(registry)) {
    const models = asRecord(asRecord(providerValue)?.models)
    if (!models) continue
    for (const [key, modelValue] of Object.entries(models)) {
      const model = asRecord(modelValue)
      if (!model) continue
      const entryId = cleanText(model.id, MAX_MODEL_ID_LENGTH).toLowerCase() || key.toLowerCase()
      const fullId = `${providerId}/${entryId}`.toLowerCase()
      const exact = normalized === fullId || normalized === entryId || normalized === key.toLowerCase()
      const short = shortId === entryId || shortId === key.toLowerCase()
      if (!exact && !short) continue
      const score = (exact ? 10 : 4) + providerScore(providerId, config)
      if (best && best.score >= score) continue
      const limit = asRecord(model.limit)
      const modalities = asRecord(model.modalities)
      const reasoningOptions = asRecord(model.reasoning_options)
      const metadata = extractModelMetadata({
        context_length: limit?.context ?? limit?.input,
        max_output_tokens: limit?.output,
        modalities,
        capabilities: {
          tools: model.tool_call,
          vision: stringList(modalities?.input)?.includes('image'),
          reasoning: model.reasoning,
          structured_outputs: model.structured_output,
          reasoning_efforts: reasoningOptions ? Object.keys(reasoningOptions) : model.reasoning_options,
        },
      })
      best = { score, metadata }
    }
  }
  return best?.metadata
}

function builtinMetadata(id: string): { preset: ModelPreset; metadata: ParsedModelMetadata } | undefined {
  const spec = getSupportedModelSpec(id)
  const preset = MODEL_PRESETS.find(item => item.model === spec?.id)
  if (!spec || !preset) return undefined
  const reasoning = getModelReasoningCapabilities(spec.id, spec.provider)
  return {
    preset,
    metadata: {
      contextWindow: spec.contextWindow,
      maxOutputTokens: spec.maxOutputTokens,
      capabilities: {
        vision: spec.supportsVision,
        reasoning: Boolean(reasoning),
        reasoningEfforts: reasoning?.efforts,
      },
      hasMetadata: true,
    },
  }
}

function fallbackPresets(config: TurboFluxConfig): ModelPreset[] {
  const providerModels = config.provider === 'custom'
    ? MODEL_PRESETS
    : MODEL_PRESETS.filter(preset => preset.provider === config.provider || config.provider === 'openrouter')
  const models = providerModels.map(preset => ({ ...preset, availability: 'builtin' as const }))
  if (!config.model || models.some(model => model.model.toLowerCase() === config.model.toLowerCase())) return models
  return [configuredPreset(config), ...models]
}

function configuredPreset(config: TurboFluxConfig): ModelPreset {
  return {
    id: config.model,
    name: config.model,
    model: config.model,
    provider: config.provider,
    baseUrl: config.baseUrl,
    contextWindow: config.contextWindow || DEFAULT_CONTEXT_WINDOW,
    maxTokens: config.maxTokens || DEFAULT_MAX_TOKENS,
    maxOutputTokens: config.maxOutputTokens,
    reasoning: config.reasoning,
    description: 'Currently configured model; availability was not confirmed by the model API.',
    capabilities: config.modelCapabilities,
    metadataSources: config.modelMetadataSources ?? ['default'],
    availability: 'configured',
  }
}

function uniqueSources(...sources: Array<ModelMetadataSource | undefined>): ModelMetadataSource[] {
  return [...new Set(sources.filter((source): source is ModelMetadataSource => Boolean(source)))]
}

function endpointLabel(baseUrl: string): string {
  try {
    return cleanText(new URL(baseUrl).host, 120)
  } catch {
    return 'the active API'
  }
}

function buildPreset(
  row: JsonRecord,
  config: TurboFluxConfig,
  gatewayMetadata: ParsedModelMetadata | undefined,
  registryMetadata: ParsedModelMetadata | undefined,
): ModelPreset | undefined {
  const id = modelId(row)
  if (!id) return undefined
  const apiMetadata = extractModelMetadata(row)
  const builtin = builtinMetadata(id)
  let metadata = mergeMetadata(apiMetadata, gatewayMetadata)
  metadata = mergeMetadata(metadata, registryMetadata)
  metadata = mergeMetadata(metadata, builtin?.metadata)
  if (!isAgentCandidate(id, metadata)) return undefined

  const contextWindow = metadata.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const maxOutputTokens = metadata.maxOutputTokens
  const maxTokens = Math.min(DEFAULT_MAX_TOKENS, maxOutputTokens ?? DEFAULT_MAX_TOKENS)
  const sources = uniqueSources(
    'api',
    gatewayMetadata?.hasMetadata ? 'gateway' : undefined,
    registryMetadata?.hasMetadata ? 'models.dev' : undefined,
    builtin ? 'builtin' : undefined,
    metadata.contextWindow ? undefined : 'default',
  )
  const description = cleanText(row.description, 500)
    || builtin?.preset.description
    || `Available from ${endpointLabel(config.baseUrl)}.`

  return {
    id,
    name: modelName(row, builtin?.preset.name ?? id),
    model: id,
    provider: config.provider,
    baseUrl: config.baseUrl,
    contextWindow,
    maxTokens,
    maxOutputTokens,
    reasoning: normalizeNativeReasoningConfig(id, undefined, config.provider, metadata.capabilities),
    description,
    capabilities: metadata.capabilities,
    metadataSources: sources,
    availability: 'api',
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof ModelDiscoveryHttpError) {
    if (error.status === 401 || error.status === 403) return `Model discovery was rejected by the API (${error.status}).`
    return error.message
  }
  if (error instanceof Error && error.name === 'AbortError') return 'Model discovery timed out.'
  return error instanceof Error ? cleanText(error.message, 240) : 'Model discovery failed.'
}

export async function discoverModelPresets(
  config: TurboFluxConfig,
  options: ModelDiscoveryOptions = {},
): Promise<ModelDiscoveryResult> {
  if (!config.baseUrl) {
    return {
      models: fallbackPresets(config),
      fetchedAt: Date.now(),
      source: 'fallback',
      stale: false,
      error: 'Configure an API endpoint to discover available models.',
    }
  }

  const cached = readCachedModelDiscovery(config, true)
  if (!options.force && cached && !cached.stale) return cached

  try {
    const payload = await fetchJson(modelsUrl(config), requestHeaders(config))
    const rows = modelRows(payload)
    if (rows.length === 0) throw new Error('The model API returned no selectable models.')
    const gateway = await loadGatewayMetadata(config, rows)
    const needsRegistry = rows.some(row => {
      const api = extractModelMetadata(row)
      const enriched = mergeMetadata(api, gateway.get(modelId(row).toLowerCase()))
      return !enriched.contextWindow || !enriched.maxOutputTokens
    })
    const registry = needsRegistry ? await loadModelsDev() : undefined
    const seen = new Set<string>()
    const models = rows.flatMap(row => {
      const id = modelId(row)
      const key = id.toLowerCase()
      if (!id || seen.has(key)) return []
      seen.add(key)
      const preset = buildPreset(
        row,
        config,
        gateway.get(key),
        findModelsDevMetadata(registry, id, config),
      )
      return preset ? [preset] : []
    })

    if (config.model && !seen.has(config.model.toLowerCase())) models.unshift(configuredPreset(config))
    models.sort((a, b) => {
      if (a.model === config.model) return -1
      if (b.model === config.model) return 1
      return a.name.localeCompare(b.name)
    })
    const result: ModelDiscoveryResult = {
      models,
      fetchedAt: Date.now(),
      source: 'network',
      stale: false,
    }
    writeDiscoveryCache(config, result)
    return result
  } catch (error) {
    if (cached) return { ...cached, stale: true, error: errorMessage(error) }
    return {
      models: fallbackPresets(config),
      fetchedAt: Date.now(),
      source: 'fallback',
      stale: false,
      error: errorMessage(error),
    }
  }
}

export async function getModelPresets(config: TurboFluxConfig, options?: ModelDiscoveryOptions): Promise<ModelPreset[]> {
  return (await discoverModelPresets(config, options)).models
}
