import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import {
  PROVIDER_PRESETS,
  configFromProviderPreset,
  getProviderPreset,
  saveConfig,
  type ProviderPreset,
} from '../core/config'
import { getSupportedModelSpec } from '../core/modelRegistry'

export interface SetupOptions {
  provider?: string
  apiKey?: string
  baseUrl?: string
  model?: string
  yes?: boolean
}

function maskKey(key: string): string {
  if (!key) return '(not set)'
  if (key.length <= 8) return '***'
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

function printProviders(): void {
  console.log('Available providers:')
  PROVIDER_PRESETS.forEach((preset, index) => {
    console.log(`  ${index + 1}. ${preset.name.padEnd(22)} ${preset.id.padEnd(12)} ${preset.description}`)
  })
}

function resolveProvider(value: string): ProviderPreset | undefined {
  const trimmed = value.trim()
  const index = Number(trimmed)
  if (Number.isInteger(index) && index >= 1 && index <= PROVIDER_PRESETS.length) {
    return PROVIDER_PRESETS[index - 1]
  }
  return getProviderPreset(trimmed)
}

async function ask(question: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input, output })
  try {
    const suffix = fallback ? ` (${fallback})` : ''
    const answer = await rl.question(`${question}${suffix}: `)
    return answer.trim() || fallback || ''
  } finally {
    rl.close()
  }
}

export async function runSetup(options: SetupOptions = {}): Promise<void> {
  console.log('\nTurboFlux setup\n')

  let preset = options.provider ? resolveProvider(options.provider) : undefined

  if (!preset) {
    if (options.yes) {
      throw new Error('Missing provider. Use --provider deepseek, openai, anthropic, openrouter, local-proxy, or run turboflux setup interactively.')
    } else {
      printProviders()
      const answer = await ask('\nChoose provider number or id')
      preset = answer ? resolveProvider(answer) : undefined
    }
  }

  if (!preset) {
    throw new Error(`Unknown provider "${options.provider || ''}". Run "turboflux setup" and choose from the list.`)
  }

  if (options.yes && preset.id === 'custom' && (!options.baseUrl || !options.model)) {
    throw new Error('Custom provider requires --base-url and --model when using --yes.')
  }

  const defaultModel = options.model || preset.defaultModel
  const model = options.yes
    ? defaultModel
    : await ask('Model', defaultModel || undefined)

  const defaultBaseUrl = options.baseUrl || preset.baseUrl
  const baseUrl = options.yes
    ? defaultBaseUrl
    : await ask('Base URL', defaultBaseUrl || undefined)

  if (!model) throw new Error('Model is required.')
  if (!baseUrl) throw new Error('Base URL is required.')

  const apiKey = options.apiKey ?? (options.yes ? '' : await ask('API key'))
  const next = configFromProviderPreset(preset, apiKey, model, baseUrl)
  saveConfig(next)

  const knownModel = getSupportedModelSpec(next.model)
  console.log('\nSaved TurboFlux config:')
  console.log(`  provider: ${next.provider}`)
  console.log(`  baseUrl:  ${next.baseUrl}`)
  console.log(`  model:    ${next.model}${knownModel ? ` (${knownModel.name})` : ''}`)
  console.log(`  apiKey:   ${maskKey(next.apiKey)}`)
  console.log('\nRun:')
  console.log('  turboflux /path/to/project')
}
