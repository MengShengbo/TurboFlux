import chalk from 'chalk'
import inquirer from 'inquirer'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  PROVIDER_PRESETS,
  createApiConfigProfile,
  createEmptyConfig,
  deleteApiConfigProfile,
  getActiveApiConfigProfile,
  getApiConfigProfiles,
  getProviderPreset,
  loadConfig,
  saveApiConfigProfile,
  saveConfig,
  switchActiveApiConfig,
  type ProviderPreset,
  type TurboFluxApiConfigProfile,
  type TurboFluxConfig,
} from '../core/config'
import {
  formatNativeReasoningSetting,
  getSupportedModelSpec,
  normalizeNativeReasoningConfig,
} from '../core/modelRegistry'
import {
  normalizeApprovalPolicy,
  type ApprovalPolicy,
} from '../shared/agentTypes'
import { TURBOFLUX_WORDMARK_LINES } from './brand'
import { createTranslator, type MessageKey, type TranslationValues, type Translator } from './i18n/index'
import { TURBOFLUX_ACCENTS } from './theme/palette'
import {
  DEFAULT_PROFILE,
  PERSONA_DEFINITIONS,
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
  approvalPolicy?: string
}

type SetupAction =
  | 'menu'
  | 'init'
  | 'api'
  | 'language'
  | 'persona'
  | 'custom'
  | 'approval'
  | 'show'
  | 'reset'
  | 'exit'

const MAIN_ACTIONS = new Set<SetupAction>([
  'menu',
  'init',
  'api',
  'language',
  'persona',
  'custom',
  'approval',
  'show',
  'reset',
  'exit',
])

function setupText(key: MessageKey, values?: TranslationValues, profile = loadProfile()): string {
  return createTranslator(profile.interfaceLanguage)(key, values)
}

const PROMPT_PREFIX = chalk.gray('›')
const PROMPT_DONE_PREFIX = chalk.green('✓')
const PROMPT_THEME = {
  prefix: {
    idle: PROMPT_PREFIX,
    done: PROMPT_DONE_PREFIX,
  },
  style: {
    answer: (text: string) => chalk.cyan(text),
    message: (text: string) => chalk.white.bold(text),
    error: (text: string) => chalk.red(`  ${text}`),
    defaultAnswer: (text: string) => chalk.dim(`(${text})`),
    help: (text: string) => chalk.dim(text),
    highlight: (text: string) => chalk.cyan.bold(text),
    key: (text: string) => chalk.cyan(`<${text}>`),
  },
}

type PromptChoice<T extends string = string> = {
  name: string
  value: T
  short?: string
  disabled?: boolean | string
  checked?: boolean
}

function promptConfig<T extends Record<string, unknown>>(question: T): T {
  return {
    prefix: PROMPT_PREFIX,
    theme: PROMPT_THEME,
    ...question,
  }
}

async function settlePromptInput(): Promise<void> {
  if (!process.stdin.isTTY) return
  await new Promise(resolve => setTimeout(resolve, 50))
  while (process.stdin.read() !== null) {}
}

