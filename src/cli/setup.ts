import chalk from 'chalk'
import inquirer from 'inquirer'
import {
  PROVIDER_PRESETS,
  configFromProviderPreset,
  getProviderPreset,
  loadConfig,
  saveConfig,
  type ProviderPreset,
  type TurboFluxConfig,
} from '../core/config'
import { getSupportedModelSpec } from '../core/modelRegistry'
import {
  DEFAULT_PROFILE,
  PERSONA_DEFINITIONS,
  getOutputLanguageLabel,
  getPersonaDefinition,
  getProfileFile,
  loadProfile,
  resetProfile,
  saveProfile,
  type TurboFluxAiOutputLanguage,
  type TurboFluxInterfaceLanguage,
  type TurboFluxProfile,
} from '../core/profile'

export interface SetupOptions {
  action?: string
  provider?: string
  apiKey?: string
  baseUrl?: string
  model?: string
  yes?: boolean
  lang?: string
  allLang?: string
  configLang?: string
  aiOutputLang?: string
  outputStyle?: string
  defaultOutputStyle?: string
  customInstructions?: string
}

type SetupAction =
  | 'menu'
  | 'init'
  | 'api'
  | 'language'
  | 'persona'
  | 'custom'
  | 'show'
  | 'reset'
  | 'exit'

const MAIN_ACTIONS = new Set<SetupAction>(['menu', 'init', 'api', 'language', 'persona', 'custom', 'show', 'reset', 'exit'])

