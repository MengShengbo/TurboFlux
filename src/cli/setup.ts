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
  setFastContextModelConfig,
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
  APPROVAL_POLICY_LABELS,
  normalizeApprovalPolicy,
  type ApprovalPolicy,
} from '../shared/agentTypes'
import { TURBOFLUX_WORDMARK_LINES } from './brand'
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
  approvalPolicy?: string
}

type SetupAction =
  | 'menu'
  | 'init'
  | 'api'
  | 'fastcontext'
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
  'fastcontext',
  'language',
  'persona',
  'custom',
  'approval',
  'show',
  'reset',
  'exit',
])

function zh(profile: TurboFluxProfile, zhText: string, enText: string): string {
  return profile.interfaceLanguage === 'en' ? enText : zhText
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
  if (!key) return '(未设置)'
  if (key.length <= 8) return '***'
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

function normalizeAction(action?: string): SetupAction {
  const normalized = (action || 'menu').trim().toLowerCase()
  if (!normalized) return 'menu'
  if (['1', 'i', 'init', 'full', 'start'].includes(normalized)) return 'init'
  if (['2', 'api', 'model', 'provider', 'providers', 'config'].includes(normalized)) return 'api'
  if (['fc', 'fastcontext', 'fast-context', 'fast_context', 'subagent', 'sub-agent'].includes(normalized)) return 'fastcontext'
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
      out += chalk.hex('#d6d6d6').bold(ch)
    } else if ('-`.\''.includes(ch)) {
      out += chalk.hex('#777777')(ch)
    } else {
      out += ch
    }
  }
  return out
}

function printBanner(profile = loadProfile()): void {
  const subtitle = zh(
    profile,
    '模型档案 · FastContext 子代理 · 语言 · 人设 · 全局行为',
    'Model profiles · FastContext subagent · Language · Persona · Behavior',
  )
  const title = zh(profile, '终端工作台初始化', 'Terminal workbench setup')
  console.log('')
  console.log(`  ${chalk.dim('─'.repeat(72))}`)
  console.log('')
  console.log(TURBOFLUX_WORDMARK_LINES.map(line => `  ${renderSetupLogoLine(line)}`).join('\n'))
  console.log('')
  console.log(`  ${chalk.white.bold('TurboFlux Setup')} ${chalk.dim('v0.1.5')} ${chalk.gray(`- ${title}`)}`)
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
  const model = item.model || '(未设置模型)'
  const key = item.apiKey ? maskKey(item.apiKey) : '(未设置 Key)'
  return `${marker} ${item.name}  [${item.id}]  ${item.provider} / ${model} / ${key}`
}

function printApiProfiles(config: TurboFluxConfig): void {
  const profiles = getApiConfigProfiles(config)
  if (profiles.length === 0) {
    console.log(chalk.yellow('  当前没有 API 配置档案。'))
    return
  }
  for (const item of profiles) {
    console.log(`  ${profileLine(item, config.activeApiConfigId)}`)
  }
}

function printSummary(config: TurboFluxConfig, profile: TurboFluxProfile): void {
  const knownModel = getSupportedModelSpec(config.model)
  const persona = getPersonaDefinition(profile.defaultPersonaId)
  const personaName = profile.defaultPersonaId === 'custom'
    ? (profile.customPersonaName || 'Custom Persona')
    : (profile.interfaceLanguage === 'en' ? persona?.nameEn : persona?.nameZh) || profile.defaultPersonaId
  const outputLanguage = getOutputLanguageLabel(profile.aiOutputLanguage, profile.customAiOutputLanguage, profile.interfaceLanguage)
  const profiles = getApiConfigProfiles(config)
  const activeProfile = getActiveApiConfigProfile(config)

  console.log(chalk.bold(zh(profile, '当前配置', 'Current configuration')))
  console.log(`  activeApiConfig:   ${activeProfile ? `${activeProfile.name} (${activeProfile.id})` : '(未设置)'}`)
  console.log(`  apiConfigCount:    ${profiles.length}`)
  console.log(`  provider:          ${config.provider}`)
  console.log(`  baseUrl:           ${config.baseUrl || '(未设置)'}`)
  console.log(`  model:             ${config.model || '(未设置)'}${knownModel ? ` (${knownModel.name})` : ''}`)
  console.log(`  apiKey:            ${maskKey(config.apiKey)}`)
  console.log(`  contextWindow:     ${config.contextWindow.toLocaleString()}`)
  console.log(`  maxTokens:         ${config.maxTokens.toLocaleString()}`)
  console.log(`  reasoning:         ${formatNativeReasoningSetting(config.model, config.reasoning, config.provider) || '(provider default)'}`)
  console.log(`  approvalPolicy:    ${APPROVAL_POLICY_LABELS[config.approvalPolicy]} (${config.approvalPolicy})`)
  console.log('  fastContextModel:  跟随主模型')
  console.log(`  interfaceLanguage: ${profile.interfaceLanguage}`)
  console.log(`  aiOutputLanguage:  ${outputLanguage}`)
  console.log(`  persona:           ${personaName} (${profile.defaultPersonaId})`)
  console.log(`  customInstructions:${profile.customInstructions ? ' set' : ' (未设置)'}`)
  console.log(`  profileFile:       ${getProfileFile()}`)
}