function maskKey(key: string): string {
  if (!key) return `(${setupText('common.notSet')})`
  if (key.length <= 8) return '***'
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

function normalizeAction(action?: string): SetupAction {
  const normalized = (action || 'menu').trim().toLowerCase()
  if (!normalized) return 'menu'
  if (['1', 'i', 'init', 'full', 'start'].includes(normalized)) return 'init'
  if (['2', 'api', 'model', 'provider', 'providers', 'config'].includes(normalized)) return 'api'
  if (['3', 'lang', 'language'].includes(normalized)) return 'language'
  if (['4', 'persona', 'style', 'output-style', 'output'].includes(normalized)) return 'persona'
  if (['5', 'custom', 'instructions', 'prompt'].includes(normalized)) return 'custom'
  if (['6', 'approval', 'permissions', 'permission'].includes(normalized)) return 'approval'
  if (['7', 'show', 'current', 'status'].includes(normalized)) return 'show'
  if (['8', 'reset', 'clear'].includes(normalized)) return 'reset'
  if (['q', 'quit', 'exit'].includes(normalized)) return 'exit'
  if (MAIN_ACTIONS.has(normalized as SetupAction)) return normalized as SetupAction
  return 'menu'
}

function renderSetupLogoLine(line: string): string {
  let out = ''
  for (const ch of line) {
    if ('_/\\'.includes(ch)) {
      out += chalk.hex('#D6D6D6').bold(ch)
    } else if ('-`.\''.includes(ch)) {
      out += chalk.hex('#777777')(ch)
    } else {
      out += ch
    }
  }
  return out
}

function printBanner(profile = loadProfile()): void {
  const subtitle = setupText('setup.banner.subtitle', undefined, profile)
  const title = setupText('setup.banner.title', undefined, profile)
  console.log('')
  console.log(`  ${chalk.dim('─'.repeat(72))}`)
  console.log('')
  console.log(TURBOFLUX_WORDMARK_LINES.map(line => `  ${renderSetupLogoLine(line)}`).join('\n'))
  console.log('')
  console.log(`  ${chalk.hex(TURBOFLUX_ACCENTS.neonGreen).bold('TurboFlux Setup')} ${chalk.hex(TURBOFLUX_ACCENTS.cyan)(`v0.1.5`)} ${chalk.gray(`- ${title}`)}`)
  console.log(`  ${chalk.gray(subtitle)}`)
  console.log(`  ${chalk.dim('─'.repeat(72))}`)
  console.log('')
}

function printSeparator(): void {
  console.log('')
  console.log(chalk.dim('-'.repeat(62)))
  console.log('')
}

function profileLine(item: TurboFluxApiConfigProfile, currentId?: string): string {
  const marker = item.id === currentId ? chalk.green('*') : ' '
  const model = item.model || `(${setupText('common.notSet')})`
  const key = item.apiKey ? maskKey(item.apiKey) : `(${setupText('common.notSet')})`
  return `${marker} ${item.name}  [${item.id}]  ${item.provider} / ${model} / ${key}`
}

function printApiProfiles(config: TurboFluxConfig): void {
  const profiles = getApiConfigProfiles(config)
  if (profiles.length === 0) {
    console.log(chalk.yellow(`  ${setupText('setup.current.noApiProfiles')}`))
    return
  }
  for (const item of profiles) {
    console.log(`  ${profileLine(item, config.activeApiConfigId)}`)
  }
}

function printSummary(config: TurboFluxConfig, profile: TurboFluxProfile): void {
  const t = createTranslator(profile.interfaceLanguage)
  const knownModel = getSupportedModelSpec(config.model)
  const persona = getPersonaDefinition(profile.defaultPersonaId)
  const personaName = profile.defaultPersonaId === 'custom'
    ? (profile.customPersonaName || t('setup.persona.customFallback'))
    : (profile.interfaceLanguage === 'en' ? persona?.nameEn : persona?.nameZh) || profile.defaultPersonaId
  const outputLanguage = getOutputLanguageLabel(profile, t)
  const profiles = getApiConfigProfiles(config)
  const activeProfile = getActiveApiConfigProfile(config)

  console.log(chalk.bold(t('setup.current.title')))
  console.log(`  ${t('setup.current.activeApiConfig')}: ${activeProfile ? `${activeProfile.name} (${activeProfile.id})` : `(${t('common.notSet')})`}`)
  console.log(`  ${t('setup.current.apiConfigCount')}: ${profiles.length}`)
  console.log(`  ${t('setup.current.provider')}: ${config.provider}`)
  console.log(`  ${t('setup.current.baseUrl')}: ${config.baseUrl || `(${t('common.notSet')})`}`)
  console.log(`  ${t('setup.current.model')}: ${config.model || `(${t('common.notSet')})`}${knownModel ? ` (${knownModel.name})` : ''}`)
  console.log(`  ${t('setup.current.apiKey')}: ${maskKey(config.apiKey)}`)
  console.log(`  ${t('setup.current.contextWindow')}: ${config.contextWindow.toLocaleString()}`)
  console.log(`  ${t('setup.current.maxTokens')}: ${config.maxTokens.toLocaleString()}`)
  console.log(`  ${t('setup.current.reasoning')}: ${formatNativeReasoningSetting(config.model, config.reasoning, config.provider) || `(${t('common.providerDefault')})`}`)
  console.log(`  ${t('setup.current.approvalPolicy')}: ${approvalPolicyLabel(config.approvalPolicy, t)} (${config.approvalPolicy})`)
  console.log(`  ${t('setup.current.interfaceLanguage')}: ${profile.interfaceLanguage}`)
  console.log(`  ${t('setup.current.aiOutputLanguage')}: ${outputLanguage}`)
  console.log(`  ${t('setup.current.persona')}: ${personaName} (${profile.defaultPersonaId})`)
  console.log(`  ${t('setup.current.customInstructions')}:${profile.customInstructions ? ` ${t('setup.current.customInstructionsSet')}` : ` (${t('common.notSet')})`}`)
  console.log(`  ${t('setup.current.profileFile')}: ${getProfileFile()}`)
}

function getOutputLanguageLabel(profile: TurboFluxProfile, t: Translator): string {
  if (profile.aiOutputLanguage === 'follow-user') return t('setup.language.followUser')
  if (profile.aiOutputLanguage === 'zh-CN') return t('setup.language.simplifiedChinese')
  if (profile.aiOutputLanguage === 'en') return t('setup.language.english')
  if (profile.aiOutputLanguage === 'ja') return t('setup.language.japanese')
  if (profile.aiOutputLanguage === 'ko') return t('setup.language.korean')
  return profile.customAiOutputLanguage || t('setup.language.customLabel')
}

function approvalPolicyLabel(policy: ApprovalPolicy, t: Translator): string {
  if (policy === 'ask') return t('command.approval.ask')
  if (policy === 'agent') return t('command.approval.agent')
  return t('command.approval.full')
}

async function promptInput(message: string, options: { default?: string; required?: boolean; validate?: (value: string) => true | string } = {}): Promise<string> {
  const answer = await inquirer.prompt<{ value: string }>(promptConfig({
    type: 'input',
    name: 'value',
    message,
    default: options.default,
    validate: (value: string) => {
      const trimmed = value.trim()
      if (options.required && !trimmed) return setupText('setup.prompt.required')
      return options.validate?.(trimmed) ?? true
    },
  }))
  await settlePromptInput()
  return answer.value.trim()
}

async function promptPassword(message: string): Promise<string> {
  const answer = await inquirer.prompt<{ value: string }>(promptConfig({
    type: 'password',
    name: 'value',
    message,
    mask: '*',
  }))
  await settlePromptInput()
  return answer.value.trim()
}

async function promptConfirm(message: string, defaultValue = false): Promise<boolean> {
  const answer = await inquirer.prompt<{ ok: boolean }>(promptConfig({
    type: 'confirm',
    name: 'ok',
    message,
    default: defaultValue,
  }))
  await settlePromptInput()
  return answer.ok
}

async function promptEditor(message: string, defaultValue: string): Promise<string> {
  const answer = await inquirer.prompt<{ value: string }>(promptConfig({
    type: 'editor',
    name: 'value',
    message,
    default: defaultValue,
  }))
  await settlePromptInput()
  return answer.value.trim()
}

async function promptChoice(message: string, valid: string[], fallback = ''): Promise<string> {
  const lowerValid = new Set(valid.map(item => item.toLowerCase()))
  const answer = await promptInput(message, {
    default: fallback,
    validate: value => {
      const normalized = value.trim().toLowerCase()
      return lowerValid.has(normalized) || setupText('setup.prompt.chooseFrom', { values: valid.join(', ') })
    },
  })
  return answer.toLowerCase()
}

async function promptSelect<T extends string>(message: string, choices: PromptChoice<T>[], fallback?: T): Promise<T> {
  const answer = await inquirer.prompt<{ value: T }>(promptConfig({
    type: 'select',
    name: 'value',
    message,
    default: fallback,
    choices,
    pageSize: Math.min(12, Math.max(5, choices.length)),
  }))
  await settlePromptInput()
  return answer.value
}

async function promptCheckbox<T extends string>(message: string, choices: PromptChoice<T>[]): Promise<T[]> {
  const answer = await inquirer.prompt<{ value: T[] }>(promptConfig({
    type: 'checkbox',
    name: 'value',
    message,
    choices,
    pageSize: Math.min(14, Math.max(6, choices.length)),
  }))
  await settlePromptInput()
  return answer.value
}

async function promptContinue(profile: TurboFluxProfile): Promise<boolean> {
  return promptConfirm(setupText('setup.returnToMenu', undefined, profile), true)
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
  return hasApiOptions(options) || hasLanguageOptions(options) || hasPersonaOptions(options) || options.customInstructions !== undefined || options.approvalPolicy !== undefined
}

function shouldKeepCurrentApiKey(current: TurboFluxConfig, preset: ProviderPreset, baseUrl: string): boolean {
  if (!current.apiKey) return false
  const currentBaseUrl = current.baseUrl.replace(/\/+$/, '')
  const nextBaseUrl = baseUrl.replace(/\/+$/, '')
  return current.provider === preset.provider && currentBaseUrl === nextBaseUrl
}

function normalizeInterfaceLanguage(value?: string): TurboFluxInterfaceLanguage | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (['zh', 'zh-cn', 'cn', 'chinese', '中文', '简体中文'].includes(normalized)) return 'zh-CN'
  if (['en', 'english'].includes(normalized)) return 'en'
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

function parseStyleList(value?: string): string[] | 'skip' | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const normalized = trimmed.toLowerCase()
  if (normalized === 'skip' || normalized === 'none') return 'skip'
  if (normalized === 'all') return PERSONA_DEFINITIONS.filter(p => !p.isCustom).map(p => p.id)
  return trimmed.split(',').map(item => item.trim().toLowerCase()).filter(Boolean)
}