function maskKey(key: string): string {
  if (!key) return '(not set)'
  if (key.length <= 8) return '***'
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

function normalizeAction(action?: string): SetupAction {
  const normalized = (action || 'menu').trim().toLowerCase()
  if (normalized === 'i' || normalized === 'full') return 'init'
  if (normalized === 'model' || normalized === 'provider') return 'api'
  if (normalized === 'lang') return 'language'
  if (normalized === 'style' || normalized === 'output-style' || normalized === 'output') return 'persona'
  if (normalized === 'instructions') return 'custom'
  if (normalized === 'config' || normalized === 'current') return 'show'
  if (normalized === 'clear') return 'reset'
  if (MAIN_ACTIONS.has(normalized as SetupAction)) return normalized as SetupAction
  return 'menu'
}

function resolveProvider(value: string): ProviderPreset | undefined {
  const trimmed = value.trim()
  const index = Number(trimmed)
  if (Number.isInteger(index) && index >= 1 && index <= PROVIDER_PRESETS.length) {
    return PROVIDER_PRESETS[index - 1]
  }
  return getProviderPreset(trimmed)
}

function providerLabel(preset: ProviderPreset): string {
  return `${preset.name} (${preset.id})`
}

function uiText(profile: TurboFluxProfile, zh: string, en: string): string {
  return profile.interfaceLanguage === 'en' ? en : zh
}

function printBanner(profile = loadProfile()): void {
  const line = '-'.repeat(62)
  console.log('')
  console.log(chalk.dim(line))
  console.log(chalk.cyan.bold('  TurboFlux Setup'))
  console.log(chalk.gray(`  ${uiText(profile, '初始化 TurboFlux 模型、语言、人设和自定义行为。', 'Configure TurboFlux models, language, persona, and custom behavior.')}`))
  console.log(chalk.dim(line))
  console.log('')
}

function printSummary(config: TurboFluxConfig, profile: TurboFluxProfile): void {
  const knownModel = getSupportedModelSpec(config.model)
  const persona = getPersonaDefinition(profile.defaultPersonaId)
  const personaName = profile.defaultPersonaId === 'custom'
    ? (profile.customPersonaName || 'Custom Persona')
    : (profile.interfaceLanguage === 'en' ? persona?.nameEn : persona?.nameZh) || profile.defaultPersonaId
  const outputLanguage = getOutputLanguageLabel(profile.aiOutputLanguage, profile.customAiOutputLanguage, profile.interfaceLanguage)

  console.log(chalk.bold(uiText(profile, '当前配置', 'Current configuration')))
  console.log(`  provider:          ${config.provider}`)
  console.log(`  baseUrl:           ${config.baseUrl || '(not set)'}`)
  console.log(`  model:             ${config.model || '(not set)'}${knownModel ? ` (${knownModel.name})` : ''}`)
  console.log(`  apiKey:            ${maskKey(config.apiKey)}`)
  console.log(`  contextWindow:     ${config.contextWindow.toLocaleString()}`)
  console.log(`  maxTokens:         ${config.maxTokens.toLocaleString()}`)
  console.log(`  interfaceLanguage: ${profile.interfaceLanguage}`)
  console.log(`  aiOutputLanguage:  ${outputLanguage}`)
  console.log(`  persona:           ${personaName} (${profile.defaultPersonaId})`)
  console.log(`  customInstructions:${profile.customInstructions ? ' set' : ' (not set)'}`)
  console.log(`  profileFile:       ${getProfileFile()}`)
}

async function promptContinue(profile: TurboFluxProfile): Promise<boolean> {
  const { again } = await inquirer.prompt<{ again: boolean }>({
    type: 'confirm',
    name: 'again',
    message: uiText(profile, '返回主菜单？', 'Return to main menu?'),
    default: true,
  })
  return again
}

function normalizeInterfaceLanguage(value?: string): TurboFluxInterfaceLanguage | undefined {
  if (!value) return undefined
  const normalized = value.trim()
  if (normalized === 'zh' || normalized === 'zh-CN' || normalized.toLowerCase() === 'chinese') return 'zh-CN'
  if (normalized === 'en' || normalized.toLowerCase() === 'english') return 'en'
  return undefined
}

function normalizeOutputLanguage(value?: string): { language?: TurboFluxAiOutputLanguage; custom?: string } {
  if (!value) return {}
  const trimmed = value.trim()
  const lower = trimmed.toLowerCase()
  if (['follow', 'follow-user', 'auto', 'user'].includes(lower)) return { language: 'follow-user' }
  if (['zh', 'zh-cn', 'cn', 'chinese', '中文', '简体中文'].includes(lower)) return { language: 'zh-CN' }
  if (['en', 'english'].includes(lower)) return { language: 'en' }
  if (['ja', 'jp', 'japanese'].includes(lower)) return { language: 'ja' }
  if (['ko', 'kr', 'korean'].includes(lower)) return { language: 'ko' }
  if (lower === 'custom') return { language: 'custom' }
  return { language: 'custom', custom: trimmed }
}

async function configureLanguage(options: SetupOptions = {}): Promise<TurboFluxProfile> {
  let profile = loadProfile()
  const interfaceFromCli = normalizeInterfaceLanguage(options.allLang || options.configLang || options.lang)
  const outputFromCli = normalizeOutputLanguage(options.allLang || options.aiOutputLang || options.lang)

  if (options.yes || interfaceFromCli || outputFromCli.language) {
    profile = saveProfile({
      interfaceLanguage: interfaceFromCli || profile.interfaceLanguage,
      aiOutputLanguage: outputFromCli.language || profile.aiOutputLanguage,
      customAiOutputLanguage: outputFromCli.custom || profile.customAiOutputLanguage,
    })
    console.log(chalk.green(uiText(profile, '已保存语言配置。', 'Language configuration saved.')))
    return profile
  }

  const { interfaceLanguage } = await inquirer.prompt<{ interfaceLanguage: TurboFluxInterfaceLanguage }>({
    type: 'select',
    name: 'interfaceLanguage',
    message: uiText(profile, '选择 TurboFlux Setup 显示语言', 'Select TurboFlux Setup display language'),
    default: profile.interfaceLanguage,
    choices: [
      { name: '简体中文', value: 'zh-CN' },
      { name: 'English', value: 'en' },
    ],
  })

  profile = saveProfile({ interfaceLanguage })

  const { aiOutputLanguage } = await inquirer.prompt<{ aiOutputLanguage: TurboFluxAiOutputLanguage }>({
    type: 'select',
    name: 'aiOutputLanguage',
    message: uiText(profile, '选择 AI 默认输出语言', 'Select default AI output language'),
    default: profile.aiOutputLanguage,
    choices: [
      { name: uiText(profile, '跟随用户语言', 'Follow user language'), value: 'follow-user' },
      { name: '简体中文', value: 'zh-CN' },
      { name: 'English', value: 'en' },
      { name: '日本语', value: 'ja' },
      { name: '한국어', value: 'ko' },
      { name: uiText(profile, '自定义语言/语气', 'Custom language/style'), value: 'custom' },
    ],
  })

  let customAiOutputLanguage = profile.customAiOutputLanguage
  if (aiOutputLanguage === 'custom') {
    const answer = await inquirer.prompt<{ customAiOutputLanguage: string }>({
      type: 'input',
      name: 'customAiOutputLanguage',
      message: uiText(profile, '输入自定义输出语言或语气要求', 'Enter custom output language or tone'),
      default: profile.customAiOutputLanguage || '',
      validate: value => value.trim().length > 0 || uiText(profile, '不能为空', 'Required'),
    })
    customAiOutputLanguage = answer.customAiOutputLanguage.trim()
  }

  profile = saveProfile({ aiOutputLanguage, customAiOutputLanguage })
  console.log(chalk.green(uiText(profile, '已保存语言配置。', 'Language configuration saved.')))
  return profile
}

function defaultProviderForOptions(options: SetupOptions, current: TurboFluxConfig): ProviderPreset | undefined {
  if (options.provider) return resolveProvider(options.provider)
  if (current.baseUrl) {
    return PROVIDER_PRESETS.find(p => p.baseUrl.replace(/\/+$/, '') === current.baseUrl.replace(/\/+$/, ''))
  }
  return getProviderPreset(current.provider)
}

function hasApiOptions(options: SetupOptions): boolean {
  return Boolean(options.provider || options.apiKey !== undefined || options.baseUrl || options.model)
}

function hasLanguageOptions(options: SetupOptions): boolean {
  return Boolean(options.lang || options.allLang || options.configLang || options.aiOutputLang)
}

function hasPersonaOptions(options: SetupOptions): boolean {
  return Boolean(options.outputStyle || options.defaultOutputStyle)
}

function hasDirectOptions(options: SetupOptions): boolean {
  return hasApiOptions(options) || hasLanguageOptions(options) || hasPersonaOptions(options) || options.customInstructions !== undefined
}

function shouldKeepCurrentApiKey(current: TurboFluxConfig, preset: ProviderPreset, baseUrl: string): boolean {
  if (!current.apiKey) return false
  const currentBaseUrl = current.baseUrl.replace(/\/+$/, '')
  const nextBaseUrl = baseUrl.replace(/\/+$/, '')
  return current.provider === preset.provider && currentBaseUrl === nextBaseUrl
}

async function configureApi(options: SetupOptions = {}): Promise<TurboFluxConfig> {
  const current = await loadConfig()
  const profile = loadProfile()
  const directMode = options.yes || hasApiOptions(options)
  let preset = directMode ? defaultProviderForOptions(options, current) : undefined

  if (!preset) {
    if (options.yes) {
      throw new Error('Missing provider. Use --provider deepseek, openai, anthropic, openrouter, or custom.')
    }
    const defaultPreset = defaultProviderForOptions(options, current)
    const { providerId } = await inquirer.prompt<{ providerId: string }>({
      type: 'select',
      name: 'providerId',
      message: uiText(profile, '选择 API 提供商', 'Choose API provider'),
      choices: PROVIDER_PRESETS.map((item, index) => ({
        name: `${index + 1}. ${providerLabel(item)} - ${item.description}`,
        value: item.id,
      })),
      default: defaultPreset?.id || PROVIDER_PRESETS[0]?.id,
    })
    preset = resolveProvider(providerId)
  }

  if (!preset) {
    throw new Error(`Unknown provider "${options.provider || ''}".`)
  }

  if (options.yes && preset.id === 'custom' && (!options.baseUrl || !options.model)) {
    throw new Error('Custom provider requires --base-url and --model when using --yes.')
  }

  const defaultModel = options.model || current.model || preset.defaultModel
  const model = directMode
    ? defaultModel
    : (await inquirer.prompt<{ model: string }>({
        type: 'input',
        name: 'model',
        message: uiText(profile, '模型名称', 'Model name'),
        default: defaultModel,
        validate: value => value.trim().length > 0 || uiText(profile, '模型不能为空', 'Model is required'),
      })).model.trim()

  const defaultBaseUrl = options.baseUrl || current.baseUrl || preset.baseUrl
  const baseUrl = directMode
    ? defaultBaseUrl
    : (await inquirer.prompt<{ baseUrl: string }>({
        type: 'input',
        name: 'baseUrl',
        message: uiText(profile, 'Base URL', 'Base URL'),
        default: defaultBaseUrl,
        validate: value => {
          try {
            new URL(value)
            return true
          } catch {
            return uiText(profile, '请输入完整 URL，例如 https://api.example.com/v1', 'Enter a full URL, e.g. https://api.example.com/v1')
          }
        },
      })).baseUrl.trim()

  let apiKey = options.apiKey
  if (apiKey === undefined) {
    if (options.yes) {
      apiKey = shouldKeepCurrentApiKey(current, preset, baseUrl) ? current.apiKey : ''
    } else {
      const keepCurrentApiKey = shouldKeepCurrentApiKey(current, preset, baseUrl)
      const answer = await inquirer.prompt<{ apiKey: string }>({
        type: 'password',
        name: 'apiKey',
        message: keepCurrentApiKey
          ? uiText(profile, 'API Key（留空保留当前值）', 'API Key (leave empty to keep current value)')
          : uiText(profile, 'API Key（可留空，稍后再配置）', 'API Key (may be empty; configure later)'),
        mask: '*',
      })
      apiKey = answer.apiKey.trim() || (keepCurrentApiKey ? current.apiKey : '')
    }
  }

  if (!model) throw new Error('Model is required.')
  if (!baseUrl) throw new Error('Base URL is required.')

  const next = configFromProviderPreset(preset, apiKey, model, baseUrl)
  saveConfig(next)
  console.log(chalk.green(uiText(profile, '已保存 API 配置。', 'API configuration saved.')))
  console.log(`  provider: ${next.provider}`)
  console.log(`  baseUrl:  ${next.baseUrl}`)
  console.log(`  model:    ${next.model}`)
  console.log(`  apiKey:   ${maskKey(next.apiKey)}`)
  return next
}

function parseStyleList(value?: string): string[] | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed === 'skip' || trimmed === 'none') return []
  if (trimmed === 'all') return PERSONA_DEFINITIONS.filter(p => !p.isCustom).map(p => p.id)
  return trimmed.split(',').map(item => item.trim()).filter(Boolean)
}

