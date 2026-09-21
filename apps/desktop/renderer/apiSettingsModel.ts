import type {
  WorkbenchApiConfigInput,
  WorkbenchApiConfigSummary,
  WorkbenchModelOption,
  WorkbenchSettingsSnapshot,
} from '@turboflux/workbench'

export function normalizedApiUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

export function apiConnectionFingerprint(profile: WorkbenchApiConfigInput): string {
  return JSON.stringify([profile.id, profile.provider, normalizedApiUrl(profile.baseUrl), profile.apiKey?.trim() || ''])
}

export function apiProviderPreset(settings: WorkbenchSettingsSnapshot, profile: WorkbenchApiConfigInput) {
  return settings.providerPresets.find(item => item.provider === profile.provider && normalizedApiUrl(item.baseUrl) === normalizedApiUrl(profile.baseUrl))
    ?? settings.providerPresets.find(item => item.provider === profile.provider)
}

export function apiModelsForProfile(models: WorkbenchModelOption[], profile: WorkbenchApiConfigInput, query = ''): WorkbenchModelOption[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const seen = new Set<string>()
  return models.filter(model => {
    const compatible = profile.provider === 'custom' || profile.provider === 'openrouter'
      || model.provider === profile.provider
      || (model.availability === 'api' && normalizedApiUrl(model.baseUrl) === normalizedApiUrl(profile.baseUrl))
    const key = model.model.toLocaleLowerCase()
    const text = `${model.name} ${model.model} ${model.provider}`.toLocaleLowerCase()
    if (!compatible || seen.has(key) || !terms.every(term => text.includes(term))) return false
    seen.add(key)
    return true
  })
}

export function applyApiModelCapabilities(profile: WorkbenchApiConfigInput, model?: WorkbenchModelOption): void {
  profile.modelCapabilities = model?.capabilities ? structuredClone(model.capabilities) : undefined
  profile.modelMetadataSources = model?.metadataSources ? [...model.metadataSources] : undefined
}

export function applyApiModel(profile: WorkbenchApiConfigInput, id: string, model?: WorkbenchModelOption): void {
  profile.model = id.trim()
  profile.reasoning = model?.reasoning ? { ...model.reasoning } : undefined
  applyApiModelCapabilities(profile, model)
  if (!model) return
  profile.contextWindow = model.contextWindow
  profile.maxTokens = model.maxTokens
  profile.maxOutputTokens = model.maxOutputTokens
}

export function reconcileDiscoveredProfileModel(
  profile: WorkbenchApiConfigInput,
  previous: WorkbenchApiConfigSummary | undefined,
  models: WorkbenchModelOption[],
): WorkbenchModelOption | undefined {
  const connectionChanged = Boolean(previous) && (
    previous!.provider !== profile.provider
    || normalizedApiUrl(previous!.baseUrl) !== normalizedApiUrl(profile.baseUrl)
    || Boolean(profile.apiKey?.trim())
  )
  const modelWasCarried = Boolean(previous) && (!profile.model.trim() || profile.model.trim() === previous!.model)
  if (!connectionChanged || !modelWasCarried) return undefined
  const selected = models.find(model => model.availability === 'api' && model.model.toLowerCase() === profile.model.trim().toLowerCase())
    ?? models.find(model => model.availability === 'api')
  if (selected) applyApiModel(profile, selected.model, selected)
  return selected
}