function validateUrl(value: string): true | string {
  if (!value.trim()) return setupText('setup.url.required')
  try {
    new URL(value)
    return true
  } catch {
    return setupText('setup.url.invalid')
  }
}

function uniqueProfileName(baseName: string, profiles: TurboFluxApiConfigProfile[]): string {
  const names = new Set(profiles.map(item => item.name.toLowerCase()))
  if (!names.has(baseName.toLowerCase())) return baseName
  let suffix = 2
  while (names.has(`${baseName} ${suffix}`.toLowerCase())) suffix++
  return `${baseName} ${suffix}`
}

function findProfileByInput(config: TurboFluxConfig, value: string): TurboFluxApiConfigProfile | undefined {
  const profiles = getApiConfigProfiles(config)
  const trimmed = value.trim()
  const index = Number(trimmed)
  if (Number.isInteger(index) && index >= 1 && index <= profiles.length) return profiles[index - 1]
  const lower = trimmed.toLowerCase()
  return profiles.find(item => item.id.toLowerCase() === lower || item.name.toLowerCase() === lower)
}

async function promptProfile(config: TurboFluxConfig, message = setupText('setup.api.chooseAction')): Promise<TurboFluxApiConfigProfile | undefined> {
  const profiles = getApiConfigProfiles(config)
  if (profiles.length === 0) {
    console.log(chalk.yellow(setupText('setup.api.noSelectableProfiles')))
    return undefined
  }
  const selectedId = await promptSelect(message, profiles.map(item => ({
    name: profileLine(item, config.activeApiConfigId),
    value: item.id,
    short: item.name,
  })), config.activeApiConfigId || profiles[0]?.id)
  return profiles.find(item => item.id === selectedId)
}