async function promptInput(message: string, options: { default?: string; required?: boolean; validate?: (value: string) => true | string } = {}): Promise<string> {
  const answer = await inquirer.prompt<{ value: string }>(promptConfig({
    type: 'input',
    name: 'value',
    message,
    default: options.default,
    validate: (value: string) => {
      const trimmed = value.trim()
      if (options.required && !trimmed) return '不能为空'
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
      return lowerValid.has(normalized) || `请输入：${valid.join(', ')}`
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
  return promptConfirm(zh(profile, '返回主菜单？', 'Return to main menu?'), true)
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

function parseStyleList(value?: string): string[] | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed === 'skip' || trimmed === 'none') return []
  if (trimmed === 'all') return PERSONA_DEFINITIONS.filter(p => !p.isCustom).map(p => p.id)
  return trimmed.split(',').map(item => item.trim()).filter(Boolean)
}

function validateUrl(value: string): true | string {
  if (!value.trim()) return 'URL 不能为空'
  try {
    new URL(value)
    return true
  } catch {
    return '请输入完整 URL，例如 https://api.example.com/v1'
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

async function promptProfile(config: TurboFluxConfig, message = '输入配置编号 / id / 名称'): Promise<TurboFluxApiConfigProfile | undefined> {
  const profiles = getApiConfigProfiles(config)
  if (profiles.length === 0) {
    console.log(chalk.yellow('还没有可选的 API 配置。'))
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
  const providerId = await promptSelect('选择 Provider', PROVIDER_PRESETS.map(item => ({
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
  if (!preset) preset = await promptProvider(source)
  if (!preset) throw new Error(`Unknown provider "${cliOptions.provider || ''}".`)
  if (directMode && preset.id === 'custom' && !cliOptions.baseUrl) {
    throw new Error('Custom provider requires --base-url when using --yes.')
  }

  const defaultBaseUrl = cliOptions.baseUrl || source.baseUrl || preset.baseUrl
  const baseUrl = directMode
    ? defaultBaseUrl
    : await promptInput('Base URL', {
      default: defaultBaseUrl,
      required: true,
      validate: validateUrl,
    })
  const model = cliOptions.model?.trim() || existing?.model || copyFrom?.model || ''

  let apiKey = cliOptions.apiKey
  if (apiKey === undefined) {
    if (directMode) {
      apiKey = shouldKeepCurrentApiKey(currentConfig, preset, baseUrl) ? currentConfig.apiKey : (source.apiKey || '')
    } else {
      const keepCurrent = Boolean(existing?.apiKey || copyFrom?.apiKey || shouldKeepCurrentApiKey(currentConfig, preset, baseUrl))
      const entered = await promptPassword(keepCurrent ? 'API Key（留空保留当前值）' : 'API Key（可留空，之后再补）')
      apiKey = entered || (keepCurrent ? source.apiKey : '')
    }
  }

  if (!baseUrl) throw new Error('Base URL is required.')

  const limits = modelLimits(model)
  const reasoning = model
    ? normalizeNativeReasoningConfig(model, source.reasoning, preset.provider)
    : undefined
  const profiles = getApiConfigProfiles(currentConfig).filter(item => item.id !== existing?.id)
  const defaultName = existing?.name
    || uniqueProfileName(preset.id === 'custom' ? 'Custom API' : preset.name, profiles)
  const name = directMode
    ? defaultName
    : await promptInput('配置名称', {
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
    contextWindow: existing?.contextWindow || limits.contextWindow,
    maxTokens: existing?.maxTokens || limits.maxTokens,
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
  saveConfig(next)
  console.log(chalk.green('已保存 API 配置。'))
  console.log(`  name:     ${profile.name}`)
  console.log(`  provider: ${next.provider}`)
  console.log(`  baseUrl:  ${next.baseUrl}`)
  console.log(`  model:    ${next.model || '(启动后自动发现，或使用 /model add <模型ID>)'}`)
  console.log(`  apiKey:   ${maskKey(next.apiKey)}`)
  return next
}

async function addApiProfile(config: TurboFluxConfig): Promise<TurboFluxConfig> {
  const profile = await promptProfileFields({ currentConfig: config })
  const makeActive = await promptConfirm('设为当前 API 配置？', getApiConfigProfiles(config).length === 0)
  const next = saveApiConfigProfile(config, profile, makeActive)
  saveConfig(next)
  console.log(chalk.green(`已添加配置：${profile.name}`))
  return next
}

async function switchApiProfile(config: TurboFluxConfig): Promise<TurboFluxConfig> {
  const selected = await promptProfile(config, '切换到哪个配置？')
  if (!selected) return config
  const next = switchActiveApiConfig(config, selected.id)
  saveConfig(next)
  console.log(chalk.green(`已切换到：${selected.name}`))
  return next
}

async function editApiProfile(config: TurboFluxConfig): Promise<TurboFluxConfig> {
  const selected = await promptProfile(config, '编辑哪个配置？')
  if (!selected) return config
  const profile = await promptProfileFields({ currentConfig: config, existing: selected })
  const makeActive = selected.id === config.activeApiConfigId
  const next = saveApiConfigProfile(config, profile, makeActive)
  saveConfig(next)
  console.log(chalk.green(`已更新配置：${profile.name}`))
  return next
}

async function copyApiProfile(config: TurboFluxConfig): Promise<TurboFluxConfig> {
  const selected = await promptProfile(config, '复制哪个配置？')
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
  saveConfig(next)
  console.log(chalk.green(`已复制配置：${copied.name}`))
  return next
}

async function deleteApiProfile(config: TurboFluxConfig): Promise<TurboFluxConfig> {
  const selected = await promptProfile(config, '删除哪个配置？')
  if (!selected) return config
  const ok = await promptConfirm(`确认删除「${selected.name}」？`, false)
  if (!ok) {
    console.log(chalk.yellow('已取消。'))
    return config
  }
  const next = deleteApiConfigProfile(config, selected.id)
  saveConfig(next)
  console.log(chalk.green(`已删除配置：${selected.name}`))
  return next
}

async function configureApiProfiles(): Promise<TurboFluxConfig> {
  let config = await loadConfig()
  let done = false
  while (!done) {
    console.log(chalk.cyan('API 配置档案'))
    printApiProfiles(config)
    console.log('')
    const choice = await promptSelect('选择 API 配置操作', [
      { name: '新建配置 - 添加一个 API 档案', value: '1' },
      { name: '切换当前配置 - 设置主 Agent 使用的档案', value: '2', disabled: getApiConfigProfiles(config).length === 0 && '还没有可切换的配置' },
      { name: '编辑配置 - 修改 Provider、Base URL 和 Key', value: '3', disabled: getApiConfigProfiles(config).length === 0 && '还没有可编辑的配置' },
      { name: '复制配置 - 基于已有档案创建副本', value: '4', disabled: getApiConfigProfiles(config).length === 0 && '还没有可复制的配置' },
      { name: '删除配置 - 移除一个 API 档案', value: '5', disabled: getApiConfigProfiles(config).length === 0 && '还没有可删除的配置' },
      { name: '返回主菜单', value: 'q' },
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

async function configureFastContextModel(): Promise<TurboFluxConfig> {
  const config = setFastContextModelConfig(await loadConfig(), { mode: 'follow-main' })
  saveConfig(config)
  console.log(chalk.green('FastContext 始终跟随当前主模型。'))
  return config
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
    console.log(chalk.green('已保存语言配置。'))
    return profile
  }

  console.log(chalk.cyan('语言配置'))
  const interfaceLanguage = await promptSelect<TurboFluxInterfaceLanguage>('Setup 界面语言', [
    { name: '简体中文', value: 'zh-CN' },
    { name: 'English', value: 'en' },
  ], profile.interfaceLanguage)
  profile = saveProfile({ interfaceLanguage })

  console.log('')
  const aiOutputLanguage = await promptSelect<TurboFluxAiOutputLanguage>('AI 默认输出语言', [
    { name: '跟随用户语言', value: 'follow-user' },
    { name: '简体中文', value: 'zh-CN' },
    { name: 'English', value: 'en' },
    { name: 'Japanese', value: 'ja' },
    { name: 'Korean', value: 'ko' },
    { name: '自定义语言/语气', value: 'custom' },
  ], profile.aiOutputLanguage)
  let customAiOutputLanguage = profile.customAiOutputLanguage
  if (aiOutputLanguage === 'custom') {
    customAiOutputLanguage = await promptInput('输入自定义输出语言/语气', {
      default: customAiOutputLanguage,
      required: true,
    })
  }
  profile = saveProfile({ aiOutputLanguage, customAiOutputLanguage })
  console.log(chalk.green('已保存语言配置。'))
  return profile
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
    console.log(chalk.green('已保存人设配置。'))
    return profile
  }

  const available = PERSONA_DEFINITIONS.filter(persona => !persona.isCustom)
  console.log(chalk.cyan('可用人设 / 输出风格'))
  const enabledPersonaIds = await promptCheckbox('选择要启用的人设（空格勾选，回车确认）', available.map(persona => {
    const name = profile.interfaceLanguage === 'en' ? persona.nameEn : persona.nameZh
    const desc = profile.interfaceLanguage === 'en' ? persona.descriptionEn : persona.descriptionZh
    return {
      name: `${name} (${persona.id}) ${chalk.gray(`- ${desc}`)}`,
      value: persona.id,
      checked: profile.enabledPersonaIds.includes(persona.id),
    }
  }))

  if (enabledPersonaIds.length === 0) throw new Error('至少启用一个人设。')

  const defaultChoices = enabledPersonaIds.map(id => {
    const persona = getPersonaDefinition(id)!
    const name = profile.interfaceLanguage === 'en' ? persona.nameEn : persona.nameZh
    return {
      name: `${name} (${persona.id})`,
      value: id,
    }
  })
  const defaultPersonaId = await promptSelect('默认人设', [
    ...defaultChoices,
    { name: '自定义人设', value: 'custom' },
  ], enabledPersonaIds.includes(profile.defaultPersonaId) || profile.defaultPersonaId === 'custom'
    ? profile.defaultPersonaId
    : enabledPersonaIds[0])
  let customPersonaName = profile.customPersonaName
  let customPersonaPrompt = profile.customPersonaPrompt
  if (defaultPersonaId === 'custom') {
    customPersonaName = await promptInput('自定义人设名称', {
      default: customPersonaName || 'My TurboFlux',
      required: true,
    })
    customPersonaPrompt = await promptEditor('编辑自定义人设提示词', customPersonaPrompt || [
      'Use a precise, product-grade engineering style.',
      'Balance execution speed with careful verification.',
    ].join('\n'))
    if (!customPersonaPrompt) throw new Error('自定义人设提示词不能为空。')
  }

  profile = saveProfile({ enabledPersonaIds, defaultPersonaId, customPersonaName, customPersonaPrompt })
  console.log(chalk.green('已保存人设配置。'))
  return profile
}

async function configureCustomInstructions(options: SetupOptions = {}): Promise<TurboFluxProfile> {
  const profile = loadProfile()
  if (options.yes || options.customInstructions !== undefined) {
    const next = saveProfile({ customInstructions: options.customInstructions ?? profile.customInstructions })
    console.log(chalk.green('已保存自定义指令。'))
    return next
  }

  const customInstructions = await promptEditor('编辑全局自定义指令（可留空）', profile.customInstructions)
  const next = saveProfile({ customInstructions })
  console.log(chalk.green('已保存自定义指令。'))
  return next
}

async function configureApprovalPolicy(options: SetupOptions = {}): Promise<TurboFluxConfig> {
  const config = await loadConfig()
  const profile = loadProfile()
  let approvalPolicy: ApprovalPolicy
  if (options.approvalPolicy) {
    const normalized = options.approvalPolicy.trim().toLowerCase()
    if (!['ask', 'agent', 'full', 'request', 'auto'].includes(normalized)) {
      throw new Error('Approval policy must be ask, agent, or full.')
    }
    approvalPolicy = normalizeApprovalPolicy(normalized)
  } else if (options.yes) {
    approvalPolicy = config.approvalPolicy
  } else {
    const labels: Record<ApprovalPolicy, { zh: string; en: string }> = {
      ask: { zh: '请求批准 - 修改文件、执行命令和外部操作前询问', en: 'Request approval - ask before changes, commands, and external actions' },
      agent: { zh: '替我审批 - 低风险工作区操作自动继续，检测到风险时询问', en: 'Approve low risk - continue routine workspace actions and ask on risk' },
      full: { zh: '完全访问权限 - 不限制本地和网络访问，灾难性命令仍会阻止', en: 'Full access - unrestricted local and network access; catastrophic commands stay blocked' },
    }
    approvalPolicy = await promptSelect('审批策略', (['ask', 'agent', 'full'] as ApprovalPolicy[]).map(policy => ({
      name: zh(profile, labels[policy].zh, labels[policy].en),
      value: policy,
    })), config.approvalPolicy)
  }

  const next = { ...config, approvalPolicy }
  saveConfig(next)
  console.log(chalk.green(`审批策略：${APPROVAL_POLICY_LABELS[approvalPolicy]}`))
  return next
}

async function runFullInitialization(options: SetupOptions = {}): Promise<void> {
  let profile = await configureLanguage(options)
  await configureApi(options)
  await configureApprovalPolicy(options)
  profile = await configurePersona(options)
  if (!options.yes) {
    const editCustom = await promptConfirm('现在编辑全局自定义指令？', false)
    if (editCustom) profile = await configureCustomInstructions(options)
  } else if (options.customInstructions !== undefined) {
    profile = await configureCustomInstructions(options)
  }

  const config = await loadConfig()
  console.log('')
  printSummary(config, profile)
  console.log('')
  console.log(chalk.cyan('完成。现在可以运行：turboflux <workspace>'))
}

async function showCurrentConfiguration(): Promise<void> {
  const [config, profile] = await Promise.all([loadConfig(), Promise.resolve(loadProfile())])
  printSummary(config, profile)
}

async function resetAllConfiguration(options: SetupOptions = {}): Promise<void> {
  let profile = loadProfile()
  const ok = options.yes
    ? true
    : await promptConfirm('确认重置本机 TurboFlux 配置？API Key、模型配置、人设和语言都会恢复默认。', false)
  if (!ok) {
    console.log(chalk.yellow('已取消。'))
    return
  }

  saveConfig(createEmptyConfig())
  profile = resetProfile()
  console.log(chalk.green(zh(profile, '已重置配置。', 'Configuration reset.')))
}

async function promptMainAction(profile: TurboFluxProfile): Promise<SetupAction> {
  console.log(chalk.cyan(zh(profile, '选择功能', 'Select action')))
  console.log('  1. 完整初始化 - 语言 + API + FastContext + 人设 + 自定义指令')
  console.log('  2. API 配置档案')
  console.log('  3. 语言配置')
  console.log('  4. 人设 / 输出风格')
  console.log('  5. 全局自定义指令')
  console.log('  6. 审批策略')
  console.log('  7. 查看当前配置')
  console.log('  8. 重置本机配置')
  console.log('  Q. 退出')
  const choice = await promptChoice('输入选项', ['1', '2', '3', '4', '5', '6', '7', '8', 'q'])
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
      case 'fastcontext':
        await configureFastContextModel()
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
      case 'fastcontext':
        await configureFastContextModel()
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