async function configurePersona(options: SetupOptions = {}): Promise<TurboFluxProfile> {
  let profile = loadProfile()
  const fromCli = parseStyleList(options.outputStyle)
  const defaultFromCli = options.defaultOutputStyle

  if (options.yes || fromCli || defaultFromCli) {
    const enabledPersonaIds = fromCli?.filter(id => PERSONA_DEFINITIONS.some(p => p.id === id && !p.isCustom))
      || profile.enabledPersonaIds
    const defaultPersonaId = defaultFromCli || profile.defaultPersonaId
    if (defaultPersonaId !== 'custom' && !PERSONA_DEFINITIONS.some(p => p.id === defaultPersonaId)) {
      throw new Error(`Unknown persona "${defaultPersonaId}".`)
    }
    profile = saveProfile({ enabledPersonaIds, defaultPersonaId })
    console.log(chalk.green(uiText(profile, '已保存人设配置。', 'Persona configuration saved.')))
    return profile
  }

  const personaChoices = PERSONA_DEFINITIONS
    .filter(persona => !persona.isCustom)
    .map(persona => ({
      name: `${profile.interfaceLanguage === 'en' ? persona.nameEn : persona.nameZh} - ${profile.interfaceLanguage === 'en' ? persona.descriptionEn : persona.descriptionZh}`,
      value: persona.id,
      checked: profile.enabledPersonaIds.includes(persona.id),
    }))

  const { enabledPersonaIds } = await inquirer.prompt<{ enabledPersonaIds: string[] }>({
    type: 'checkbox',
    name: 'enabledPersonaIds',
    message: uiText(profile, '选择可用人设/输出风格（空格多选）', 'Select available personas/output styles'),
    choices: personaChoices,
    validate: value => value.length > 0 || uiText(profile, '至少选择一个人设', 'Select at least one persona'),
  })

  const defaultChoices = [
    ...enabledPersonaIds.map(id => {
      const persona = getPersonaDefinition(id)!
      return {
        name: `${profile.interfaceLanguage === 'en' ? persona.nameEn : persona.nameZh} - ${profile.interfaceLanguage === 'en' ? persona.descriptionEn : persona.descriptionZh}`,
        value: persona.id,
      }
    }),
    {
      name: uiText(profile, '自定义人设 - 使用你自己写的 TurboFlux 行为风格', 'Custom Persona - use your own TurboFlux behavior style'),
      value: 'custom',
    },
  ]

  const { defaultPersonaId } = await inquirer.prompt<{ defaultPersonaId: string }>({
    type: 'select',
    name: 'defaultPersonaId',
    message: uiText(profile, '选择默认人设/输出风格', 'Choose default persona/output style'),
    choices: defaultChoices,
    default: enabledPersonaIds.includes(profile.defaultPersonaId) ? profile.defaultPersonaId : enabledPersonaIds[0],
  })

  let customPersonaName = profile.customPersonaName
  let customPersonaPrompt = profile.customPersonaPrompt
  if (defaultPersonaId === 'custom') {
    const answer = await inquirer.prompt<{ customPersonaName: string; customPersonaPrompt: string }>([
      {
        type: 'input',
        name: 'customPersonaName',
        message: uiText(profile, '自定义人设名称', 'Custom persona name'),
        default: profile.customPersonaName || 'My TurboFlux',
      },
      {
        type: 'editor',
        name: 'customPersonaPrompt',
        message: uiText(profile, '编辑自定义人设提示词', 'Edit custom persona prompt'),
        default: profile.customPersonaPrompt || [
          'Use a precise, product-grade engineering style.',
          'Balance execution speed with careful verification.',
        ].join('\n'),
        validate: value => value.trim().length > 0 || uiText(profile, '自定义提示词不能为空', 'Custom prompt is required'),
      },
    ])
    customPersonaName = answer.customPersonaName.trim()
    customPersonaPrompt = answer.customPersonaPrompt.trim()
  }

  profile = saveProfile({ enabledPersonaIds, defaultPersonaId, customPersonaName, customPersonaPrompt })
  console.log(chalk.green(uiText(profile, '已保存人设配置。', 'Persona configuration saved.')))
  return profile
}