function modelLimits(model: string): { contextWindow: number; maxTokens: number } {
  const spec = getSupportedModelSpec(model)
  return {
    contextWindow: spec?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: spec?.defaultRequestTokens ?? DEFAULT_MAX_TOKENS,
  }
}

async function promptProvider(current?: TurboFluxApiConfigProfile | TurboFluxConfig): Promise<ProviderPreset> {
  const defaultPreset = current ? getProviderPreset(current.provider) : undefined
  const providerId = await promptSelect(setupText('setup.api.selectProvider'), PROVIDER_PRESETS.map(item => ({
    name: `${providerLabel(item)} ${chalk.gray(`- ${item.description}`)}`,
    value: item.id,
    short: item.name,
  })), defaultPreset?.id || 'custom')
  return resolveProvider(providerId)!
}

async function promptProfileFields(options: {
  currentConfig: TurboFluxConfig
  existing?: TurboFluxApiConfigProfile
  copyFrom?: TurboFluxApiConfigProfile
  cliOptions?: SetupOptions
  directMode?: boolean
}): Promise<TurboFluxApiConfigProfile> {
  const { currentConfig, existing, copyFrom, cliOptions = {}, directMode = false } = options
  const source = existing || copyFrom || currentConfig
  let preset = directMode ? defaultProviderForOptions(cliOptions, currentConfig) : undefined
  if (directMode && cliOptions.provider && !preset) {
    throw new Error(setupText('setup.api.unknownProvider', { provider: cliOptions.provider }))
  }
  if (!preset) preset = await promptProvider(source)
  if (!preset) throw new Error(setupText('setup.api.unknownProvider', { provider: cliOptions.provider || '' }))

  const providerWasExplicit = Boolean(cliOptions.provider?.trim())
  const providerChanged = source.provider !== preset.provider
  const defaultBaseUrl = cliOptions.baseUrl
    || (providerChanged || providerWasExplicit ? preset.baseUrl : source.baseUrl)
    || preset.baseUrl
  const baseUrl = directMode
    ? defaultBaseUrl
    : await promptInput('Base URL', {
      default: defaultBaseUrl,
      required: true,
      validate: validateUrl,
    })
  const sameConnection = source.provider === preset.provider
    && source.baseUrl.replace(/\/+$/, '') === baseUrl.replace(/\/+$/, '')
  const model = cliOptions.model?.trim()
    || (sameConnection ? source.model : preset.defaultModel)

  let apiKey = cliOptions.apiKey
  if (apiKey === undefined) {
    if (directMode) {
      apiKey = shouldKeepCurrentApiKey(currentConfig, preset, baseUrl) ? currentConfig.apiKey : ''
    } else {
      const keepCurrent = sameConnection && Boolean(source.apiKey)
      const entered = await promptPassword(setupText(keepCurrent ? 'setup.api.keepKey' : 'setup.api.newKey'))
      apiKey = entered || (keepCurrent ? source.apiKey : '')
    }
  }

  if (!baseUrl) throw new Error(setupText('setup.api.baseUrlRequired'))
  const urlValidation = validateUrl(baseUrl)
  if (urlValidation !== true) throw new Error(urlValidation)

  const modelUnchanged = sameConnection && model === source.model
  const limits = modelLimits(model)
  const modelSpec = getSupportedModelSpec(model)
  const reasoning = model
    ? normalizeNativeReasoningConfig(model, modelUnchanged ? source.reasoning : undefined, preset.provider)
    : undefined
  const profiles = getApiConfigProfiles(currentConfig).filter(item => item.id !== existing?.id)
  const defaultName = existing?.name
    || uniqueProfileName(preset.id === 'custom' ? setupText('setup.api.customName') : preset.name, profiles)
  const name = directMode
    ? defaultName
    : await promptInput(setupText('setup.api.profileName'), {
      default: defaultName,
      required: true,
    })

  return createApiConfigProfile({
    id: existing?.id,
    name,
    provider: preset.provider,
    apiKey,
    baseUrl,
    model,
    contextWindow: modelUnchanged ? source.contextWindow : limits.contextWindow,
    maxTokens: modelUnchanged ? source.maxTokens : limits.maxTokens,
    maxOutputTokens: modelUnchanged ? source.maxOutputTokens : modelSpec?.maxOutputTokens,
    modelCapabilities: modelUnchanged ? source.modelCapabilities : modelSpec ? {
      vision: modelSpec.supportsVision,
      reasoning: Boolean(reasoning),
    } : undefined,
    modelMetadataSources: modelUnchanged ? source.modelMetadataSources : modelSpec ? ['builtin'] : ['default'],
    reasoning,
    createdAt: existing?.createdAt,
  })
}

