import { describe, expect, it } from 'vitest'
import type { WorkbenchApiConfigInput, WorkbenchModelOption, WorkbenchSettingsSnapshot } from '@turboflux/agent-core/workbench'
import { apiConnectionFingerprint, apiModelsForProfile, apiProviderPreset, applyApiModel } from './apiSettingsModel'

const profile: WorkbenchApiConfigInput = { id: 'main', name: 'Gateway', provider: 'custom', baseUrl: 'https://gateway.example/v1', model: 'gpt-current', contextWindow: 200_000, maxTokens: 16_384 }
const models = [
  { id: 'gpt-current', model: 'gpt-current', name: 'GPT Current', provider: 'openai' },
  { id: 'claude-other', model: 'claude-other', name: 'Claude Other', provider: 'anthropic' },
  { id: 'another', model: 'another', name: 'Independent Model', provider: 'custom' },
] as WorkbenchModelOption[]

describe('API settings models', () => {
  it('shows every compatible model when opening a picker with an existing selection', () => {
    expect(apiModelsForProfile(models, profile).map(item => item.model)).toEqual(['gpt-current', 'claude-other', 'another'])
    expect(apiModelsForProfile(models, { ...profile, model: 'claude-other' })).toEqual(models)
  })

  it('searches by name, identifier, or provider with independent case-insensitive terms', () => {
    expect(apiModelsForProfile(models, profile, 'OTHER ANTHROPIC')).toEqual([models[1]])
    expect(apiModelsForProfile(models, profile, ' Independent ')).toEqual([models[2]])
    expect(apiModelsForProfile(models, profile, 'unlisted')).toEqual([])
    expect(apiModelsForProfile(models, profile, '   ')).toEqual(models)
  })

  it('includes endpoint models whose family differs from the connection protocol', () => {
    const endpointModel = { ...models[1], baseUrl: `${profile.baseUrl}/`, availability: 'api' } as WorkbenchModelOption
    expect(apiModelsForProfile([...models, endpointModel], { ...profile, provider: 'openai' })).toEqual([models[0], endpointModel])
    expect(apiModelsForProfile([...models, models[0]], profile)).toEqual(models)
  })

  it('matches provider presets by endpoint before falling back to the protocol', () => {
    const presets = [{ id: 'custom', provider: 'custom', baseUrl: '' }, { id: 'gateway', provider: 'custom', baseUrl: profile.baseUrl }]
    expect(apiProviderPreset({ providerPresets: presets } as WorkbenchSettingsSnapshot, profile)?.id).toBe('gateway')
  })

  it('isolates catalogs across endpoint and credential changes, independent of the selected model', () => {
    const fingerprint = apiConnectionFingerprint(profile)
    expect(apiConnectionFingerprint({ ...profile, model: 'other', baseUrl: `${profile.baseUrl}/` })).toBe(fingerprint)
    expect(apiConnectionFingerprint({ ...profile, apiKey: 'replacement' })).not.toBe(fingerprint)
    expect(apiConnectionFingerprint({ ...profile, baseUrl: 'https://other.example/v1' })).not.toBe(fingerprint)
  })

  it('applies model metadata and clears previous reasoning when choosing a custom model', () => {
    const draft = { ...profile, reasoning: { enabled: true, effort: 'high' as const } }
    applyApiModel(draft, 'claude-other', { ...models[1], contextWindow: 128_000, maxTokens: 8_192, maxOutputTokens: 32_768 })
    expect(draft).toMatchObject({ model: 'claude-other', contextWindow: 128_000, maxTokens: 8_192, maxOutputTokens: 32_768, reasoning: undefined })
    applyApiModel(draft, ' private/model ')
    expect(draft.model).toBe('private/model')
  })
})