async function configureCustomInstructions(options: SetupOptions = {}): Promise<TurboFluxProfile> {
  const profile = loadProfile()
  if (options.yes || options.customInstructions !== undefined) {
    const next = saveProfile({ customInstructions: options.customInstructions ?? profile.customInstructions })
    console.log(chalk.green(uiText(next, '已保存自定义配置。', 'Custom configuration saved.')))
    return next
  }

  const { customInstructions } = await inquirer.prompt<{ customInstructions: string }>({
    type: 'editor',
    name: 'customInstructions',
    message: uiText(profile, '编辑全局自定义指令（可留空）', 'Edit global custom instructions (may be empty)'),
    default: profile.customInstructions,
  })
  const next = saveProfile({ customInstructions: customInstructions.trim() })
  console.log(chalk.green(uiText(next, '已保存自定义配置。', 'Custom configuration saved.')))
  return next
}

async function runFullInitialization(options: SetupOptions = {}): Promise<void> {
  let profile = await configureLanguage(options)
  await configureApi(options)
  profile = await configurePersona(options)
  if (!options.yes) {
    const { editCustom } = await inquirer.prompt<{ editCustom: boolean }>({
      type: 'confirm',
      name: 'editCustom',
      message: uiText(profile, '是否现在编辑全局自定义指令？', 'Edit global custom instructions now?'),
      default: false,
    })
    if (editCustom) profile = await configureCustomInstructions(options)
  } else if (options.customInstructions !== undefined) {
    profile = await configureCustomInstructions(options)
  }

  const config = await loadConfig()
  console.log('')
  printSummary(config, profile)
  console.log('')
  console.log(chalk.cyan(uiText(profile, '完成。现在可以运行：turboflux <项目目录>', 'Done. You can now run: turboflux <workspace>')))
}

