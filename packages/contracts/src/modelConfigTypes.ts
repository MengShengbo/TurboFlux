import type { ApprovalPolicy, CapabilityProfile, NativeReasoningConfig } from './agentTypes'

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
  reasoningDefaultEffort?: NonNullable<NativeReasoningConfig['effort']>
  reasoningDefaultEnabled?: boolean
  reasoningMandatory?: boolean
  reasoningSupportsMaxTokens?: boolean
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