async function configureApiDirect(options: SetupOptions = {}): Promise<TurboFluxConfig> {
  const current = await loadConfig()
  const directMode = options.yes || hasApiOptions(options)
  if (!directMode) return configureApiProfiles()

  const profile = await promptProfileFields({
    currentConfig: current,
    existing: getActiveApiConfigProfile(current),
    cliOptions: options,
    directMode: true,
  })
  const next = saveApiConfigProfile(current, profile, true)
  const saved = saveConfig(next)
  console.log(chalk.green(setupText('setup.api.saved')))
  console.log(`  name:     ${profile.name}`)
  console.log(`  provider: ${saved.provider}`)
  console.log(`  baseUrl:  ${saved.baseUrl}`)
  console.log(`  model:    ${saved.model || `(${setupText('setup.api.modelLater')})`}`)
  console.log(`  apiKey:   ${maskKey(saved.apiKey)}`)
  return saved
}

async function addApiProfile(config: TurboFluxConfig): Promise<TurboFluxConfig> {
  const profile = await promptProfileFields({ currentConfig: config })
  const makeActive = await promptConfirm(setupText('setup.api.makeActive'), getApiConfigProfiles(config).length === 0)
  const next = saveApiConfigProfile(config, profile, makeActive)
  const saved = saveConfig(next)
  console.log(chalk.green(setupText('setup.api.added', { name: profile.name })))
  return saved
}

async function switchApiProfile(config: TurboFluxConfig): Promise<TurboFluxConfig> {
  const selected = await promptProfile(config, setupText('setup.api.selectSwitch'))
  if (!selected) return config
  const next = switchActiveApiConfig(config, selected.id)
  const saved = saveConfig(next)
  console.log(chalk.green(setupText('setup.api.switched', { name: selected.name })))
  return saved
}

async function editApiProfile(config: TurboFluxConfig): Promise<TurboFluxConfig> {
  const selected = await promptProfile(config, setupText('setup.api.selectEdit'))
  if (!selected) return config
  const profile = await promptProfileFields({ currentConfig: config, existing: selected })
  const makeActive = selected.id === config.activeApiConfigId
  const next = saveApiConfigProfile(config, profile, makeActive)
  const saved = saveConfig(next)
  console.log(chalk.green(setupText('setup.api.updated', { name: profile.name })))
  return saved
}

async function copyApiProfile(config: TurboFluxConfig): Promise<TurboFluxConfig> {
  const selected = await promptProfile(config, setupText('setup.api.selectCopy'))
  if (!selected) return config
  const profiles = getApiConfigProfiles(config)
  const copied = createApiConfigProfile({
    ...selected,
    id: undefined,
    name: uniqueProfileName(`${selected.name} Copy`, profiles),
    createdAt: undefined,
    updatedAt: undefined,
  })
  const next = saveApiConfigProfile(config, copied, false)
  const saved = saveConfig(next)
  console.log(chalk.green(setupText('setup.api.copied', { name: copied.name })))
  return saved
}

async function deleteApiProfile(config: TurboFluxConfig): Promise<TurboFluxConfig> {
  const selected = await promptProfile(config, setupText('setup.api.selectDelete'))
  if (!selected) return config
  const ok = await promptConfirm(setupText('setup.api.confirmDelete', { name: selected.name }), false)
  if (!ok) {
    console.log(chalk.yellow(setupText('common.cancelled')))
    return config
  }
  const next = deleteApiConfigProfile(config, selected.id)
  const saved = saveConfig(next)
  console.log(chalk.green(setupText('setup.api.deleted', { name: selected.name })))
  return saved
}