async function showCurrentConfiguration(): Promise<void> {
  const [config, profile] = await Promise.all([loadConfig(), Promise.resolve(loadProfile())])
  printSummary(config, profile)
}

async function resetAllConfiguration(options: SetupOptions = {}): Promise<void> {
  let profile = loadProfile()
  const ok = options.yes
    ? true
    : (await inquirer.prompt<{ ok: boolean }>({
        type: 'confirm',
        name: 'ok',
        message: uiText(profile, '确认重置 TurboFlux 本机配置？API Key、人设和语言配置都会清空/恢复默认。', 'Reset local TurboFlux config? API key, persona, and language settings will be cleared/reset.'),
        default: false,
      })).ok
  if (!ok) {
    console.log(chalk.yellow(uiText(profile, '已取消。', 'Cancelled.')))
    return
  }

  const preset = getProviderPreset('custom')!
  saveConfig(configFromProviderPreset(preset, '', '', ''))
  profile = resetProfile()
  console.log(chalk.green(uiText(profile, '已重置配置。', 'Configuration reset.')))
}

async function promptMainAction(profile: TurboFluxProfile): Promise<SetupAction> {
  const { action } = await inquirer.prompt<{ action: SetupAction }>({
    type: 'select',
    name: 'action',
    message: uiText(profile, '选择功能', 'Select action'),
    choices: [
      { name: uiText(profile, '1. 完整初始化 - 语言 + API + 人设 + 自定义配置', '1. Full initialization - language + API + persona + custom config'), value: 'init' },
      { name: uiText(profile, '2. 配置 API / 模型供应商', '2. Configure API / model provider'), value: 'api' },
      { name: uiText(profile, '3. 配置输出语言', '3. Configure output language'), value: 'language' },
      { name: uiText(profile, '4. 配置人设 / 输出风格', '4. Configure persona / output style'), value: 'persona' },
      { name: uiText(profile, '5. 自定义全局指令', '5. Custom global instructions'), value: 'custom' },
      { name: uiText(profile, '6. 查看当前配置', '6. Show current configuration'), value: 'show' },
      { name: uiText(profile, '7. 重置本机配置', '7. Reset local configuration'), value: 'reset' },
      { name: uiText(profile, 'Q. 退出', 'Q. Exit'), value: 'exit' },
    ],
  })
  return action
}

async function runMenu(options: SetupOptions = {}): Promise<void> {
  let profile = loadProfile()
  printBanner(profile)

  let exit = false
  while (!exit) {
    profile = loadProfile()
    const action = await promptMainAction(profile)
    console.log('')

    switch (action) {
      case 'init':
        await runFullInitialization(options)
        break
      case 'api':
        await configureApi(options)
        break
      case 'language':
        profile = await configureLanguage(options)
        break
      case 'persona':
        profile = await configurePersona(options)
        break
      case 'custom':
        profile = await configureCustomInstructions(options)
        break
      case 'show':
        await showCurrentConfiguration()
        break
      case 'reset':
        await resetAllConfiguration(options)
        break
      case 'exit':
        exit = true
        continue
    }

    console.log('')
    exit = !(await promptContinue(profile))
    if (!exit) {
      console.log('')
      printBanner(loadProfile())
    }
  }
}

export async function runSetup(options: SetupOptions = {}): Promise<void> {
  const action = normalizeAction(options.action)

  if (action === 'menu' && hasDirectOptions(options) && !options.yes) {
    printBanner(loadProfile())
    if (hasLanguageOptions(options)) await configureLanguage(options)
    if (hasApiOptions(options)) await configureApi(options)
    if (hasPersonaOptions(options)) await configurePersona(options)
    if (options.customInstructions !== undefined) await configureCustomInstructions(options)
    console.log('')
    await showCurrentConfiguration()
    return
  }

  if (options.yes || action !== 'menu') {
    if (action !== 'show') printBanner(loadProfile())
    switch (action) {
      case 'init':
        await runFullInitialization(options)
        return
      case 'api':
        await configureApi(options)
        return
      case 'language':
        await configureLanguage(options)
        return
      case 'persona':
        await configurePersona(options)
        return
      case 'custom':
        await configureCustomInstructions(options)
        return
      case 'show':
        await showCurrentConfiguration()
        return
      case 'reset':
        await resetAllConfiguration(options)
        return
      case 'exit':
        return
      case 'menu':
        await runFullInitialization({
          ...options,
          action: 'init',
          lang: options.lang || DEFAULT_PROFILE.interfaceLanguage,
        })
        return
    }
  }

  await runMenu(options)
}