async function configureApiProfiles(): Promise<TurboFluxConfig> {
  let config = await loadConfig()
  let done = false
  while (!done) {
    console.log(chalk.cyan(setupText('setup.api.profilesTitle')))
    printApiProfiles(config)
    console.log('')
    const choice = await promptSelect(setupText('setup.api.chooseAction'), [
      { name: setupText('setup.api.actionAdd'), value: '1' },
      { name: setupText('setup.api.actionSwitch'), value: '2', disabled: getApiConfigProfiles(config).length === 0 && setupText('setup.api.noSwitch') },
      { name: setupText('setup.api.actionEdit'), value: '3', disabled: getApiConfigProfiles(config).length === 0 && setupText('setup.api.noEdit') },
      { name: setupText('setup.api.actionCopy'), value: '4', disabled: getApiConfigProfiles(config).length === 0 && setupText('setup.api.noCopy') },
      { name: setupText('setup.api.actionDelete'), value: '5', disabled: getApiConfigProfiles(config).length === 0 && setupText('setup.api.noDelete') },
      { name: setupText('setup.api.back'), value: 'q' },
    ])
    console.log('')
    switch (choice) {
      case '1':
        config = await addApiProfile(config)
        break
      case '2':
        config = await switchApiProfile(config)
        break
      case '3':
        config = await editApiProfile(config)
        break
      case '4':
        config = await copyApiProfile(config)
        break
      case '5':
        config = await deleteApiProfile(config)
        break
      case 'q':
        done = true
        break
    }
    if (!done) printSeparator()
  }
  return config
}

async function configureApi(options: SetupOptions = {}): Promise<TurboFluxConfig> {
  return configureApiDirect(options)
}

async function configureLanguage(options: SetupOptions = {}): Promise<TurboFluxProfile> {
  let profile = loadProfile()
  const interfaceInput = options.allLang || options.configLang || options.lang
  const outputInput = options.allLang || options.aiOutputLang || options.lang
  const interfaceFromCli = normalizeInterfaceLanguage(interfaceInput)
  const outputFromCli = normalizeOutputLanguage(outputInput)

  if (options.configLang && !normalizeInterfaceLanguage(options.configLang)) {
    throw new Error(setupText('setup.language.invalidInterface', { language: options.configLang }, profile))
  }
  if (options.allLang && !normalizeInterfaceLanguage(options.allLang)) {
    throw new Error(setupText('setup.language.invalidShared', { language: options.allLang }, profile))
  }
  if (outputFromCli.language === 'custom' && !outputFromCli.custom && !profile.customAiOutputLanguage) {
    throw new Error(setupText('setup.language.customRequired', undefined, profile))
  }

  if (options.yes || interfaceFromCli || outputFromCli.language) {
    profile = saveProfile({
      interfaceLanguage: interfaceFromCli || profile.interfaceLanguage,
      aiOutputLanguage: outputFromCli.language || profile.aiOutputLanguage,
      customAiOutputLanguage: outputFromCli.custom || profile.customAiOutputLanguage,
    })
    console.log(chalk.green(setupText('setup.language.saved', undefined, profile)))
    return profile
  }

  console.log(chalk.cyan(setupText('setup.language.title', undefined, profile)))
  const interfaceLanguage = await promptSelect<TurboFluxInterfaceLanguage>(setupText('setup.language.interface', undefined, profile), [
    { name: setupText('setup.language.simplifiedChinese', undefined, profile), value: 'zh-CN' },
    { name: 'English', value: 'en' },
  ], profile.interfaceLanguage)
  profile = saveProfile({ interfaceLanguage })

  console.log('')
  const aiOutputLanguage = await promptSelect<TurboFluxAiOutputLanguage>(setupText('setup.language.aiOutput', undefined, profile), [
    { name: setupText('setup.language.followUser', undefined, profile), value: 'follow-user' },
    { name: setupText('setup.language.simplifiedChinese', undefined, profile), value: 'zh-CN' },
    { name: 'English', value: 'en' },
    { name: 'Japanese', value: 'ja' },
    { name: 'Korean', value: 'ko' },
    { name: setupText('setup.language.custom', undefined, profile), value: 'custom' },
  ], profile.aiOutputLanguage)
  let customAiOutputLanguage = profile.customAiOutputLanguage
  if (aiOutputLanguage === 'custom') {
    customAiOutputLanguage = await promptInput(setupText('setup.language.customPrompt', undefined, profile), {
      default: customAiOutputLanguage,
      required: true,
    })
  }
  profile = saveProfile({ aiOutputLanguage, customAiOutputLanguage })
  console.log(chalk.green(setupText('setup.language.saved', undefined, profile)))
  return profile
}

async function configurePersona(options: SetupOptions = {}): Promise<TurboFluxProfile> {
  let profile = loadProfile()
  const fromCli = parseStyleList(options.outputStyle)
  const defaultFromCli = options.defaultOutputStyle?.trim().toLowerCase()

  if (options.yes || fromCli || defaultFromCli) {
    if (fromCli === 'skip' && !defaultFromCli) {
      console.log(chalk.gray(setupText('setup.persona.skipped', undefined, profile)))
      return profile
    }
    if (Array.isArray(fromCli)) {
      const unknown = fromCli.filter(id => !PERSONA_DEFINITIONS.some(p => p.id === id && !p.isCustom))
      if (unknown.length > 0) throw new Error(setupText('setup.persona.unknown', { personas: unknown.join(', ') }, profile))
      if (fromCli.length === 0) throw new Error(setupText('setup.persona.oneRequired', undefined, profile))
    }
    let enabledPersonaIds = Array.isArray(fromCli) ? fromCli : [...profile.enabledPersonaIds]
    const defaultPersonaId = defaultFromCli || profile.defaultPersonaId
    if (defaultPersonaId !== 'custom' && !PERSONA_DEFINITIONS.some(p => p.id === defaultPersonaId)) {
      throw new Error(setupText('setup.persona.unknownDefault', { persona: defaultPersonaId }, profile))
    }
    if (defaultPersonaId === 'custom' && !profile.customPersonaPrompt) {
      throw new Error(setupText('setup.persona.customPromptRequired', undefined, profile))
    }
    if (defaultPersonaId !== 'custom' && !enabledPersonaIds.includes(defaultPersonaId)) {
      enabledPersonaIds = [...enabledPersonaIds, defaultPersonaId]
    }
    profile = saveProfile({ enabledPersonaIds, defaultPersonaId })
    console.log(chalk.green(setupText('setup.persona.saved', undefined, profile)))
    return profile
  }

  const available = PERSONA_DEFINITIONS.filter(persona => !persona.isCustom)
  console.log(chalk.cyan(setupText('setup.persona.title', undefined, profile)))
  const enabledPersonaIds = await promptCheckbox(setupText('setup.persona.selectEnabled', undefined, profile), available.map(persona => {
    const name = profile.interfaceLanguage === 'en' ? persona.nameEn : persona.nameZh
    const desc = profile.interfaceLanguage === 'en' ? persona.descriptionEn : persona.descriptionZh
    return {
      name: `${name} (${persona.id}) ${chalk.gray(`- ${desc}`)}`,
      value: persona.id,
      checked: profile.enabledPersonaIds.includes(persona.id),
    }
  }))

  if (enabledPersonaIds.length === 0) throw new Error(setupText('setup.persona.oneRequired', undefined, profile))

  const defaultChoices = enabledPersonaIds.map(id => {
    const persona = getPersonaDefinition(id)!
    const name = profile.interfaceLanguage === 'en' ? persona.nameEn : persona.nameZh
    return {
      name: `${name} (${persona.id})`,
      value: id,
    }
  })
  const defaultPersonaId = await promptSelect(setupText('setup.persona.default', undefined, profile), [
    ...defaultChoices,
    { name: setupText('setup.persona.custom', undefined, profile), value: 'custom' },
  ], enabledPersonaIds.includes(profile.defaultPersonaId) || profile.defaultPersonaId === 'custom'
    ? profile.defaultPersonaId
    : enabledPersonaIds[0])
  let customPersonaName = profile.customPersonaName
  let customPersonaPrompt = profile.customPersonaPrompt
  if (defaultPersonaId === 'custom') {
    customPersonaName = await promptInput(setupText('setup.persona.customName', undefined, profile), {
      default: customPersonaName || setupText('setup.persona.defaultCustomName', undefined, profile),
      required: true,
    })
    customPersonaPrompt = await promptEditor(setupText('setup.persona.customPrompt', undefined, profile), customPersonaPrompt || setupText('setup.persona.defaultPrompt', undefined, profile))
    if (!customPersonaPrompt) throw new Error(setupText('setup.persona.customPromptEmpty', undefined, profile))
  }

  profile = saveProfile({ enabledPersonaIds, defaultPersonaId, customPersonaName, customPersonaPrompt })
  console.log(chalk.green(setupText('setup.persona.saved', undefined, profile)))
  return profile
}

async function configureCustomInstructions(options: SetupOptions = {}): Promise<TurboFluxProfile> {
  const profile = loadProfile()
  if (options.yes || options.customInstructions !== undefined) {
    const next = saveProfile({ customInstructions: options.customInstructions ?? profile.customInstructions })
    console.log(chalk.green(setupText('setup.instructions.saved', undefined, next)))
    return next
  }

  const customInstructions = await promptEditor(setupText('setup.instructions.edit', undefined, profile), profile.customInstructions)
  const next = saveProfile({ customInstructions })
  console.log(chalk.green(setupText('setup.instructions.saved', undefined, next)))
  return next
}

async function configureApprovalPolicy(options: SetupOptions = {}): Promise<TurboFluxConfig> {
  const config = await loadConfig()
  const profile = loadProfile()
  let approvalPolicy: ApprovalPolicy
  if (options.approvalPolicy) {
    const normalized = options.approvalPolicy.trim().toLowerCase()
    if (!['ask', 'agent', 'full', 'request', 'auto'].includes(normalized)) {
      throw new Error(setupText('setup.approval.invalid', undefined, profile))
    }
    approvalPolicy = normalizeApprovalPolicy(normalized)
  } else if (options.yes) {
    approvalPolicy = config.approvalPolicy
  } else {
    const labelKeys: Record<ApprovalPolicy, MessageKey> = {
      ask: 'setup.approval.ask',
      agent: 'setup.approval.agent',
      full: 'setup.approval.full',
    }
    approvalPolicy = await promptSelect(setupText('setup.approval.title', undefined, profile), (['ask', 'agent', 'full'] as ApprovalPolicy[]).map(policy => ({
      name: setupText(labelKeys[policy], undefined, profile),
      value: policy,
    })), config.approvalPolicy)
  }

  const next = { ...config, approvalPolicy }
  saveConfig(next)
  console.log(chalk.green(setupText('setup.approval.saved', { policy: approvalPolicyLabel(approvalPolicy, createTranslator(profile.interfaceLanguage)) }, profile)))
  return next
}

async function runFullInitialization(options: SetupOptions = {}): Promise<void> {
  let profile = await configureLanguage(options)
  await configureApi(options)
  await configureApprovalPolicy(options)
  profile = await configurePersona(options)
  if (!options.yes) {
    const editCustom = await promptConfirm(setupText('setup.init.editInstructions', undefined, profile), false)
    if (editCustom) profile = await configureCustomInstructions(options)
  } else if (options.customInstructions !== undefined) {
    profile = await configureCustomInstructions(options)
  }

  const config = await loadConfig()
  console.log('')
  printSummary(config, profile)
  console.log('')
  console.log(chalk.cyan(setupText('setup.init.done', undefined, profile)))
}

async function showCurrentConfiguration(): Promise<void> {
  const [config, profile] = await Promise.all([loadConfig(), Promise.resolve(loadProfile())])
  printSummary(config, profile)
}

async function resetAllConfiguration(options: SetupOptions = {}): Promise<void> {
  let profile = loadProfile()
  const ok = options.yes
    ? true
    : await promptConfirm(setupText('setup.reset.confirm', undefined, profile), false)
  if (!ok) {
    console.log(chalk.yellow(setupText('common.cancelled', undefined, profile)))
    return
  }

  saveConfig(createEmptyConfig())
  profile = resetProfile()
  console.log(chalk.green(setupText('setup.reset.done', undefined, profile)))
}

async function promptMainAction(profile: TurboFluxProfile): Promise<SetupAction> {
  console.log(chalk.cyan(setupText('setup.menu.title', undefined, profile)))
  console.log(`  ${setupText('setup.menu.init', undefined, profile)}`)
  console.log(`  ${setupText('setup.menu.api', undefined, profile)}`)
  console.log(`  ${setupText('setup.menu.language', undefined, profile)}`)
  console.log(`  ${setupText('setup.menu.persona', undefined, profile)}`)
  console.log(`  ${setupText('setup.menu.instructions', undefined, profile)}`)
  console.log(`  ${setupText('setup.menu.approval', undefined, profile)}`)
  console.log(`  ${setupText('setup.menu.show', undefined, profile)}`)
  console.log(`  ${setupText('setup.menu.reset', undefined, profile)}`)
  console.log(`  ${setupText('setup.menu.exit', undefined, profile)}`)
  const choice = await promptChoice(setupText('setup.menu.input', undefined, profile), ['1', '2', '3', '4', '5', '6', '7', '8', 'q'])
  switch (choice) {
    case '1': return 'init'
    case '2': return 'api'
    case '3': return 'language'
    case '4': return 'persona'
    case '5': return 'custom'
    case '6': return 'approval'
    case '7': return 'show'
    case '8': return 'reset'
    case 'q': return 'exit'
    default: return 'menu'
  }
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
        await configureApi()
        break
      case 'language':
        profile = await configureLanguage()
        break
      case 'persona':
        profile = await configurePersona()
        break
      case 'custom':
        profile = await configureCustomInstructions()
        break
      case 'approval':
        await configureApprovalPolicy()
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
    if (!exit) printSeparator()
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
    if (options.approvalPolicy !== undefined) await configureApprovalPolicy(options)
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
      case 'approval':
        await configureApprovalPolicy(options)
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
